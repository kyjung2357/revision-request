import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ReviewPdfDocumentStore} from './reviewPdfDocument';
import {createReviewPdfViewHtml} from './reviewPdfView';

export const PDF_REVIEW_VIEW = 'revisionRequest.pdfReview';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const key = (uri: vscode.Uri) => process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
type Waiter = {resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>};
type Session = {
  uri: vscode.Uri; panel: vscode.WebviewPanel; disposed: boolean; ready: boolean; saves: number; epoch: number;
  hash?: string; loading?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  flushes: Map<string, Waiter>;
};

/** A local RR PDF view owns its form choices; arbitrary PDF scripts never execute. */
export class ReviewPdfEditor implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly extensionUri: vscode.Uri,
    private readonly changed: (uri: vscode.Uri) => void,
    private readonly store = new ReviewPdfDocumentStore()) {}

  private async localPath(uri: vscode.Uri, writing = false): Promise<string> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || !/\.rr\.pdf$/i.test(uri.fsPath) || !folder || folder.uri.scheme !== 'file') {
      throw new Error('Open the local workspace containing this .rr.pdf first.');
    }
    if (writing && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before saving PDF review choices.');
    const root = await fs.realpath(folder.uri.fsPath), parent = await fs.realpath(path.dirname(uri.fsPath));
    const relative = path.relative(root, parent);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
        relative.split(path.sep).some(part => part.toLowerCase() === '.git')) {
      throw new Error('The review PDF must remain inside the workspace, outside Git metadata.');
    }
    return uri.fsPath;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    await this.store.load(await this.localPath(uri));
    return {uri, dispose() {}};
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session: Session = {uri: document.uri, panel, disposed: false, ready: false, saves: 0, epoch: 0, flushes: new Map()};
    this.sessions.set(key(document.uri), session);
    panel.webview.options = {enableScripts: true, localResourceRoots: [
      vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist', 'pdfjs'),
      vscode.Uri.joinPath(this.extensionUri, '.codex-build', 'pdfjs'),
    ]};
    const receive = panel.webview.onDidReceiveMessage(async message => {
      if (session.disposed || !message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        session.ready = true;
        await this.load(session, true);
      } else if (message.type === 'flushed' && typeof message.requestId === 'string') {
        const waiter = session.flushes.get(message.requestId);
        if (!waiter) return;
        session.flushes.delete(message.requestId); clearTimeout(waiter.timer);
        if (message.ok === true) waiter.resolve();
        else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'Save the pending PDF choices before importing.'));
      } else if (message.type === 'saveDecision') {
        const sequence = message.sequence;
        try {
          if (Object.keys(message).some(name => !['type','sequence','expectedPdfHash','entryId','decision','through'].includes(name)) ||
              !Number.isSafeInteger(sequence) || sequence < 1 || typeof message.expectedPdfHash !== 'string' ||
              !/^[a-f0-9]{64}$/.test(message.expectedPdfHash) || typeof message.entryId !== 'string' ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(message.entryId) || message.entryId === '__proto__' || !['pending','accepted','ignored'].includes(message.decision) ||
              (message.through !== undefined && typeof message.through !== 'boolean') ||
              (message.through === true && message.decision !== 'accepted')) throw new Error('Invalid PDF review choice.');
          if (!session.ready || !session.hash || message.expectedPdfHash !== session.hash) throw new Error('The PDF view is out of date. Reload the saved PDF before reviewing.');
          session.epoch++;
          session.saves++;
          try {
            const filename = await this.localPath(document.uri, true);
            const saved = await this.store.saveDecision(filename, message.expectedPdfHash, message.entryId, message.decision, message.through === true);
            session.hash = saved.review.pdfHash;
            if (!session.disposed) await panel.webview.postMessage({type: 'pdfSaved', sequence,
              pdfHash: saved.review.pdfHash, decisions: saved.review.decisions});
            this.changed(document.uri);
          } finally {session.saves--;}
        } catch (error) {
          if (!session.disposed) await panel.webview.postMessage({type: 'pdfSaveError', sequence, error: errorText(error)});
        }
      }
    });
    const disposed = panel.onDidDispose(() => {
      session.disposed = true; receive.dispose(); disposed.dispose();
      if (session.timer) clearTimeout(session.timer);
      for (const waiter of session.flushes.values()) {
        clearTimeout(waiter.timer); waiter.reject(new Error('The PDF view closed before saving finished. Reopen it before importing.'));
      }
      session.flushes.clear();
      if (this.sessions.get(key(document.uri)) === session) this.sessions.delete(key(document.uri));
    });
    panel.webview.html = createReviewPdfViewHtml(panel.webview, this.extensionUri);
  }

  private async load(session: Session, force = false): Promise<void> {
    if (session.disposed || !session.ready || session.saves) return;
    if (session.loading) {await session.loading; return;}
    const epoch = session.epoch;
    session.loading = (async () => {
      try {
        const snapshot = await this.store.load(await this.localPath(session.uri));
        if (session.disposed || session.saves || session.epoch !== epoch) return;
        if (!force && session.hash === snapshot.review.pdfHash) return;
        session.hash = snapshot.review.pdfHash;
        await session.panel.webview.postMessage({type:'pdfState', base64:Buffer.from(snapshot.bytes).toString('base64'),
          manifest:snapshot.review.manifest, decisions:snapshot.review.decisions, pdfHash:snapshot.review.pdfHash,
          readOnly:!vscode.workspace.isTrusted});
      } catch(error) {
        if (!session.disposed && session.epoch === epoch) await session.panel.webview.postMessage({type:'pdfError', error:errorText(error)});
      }
    })();
    try {await session.loading;} finally {session.loading = undefined;}
  }

  pdfChanged(uri: vscode.Uri) {
    const session = this.sessions.get(key(uri));
    if (!session || session.disposed || session.saves) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {session.timer = undefined; void this.load(session);}, 100);
  }

  async flush(uri: vscode.Uri): Promise<void> {
    const session = this.sessions.get(key(uri));
    if (session && !session.disposed && session.ready) {
      const requestId = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {session.flushes.delete(requestId); reject(new Error('PDF choices are still saving. Wait for Saved, then import again.'));}, 30000);
        session.flushes.set(requestId, {resolve, reject, timer});
        void session.panel.webview.postMessage({type:'flush', requestId}).then(sent => {
          if (!sent) {clearTimeout(timer); session.flushes.delete(requestId); reject(new Error('The PDF view is unavailable. Reopen it before importing.'));}
        }, error => {clearTimeout(timer);session.flushes.delete(requestId);reject(error);});
      });
    }
    await this.store.flush(await this.localPath(uri));
  }

  dispose() {
    for (const session of this.sessions.values()) session.panel.dispose();
    this.sessions.clear();
  }
}
