import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { computeHunks, computeFileInlineChanges, renderAccepted, requestFingerprint, type Decision, type RequestFile, type InlineChangeLine } from './core';
import { getReviewHtml, getReviewRestoreErrorHtml } from './webview';
import { parseRequestDocument, proposalIdentity, resolveRequest, patchRequestStatuses, editPendingRequest, ensureRequestTime, type RevisionRequest } from './request';
import { McpHost } from './mcpHost';
import { startMcpBridge } from './mcpBridge';
import { installMcpAdapter, createMcpConfiguration } from './mcpSetup';
import { createRequestFromFiles } from './createRequestCommand';
import { readGitOriginal, validateGitOriginalTarget, type GitOriginal } from './gitOriginal';
import { collectMcpDiagnostics, formatMcpDiagnostics } from './mcpDiagnostics';
import { applyReviewAction, getReviewActions, type ReviewAction, type ReviewActionInput } from './reviewActions';
import { inspectReviewMacros, setupReviewMacros, type SetupImportPlan } from './reviewMacroSetup';

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
export interface CompletionPrompt {
  completionId: string; revision: string; requestName: string;
}
interface ReviewTransaction {
  generation: string; baseline: string; oldRequest: string; newRequest: string;
}
class ResolutionError extends Error {
  constructor(readonly request: RevisionRequest, readonly revision: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
interface ReviewFile {
  path: string; before: string; currentText?: string; reason?: string; issue?: string;
  hunks: (ReturnType<typeof computeHunks>[number] & {decision: Decision; explanation?: string; inlineChanges?: InlineChangeLine[]})[];
}
export interface ReviewState {
  type: 'state'; revision: string; title: string; description?: string;
  requestName: string; files: ReviewFile[]; trusted: boolean; busy: boolean; unchangedOpacity: number;
  highlightChangedLines: boolean; showOnlyChangedText: boolean; defaultLayout: 'unified' | 'sideBySide'; error?: string;
  acceptShortcut: 'ctrlEnter' | 'altEnter' | 'tab' | 'shiftTab' | 'none';
  requestIdentity?: string; verified: boolean;
  verificationIssue?: string; verifiedTargetHash?: string; closed?: boolean;
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
  } catch { throw new Error('Only UTF-8 text files are supported.'); }
}

export class ReviewService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly completed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidDeleteRequest = this.completed.event;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly completionPrompts = new Map<string, CompletionPrompt>();
  private readonly attemptedPreparation = new Map<string, string>();
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
  changed(retryPreparation = false) { if (retryPreparation || !this.busy) this.attemptedPreparation.clear(); this.emitter.fire(); }
  isTarget(uri: vscode.Uri) { return this.watchedTargets.has(uri.toString()); }
  private storageKey(uri: vscode.Uri) {
    return 'review.' + createHash('sha256').update(uri.toString()).digest('hex');
  }
  private async readRequest(uri: vscode.Uri) {
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
    let request: RevisionRequest;
    try { request = parseRequestDocument(text); }
    catch (error) {
      if (error instanceof SyntaxError || failure(error).startsWith('Invalid .rr JSON:')) {
        throw new Error('JSON syntax error in "' + path.basename(uri.fsPath) + '".');
      }
      throw error;
    }
    const targetPath = request.path;
    const expectedName = path.basename(targetPath) + '.rr';
    if (path.basename(uri.fsPath) !== expectedName) {
      throw new Error('The request filename does not match "' + path.basename(targetPath) + '".');
    }
    const generation = requestStat.dev + ':' + requestStat.ino + ':' + requestStat.birthtimeMs;
    return {document, request, fingerprint, savedText, realRequest, generation, requestStat};
  }
  // Keep the persisted namespace stable so retained requests preserve their baselines.
  private reviewPrefix(uri: vscode.Uri) { return this.storageKey(uri) + '.v2.'; }
  private journalKey(uri: vscode.Uri) { return this.reviewPrefix(uri) + 'transaction'; }
  private baselineKey(uri: vscode.Uri, generation: string, identity: string) {
    return this.reviewPrefix(uri) + 'baseline.' + requestFingerprint(generation) + '.' + identity;
  }
  private gitOriginalKey(uri: vscode.Uri, generation: string) {
    return this.reviewPrefix(uri) + 'git-original.' + requestFingerprint(generation);
  }
  /** Remember the creation baseline locally; the portable .rr format stays unchanged. */
  async rememberGitOriginal(uri: vscode.Uri, selected: GitOriginal): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before recording a Git original.');
    const raw = await this.readRequest(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri)!;
    const target = await this.targetUri(uri, {path: raw.request.path, before: '', after: ''});
    const selection = await validateGitOriginalTarget(folder.uri.fsPath, target.fsPath, selected);
    const baseline = requestModelText(await readGitOriginal(selection));
    if (raw.request.request.some(entry => entry.status !== 'pending')) throw new Error('A new Git request must contain only pending changes.');
    resolveRequest(raw.request, '', baseline);
    await this.assertRawRequest(uri, raw);
    if (!vscode.workspace.isTrusted) throw new Error('The selected workspace is no longer trusted.');
    await this.context.workspaceState.update(this.gitOriginalKey(uri, raw.generation), {
      path: raw.request.path, hash: requestFingerprint(baseline), commit: selection.commit
    });
  }
  private async load(uri: vscode.Uri) {
    const raw = await this.readRequest(uri);
    const request = raw.request;
    try {
      const identity = proposalIdentity(request);
      const key = this.baselineKey(uri, raw.generation, identity);
      const gitOriginal = this.context.workspaceState.get<{path: string; hash: string; commit: string}>(
        this.gitOriginalKey(uri, raw.generation));
      let cached = this.context.workspaceState.get<string>(key);
      // A preview may have read the newly created file while its origin was being recorded.
      if (gitOriginal && cached !== undefined && requestFingerprint(requestModelText(cached)) !== gitOriginal.hash) cached = undefined;
      const target = await this.targetUri(uri, {path: request.path, before: '', after: ''});
      const current = decode(await vscode.workspace.fs.readFile(target));
      const review = resolveRequest(request, current, cached);
      if (gitOriginal && (gitOriginal.path !== request.path || requestFingerprint(requestModelText(review.baseline)) !== gitOriginal.hash)) {
        throw new Error('This request uses Git commit ' + gitOriginal.commit.slice(0, 8) +
          ' as its original. Review it in a workspace whose target matches that version.');
      }
      if (cached === undefined) await this.context.workspaceState.update(key, review.baseline);
      const decisions: Decisions = {};
      for (const [hunk, decision] of Object.entries(review.decisions)) decisions[keyFor(request.path, hunk)] = decision;
      return {...raw, request: {title: path.basename(request.path), files: [review.file]}, decisions,
        resolved: {request, review, identity}};
    } catch (error) { throw new ResolutionError(request, raw.fingerprint, error); }
  }
  private async waitForRequestModel(document: vscode.TextDocument, savedText: string) {
    const deadline = Date.now() + 1500;
    while (!document.isClosed && !document.isDirty &&
        requestModelText(document.getText()) !== requestModelText(savedText.replace(/^\uFEFF/, '')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private async assertRawRequest(uri: vscode.Uri, raw: Omit<Awaited<ReturnType<ReviewService['readRequest']>>, 'request'>) {
    const latest = await this.readRequest(uri);
    if (latest.savedText !== raw.savedText || latest.generation !== raw.generation || latest.realRequest !== raw.realRequest) {
      throw new Error('The request changed while preparing this action. Review it again.');
    }
  }
  private async writeRawRequest(uri: vscode.Uri, raw: Omit<Awaited<ReturnType<ReviewService['readRequest']>>, 'request'>, text: string) {
    await this.assertRawRequest(uri, raw);
    try { await this.writeRequest(vscode.Uri.file(raw.realRequest), Buffer.from(text, 'utf8')); }
    catch (error) {
      // A provider may commit bytes and then reject before VS Code's clean model
      // catches up. Let that model observe the saved bytes before journal recovery
      // compares it; never revert or replace a dirty editor.
      const saved = await vscode.workspace.fs.readFile(uri).then(bytes => decode(bytes), () => undefined);
      if (saved === text) await this.waitForRequestModel(raw.document, text);
      throw error;
    }
    await this.waitForRequestModel(raw.document, text);
    if (decode(await vscode.workspace.fs.readFile(uri)) !== text) throw new Error('The request changed while saving. Review it again.');
  }
  private projection(text: string, baseline: string) {
    const request = parseRequestDocument(text);
    return {request, review: resolveRequest(request, '', baseline)};
  }
  private async recoverReview(uri: vscode.Uri): Promise<'old' | 'new' | undefined> {
    const journal = this.context.workspaceState.get<ReviewTransaction>(this.journalKey(uri));
    if (!journal) return;
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before recovering an interrupted review.');
    const raw = await this.readRequest(uri);
    if (raw.generation !== journal.generation || (raw.savedText !== journal.oldRequest && raw.savedText !== journal.newRequest)) {
      throw new Error('An interrupted review conflicts with newer request contents. The files were kept unchanged.');
    }
    const old = this.projection(journal.oldRequest, journal.baseline);
    const next = this.projection(journal.newRequest, journal.baseline);
    if (old.request.path !== next.request.path) throw new Error('The interrupted request has inconsistent targets.');
    const target = await this.targetUri(uri, old.review.file);
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === target.toString());
    if (open?.isDirty) throw new Error('Save or undo unsaved original edits before recovering this review.');
    const current = decode(await vscode.workspace.fs.readFile(target));
    const matchesOld = current === old.review.expectedTarget;
    const matchesNew = current === next.review.expectedTarget;
    if (!matchesOld && !matchesNew) throw new Error('An interrupted review conflicts with newer original contents. The files were kept unchanged.');
    // Recovery only reconciles metadata with the saved source; it NEVER writes the original.
    const outcome = matchesNew && (!matchesOld || raw.savedText === journal.newRequest) ? 'new' : 'old';
    const chosen = outcome === 'new' ? next : old;
    const text = outcome === 'new' ? journal.newRequest : journal.oldRequest;
    if (text !== raw.savedText) {
      await this.assertRawRequest(uri, raw);
      if (decode(await vscode.workspace.fs.readFile(target)) !== current || open?.isDirty) throw new Error('The original changed during recovery.');
      await this.writeRawRequest(uri, raw, text);
    }
    if (decode(await vscode.workspace.fs.readFile(target)) !== chosen.review.expectedTarget || open?.isDirty) {
      throw new Error('The original changed during recovery.');
    }
    await this.context.workspaceState.update(this.baselineKey(uri, journal.generation, chosen.review.identity), journal.baseline);
    await this.context.workspaceState.update(this.journalKey(uri), undefined);
    return outcome;
  }
  private async prepareReview(uri: vscode.Uri) {
    await this.recoverReview(uri);
    const raw = await this.readRequest(uri);
    if (raw.request.time !== undefined || !vscode.workspace.isTrusted) return;
    const created = raw.requestStat.birthtimeMs > 0 && Number.isFinite(raw.requestStat.birthtimeMs) ? raw.requestStat.birthtimeMs
      : Number.isFinite(raw.requestStat.mtimeMs) ? raw.requestStat.mtimeMs : Date.now();
    const text = ensureRequestTime(raw.savedText, new Date(created).toISOString());
    if (text !== raw.savedText) await this.writeRawRequest(uri, raw, text);
  }
  private async commitReview(uri: vscode.Uri, loaded: Awaited<ReturnType<ReviewService['load']>>, text: string, origin: DecisionOrigin) {
    const next = this.projection(text, loaded.resolved.review.baseline);
    if (next.request.path !== loaded.resolved.request.path) throw new Error('A review cannot change its target path.');
    const target = await this.inspectTarget(uri, loaded.request.files[0]!, loaded.decisions);
    await this.assertRawRequest(uri, loaded);
    const journal: ReviewTransaction = {generation: loaded.generation, baseline: loaded.resolved.review.baseline,
      oldRequest: loaded.savedText, newRequest: text};
    await this.context.workspaceState.update(this.journalKey(uri), journal);
    try {
      await this.assertRawRequest(uri, loaded);
      const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === target.uri.toString());
      if (open?.isDirty || decode(await vscode.workspace.fs.readFile(target.uri)) !== target.expected) throw new Error('The original changed while preparing this action. Nothing was applied.');
      assertDecisionOrigin(origin);
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying changes.');
      if (next.review.expectedTarget !== target.expected) {
        await vscode.workspace.fs.writeFile(target.uri, Buffer.from(next.review.expectedTarget, 'utf8'));
        if (decode(await vscode.workspace.fs.readFile(target.uri)) !== next.review.expectedTarget) throw new Error('The original changed while applying this action.');
      }
      // Once the authorized source write commits, finish its matching status metadata.
      await this.writeRawRequest(uri, loaded, text);
      if (open?.isDirty || decode(await vscode.workspace.fs.readFile(target.uri)) !== next.review.expectedTarget) {
        throw new Error('The original changed while saving the review status.');
      }
      await this.context.workspaceState.update(this.baselineKey(uri, loaded.generation, next.review.identity), journal.baseline);
      await this.context.workspaceState.update(this.journalKey(uri), undefined);
    } catch (error) {
      // A write can commit and still reject. Reconcile exact known states without
      // rolling back or replaying original-file writes, then report actual outcome.
      const outcome = await this.recoverReview(uri).catch(() => undefined);
      if (outcome !== 'new') throw error;
    }
    return this.load(uri);
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The corresponding file "' + path.basename(file.path) + '" does not exist.');
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
    const configuredShortcut = vscode.workspace.getConfiguration('revisionRequest', uri).get<ReviewState['acceptShortcut']>('acceptShortcut', 'ctrlEnter');
    const base: ReviewState = {
      type: 'state', revision: '', title: 'Revision Request', requestName: path.basename(uri.fsPath),
      files: [], trusted: vscode.workspace.isTrusted, busy: this.busy, verified: false,
      unchangedOpacity: Math.max(0, Math.min(100, vscode.workspace.getConfiguration('revisionRequest', uri).get<number>('unchangedOpacity', 20))),
      highlightChangedLines: vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('highlightChangedLines', true),
      showOnlyChangedText: vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('showOnlyChangedText', false),
      acceptShortcut: ['ctrlEnter', 'altEnter', 'tab', 'shiftTab', 'none'].includes(configuredShortcut) ? configuredShortcut : 'ctrlEnter',
      defaultLayout: vscode.workspace.getConfiguration('revisionRequest', uri).get<unknown>('defaultLayout', 'unified') === 'sideBySide' ? 'sideBySide' : 'unified'
    };
    try {
      const raw = await this.readRequest(uri);
      base.revision = raw.fingerprint;
      base.requestIdentity = proposalIdentity(raw.request);
      base.closed = raw.request.request.length > 0 && raw.request.request.every(entry => entry.status !== 'pending');
      const needsPreparation = this.context.workspaceState.get(this.journalKey(uri)) !== undefined ||
        (raw.request.time === undefined && vscode.workspace.isTrusted);
      if (!this.busy && needsPreparation && this.attemptedPreparation.get(uri.toString()) !== raw.fingerprint) {
        // Queue metadata/recovery writes outside load; never enqueue recursively
        // from completion recording or the busy-state refresh inside an action.
        this.attemptedPreparation.set(uri.toString(), raw.fingerprint);
        await this.runExclusive(() => this.prepareReview(uri));
        this.attemptedPreparation.delete(uri.toString());
      }
      const loaded = await this.load(uri);
      const {request, fingerprint, decisions} = loaded;
      base.revision = fingerprint;
      base.title = request.title;
      base.requestIdentity = loaded.resolved.identity;
      base.closed = loaded.resolved.request.request.length > 0 && loaded.resolved.request.request.every(entry => entry.status !== 'pending');
      base.verified = true;
      for (const file of request.files) {
        let issue: string | undefined;
        let currentText: string | undefined;
        try {
          const target = await this.inspectTarget(uri, file, decisions);
          currentText = target.current;
          base.verifiedTargetHash = requestFingerprint(target.current);
        } catch (error) {
          issue = failure(error); base.verified = false; base.verificationIssue = issue;
          if (base.closed) {
            try { currentText = decode(await vscode.workspace.fs.readFile(await this.targetUri(uri, file))); } catch { /* A closed summary may have no current source. */ }
          }
        }
        const hunks = computeHunks(file);
        const bomLength = file.before.startsWith('\uFEFF') ? 1 : 0;
        const inlineChanges = includeInlineChanges ? computeFileInlineChanges(file, hunks, this.fileDecisions(file, decisions)) : undefined;
        base.files.push({
          path: file.path, before: file.before.slice(bomLength),
          currentText: currentText?.replace(/^\uFEFF/, ''), reason: file.reason, issue,
          hunks: hunks.map(hunk => {
            // An insertion after an unterminated final row needs a physical
            // separator, but its preview and editable draft contain only the new row.
            const preview = {...hunk, start: Math.max(0, hunk.start - bomLength), end: Math.max(0, hunk.end - bomLength),
              after: hunk.displayAfter ?? hunk.after};
            return {...preview,
              decision: decisions[keyFor(file.path, hunk.id)] ?? 'pending',
              explanation: loaded.resolved.request.request[loaded.resolved.review.entryIndexByHunkId[hunk.id]!]!.reason,
              inlineChanges: inlineChanges?.get(hunk.id)
            };
          })
        });
      }
    } catch (error) {
      if (error instanceof ResolutionError) {
        base.revision = error.revision;
        base.requestIdentity = proposalIdentity(error.request);
        base.closed = error.request.request.length > 0 && error.request.request.every(entry => entry.status !== 'pending');
      }
      base.verified = false; base.verificationIssue = failure(error);
      if (!base.closed) base.error = failure(error);
    }
    return base;
  }
  runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = async () => {
      this.busy = true;
      this.changed();
      try { return await action(); } finally { this.busy = false; this.emitter.fire(); }
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
  async decide(uri: vscode.Uri, filePath: string, hunkId: string | undefined, decision: 'accepted' | 'ignored', revision: string, origin: DecisionOrigin = 'user') {
    assertDecisionOrigin(origin);
    return this.runExclusive(async () => {
      assertDecisionOrigin(origin);
      await this.prepareReview(uri);
      if (decision !== 'accepted' && decision !== 'ignored') throw new Error('Invalid review decision.');
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before deciding.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const hunks = computeHunks(file);
      const selected = hunks.filter(hunk => (!hunkId || hunk.id === hunkId) &&
        (loaded.decisions[keyFor(file.path, hunk.id)] ?? 'pending') === 'pending');
      if (!selected.length) throw new Error('There are no pending changes for this action.');
      this.completionPrompts.delete(uri.toString());
      const next = {...loaded.decisions};
      for (const hunk of selected) next[keyFor(file.path, hunk.id)] = decision;
      const updates: Record<number, Decision> = {};
      for (const hunk of selected) updates[loaded.resolved.review.entryIndexByHunkId[hunk.id]!] = decision;
      const committed = await this.commitReview(uri, loaded, patchRequestStatuses(loaded.savedText, updates), origin);
      if (hunks.every(hunk => next[keyFor(file.path, hunk.id)] !== 'pending' && next[keyFor(file.path, hunk.id)] !== undefined)) {
        // Persist the final outcome before automatic cleanup clears decisions.
        try { await this.completionRecorder?.(uri, 'retained'); }
        catch (error) {
          void vscode.window.showWarningMessage('Review completed. The .rr request was kept because its completion record could not be saved: ' + failure(error));
          return;
        }
        if (origin === 'user' && hunkId === undefined &&
            !vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('skipCompletedDeleteConfirmation', false)) {
          const completionPrompt: CompletionPrompt = {completionId: randomUUID(), revision: committed.fingerprint, requestName: path.basename(uri.fsPath)};
          this.completionPrompts.set(uri.toString(), completionPrompt);
          return {completionPrompt};
        }
        await this.removeCompletedRequest(uri, committed.document, committed.fingerprint);
      }
    });
  }
  private completedReview(loaded: Awaited<ReturnType<ReviewService['load']>>) {
    const hunks = loaded.request.files.flatMap(file => computeHunks(file).map(hunk => ({file: file.path, id: hunk.id})));
    return hunks.length > 0 && hunks.every(hunk => {
      const decision = loaded.decisions[keyFor(hunk.file, hunk.id)];
      return decision === 'accepted' || decision === 'ignored';
    });
  }
  private async rememberCompletionChoice(uri: vscode.Uri, deleteRequest: boolean) {
    const settings = vscode.workspace.getConfiguration('revisionRequest', uri);
    const existing = [settings.inspect<boolean>('autoDeleteCompleted'), settings.inspect<boolean>('skipCompletedDeleteConfirmation')];
    const target = existing.some(value => value?.workspaceFolderValue !== undefined) ? vscode.ConfigurationTarget.WorkspaceFolder
      : existing.some(value => value?.workspaceValue !== undefined) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    // Write the choice first: never enable skipping while the previous choice remains.
    await settings.update('autoDeleteCompleted', deleteRequest, target);
    await settings.update('skipCompletedDeleteConfirmation', true, target);
  }
  async resolveCompletion(uri: vscode.Uri, completionId: string, revision: string, deleteRequest: boolean, rememberChoice: boolean) {
    if (typeof completionId !== 'string' || typeof revision !== 'string' || typeof deleteRequest !== 'boolean' || typeof rememberChoice !== 'boolean') {
      throw new Error('Invalid completed-request choice.');
    }
    return this.runExclusive(async () => {
      const prompt = this.completionPrompts.get(uri.toString());
      if (!prompt || prompt.completionId !== completionId || prompt.revision !== revision) {
        if (!deleteRequest) return {deleted: false};
        throw new Error('This deletion question is no longer current. The .rr request was kept.');
      }
      if (!deleteRequest) {
        // No/Escape must remain an escape route even if the request changed or vanished.
        if (rememberChoice) {
          let current = false;
          try {
            const loaded = await this.load(uri);
            current = loaded.fingerprint === revision && this.completedReview(loaded);
            if (current) await this.assertRequestUnchanged(uri, loaded.document, revision);
          } catch { current = false; }
          if (current) await this.rememberCompletionChoice(uri, false);
        }
        this.completionPrompts.delete(uri.toString());
        return {deleted: false};
      }
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before deleting a request.');
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision || !this.completedReview(loaded)) {
        throw new Error('The request changed or has pending changes. The .rr request was kept.');
      }
      await this.assertRequestUnchanged(uri, loaded.document, revision);
      if (rememberChoice) await this.rememberCompletionChoice(uri, true);
      await this.trashRequest(uri, true, async () => {
        const latest = await this.load(uri);
        if (latest.fingerprint !== revision || !this.completedReview(latest)) {
          throw new Error('The request changed or has pending changes. The .rr request was kept.');
        }
        await this.assertRequestUnchanged(uri, latest.document, revision);
      });
      return {deleted: true};
    });
  }
  async deleteRequest(uri: vscode.Uri) {
    // Explicit deletion also works for malformed JSON. It never creates a review receipt.
    return this.runExclusive(() => this.trashRequest(uri, false));
  }
  async undo(uri: vscode.Uri, filePath: string, hunkId: string, revision: string, origin: DecisionOrigin = 'user') {
    assertDecisionOrigin(origin);
    return this.runExclusive(async () => {
      assertDecisionOrigin(origin);
      if (typeof hunkId !== 'string' || !hunkId) throw new Error('Choose a specific change to undo.');
      await this.prepareReview(uri);
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
      const index = loaded.resolved.review.entryIndexByHunkId[hunk.id]!;
      await this.commitReview(uri, loaded, patchRequestStatuses(loaded.savedText, {[index]: 'pending'}), origin);
    });
  }
  /** Review-menu operations return a local draft; they do not save either file. */
  private async reviewActionContext(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof draft !== 'string' || typeof revision !== 'string') {
      throw new Error('Choose a pending change and provide its complete draft text.');
    }
    if (this.busy) throw new Error('Wait for the current review action to finish.');
    const loaded = await this.load(uri);
    if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before editing.');
    const file = loaded.request.files.find(item => item.path === filePath);
    if (!file) throw new Error('This file is not part of the request.');
    const hunks = computeHunks(file), hunk = hunks.find(item => item.id === hunkId);
    if (!hunk || (loaded.decisions[keyFor(file.path, hunk.id)] ?? 'pending') !== 'pending') {
      throw new Error('Only pending changes can be edited.');
    }
    const target = await this.inspectTarget(uri, file, loaded.decisions);
    // This validates Unicode, size, and entry boundaries without saving the draft.
    editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
    let start = hunk.start;
    for (const previous of hunks) {
      if (previous === hunk) break;
      if (loaded.decisions[keyFor(file.path, previous.id)] === 'accepted') start += previous.after.length - previous.before.length;
    }
    const input: ReviewActionInput = {path: file.path,
      before: hunk.before.replace(/\r\n|\r/g, '\n').replace(/\n$/, ''),
      after: draft.replace(/\r\n|\r/g, '\n'), prefix: target.current.slice(0, start).replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')};
    return {loaded, file, hunk, input, target};
  }
  private async actionAvailability(input: ReviewActionInput, targetUri: vscode.Uri) {
    const actions = getReviewActions(input);
    if (actions.some(action => action.id !== 'comment' && action.enabled)) {
      const rememberedRoot = this.context.workspaceState.get<string>('revisionRequest.macroRoot.' + targetUri.toString());
      const macros = await inspectReviewMacros(targetUri, rememberedRoot ? vscode.Uri.parse(rememberedRoot) : undefined);
      if (!macros.ready) for (const action of actions) {
        if (action.id !== 'comment' && action.enabled) {
          action.enabled = false;
          action.reason = (macros.reason || 'LaTeX review macros are not loaded.') + ' Use Set up LaTeX review macros, then Accept its import proposal.';
        }
      }
    }
    return actions;
  }
  async reviewActions(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    const context = await this.reviewActionContext(uri, filePath, hunkId, draft, revision);
    const actions = await this.actionAvailability(context.input, context.target.uri);
    await this.assertRawRequest(uri, context.loaded);
    return actions;
  }
  async transformDraft(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string, action: ReviewAction) {
    if (!['comment', 'markRemoved', 'markAdded'].includes(action)) throw new Error('Unknown proposal action.');
    const context = await this.reviewActionContext(uri, filePath, hunkId, draft, revision);
    const actions = await this.actionAvailability(context.input, context.target.uri);
    const selected = actions.find(item => item.id === action)!;
    if (!selected.enabled) throw new Error(selected.reason || 'This action is unavailable for this change.');
    const transformed = applyReviewAction(context.input, action);
    editPendingRequest(context.loaded.savedText, context.loaded.resolved.review.baseline, hunkId, transformed);
    await this.assertRawRequest(uri, context.loaded);
    return {draft: transformed, reviewActions: await this.actionAvailability({...context.input, after: transformed}, context.target.uri)};
  }
  /** Macro installation is explicit; the preamble change remains a pending RR entry. */
  async setupMacros(uri: vscode.Uri, filePath: string, extensionUri: vscode.Uri) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before setting up LaTeX review macros.');
    const loaded = await this.load(uri), file = loaded.request.files.find(item => item.path === filePath);
    if (!file || !/\.(?:tex|ltx)$/i.test(file.path)) throw new Error('Choose a LaTeX revision request.');
    const target = await this.targetUri(uri, file);
    let result: vscode.Uri | undefined;
    const root = await setupReviewMacros(target, extensionUri, async plan => {
      result = await this.queueMacroImport(uri, plan);
    });
    if (root) await this.context.workspaceState.update('revisionRequest.macroRoot.' + target.toString(), root.toString());
    return result;
  }
  async queueMacroImport(requestUri: vscode.Uri, plan: SetupImportPlan): Promise<vscode.Uri> {
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before preparing the import proposal.');
      const folder = vscode.workspace.getWorkspaceFolder(requestUri);
      if (!folder || plan.rootUri.scheme !== 'file' || !inside(folder.uri.fsPath, plan.rootUri.fsPath)) {
        throw new Error('The LaTeX root must be inside the request workspace.');
      }
      const relative = path.relative(folder.uri.fsPath, plan.rootUri.fsPath).split(path.sep).join('/');
      const active = await this.load(requestUri);
      const destination = active.resolved.request.path === relative ? requestUri : vscode.Uri.file(plan.rootUri.fsPath + '.rr');
      const targetUri = await this.targetUri(requestUri, {path: relative, before: '', after: ''});
      if (!Number.isSafeInteger(plan.line) || plan.line < 1 || plan.text !== '\\input{review-macro.tex}') throw new Error('Invalid macro import proposal.');
      const dirty = vscode.workspace.textDocuments.some(document => document.uri.toString() === targetUri.toString() && document.isDirty);
      if (dirty || decode(await vscode.workspace.fs.readFile(targetUri)) !== plan.original) throw new Error('The LaTeX root changed. Save it and try setup again.');
      let exists = true;
      try { await fs.lstat(destination.fsPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exists = false;
      }
      const entry = {line: plan.line, before: null, after: plan.text, reason: 'Load the shared LaTeX review markup commands.', status: 'pending' as const};
      if (exists) {
        await this.prepareReview(destination);
        const loaded = await this.load(destination);
        const file = loaded.request.files[0]!;
        const target = await this.inspectTarget(destination, file, loaded.decisions);
        if (file.path !== relative || target.current !== plan.original) throw new Error('The LaTeX root or its request changed. Review it before setup.');
        // Convert the current preamble line to the request's immutable original line.
        let shift = 0;
        for (const hunk of computeHunks(file)) {
          if (loaded.decisions[keyFor(file.path, hunk.id)] !== 'accepted') continue;
          const currentStart = hunk.oldStart + shift;
          if (plan.line <= currentStart) break;
          if (plan.line < currentStart + hunk.newLines) throw new Error('The import location is inside an accepted block. Undo that block or prepare the macros before creating this request.');
          shift += hunk.newLines - hunk.oldLines;
        }
        entry.line -= shift;
        if (loaded.resolved.request.request.some(item => item.before === null && item.after === entry.after && item.status === 'pending')) return destination;
        const request = {...loaded.resolved.request, request: [...loaded.resolved.request.request, entry]};
        const text = JSON.stringify(request, null, 2) + '\n';
        const review = resolveRequest(parseRequestDocument(text), target.current, loaded.resolved.review.baseline);
        if (review.expectedTarget !== target.current) throw new Error('Macro setup must preserve the original file.');
        await this.commitReview(destination, loaded, text, 'user');
      } else {
        const request: RevisionRequest = {path: relative, time: new Date().toISOString(), request: [entry]};
        const text = JSON.stringify(request, null, 2) + '\n';
        resolveRequest(parseRequestDocument(text), plan.original);
        const bytes = Buffer.from(text, 'utf8');
        const parent = path.dirname(destination.fsPath);
        const parentReal = await fs.realpath(parent);
        if (path.relative(parentReal, path.resolve(parent)) !== '') throw new Error('The import request destination cannot use symbolic links.');
        if (vscode.workspace.textDocuments.some(document => document.uri.toString() === targetUri.toString() && document.isDirty) ||
            decode(await vscode.workspace.fs.readFile(targetUri)) !== plan.original) throw new Error('The LaTeX root changed before creating the import proposal.');
        const handle = await fs.open(destination.fsPath, 'wx');
        const created = await handle.stat();
        let written: Awaited<ReturnType<typeof handle.stat>> | undefined;
        try {
          try { await handle.writeFile(bytes); } finally { written = await handle.stat(); await handle.close(); }
          if (path.relative(parentReal, await fs.realpath(parent)) !== '' ||
              vscode.workspace.textDocuments.some(document => document.uri.toString() === targetUri.toString() && document.isDirty) ||
              decode(await vscode.workspace.fs.readFile(targetUri)) !== plan.original) {
            throw new Error('The LaTeX root changed while preparing its import proposal.');
          }
        } catch (error) {
          // Remove only this creation, including a partial write, while preserving concurrent edits/replacements.
          try {
            const current = await fs.lstat(destination.fsPath), contents = await fs.readFile(destination.fsPath);
            if (written && current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino &&
                current.birthtimeMs === created.birthtimeMs && current.mtimeMs === written.mtimeMs && current.size === written.size &&
                contents.length <= bytes.length && bytes.subarray(0, contents.length).equals(contents)) {
              const final = await fs.lstat(destination.fsPath);
              if (final.dev === current.dev && final.ino === current.ino && final.birthtimeMs === current.birthtimeMs &&
                  final.mtimeMs === current.mtimeMs && final.size === current.size) await fs.unlink(destination.fsPath);
            }
          } catch { /* Keep any file whose identity is no longer certain. */ }
          throw error;
        }
      }
      return destination;
    });
  }
  async editPending(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof draft !== 'string' || typeof revision !== 'string') {
      throw new Error('Choose a pending change and provide its complete draft text.');
    }
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
      await this.prepareReview(uri);
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before editing.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const target = await this.inspectTarget(uri, file, loaded.decisions);
      const edited = editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
      await this.assertRawRequest(uri, loaded);
      if (!edited.changed) return {changed: false, revision: loaded.fingerprint};
      if (edited.review.expectedTarget !== target.expected) throw new Error('Editing a proposal must preserve accepted source content.');
      const committed = await this.commitReview(uri, loaded, edited.text, 'user');
      return {changed: true, revision: committed.fingerprint};
    });
  }
  async editAndAccept(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accepting a proposal.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof draft !== 'string' || typeof revision !== 'string') {
      throw new Error('Choose a pending change and provide its complete draft text.');
    }
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accepting a proposal.');
      await this.prepareReview(uri);
      const loaded = await this.load(uri);
      if (loaded.fingerprint !== revision) throw new Error('The request changed. Review its refreshed contents before accepting.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const target = await this.inspectTarget(uri, file, loaded.decisions);
      const edited = editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
      await this.assertRawRequest(uri, loaded);
      if (edited.review.expectedTarget !== target.expected) throw new Error('Editing a proposal must preserve accepted source content.');
      const index = loaded.resolved.review.entryIndexByHunkId[hunkId]!;
      // Returning to the original removes this entry. Never accept its shifted neighbor.
      const removed = edited.request.request.length < loaded.resolved.request.request.length;
      const text = removed ? edited.text : patchRequestStatuses(edited.text, {[index]: 'accepted'});
      this.completionPrompts.delete(uri.toString());
      // The draft and its decision share one source/RR journal and one guarded commit.
      const committed = await this.commitReview(uri, loaded, text, 'user');
      const result = {changed: true, revision: committed.fingerprint};
      if (this.completedReview(committed)) {
        try { await this.completionRecorder?.(uri, 'retained'); }
        catch (error) {
          void vscode.window.showWarningMessage('Review completed. The .rr request was kept because its completion record could not be saved: ' + failure(error));
          return result;
        }
        // This is an individual acceptance, so batch confirmation does not apply.
        await this.removeCompletedRequest(uri, committed.document, committed.fingerprint);
      }
      return result;
    });
  }
  private async inspectRequestDeletion(uri: vscode.Uri) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before deleting a request.');
    if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.rr') throw new Error('Choose a local .rr request.');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file' || !inside(folder.uri.fsPath, uri.fsPath)) throw new Error('The request must be inside an open local workspace.');
    const [root, realRequest, stat] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(uri.fsPath), fs.lstat(uri.fsPath)]);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(root, realRequest) ||
        [path.relative(root, realRequest), path.relative(folder.uri.fsPath, uri.fsPath)].some(relative => relative.split(path.sep).some(part => part.toLowerCase() === '.git'))) {
      throw new Error('Delete only a regular .rr file inside its workspace and outside Git metadata.');
    }
    const dirty = vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && document.isDirty &&
      path.resolve(document.uri.fsPath).toLowerCase() === path.resolve(uri.fsPath).toLowerCase());
    if (dirty) throw new Error('Save or undo unsaved .rr edits before deleting this request.');
    return {realRequest, stat};
  }
  private async trashRequest(uri: vscode.Uri, recordCompletion: boolean, guard?: () => Promise<void>) {
    const initial = await this.inspectRequestDeletion(uri);
    await guard?.();
    const latest = await this.inspectRequestDeletion(uri);
    if (initial.realRequest !== latest.realRequest || initial.stat.ino !== latest.stat.ino ||
        initial.stat.size !== latest.stat.size || initial.stat.mtimeMs !== latest.stat.mtimeMs) {
      throw new Error('The .rr request changed while preparing deletion, so it was kept.');
    }
    await vscode.workspace.fs.delete(uri, {recursive: false, useTrash: true});
    this.completionPrompts.delete(uri.toString());
    this.attemptedPreparation.delete(uri.toString());
    try {
      if (recordCompletion) await this.completionRecorder?.(uri, 'deleted');
    } finally {
      try {
        // The RR is definitively gone: retire every baseline generation and
        // recovery journal even if completion-receipt recording failed.
        const keys = [this.storageKey(uri), ...this.context.workspaceState.keys().filter(key => key.startsWith(this.reviewPrefix(uri)))];
        const cleanup = await Promise.allSettled(keys.map(key => this.context.workspaceState.update(key, undefined)));
        const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      } finally {
        const sourceTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
          !tab.isDirty && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
        try { if (sourceTabs.length) await vscode.window.tabGroups.close(sourceTabs, true); }
        finally { this.completed.fire(uri); }
      }
    }
  }
  private async removeCompletedRequest(uri: vscode.Uri, document: vscode.TextDocument, fingerprint: string) {
    if (!vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('autoDeleteCompleted', false)) return;
    try {
      await this.trashRequest(uri, true, async () => { await this.assertRequestUnchanged(uri, document, fingerprint); });
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

export class ReviewEditor implements vscode.Disposable, vscode.WebviewPanelSerializer {
  readyCount = 0;
  activeUri: vscode.Uri | undefined;
  private sourceOnlyUri: string | undefined;
  private sourceOnlyDocument: vscode.TextDocument | undefined;
  private activeSourceDocument: vscode.TextDocument | undefined;
  private autoPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly firstChangeRequested = new WeakSet<vscode.WebviewPanel>();
  private readonly seenSourceDocuments = new WeakSet<vscode.TextDocument>();
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly unboundPanels = new Set<vscode.WebviewPanel>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly quickReview = new Map<vscode.WebviewPanel, {ready: boolean; enabled: boolean; requested?: boolean; sent?: boolean}>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly service: ReviewService, private readonly snapshots: SnapshotProvider) {}
  dispose() {
    clearTimeout(this.autoPreviewTimer);
    for (const panel of this.panels.values()) panel.dispose();
    for (const panel of this.unboundPanels) panel.dispose();
  }
  private webviewOptions(): vscode.WebviewOptions {
    return {enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]};
  }
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    let uri: vscode.Uri | undefined;
    if (state && typeof state === 'object' && typeof (state as Record<string, unknown>).requestUri === 'string') {
      try {
        const candidate = vscode.Uri.parse((state as {requestUri: string}).requestUri, true);
        const folder = vscode.workspace.getWorkspaceFolder(candidate);
        if (candidate.scheme === 'file' && candidate.path.endsWith('.rr') && !candidate.query && !candidate.fragment &&
            folder?.uri.scheme === 'file') uri = candidate;
      } catch { /* Legacy or malformed state must never guess a request from its title. */ }
    }
    if (!uri) {
      panel.webview.options = {enableScripts: false, localResourceRoots: []};
      panel.webview.html = getReviewRestoreErrorHtml();
      this.unboundPanels.add(panel);
      if (panel.active) { this.activeUri = undefined; this.syncQuickReviewContext(); }
      const viewListener = panel.onDidChangeViewState(event => {
        if (event.webviewPanel.active) { this.activeUri = undefined; this.syncQuickReviewContext(); }
      });
      panel.onDidDispose(() => { this.unboundPanels.delete(panel); viewListener.dispose(); });
      return;
    }
    const existing = this.panels.get(uri.toString());
    if (existing && existing !== panel) {
      if (panel.active) existing.reveal(panel.viewColumn, false);
      panel.dispose();
      return;
    }
    panel.title = path.basename(uri.fsPath) + ' — Preview';
    panel.webview.options = this.webviewOptions();
    this.panels.set(uri.toString(), panel);
    if (panel.active) this.activeUri = uri;
    this.connect(uri, panel);
  }
  private activeReviewPanel(): [string, vscode.WebviewPanel] | undefined {
    if ([...this.unboundPanels].some(panel => panel.active)) return undefined;
    return [...this.panels].find(([, panel]) => panel.active);
  }
  private syncQuickReviewContext() {
    const panel = this.activeUri ? this.panels.get(this.activeUri.toString()) : undefined;
    void vscode.commands.executeCommand('setContext', 'revisionRequest.quickReviewActive', Boolean(panel && this.quickReview.get(panel)?.enabled));
  }
  private async deliverFirstChange(panel: vscode.WebviewPanel) {
    if (!this.quickReview.get(panel)?.ready || !this.firstChangeRequested.has(panel)) return;
    this.firstChangeRequested.delete(panel);
    await panel.webview.postMessage({type: 'revealFirstChange'});
  }
  private async deliverQuickReview(panel: vscode.WebviewPanel) {
    const mode = this.quickReview.get(panel);
    if (!mode?.ready || mode.requested === undefined) return;
    mode.sent = true;
    await panel.webview.postMessage({type: 'toggleQuickReview', enabled: mode.requested});
  }
  /** Sidebar focus does not change the last selected request. New previews start only after ready. */
  async toggleQuickReview(uri?: vscode.Uri): Promise<void> {
    let target = uri;
    if (!target && this.activeUri && this.panels.has(this.activeUri.toString())) target = this.activeUri;
    if (!target) target = (await vscode.window.showOpenDialog({
      title: 'Open a request for Quick Review', openLabel: 'Quick Review',
      filters: {'Revision Request': ['rr']}, canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
    }))?.[0];
    if (!target) return;
    if (target.scheme !== 'file' || !target.path.endsWith('.rr') || !vscode.workspace.getWorkspaceFolder(target)) {
      throw new Error('Choose a local .rr request inside an open workspace.');
    }
    const existing = this.panels.get(target.toString());
    // Sidebar focus can make the selected preview inactive without hiding it.
    // Return focus without treating a mode toggle as a fresh request opening.
    const selectedVisible = existing && (existing.active || (existing.visible && this.activeUri?.toString() === target.toString()));
    if (selectedVisible) {
      if (!existing.active) existing.reveal(existing.viewColumn, false);
    } else await this.openPreview(target);
    const panel = this.panels.get(target.toString());
    if (!panel) return;
    const mode = this.quickReview.get(panel)!;
    mode.requested = existing ? !(mode.requested ?? mode.enabled) : true;
    mode.sent = false;
    await this.deliverQuickReview(panel);
  }
  async toggleLayout(uri?: vscode.Uri): Promise<void> {
    const active = this.activeReviewPanel();
    if (!active || (uri && uri.scheme !== 'file' && uri.scheme !== 'webview-panel') ||
        (uri?.scheme === 'file' && uri.toString() !== active[0])) return;
    await active[1].webview.postMessage({type: 'toggleLayout'});
  }
  async openSource(uri?: vscode.Uri) {
    // Editor-title commands receive VS Code's virtual panel resource. The
    // active panel's bound request is the source, never that synthetic URI.
    const activePanel = uri?.scheme === 'webview-panel' ? this.activeReviewPanel() : undefined;
    const target = uri?.scheme === 'webview-panel' ? (activePanel ? vscode.Uri.parse(activePanel[0]) : undefined) : uri ?? this.activeUri;
    if (!target) return;
    if (target.scheme !== 'file' || !target.path.endsWith('.rr')) throw new Error('Choose a local .rr request.');
    this.suppressSource(target);
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
  private previewMode(uri: vscode.Uri): 'always' | 'once' | 'manual' {
    const config = vscode.workspace.getConfiguration('revisionRequest', uri);
    const explicit = (key: string) => {
      const value = config.inspect(key);
      return value && [value.globalValue, value.workspaceValue, value.workspaceFolderValue,
        value.globalLanguageValue, value.workspaceLanguageValue, value.workspaceFolderLanguageValue]
        .some(item => item !== undefined);
    };
    // Keep an explicitly chosen legacy workflow until the new setting is chosen.
    if (!explicit('previewMode') && explicit('previewOnOpen')) {
      return config.get<boolean>('previewOnOpen', true) ? 'once' : 'manual';
    }
    const mode = config.get<string>('previewMode', 'always');
    return mode === 'once' || mode === 'manual' ? mode : 'always';
  }
  private suppressSource(uri: vscode.Uri) {
    this.sourceOnlyUri = uri.toString();
    this.sourceOnlyDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === this.sourceOnlyUri);
  }
  autoPreview(editor: vscode.TextEditor | undefined) {
    clearTimeout(this.autoPreviewTimer);
    this.activeSourceDocument = editor?.document;
    // Undefined accompanies focus moving into a webview or transient editor
    // changes. It must not revoke an explicit Open RR as JSON escape.
    if (!editor) return;
    const document = editor.document, uri = document.uri;
    if (this.sourceOnlyUri !== uri.toString() || (this.sourceOnlyDocument && this.sourceOnlyDocument !== document)) {
      this.sourceOnlyUri = undefined;
      this.sourceOnlyDocument = undefined;
    }
    if (uri.scheme !== 'file' || !uri.path.endsWith('.rr')) return;
    if (this.sourceOnlyUri === uri.toString()) {
      this.sourceOnlyDocument = document;
      this.seenSourceDocuments.add(document);
      return;
    }
    // VS Code may activate the source before notifying that its preview closed.
    // Let that handoff finish before deciding whether to open another preview.
    this.autoPreviewTimer = setTimeout(() => {
      this.autoPreviewTimer = undefined;
      if (this.activeSourceDocument !== document || this.sourceOnlyUri === uri.toString()) return;
      const mode = this.previewMode(uri);
      if (mode === 'manual' || (mode === 'once' && this.seenSourceDocuments.has(document))) return;
      this.seenSourceDocuments.add(document);
      void this.openPreview(uri).catch(error => {
        this.seenSourceDocuments.delete(document);
        void vscode.window.showErrorMessage(failure(error));
      });
    }, 0);
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
    this.sourceOnlyDocument = undefined;
    const key = uri.toString();
    let panel = this.panels.get(key);
    try {
      if (!panel) {
        panel = vscode.window.createWebviewPanel(
          VIEW, path.basename(uri.fsPath) + ' — Preview',
          {viewColumn: vscode.ViewColumn.Active, preserveFocus: false},
          {...this.webviewOptions(), retainContextWhenHidden: true}
        );
        this.panels.set(key, panel);
        this.connect(uri, panel);
      }
      panel.reveal(panel.viewColumn, false);
      this.firstChangeRequested.add(panel);
      await this.deliverFirstChange(panel);
    } catch (error) {
      if (panel && this.panels.get(key) === panel) this.panels.delete(key);
      panel?.dispose();
      if (this.activeUri?.toString() === key) this.activeUri = undefined;
      throw error;
    }
  }
  private rememberSourceDocument(uri: vscode.Uri) {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString() === uri.toString()) this.seenSourceDocuments.add(document);
    }
  }
  private connect(uri: vscode.Uri, panel: vscode.WebviewPanel) {
    this.rememberSourceDocument(uri);
    this.quickReview.set(panel, {ready: false, enabled: false});
    this.syncQuickReviewContext();
    let generation = 0;
    let disposed = false;
    let actionError: string | undefined;
    let refreshRequested = false;
    let refreshTask: Promise<void> | undefined;
    let notifiedBusy = false;
    const update = (invalidate = true): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (invalidate) ++generation;
      if (this.service.busy) {
        refreshRequested = true;
        // Writes can emit several document and filesystem events. Keep the
        // verified rows visible until the transaction has finished.
        if (!notifiedBusy) {
          notifiedBusy = true;
          void panel.webview.postMessage({type: 'busy', busy: true});
        }
        return refreshTask ?? Promise.resolve();
      }
      if (refreshTask) {
        if (invalidate) refreshRequested = true;
        return refreshTask;
      }
      refreshRequested = true;
      refreshTask = Promise.resolve().then(async () => {
        try {
          while (refreshRequested && !disposed && !this.service.busy) {
            refreshRequested = false;
            const requested = generation;
            const state = await this.service.getState(uri);
            if (disposed || this.service.busy || requested !== generation) continue;
            this.rememberSourceDocument(uri);
            if (actionError) state.error = actionError;
            notifiedBusy = false;
            await panel.webview.postMessage(state);
          }
        } finally { refreshTask = undefined; }
      });
      return refreshTask;
    };
    const disposables = [
      this.service.onDidChange(() => { void update(); }),
      this.service.onDidDeleteRequest(deleted => {
        if (deleted.toString() === uri.toString()) {
          if (this.sourceOnlyUri === uri.toString()) this.sourceOnlyUri = undefined;
          panel.dispose();
        }
      }),
      panel.onDidChangeViewState(event => {
        if (event.webviewPanel.active) { this.activeUri = uri; this.syncQuickReviewContext(); }
      }),
      panel.webview.onDidReceiveMessage(async message => {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'quickReviewState') {
          if (typeof message.enabled !== 'boolean' || Object.keys(message).some(key => !['type', 'enabled', 'initial'].includes(key)) ||
              (message.initial !== undefined && (message.initial !== true || message.enabled !== false))) return;
          const mode = this.quickReview.get(panel);
          if (mode) {
            mode.enabled = message.enabled;
            if (message.initial === true) {
              // A reloaded webview starts disarmed. A sidebar request may have
              // reached its old context, so retain it for delivery after ready.
              mode.ready = false; mode.sent = false;
            } else if (mode.sent) { mode.requested = undefined; mode.sent = false; }
            if (this.activeUri?.toString() === uri.toString()) this.syncQuickReviewContext();
          }
          return;
        }
        if (message.type === 'reviewActions' || message.type === 'transformDraft') {
          const response = {type: message.type === 'transformDraft' ? 'transformResult' : 'reviewActionsResult', editId: message.editId};
          try {
            const allowed = ['type', 'filePath', 'hunkId', 'draft', 'revision', 'editId', ...(message.type === 'transformDraft' ? ['action'] : [])];
            if (typeof message.editId !== 'string' || Object.keys(message).some(key => !allowed.includes(key))) throw new Error('Invalid proposal menu action.');
            const result = message.type === 'transformDraft'
              ? await this.service.transformDraft(uri, message.filePath, message.hunkId, message.draft, message.revision, message.action)
              : {reviewActions: await this.service.reviewActions(uri, message.filePath, message.hunkId, message.draft, message.revision)};
            if (!disposed) await panel.webview.postMessage({...response, ...result});
          } catch (error) {
            if (!disposed) await panel.webview.postMessage({...response, error: failure(error)});
          }
          return; // A local draft must not trigger a preview refresh or any file write.
        }
        let editResult: Awaited<ReturnType<ReviewService['editPending']>> | undefined;
        let decisionResult: Awaited<ReturnType<ReviewService['decide']>>;
        let completionSucceeded = false;
        let quickDecisionSucceeded = false;
        try {
          actionError = undefined;
          switch (message.type) {
            case 'ready':
              this.readyCount++;
              this.quickReview.get(panel)!.ready = true;
              break;
            case 'decide':
            case 'decideFile':
              if (typeof message.filePath !== 'string' || typeof message.revision !== 'string' ||
                  (message.decision !== 'accepted' && message.decision !== 'ignored') ||
                  (message.type === 'decide' && typeof message.hunkId !== 'string') ||
                  (message.quickDecisionId !== undefined && (message.type !== 'decide' || typeof message.quickDecisionId !== 'string' ||
                    !message.quickDecisionId || message.quickDecisionId.length > 128))) throw new Error('Invalid review action.');
              decisionResult = await this.service.decide(uri, message.filePath, message.type === 'decide' ? message.hunkId : undefined, message.decision, message.revision);
              quickDecisionSucceeded = true;
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
            case 'editAndAccept':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' ||
                  typeof message.draft !== 'string' || typeof message.revision !== 'string' || typeof message.editId !== 'string' ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'draft', 'revision', 'editId'].includes(key))) {
                throw new Error('Invalid proposal acceptance.');
              }
              editResult = await this.service.editAndAccept(uri, message.filePath, message.hunkId, message.draft, message.revision);
              break;
            case 'ignoreEdited':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' || !message.hunkId ||
                  typeof message.revision !== 'string' || typeof message.editId !== 'string' ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'revision', 'editId'].includes(key))) {
                throw new Error('Invalid proposal ignore action.');
              }
              await this.service.decide(uri, message.filePath, message.hunkId, 'ignored', message.revision);
              editResult = {changed: true, revision: (await this.service.getState(uri, false)).revision};
              break;
            case 'resolveCompletion':
              await this.service.resolveCompletion(uri, message.completionId, message.revision, message.deleteRequest, message.rememberChoice);
              completionSucceeded = true;
              break;
            case 'setupReviewMacros': {
              if (typeof message.filePath !== 'string') throw new Error('Choose a LaTeX file from this request.');
              const prepared = await this.service.setupMacros(uri, message.filePath, this.context.extensionUri);
              if (prepared && prepared.toString() !== uri.toString()) await this.openPreview(prepared);
              break;
            }
            case 'deleteRequest': await this.service.deleteRequest(uri); break;
            case 'openTarget': await this.service.openTarget(uri, message.filePath, {preserveFocus: false}); break;
            case 'openSource': await this.openSource(uri); break;
            case 'openDiff': await this.openDiff(uri, message.filePath, message.revision); break;
            default: return;
          }
        } catch (error) { actionError = failure(error); }
        if (message.type === 'decide' && typeof message.quickDecisionId === 'string' && !disposed) {
          await panel.webview.postMessage({type: 'quickDecisionResult', quickDecisionId: message.quickDecisionId,
            filePath: message.filePath, hunkId: message.hunkId, decision: message.decision,
            success: quickDecisionSucceeded, error: actionError});
        }
        if (['editPending', 'editAndAccept', 'ignoreEdited'].includes(message.type) && !disposed) {
          await panel.webview.postMessage({type: 'editResult', editId: message.editId, filePath: message.filePath,
            hunkId: message.hunkId, success: editResult !== undefined, error: actionError, ...editResult});
          actionError = undefined; // The draft editor owns edit errors and keeps the draft.
        }
        if (message.type === 'setupReviewMacros' && !disposed) {
          await panel.webview.postMessage({type: 'macroSetupResult', error: actionError});
        }
        if (message.type === 'resolveCompletion' && !disposed) {
          await panel.webview.postMessage({type: 'completionResult', completionId: message.completionId, revision: message.revision,
            success: completionSucceeded, error: actionError});
          actionError = undefined;
        }
        // Actions join their final refresh; readiness and errors need a new delivery.
        await update(message.type === 'ready' || actionError !== undefined);
        if (message.type === 'ready' && !disposed) {
          await this.deliverFirstChange(panel);
          await this.deliverQuickReview(panel);
        }
        if (decisionResult?.completionPrompt && !disposed) {
          await panel.webview.postMessage({type: 'completionPrompt', ...decisionResult.completionPrompt});
        }
      })
    ];
    panel.onDidDispose(() => {
      this.rememberSourceDocument(uri);
      disposed = true;
      ++generation;
      if (this.panels.get(uri.toString()) === panel) {
        // Closing a preview may expose its source tab. Keep that viewing session
        // as JSON; a subsequent activation after switching away can open again.
        const hasSource = vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString());
        if (hasSource && (panel.active || this.activeSourceDocument?.uri.toString() === uri.toString() ||
            (!this.activeSourceDocument && this.activeUri?.toString() === uri.toString()))) this.suppressSource(uri);
        if (this.activeUri?.toString() === uri.toString()) this.activeUri = undefined;
        this.panels.delete(uri.toString());
      }
      this.quickReview.delete(panel);
      this.syncQuickReviewContext();
      disposables.forEach(item => item.dispose());
    });
    panel.webview.html = getReviewHtml(panel.webview, this.context.extensionUri, uri);
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
  let bridgeStartFailed = false;
  let diagnosticOutput: vscode.OutputChannel | undefined;
  let disposed = false;
  const localWorkspaces = () => vscode.workspace.isTrusted ? (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file').map(folder => ({uri: folder.uri.toString(), name: folder.name})) : [];
  const ensureBridge = async () => {
    if (!localWorkspaces().length) throw new Error('Open and trust a local workspace folder before connecting MCP.');
    if (bridge) return;
    if (!startingBridge) startingBridge = (async () => {
      installation = await installMcpAdapter(context.extensionPath, context.globalStorageUri.fsPath);
      bridge = await startMcpBridge({registryDir: installation.registryDir, workspaces: localWorkspaces, handler: mcpHost.handler});
      bridgeStartFailed = false;
      if (disposed) bridge.dispose();
    })().catch(error => { bridgeStartFailed = true; throw error; }).finally(() => { startingBridge = undefined; });
    await startingBridge;
  };
  const getMcpConfiguration = async (workspaceUri?: vscode.Uri) => {
    const folders = localWorkspaces();
    const selected = workspaceUri ? folders.find(folder => folder.uri === workspaceUri.toString()) : folders.length === 1 ? folders[0] : undefined;
    if (!selected) throw new Error('Choose one explicitly opened local workspace for the MCP configuration.');
    await ensureBridge();
    return {...createMcpConfiguration({runtime: process.execPath, ...installation!, workspaceUri: selected.uri}), instanceId: bridge!.instanceId};
  };
  const getMcpDiagnostics = async (workspaceUri?: vscode.Uri) => {
    // Include untrusted folders: diagnostics must explain why the bridge is unavailable.
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const selected = workspaceUri ? folders.find(folder => folder.uri.toString() === workspaceUri.toString()) : folders.length === 1 ? folders[0] : undefined;
    const manifest = context.extension.packageJSON as {version: string; main: string};
    const directory = path.join(context.globalStorageUri.fsPath, 'mcp');
    return collectMcpDiagnostics({extensionVersion: manifest.version,
      workspace: selected ? {name: selected.name, uri: selected.uri.toString()} : undefined,
      trusted: vscode.workspace.isTrusted, adapterPath: path.join(directory, 'rr-mcp.cjs'),
      bundledAdapterPath: path.join(context.extensionPath, path.dirname(manifest.main), 'mcp-server.cjs'),
      registryDir: path.join(directory, 'instances'), bridgeInstanceId: bridge?.instanceId,
      bridgeStarting: !!startingBridge, bridgeStartFailed});
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
    {dispose: () => {disposed = true; bridge?.dispose(); diagnosticOutput?.dispose();}},
    vscode.window.registerWebviewPanelSerializer(VIEW, editor),
    vscode.window.onDidChangeActiveTextEditor(active => editor.autoPreview(active)),
    vscode.workspace.registerTextDocumentContentProvider('rr-snapshot', snapshots),
    // A separate empty view keeps its welcome action visible even when requests exist.
    vscode.window.createTreeView('revisionRequest.create', {treeDataProvider: {
      getChildren: () => [],
      getTreeItem: () => new vscode.TreeItem('Create Revision Request')
    }}),
    vscode.window.createTreeView('revisionRequest.requests', {treeDataProvider: tree}),
    requests.onDidCreate(changed), requests.onDidDelete(changed), requests.onDidChange(changed),
    targets.onDidChange(changed), targets.onDidDelete(changed),
    vscode.workspace.onDidChangeTextDocument(event => changed(event.document.uri)),
    vscode.workspace.onDidSaveTextDocument(document => changed(document.uri)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {service.changed(); publishWorkspaces();}),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('revisionRequest.unchangedOpacity') ||
          event.affectsConfiguration('revisionRequest.highlightChangedLines') ||
          event.affectsConfiguration('revisionRequest.showOnlyChangedText') ||
          event.affectsConfiguration('revisionRequest.defaultLayout') ||
          event.affectsConfiguration('revisionRequest.acceptShortcut')) service.changed();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {tree.refresh(); service.changed(); publishWorkspaces();}),
    vscode.commands.registerCommand('revisionRequest.diagnoseMcp', async (workspaceUri?: vscode.Uri) => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      if (!workspaceUri && folders.length > 1) {
        const selected = await vscode.window.showQuickPick(folders.map(folder => ({label: folder.name,
          description: folder.uri.fsPath, uri: folder.uri})), {placeHolder: 'Choose the workspace to diagnose'});
        if (!selected) return;
        workspaceUri = selected.uri;
      }
      const report = await getMcpDiagnostics(workspaceUri);
      diagnosticOutput ??= vscode.window.createOutputChannel('Revision Request MCP');
      diagnosticOutput.clear();
      diagnosticOutput.appendLine(formatMcpDiagnostics(report));
      diagnosticOutput.show(true);
      return report;
    }),
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
    vscode.commands.registerCommand('revisionRequest.createRequest', async () => {
      try {
        const created = await createRequestFromFiles(context.extensionUri, action => service.runExclusive(action),
          (uri, original) => service.rememberGitOriginal(uri, original));
        if (!created) return;
        tree.refresh();
        if (created.fromGit) {
          const choice = await vscode.window.showInformationMessage(
            'Created ' + path.basename(created.uri.fsPath) + ' from a Git commit. Review it against a file matching that commit.',
            'Open RR as JSON');
          if (choice === 'Open RR as JSON') await editor.openSource(created.uri);
        } else await editor.openPreview(created.uri);
      } catch (error) { void vscode.window.showErrorMessage(failure(error)); }
    }),
    vscode.commands.registerCommand('revisionRequest.setupReviewMacros', async () => {
      try {
        const active = vscode.window.activeTextEditor?.document.uri;
        const uri = active?.path.endsWith('.rr') ? active : editor.activeUri;
        if (!uri) throw new Error('Open a LaTeX revision request before setting up its review macros.');
        const state = await service.getState(uri);
        const file = state.files[0];
        if (!file) throw new Error(state.error || 'Open a valid LaTeX revision request.');
        const prepared = await service.setupMacros(uri, file.path, context.extensionUri);
        if (prepared) {tree.refresh(); await editor.openPreview(prepared);}
      } catch (error) { void vscode.window.showErrorMessage(failure(error)); }
    }),
    ...['revisionRequest.toggleQuickReview', 'revisionRequest.enableQuickReview', 'revisionRequest.disableQuickReview'].map(command =>
      vscode.commands.registerCommand(command, async () => {
        try { await editor.toggleQuickReview(); }
        catch (error) { void vscode.window.showErrorMessage(failure(error)); }
      })),
    vscode.commands.registerCommand('revisionRequest.refresh', () => {tree.refresh(); service.changed(true);}),
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
    vscode.commands.registerCommand('revisionRequest.toggleLayout', (uri?: vscode.Uri) => editor.toggleLayout(uri)),
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
    getMcpDiagnostics,
    mcpHandler: mcpHost.handler,
    ...(context.extensionMode === vscode.ExtensionMode.Test ? {
      testRunExclusive: <T>(action: () => Promise<T>) => service.runExclusive(action),
      testFailNextRequestWriteAfterSave: () => {failNextRequestWriteAfterSave = true;},
      testRestorePreview: (panel: vscode.WebviewPanel, state: unknown) => editor.deserializeWebviewPanel(panel, state),
      resolveCompletion: (uri: vscode.Uri, completionId: string, revision: string, deleteRequest: boolean, rememberChoice: boolean) =>
        service.resolveCompletion(uri, completionId, revision, deleteRequest, rememberChoice),
      deleteRequest: (uri: vscode.Uri) => service.deleteRequest(uri),
      editPending: (uri: vscode.Uri, file: string, hunk: string, draft: string, revision: string) =>
        service.editPending(uri, file, hunk, draft, revision),
      editAndAccept: (uri: vscode.Uri, file: string, hunk: string, draft: string, revision: string) =>
        service.editAndAccept(uri, file, hunk, draft, revision)
    } : {}),
    getState: (uri: vscode.Uri) => service.getState(uri),
    decide: (uri: vscode.Uri, file: string, hunk: string | undefined, decision: 'accepted' | 'ignored', revision: string) =>
      service.decide(uri, file, hunk, decision, revision),
    undo: (uri: vscode.Uri, file: string, hunk: string, revision: string) =>
      service.undo(uri, file, hunk, revision)
  };
}
export function deactivate() {}
