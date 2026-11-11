import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { computeHunks, computeInlineChanges, parseRequest, renderAccepted, requestFingerprint, type Decision, type RevisionRequest, type RequestFile, type InlineChangeLine } from './core';
import { getReviewHtml } from './webview';
import { editPendingHunk, replaceRequestAfter } from './proposalEditing';
import { McpHost } from './mcpHost';
import { startMcpBridge } from './mcpBridge';
import { installMcpAdapter, createMcpConfiguration } from './mcpSetup';

const VIEW = 'revisionRequest.review';
type Decisions = Record<string, Decision>;
export type DecisionOrigin = 'user' | 'agent';
export function allowAgentDecisions(): boolean {
  // Repository settings and language overrides cannot grant agent permission.
  return vscode.workspace.getConfiguration('revisionRequest').inspect<boolean>('mcp.allowAgentDecisions')?.globalValue === true;
}
function assertDecisionOrigin(origin: DecisionOrigin) {
  if (origin !== 'user' && origin !== 'agent') throw new Error('Invalid decision origin.');
  if (origin === 'agent' && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before using agent decisions.');
  if (origin === 'agent' && !allowAgentDecisions()) throw new Error('Agent decisions are disabled. Enable revisionRequest.mcp.allowAgentDecisions in User settings to allow this action.');
}
interface SavedReview {
  fingerprint: string; decisions: Decisions;
  // A proposal edit persists both fingerprints before changing the .rr file.
  // Either side remains recoverable if VS Code exits during that commit.
  previous?: {fingerprint: string; decisions: Decisions};
}
interface ReviewFile {
  path: string; before: string; reason?: string; issue?: string;
  hunks: (ReturnType<typeof computeHunks>[number] & {decision: Decision; explanation?: string; inlineChanges?: InlineChangeLine[]})[];
}
export interface ReviewState {
  type: 'state'; revision: string; title: string; description?: string;
  requestName: string; files: ReviewFile[]; trusted: boolean; busy: boolean; unchangedOpacity: number;
  highlightChangedLines: boolean; showOnlyChangedText: boolean; error?: string;
}
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const keyFor = (file: string, hunk: string) => file + ':' + hunk;
// VS Code normalizes a JSON document's physical line endings in its text model.
// Escaped newlines inside before/after remain untouched by this comparison.
const requestModelText = (text: string) => text.replace(/\r\n|\r/g, '\n');
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function decode(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    if (value.includes('\0')) throw new Error('binary');
    return value;
  } catch { throw new Error('This version supports UTF-8 text files only.'); }
}

export class ReviewService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly completed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidDeleteRequest = this.completed.event;
  private queue: Promise<unknown> = Promise.resolve();
  busy = false;
  private completionRecorder?: (uri: vscode.Uri, cleanup: 'retained' | 'deleted' | 'failed') => Promise<void>;
  setCompletionRecorder(recorder: (uri: vscode.Uri, cleanup: 'retained' | 'deleted' | 'failed') => Promise<void>) {
    this.completionRecorder = recorder;
  }
  private readonly watchedTargets = new Set<string>();
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly writeRequest: (uri: vscode.Uri, bytes: Uint8Array) => Thenable<void> = (uri, bytes) => vscode.workspace.fs.writeFile(uri, bytes),
  ) {}
  dispose() { this.emitter.dispose(); this.completed.dispose(); }
  changed() { this.emitter.fire(); }
  isTarget(uri: vscode.Uri) { return this.watchedTargets.has(uri.toString()); }
  private storageKey(uri: vscode.Uri) {
    return 'review.' + createHash('sha256').update(uri.toString()).digest('hex');
  }
  private async load(uri: vscode.Uri) {
    if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.rr') {
      throw new Error('Open a local .rr request inside a workspace folder.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open the local workspace containing this request first.');
    const [root, realRequest] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(uri.fsPath)]);
    if (!inside(root, realRequest) || path.relative(root, realRequest).split(path.sep).some(part => part.toLowerCase() === '.git')) {
      throw new Error('The request must resolve inside its workspace and outside Git metadata.');
    }
    const requestStat = await fs.stat(realRequest);
    if (!requestStat.isFile() || requestStat.size > 20 * 1024 * 1024) throw new Error('The request must be a regular .rr file within the 20 MiB limit.');
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) throw new Error('Save the .rr request before reviewing its proposals.');
    // Bind decisions to the saved JSON, not the editor's normalized text model.
    const savedText = decode(await vscode.workspace.fs.readFile(uri));
    const text = savedText.replace(/^\uFEFF/, '');
    const fingerprint = requestFingerprint(text);
    if (!this.requestMatchesSaved(document, text, fingerprint)) {
      throw new Error('The request changed while loading. Review its refreshed contents before deciding.');
    }
    const request = parseRequest(text);
    const expectedName = path.basename(request.files[0]!.path) + '.rr';
    if (path.basename(uri.fsPath) !== expectedName) {
      throw new Error('Name this request "' + expectedName + '" so the target filename and extension stay visible.');
    }
    const stored = this.context.workspaceState.get<SavedReview>(this.storageKey(uri));
    const matching = stored?.fingerprint === fingerprint ? stored : stored?.previous?.fingerprint === fingerprint ? stored.previous : undefined;
    const decisions = matching ? {...matching.decisions} : {};
    return {document, request, fingerprint, decisions, savedText};
  }
  private fileDecisions(file: RequestFile, decisions: Decisions): Decisions {
    const result: Decisions = {};
    for (const hunk of computeHunks(file)) result[hunk.id] = decisions[keyFor(file.path, hunk.id)] ?? 'pending';
    return result;
  }
  private async targetUri(requestUri: vscode.Uri, file: RequestFile): Promise<vscode.Uri> {
    const folder = vscode.workspace.getWorkspaceFolder(requestUri);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open the workspace folder containing this .rr request first.');
    const candidate = path.resolve(folder.uri.fsPath, file.path);
    if (!inside(folder.uri.fsPath, candidate) || file.path.split('/').some(part => part.toLowerCase() === '.git')) {
      throw new Error('The target must be a source file inside this workspace.');
    }
    if (path.resolve(requestUri.fsPath).toLowerCase() === candidate.toLowerCase()) {
      throw new Error('A request cannot modify itself.');
    }
    let real: string;
    try {
      const [root, target] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(candidate)]);
      if (!inside(root, target)) throw new Error('The target resolves outside this workspace.');
      if (path.relative(root, target).split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('Git metadata cannot be a revision target.');
      if ((await fs.realpath(requestUri.fsPath)).toLowerCase() === target.toLowerCase()) throw new Error('A request cannot modify itself, including through an alias.');
      real = target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The target file does not exist. Version 1 reviews existing files.');
      throw error;
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('The target is not a regular file.');
    if (stat.size > 20 * 1024 * 1024) throw new Error('The target is too large for this review.');
    const uri = vscode.Uri.file(candidate);
    this.watchedTargets.add(uri.toString());
    return uri;
  }
  private async inspectTarget(requestUri: vscode.Uri, file: RequestFile, decisions: Decisions) {
    if (file.before.startsWith('\uFEFF') !== file.after.startsWith('\uFEFF')) {
      throw new Error('Keep the original UTF-8 BOM unchanged in the proposal.');
    }
    const uri = await this.targetUri(requestUri, file);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open?.isDirty) throw new Error('This file has unsaved edits. Save or undo them before accepting a proposal.');
    const expected = renderAccepted(file.before, computeHunks(file), this.fileDecisions(file, decisions));
    const current = decode(await vscode.workspace.fs.readFile(uri));
    if (current !== expected) {
      throw new Error('The original has changed since this request was created. Create a fresh request to review the current file.');
    }
    return {uri, expected, current};
  }
  async getState(uri: vscode.Uri, includeInlineChanges = true): Promise<ReviewState> {
    const base: ReviewState = {
      type: 'state', revision: '', title: 'Revision Request', requestName: path.basename(uri.fsPath),
      files: [], trusted: vscode.workspace.isTrusted, busy: this.busy,
      unchangedOpacity: Math.max(0, Math.min(100, vscode.workspace.getConfiguration('revisionRequest', uri).get<number>('unchangedOpacity', 20))),
      highlightChangedLines: vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('highlightChangedLines', true),
      showOnlyChangedText: vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('showOnlyChangedText', false)
    };
    try {
      const {request, fingerprint, decisions} = await this.load(uri);
      base.revision = fingerprint;
      base.title = request.title;
      base.description = request.description;
      for (const file of request.files) {
        let issue: string | undefined;
        try { await this.inspectTarget(uri, file, decisions); } catch (error) { issue = failure(error); }
        const hunks = computeHunks(file);
        const inlineDeadline = Date.now() + 120;
        base.files.push({
          path: file.path, before: file.before, reason: file.reason, issue,
          hunks: hunks.map(hunk => ({...hunk,
            decision: decisions[keyFor(file.path, hunk.id)] ?? 'pending',
            explanation: file.explanations?.find(item => item.line === hunk.oldStart)?.text ?? file.reason,
            inlineChanges: includeInlineChanges ? computeInlineChanges(hunk, Math.min(40, Math.max(0, inlineDeadline - Date.now()))) : undefined
          }))
        });
      }
    } catch (error) { base.error = failure(error); }
    return base;
  }
  runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = async () => {
      this.busy = true;
      this.changed();
      try { return await action(); } finally { this.busy = false; this.changed(); }
    };
    const pending = this.queue.then(task, task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private requestMatchesSaved(document: vscode.TextDocument, saved: string, fingerprint: string) {
    return !document.isDirty && requestFingerprint(saved) === fingerprint &&
      requestModelText(document.getText()) === requestModelText(saved);
  }
  private async assertRequestUnchanged(uri: vscode.Uri, document: vscode.TextDocument, fingerprint: string) {
    const saved = decode(await vscode.workspace.fs.readFile(uri)).replace(/^\uFEFF/, '');
    if (!this.requestMatchesSaved(document, saved, fingerprint)) {
      throw new Error('The request changed while preparing this action. Review it again.');
    }
    return document.getText();
  }
  private async applyTarget(
    uri: vscode.Uri, file: RequestFile, previous: Decisions, next: Decisions,
    document: vscode.TextDocument, fingerprint: string, origin: DecisionOrigin,
  ) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying changes.');
    const target = await this.inspectTarget(uri, file, previous);
    const result = renderAccepted(file.before, computeHunks(file), this.fileDecisions(file, next));
    const checkedModelText = await this.assertRequestUnchanged(uri, document, fingerprint);
    const diskNow = decode(await vscode.workspace.fs.readFile(target.uri));
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.uri.toString());
    if (open?.isDirty || diskNow !== target.expected) {
      throw new Error('The original changed while preparing this action. Nothing was applied.');
    }
    if (document.isDirty || document.getText() !== checkedModelText) {
      throw new Error('The request changed while preparing this action. Review it again.');
    }
    // Approval and Undo both write only the reconstructed bytes. Saving an editor
    // would also run formatters and whitespace hooks that can change other text.
    assertDecisionOrigin(origin);
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying changes.');
    await vscode.workspace.fs.writeFile(target.uri, Buffer.from(result, 'utf8'));
    // Complete the authorized commit even if permission changes during the write:
    // its persisted decisions must still agree with the resulting source bytes.
    await this.context.workspaceState.update(this.storageKey(uri), {fingerprint, decisions: next});
    const saved = decode(await vscode.workspace.fs.readFile(target.uri));
    if (saved !== result) {
      throw new Error('Another process changed the file while applying this action. Review the saved file before continuing.');
    }
  }
  async decide(uri: vscode.Uri, filePath: string, hunkId: string | undefined, decision: 'accepted' | 'ignored', revision: string, origin: DecisionOrigin = 'user') {
    assertDecisionOrigin(origin);
    return this.runExclusive(async () => {
      assertDecisionOrigin(origin);
      if (decision !== 'accepted' && decision !== 'ignored') throw new Error('Invalid review decision.');
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before deciding.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const hunks = computeHunks(file);
      const selected = hunks.filter(hunk => (!hunkId || hunk.id === hunkId) &&
        (loaded.decisions[keyFor(file.path, hunk.id)] ?? 'pending') === 'pending');
      if (!selected.length) throw new Error('There are no pending changes for this action.');
      const next = {...loaded.decisions};
      for (const hunk of selected) next[keyFor(file.path, hunk.id)] = decision;
      if (decision === 'accepted') {
        await this.applyTarget(uri, file, loaded.decisions, next, loaded.document, loaded.fingerprint, origin);
      } else {
        // Ignore only changes local review state; it never edits or saves the target.
        await this.assertRequestUnchanged(uri, loaded.document, loaded.fingerprint);
        assertDecisionOrigin(origin);
        await this.context.workspaceState.update(this.storageKey(uri), {fingerprint: loaded.fingerprint, decisions: next});
      }
      if (hunks.every(hunk => next[keyFor(file.path, hunk.id)] !== 'pending' && next[keyFor(file.path, hunk.id)] !== undefined)) {
        // Persist the final outcome before automatic cleanup clears decisions.
        try { await this.completionRecorder?.(uri, 'retained'); }
        catch (error) {
          void vscode.window.showWarningMessage('Review completed. The .rr request was kept because its completion record could not be saved: ' + failure(error));
          return;
        }
        await this.removeCompletedRequest(uri, loaded.document, loaded.fingerprint);
      }
    });
  }
  async undo(uri: vscode.Uri, filePath: string, hunkId: string, revision: string, origin: DecisionOrigin = 'user') {
    assertDecisionOrigin(origin);
    return this.runExclusive(async () => {
      assertDecisionOrigin(origin);
      if (typeof hunkId !== 'string' || !hunkId) throw new Error('Choose a specific change to undo.');
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before undoing.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const hunk = computeHunks(file).find(candidate => candidate.id === hunkId);
      if (!hunk) throw new Error('Unknown change group.');
      const key = keyFor(file.path, hunk.id);
      const previous = loaded.decisions[key] ?? 'pending';
      if (previous !== 'accepted' && previous !== 'ignored') {
        throw new Error('This change is still pending; only an accepted or ignored change can be undone.');
      }
      const next = {...loaded.decisions, [key]: 'pending' as Decision};
      if (previous === 'accepted') {
        await this.applyTarget(uri, file, loaded.decisions, next, loaded.document, loaded.fingerprint, origin);
      } else {
        // Undoing Ignore only restores the proposal's pending state.
        await this.assertRequestUnchanged(uri, loaded.document, loaded.fingerprint);
        assertDecisionOrigin(origin);
        await this.context.workspaceState.update(this.storageKey(uri), {fingerprint: loaded.fingerprint, decisions: next});
      }
    });
  }
  async editPending(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof draft !== 'string' || typeof revision !== 'string') {
      throw new Error('Choose a pending change and provide its complete draft text.');
    }
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before editing.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const target = await this.inspectTarget(uri, file, loaded.decisions);
      const edited = editPendingHunk(file, this.fileDecisions(file, loaded.decisions), hunkId, draft);
      await this.assertRequestUnchanged(uri, loaded.document, loaded.fingerprint);
      if (!edited.changed) return {changed: false, revision: loaded.fingerprint};
      // Replace only the authoritative after string token. Unknown metadata,
      // numeric spellings, formatting, outer BOM and all other bytes stay intact.
      const savedText = replaceRequestAfter(loaded.savedText, edited.file.after);
      const nextRequest = parseRequest(savedText);
      const nextFile = nextRequest.files[0]!;
      if (nextFile.before !== file.before || nextFile.path !== file.path ||
          renderAccepted(nextFile.before, computeHunks(nextFile), edited.decisions) !== target.expected) {
        throw new Error('Editing a pending proposal must preserve the current original and all resolved changes.');
      }
      const fingerprint = requestFingerprint(savedText.replace(/^\uFEFF/, ''));
      const decisions: Decisions = {};
      for (const [id, decision] of Object.entries(edited.decisions)) decisions[keyFor(file.path, id)] = decision;
      const previous = {fingerprint: loaded.fingerprint, decisions: loaded.decisions};
      const next = {fingerprint, decisions};
      // Persist a recoverable transition first. Until the write, load uses the
      // previous fingerprint; after the write it uses the new decisions.
      await this.context.workspaceState.update(this.storageKey(uri), {...next, previous});
      try {
        const root = vscode.workspace.getWorkspaceFolder(uri)?.uri;
        if (!root || root.scheme !== 'file') throw new Error('The request workspace is no longer open.');
        const [realRoot, realRequest] = await Promise.all([fs.realpath(root.fsPath), fs.realpath(uri.fsPath)]);
        if (!inside(realRoot, realRequest) || path.relative(realRoot, realRequest).split(path.sep).some(part => part.toLowerCase() === '.git')) {
          throw new Error('The request no longer resolves inside its workspace.');
        }
        const [requestNow, targetNow, requestPathNow] = await Promise.all([
          vscode.workspace.fs.readFile(uri), vscode.workspace.fs.readFile(target.uri), fs.realpath(uri.fsPath)
        ]);
        const requestTextNow = decode(requestNow);
        if (requestPathNow !== realRequest || requestTextNow !== loaded.savedText ||
            !this.requestMatchesSaved(loaded.document, requestTextNow.replace(/^\uFEFF/, ''), loaded.fingerprint)) {
          throw new Error('The request changed while preparing this edit. The proposal was not saved.');
        }
        const current = decode(targetNow);
        const targetDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === target.uri.toString());
        if (targetDocument?.isDirty || current !== target.expected) throw new Error('The original changed while preparing this edit. The proposal was not saved.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
        await this.writeRequest(vscode.Uri.file(realRequest), Buffer.from(savedText, 'utf8'));
        // The transition is already durable and valid for the new bytes. Failure
        // to remove its old fallback cannot lose the resolved decisions.
        try { await this.context.workspaceState.update(this.storageKey(uri), next); }
        catch (error) { console.error('Revision Request retained proposal-edit recovery metadata:', error); }
        // Give the clean native JSON model time to observe this exact file write.
        // Never force a revert or overwrite a newly dirty editor.
        const deadline = Date.now() + 1500;
        while (!loaded.document.isClosed && !loaded.document.isDirty &&
            requestModelText(loaded.document.getText()) !== requestModelText(savedText.replace(/^\uFEFF/, '')) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const saved = decode(await vscode.workspace.fs.readFile(uri));
        if (saved !== savedText) throw new Error('Another process changed the request while saving the draft. Review it again.');
        return {changed: true, revision: fingerprint};
      } catch (error) {
        // A rejected write may already have committed its bytes. Keep both
        // fingerprints so either saved version retains its resolved decisions.
        throw error;
      }
    });
  }
  private async removeCompletedRequest(uri: vscode.Uri, document: vscode.TextDocument, fingerprint: string) {
    if (!vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('autoDeleteCompleted', true)) return;
    try {
      // Never discard a request edited while the last decision was being applied.
      const saved = decode(await vscode.workspace.fs.readFile(uri)).replace(/^\uFEFF/, '');
      if (!this.requestMatchesSaved(document, saved, fingerprint)) {
        void vscode.window.showWarningMessage('Review completed. The .rr request changed during review, so it was kept.');
        return;
      }
      await vscode.workspace.fs.delete(uri, {recursive: false, useTrash: true});
      await this.completionRecorder?.(uri, 'deleted');
      await this.context.workspaceState.update(this.storageKey(uri), undefined);
      const sourceTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        !tab.isDirty && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
      try {
        if (sourceTabs.length) await vscode.window.tabGroups.close(sourceTabs, true);
      } finally {
        // Close the JSON source before its preview, so revealing the previous tab
        // cannot automatically reopen a request that has just been deleted.
        this.completed.fire(uri);
      }
    } catch (error) {
      await this.completionRecorder?.(uri, 'failed').catch(() => undefined);
      void vscode.window.showWarningMessage('Review completed, but automatic .rr cleanup could not finish: ' + failure(error));
    }
  }
  async openTarget(requestUri: vscode.Uri, filePath: string, options: vscode.TextDocumentShowOptions = {}) {
    const {request} = await this.load(requestUri);
    const file = request.files.find(item => item.path === filePath);
    if (!file) throw new Error('Unknown request file.');
    return vscode.window.showTextDocument(await this.targetUri(requestUri, file), {viewColumn: vscode.ViewColumn.Active, preserveFocus: true, preview: false, ...options});
  }
  async snapshots(requestUri: vscode.Uri, filePath: string, revision: string) {
    const {request, fingerprint, decisions} = await this.load(requestUri);
    if (fingerprint !== revision) throw new Error('The request changed. Open the comparison again.');
    const file = request.files.find(item => item.path === filePath);
    if (!file) throw new Error('Unknown request file.');
    const hunks = computeHunks(file);
    const current = this.fileDecisions(file, decisions);
    const proposed = {...current};
    for (const hunk of hunks) if (proposed[hunk.id] === 'pending') proposed[hunk.id] = 'accepted';
    return {before: renderAccepted(file.before, hunks, current), after: renderAccepted(file.before, hunks, proposed)};
  }
}

class SnapshotProvider implements vscode.TextDocumentContentProvider {
  private readonly values = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri) { return this.values.get(uri.toString()) ?? ''; }
  put(label: string, value: string) {
    const id = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const uri = vscode.Uri.from({scheme: 'rr-snapshot', path: '/' + label, query: id});
    this.values.set(uri.toString(), value);
    return uri;
  }
}

class ReviewEditor implements vscode.Disposable {
  readyCount = 0;
  activeUri: vscode.Uri | undefined;
  private sourceOnlyUri: string | undefined;
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly opening = new Map<string, Promise<void>>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly service: ReviewService, private readonly snapshots: SnapshotProvider) {}
  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
  }
  async openSource(uri?: vscode.Uri) {
    const target = uri ?? this.activeUri;
    if (!target) return;
    this.sourceOnlyUri = target.toString();
    await vscode.window.showTextDocument(target, {viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false});
  }
  async openDiff(uri: vscode.Uri, filePath?: string, revision?: string) {
    if (filePath === undefined || revision === undefined) {
      const state = await this.service.getState(uri);
      if (state.error) throw new Error(state.error);
      const file = state.files[0];
      if (!file) throw new Error('This request has no file to compare.');
      filePath = file.path;
      revision = state.revision;
    }
    const content = await this.service.snapshots(uri, filePath, revision);
    const name = path.basename(filePath);
    await vscode.commands.executeCommand('vscode.diff',
      this.snapshots.put('current/' + name, content.before),
      this.snapshots.put('proposed/' + name, content.after),
      'Revision Request: ' + filePath, {preview: true});
  }
  autoPreview(editor: vscode.TextEditor | undefined) {
    if (!editor) return;
    const uri = editor.document.uri;
    if (!uri.path.endsWith('.rr')) { this.sourceOnlyUri = undefined; return; }
    if (this.sourceOnlyUri === uri.toString()) return;
    if (!vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('previewOnOpen', true)) return;
    void this.openPreview(uri).catch(error => vscode.window.showErrorMessage(failure(error)));
  }
  async openPreview(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const existing = this.opening.get(key);
    if (existing) return existing;
    const pending = this.showPreview(uri);
    this.opening.set(key, pending);
    try { await pending; } finally { this.opening.delete(key); }
  }
  private async showPreview(uri: vscode.Uri) {
    if (uri.scheme !== 'file' || !uri.path.endsWith('.rr')) throw new Error('Choose a local .rr request.');
    this.activeUri = uri;
    this.sourceOnlyUri = undefined;
    let panel = this.panels.get(uri.toString());
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        VIEW, path.basename(uri.fsPath) + ' — Preview',
        {viewColumn: vscode.ViewColumn.Active, preserveFocus: false},
        {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]}
      );
      this.panels.set(uri.toString(), panel);
      this.connect(uri, panel);
    }
    panel.reveal(panel.viewColumn, false);
  }
  private connect(uri: vscode.Uri, panel: vscode.WebviewPanel) {
    let generation = 0;
    let disposed = false;
    let actionError: string | undefined;
    const update = async () => {
      if (disposed) return;
      const requested = ++generation;
      const state = await this.service.getState(uri);
      if (disposed || requested !== generation) return;
      if (actionError) state.error = actionError;
      await panel.webview.postMessage(state);
    };
    const disposables = [
      this.service.onDidChange(() => { void update(); }),
      this.service.onDidDeleteRequest(deleted => {
        if (deleted.toString() === uri.toString()) {
          if (this.sourceOnlyUri === uri.toString()) this.sourceOnlyUri = undefined;
          panel.dispose();
        }
      }),
      panel.onDidChangeViewState(event => { if (event.webviewPanel.active) this.activeUri = uri; }),
      panel.webview.onDidReceiveMessage(async message => {
        if (!message || typeof message.type !== 'string') return;
        let editResult: Awaited<ReturnType<ReviewService['editPending']>> | undefined;
        try {
          actionError = undefined;
          switch (message.type) {
            case 'ready': this.readyCount++; break;
            case 'decide':
            case 'decideFile':
              if (typeof message.filePath !== 'string' || typeof message.revision !== 'string' ||
                  (message.decision !== 'accepted' && message.decision !== 'ignored') ||
                  (message.type === 'decide' && typeof message.hunkId !== 'string')) throw new Error('Invalid review action.');
              await this.service.decide(uri, message.filePath, message.type === 'decide' ? message.hunkId : undefined, message.decision, message.revision);
              break;
            case 'undo':
              if (typeof message.filePath !== 'string' || typeof message.revision !== 'string' ||
                  typeof message.hunkId !== 'string') throw new Error('Invalid undo action.');
              await this.service.undo(uri, message.filePath, message.hunkId, message.revision);
              break;
            case 'editPending':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' ||
                  typeof message.draft !== 'string' || typeof message.revision !== 'string' || typeof message.editId !== 'string') {
                throw new Error('Invalid proposal edit.');
              }
              editResult = await this.service.editPending(uri, message.filePath, message.hunkId, message.draft, message.revision);
              break;
            case 'openTarget': await this.service.openTarget(uri, message.filePath, {preserveFocus: false}); break;
            case 'openSource': await this.openSource(uri); break;
            case 'openDiff': await this.openDiff(uri, message.filePath, message.revision); break;
            default: return;
          }
        } catch (error) { actionError = failure(error); }
        if (message.type === 'editPending') {
          await panel.webview.postMessage({type: 'editResult', editId: message.editId, filePath: message.filePath,
            hunkId: message.hunkId, success: editResult !== undefined, error: actionError, ...editResult});
          actionError = undefined; // The draft editor owns edit errors and keeps the draft.
        }
        await update();
      })
    ];
    panel.onDidDispose(() => {
      disposed = true;
      ++generation;
      if (this.activeUri?.toString() === uri.toString()) this.activeUri = undefined;
      disposables.forEach(item => item.dispose());
      this.panels.delete(uri.toString());
    });
    panel.webview.html = getReviewHtml(panel.webview, this.context.extensionUri);
    void update();
  }
}

class RequestTree implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 100);
  }
  dispose() { clearTimeout(this.timer); this.emitter.dispose(); }
  getTreeItem(uri: vscode.Uri) {
    const item = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.description = vscode.workspace.asRelativePath(uri, true);
    item.tooltip = uri.fsPath;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.command = {command: 'revisionRequest.openPreview', title: 'Review request', arguments: [uri]};
    return item;
  }
  async getChildren() {
    const files = await vscode.workspace.findFiles('**/*.rr', '**/{node_modules,.git,.codex-build,.codex-test,.codex-artifacts,.codex-npm-cache}/**', 1000);
    return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }
}

export async function activate(context: vscode.ExtensionContext) {
  let failNextRequestWriteAfterSave = false;
  const service = new ReviewService(context, context.extensionMode === vscode.ExtensionMode.Test ? async (uri, bytes) => {
    await vscode.workspace.fs.writeFile(uri, bytes);
    if (failNextRequestWriteAfterSave) {
      failNextRequestWriteAfterSave = false;
      throw new Error('Injected request-write failure after saving bytes.');
    }
  } : undefined);
  const snapshots = new SnapshotProvider();
  const editor = new ReviewEditor(context, service, snapshots);
  const tree = new RequestTree();
  const mcpHost = new McpHost(context, service, uri => editor.openPreview(uri), allowAgentDecisions);
  let installation: Awaited<ReturnType<typeof installMcpAdapter>> | undefined;
  let bridge: Awaited<ReturnType<typeof startMcpBridge>> | undefined;
  let startingBridge: Promise<void> | undefined;
  let disposed = false;
  const localWorkspaces = () => vscode.workspace.isTrusted ? (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file').map(folder => ({uri: folder.uri.toString(), name: folder.name})) : [];
  const ensureBridge = async () => {
    if (!localWorkspaces().length) throw new Error('Open and trust a local workspace folder before connecting MCP.');
    if (bridge) return;
    if (!startingBridge) startingBridge = (async () => {
      installation = await installMcpAdapter(context.extensionPath, context.globalStorageUri.fsPath);
      bridge = await startMcpBridge({registryDir: installation.registryDir, workspaces: localWorkspaces, handler: mcpHost.handler});
      if (disposed) bridge.dispose();
    })().finally(() => { startingBridge = undefined; });
    await startingBridge;
  };
  const getMcpConfiguration = async (workspaceUri?: vscode.Uri) => {
    const folders = localWorkspaces();
    const selected = workspaceUri ? folders.find(folder => folder.uri === workspaceUri.toString()) : folders.length === 1 ? folders[0] : undefined;
    if (!selected) throw new Error('Choose one explicitly opened local workspace for the MCP configuration.');
    await ensureBridge();
    return {...createMcpConfiguration({runtime: process.execPath, ...installation!, workspaceUri: selected.uri}), instanceId: bridge!.instanceId};
  };
  const publishWorkspaces = () => {
    if (bridge) void bridge.publish().catch(error => console.error('Revision Request MCP:', error));
    else if (localWorkspaces().length) void ensureBridge().catch(error => console.error('Revision Request MCP:', error));
  };
  const requests = vscode.workspace.createFileSystemWatcher('**/*.rr');
  const targets = vscode.workspace.createFileSystemWatcher('**/*');
  const changed = (uri: vscode.Uri) => {
    if (uri.path.endsWith('.rr')) { tree.refresh(); service.changed(); }
    else if (service.isTarget(uri)) service.changed();
  };
  context.subscriptions.push(
    service, tree, requests, targets, editor,
    {dispose: () => {disposed = true; bridge?.dispose();}},
    vscode.window.onDidChangeActiveTextEditor(active => editor.autoPreview(active)),
    vscode.workspace.registerTextDocumentContentProvider('rr-snapshot', snapshots),
    vscode.window.createTreeView('revisionRequest.requests', {treeDataProvider: tree}),
    requests.onDidCreate(changed), requests.onDidDelete(changed), requests.onDidChange(changed),
    targets.onDidChange(changed), targets.onDidDelete(changed),
    vscode.workspace.onDidChangeTextDocument(event => changed(event.document.uri)),
    vscode.workspace.onDidSaveTextDocument(document => changed(document.uri)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {service.changed(); publishWorkspaces();}),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('revisionRequest.unchangedOpacity') ||
          event.affectsConfiguration('revisionRequest.highlightChangedLines') ||
          event.affectsConfiguration('revisionRequest.showOnlyChangedText')) service.changed();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {tree.refresh(); service.changed(); publishWorkspaces();}),
    vscode.commands.registerCommand('revisionRequest.copyMcpConfiguration', async () => {
      try {
        const folders = localWorkspaces();
        if (!folders.length) throw new Error('Open and trust a local workspace before copying its MCP configuration.');
        const selected = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(
          folders.map(folder => ({label: folder.name, description: vscode.Uri.parse(folder.uri).fsPath, uri: folder.uri})),
          {placeHolder: 'Choose the workspace this MCP connection can access'});
        if (!selected) return;
        const format = await vscode.window.showQuickPick(['Generic JSON', 'Codex TOML'], {placeHolder: 'Choose the MCP client configuration format'});
        if (!format) return;
        const configuration = await getMcpConfiguration(vscode.Uri.parse(selected.uri));
        await vscode.env.clipboard.writeText(format === 'Codex TOML' ? configuration.codexToml : JSON.stringify(configuration.json, null, 2));
        void vscode.window.showInformationMessage('Revision Request MCP configuration copied.');
      } catch (error) { void vscode.window.showErrorMessage(failure(error)); }
    }),
    vscode.commands.registerCommand('revisionRequest.refresh', () => {tree.refresh(); service.changed();}),
    vscode.commands.registerCommand('revisionRequest.showRequests', () => vscode.commands.executeCommand('revisionRequest.requests.focus')),
    vscode.commands.registerCommand('revisionRequest.openRequest', async (uri?: vscode.Uri) => {
      if (!uri) uri = (await vscode.window.showOpenDialog({filters: {'Revision Request': ['rr']}, canSelectMany: false}))?.[0];
      if (uri) await editor.openPreview(uri);
    }),
    vscode.commands.registerCommand('revisionRequest.openPreview', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? editor.activeUri;
      if (target) await editor.openPreview(target);
    }),
    vscode.commands.registerCommand('revisionRequest.openSource', (uri?: vscode.Uri) => editor.openSource(uri)),
    vscode.commands.registerCommand('revisionRequest.openDiff', async (uri?: vscode.Uri) => {
      const active = vscode.window.activeTextEditor?.document.uri;
      const target = uri ?? (active?.path.endsWith('.rr') ? active : editor.activeUri);
      if (target) await editor.openDiff(target);
    })
  );
  if (localWorkspaces().length) {
    try { await ensureBridge(); } catch (error) { console.error('Revision Request MCP could not start:', error); }
  }
  editor.autoPreview(vscode.window.activeTextEditor);
  // Exposed for integration tests and local tools. Uses exactly the same approval checks as the UI.
  return {
    getReadyCount: () => editor.readyCount,
    getMcpConfiguration,
    mcpHandler: mcpHost.handler,
    ...(context.extensionMode === vscode.ExtensionMode.Test ? {
      testRunExclusive: <T>(action: () => Promise<T>) => service.runExclusive(action),
      testFailNextRequestWriteAfterSave: () => {failNextRequestWriteAfterSave = true;},
      editPending: (uri: vscode.Uri, file: string, hunk: string, draft: string, revision: string) =>
        service.editPending(uri, file, hunk, draft, revision)
    } : {}),
    getState: (uri: vscode.Uri) => service.getState(uri),
    decide: (uri: vscode.Uri, file: string, hunk: string | undefined, decision: 'accepted' | 'ignored', revision: string) =>
      service.decide(uri, file, hunk, decision, revision),
    undo: (uri: vscode.Uri, file: string, hunk: string, revision: string) =>
      service.undo(uri, file, hunk, revision)
  };
}
export function deactivate() {}
