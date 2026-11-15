import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import {constants as fsConstants, type BigIntStats} from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { computeHunks, computeFileInlineChanges, renderAccepted, requestFingerprint, type Decision, type RequestFile, type InlineChangeLine } from './core';
import { getReviewHtml, getReviewRestoreErrorHtml } from './webview';
import { captureLatexPdfView, resolveLatexPdfView, focusLatexPdfView } from './latexNavigation';
import { createTrackedReview, rebaseTrackedReview, reconfigureTrackedReview, transitionTrackedReview, projectTrackedReview, validateTrackedReview, type TrackedReview } from './reviewRebase';
import { parseRequestDocument, proposalIdentity, resolveRequest, patchRequestStatuses, editPendingRequest, ensureRequestTime, type RevisionRequest } from './request';
import { McpHost } from './mcpHost';
import { startMcpBridge } from './mcpBridge';
import { installMcpAdapter, createMcpConfiguration } from './mcpSetup';
import { createRequestFromFiles } from './createRequestCommand';
import { readGitOriginal, validateGitOriginalTarget, type GitOriginal } from './gitOriginal';
import { collectMcpDiagnostics, formatMcpDiagnostics } from './mcpDiagnostics';
import { applyReviewAction, getReviewActions, type ReviewAction, type ReviewActionInput } from './reviewActions';
import type {CompiledReviewPdf, ImportedPdfReview, LatexReviewPdfInput, PdfReviewAnchor, PdfReviewManifest, PdfReviewState, PdfGenerationProgress, PdfGenerationResult, PdfCompilationProgressReporter} from './pdfReviewTypes';

export interface PdfReviewTools {
  compile(input: LatexReviewPdfInput, onProgress?: PdfCompilationProgressReporter): Promise<CompiledReviewPdf>;
  create(pdf: Uint8Array, manifest: PdfReviewManifest, anchors: PdfReviewAnchor[]): Promise<Uint8Array>;
  read(bytes: Uint8Array): Promise<ImportedPdfReview>;
}
const pdfReviewTools: PdfReviewTools = {
  compile: async (input, onProgress) => (require('./latexReviewPdf') as typeof import('./latexReviewPdf')).generateLatexReviewPdf(input, onProgress),
  create: async (pdf, manifest, anchors) => (require('./portableReviewPdf') as typeof import('./portableReviewPdf')).createPortableReviewPdf(pdf, manifest, anchors),
  read: async bytes => (require('./portableReviewPdf') as typeof import('./portableReviewPdf')).readPortableReviewPdf(bytes),
};
async function confirmPdfBuild(requestName: string, targetPath: string, replacing: boolean): Promise<boolean> {
  const detail = 'Request: ' + requestName + '\nSource: ' + targetPath + '\n\n' +
    'This runs the proposed LaTeX using local tools. Only continue if you trust the source and proposed changes.' +
    (replacing ? '\n\nThe existing review PDF will be replaced and its saved review decisions discarded.' : '');
  return await vscode.window.showWarningMessage('Build this review PDF?', {modal: true, detail}, 'Build PDF') === 'Build PDF';
}
interface PdfExportRecord {
  manifest: PdfReviewManifest; generation: string; warnings: string[];
  application?: {decisions: Record<string, Decision>; sourceHash: string; requestHash: string};
}

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
  oldTracking?: TrackedReview; newTracking?: TrackedReview;
}
class ResolutionError extends Error {
  constructor(readonly request: RevisionRequest, readonly revision: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
interface ReviewFile {
  path: string; before: string; currentText?: string; reason?: string; issue?: string;
  hunks: (ReturnType<typeof computeHunks>[number] & {decision: Decision; explanation?: string; inlineChanges?: InlineChangeLine[]; conflict?: string; undoBlocked?: string})[];
}
export interface ReviewState {
  type: 'state'; revision: string; rawRevision?: string; title: string; description?: string;
  requestName: string; files: ReviewFile[]; trusted: boolean; busy: boolean; unchangedOpacity: number;
  highlightChangedLines: boolean; showOnlyChangedText: boolean; defaultLayout: 'unified' | 'sideBySide'; error?: string;
  acceptShortcut: 'ctrlEnter' | 'altEnter' | 'tab' | 'shiftTab' | 'none';
  requestIdentity?: string; verified: boolean;
  verificationIssue?: string; verifiedTargetHash?: string; closed?: boolean; pdfReview?: PdfReviewState;
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

const MAX_REVIEW_PDF_BYTES = 50 * 1024 * 1024;
const pdfStamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
function checkPdfFile(stat: BigIntStats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('The companion PDF must be a regular, unlinked file.');
  if (stat.size > BigInt(MAX_REVIEW_PDF_BYTES)) throw new Error('The review PDF exceeds the 50 MiB size limit.');
}
async function readBoundedPdf(filename: string, expected?: BigIntStats): Promise<Buffer> {
  const before = expected ?? await fs.lstat(filename, {bigint: true});
  checkPdfFile(before);
  // Never follow a substituted symlink, allocate from a growing file, or trust
  // metadata from a different inode than the one whose bytes were imported.
  const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({bigint: true}); checkPdfFile(opened);
    if (pdfStamp(opened) !== pdfStamp(before)) throw new Error('The companion PDF changed while opening. Import it again.');
    const buffer = Buffer.alloc(Number(opened.size) + 1); let used = 0;
    while (used < buffer.length) {
      const {bytesRead} = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({bigint: true}), current = await fs.lstat(filename, {bigint: true});
    checkPdfFile(after); checkPdfFile(current);
    if (used !== Number(opened.size) || pdfStamp(after) !== pdfStamp(opened) || pdfStamp(current) !== pdfStamp(opened)) {
      throw new Error('The companion PDF changed while reading. Import it again.');
    }
    return buffer.subarray(0, used);
  } finally {await handle.close();}
}

export class ReviewService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly completed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidDeleteRequest = this.completed.event;
  private readonly pdfProgress = new vscode.EventEmitter<{uri: vscode.Uri; progress: PdfGenerationProgress | null}>();
  readonly onDidChangePdfGeneration = this.pdfProgress.event;
  private readonly pdfFinished = new vscode.EventEmitter<{uri: vscode.Uri} & PdfGenerationResult>();
  readonly onDidFinishPdfGeneration = this.pdfFinished.event;
  private readonly pdfGenerations = new Map<string, PdfGenerationProgress>();
  getPdfGenerationProgress(uri: vscode.Uri): PdfGenerationProgress | undefined {
    const progress = this.pdfGenerations.get(uri.toString());
    return progress ? {...progress} : undefined;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private readonly trackingQueues = new Map<string, Promise<unknown>>();
  private readonly completionPrompts = new Map<string, CompletionPrompt>();
  private readonly attemptedPreparation = new Map<string, string>();
  // Cache pure parsing/resolution only. Every action still rereads and checks both files.
  private readonly parsedRequests: {text: string; request: RevisionRequest}[] = [];
  private readonly resolvedRequests: {request: RevisionRequest; baseline: string; review: ReturnType<typeof resolveRequest>}[] = [];
  private readonly pdfImports = new Map<string, {stamp: string; review: ImportedPdfReview}>();
  busy = false;
  private completionRecorder?: (uri: vscode.Uri, cleanup: 'retained' | 'deleted' | 'failed') => Promise<void>;
  setCompletionRecorder(recorder: (uri: vscode.Uri, cleanup: 'retained' | 'deleted' | 'failed') => Promise<void>) {
    this.completionRecorder = recorder;
  }
  private readonly watchedTargets = new Set<string>();
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly writeRequest: (uri: vscode.Uri, bytes: Uint8Array) => Thenable<void> = (uri, bytes) => vscode.workspace.fs.writeFile(uri, bytes),
    private readonly pdfTools: PdfReviewTools = pdfReviewTools,
    private readonly confirmBuild: typeof confirmPdfBuild = confirmPdfBuild,
  ) {}
  dispose() { this.pdfImports.clear(); this.pdfGenerations.clear(); this.parsedRequests.length = 0; this.resolvedRequests.length = 0; this.emitter.dispose(); this.completed.dispose(); this.pdfProgress.dispose(); this.pdfFinished.dispose(); }
  changed(retryPreparation = false) { if (retryPreparation || !this.busy) this.attemptedPreparation.clear(); this.emitter.fire(); }
  isTarget(uri: vscode.Uri) { return this.watchedTargets.has(uri.toString()); }
  private storageKey(uri: vscode.Uri) {
    return 'review.' + createHash('sha256').update(uri.toString()).digest('hex');
  }
  private parseReviewRequest(text: string): RevisionRequest {
    const cached = this.parsedRequests.find(item => item.text === text);
    if (cached) return cached.request;
    const request = parseRequestDocument(text);
    this.parsedRequests.unshift({text, request});
    this.parsedRequests.length = Math.min(2, this.parsedRequests.length);
    return request;
  }
  private resolveReview(request: RevisionRequest, current: string, baseline?: string) {
    // Current text was decoded strictly from disk, but its size must still be
    // checked on cache hits just as resolveRequest checks it on cache misses.
    if (Buffer.byteLength(current, 'utf8') > 5 * 1024 * 1024) throw new Error('Current original exceeds the text size limit.');
    const cached = baseline === undefined ? undefined : this.resolvedRequests.find(item => item.request === request && item.baseline === baseline);
    if (cached) return cached.review;
    const review = resolveRequest(request, current, baseline);
    this.resolvedRequests.unshift({request, baseline: review.baseline, review});
    this.resolvedRequests.length = Math.min(2, this.resolvedRequests.length);
    return review;
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
    if (requestStat.nlink !== 1) throw new Error('The request must not have hard links; review an independent .rr file.');
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
    try { request = this.parseReviewRequest(text); }
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
  private trackingKey(uri: vscode.Uri, generation: string, identity: string) {
    return this.reviewPrefix(uri) + 'source.' + requestFingerprint(generation) + '.' + identity;
  }
  private withTracking<T>(uri: vscode.Uri, action: () => Promise<T>): Promise<T> {
    const key = uri.toString(), previous = this.trackingQueues.get(key) ?? Promise.resolve();
    const task = previous.then(action, action);
    this.trackingQueues.set(key, task);
    void task.finally(() => { if (this.trackingQueues.get(key) === task) this.trackingQueues.delete(key); }).catch(() => undefined);
    return task;
  }
  private trackedRevision(rawRevision: string, tracking?: TrackedReview) {
    return tracking ? requestFingerprint(rawRevision + '\n' + JSON.stringify(tracking)) : rawRevision;
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
    // Discard a speculative live-file snapshot read before the Git origin was registered.
    await this.context.workspaceState.update(this.trackingKey(uri, raw.generation, proposalIdentity(raw.request)), undefined);
    await this.context.workspaceState.update(this.gitOriginalKey(uri, raw.generation), {
      path: raw.request.path, hash: requestFingerprint(baseline), commit: selection.commit
    });
  }
  private load(uri: vscode.Uri) { return this.withTracking(uri, () => this.loadReview(uri)); }
  private async loadReview(uri: vscode.Uri) {
    const raw = await this.readRequest(uri);
    const request = raw.request;
    try {
      if (this.context.workspaceState.get(this.journalKey(uri))) throw new Error('A review action needs to finish before the source can be refreshed.');
      const identity = proposalIdentity(request);
      const key = this.baselineKey(uri, raw.generation, identity);
      const sourceKey = this.trackingKey(uri, raw.generation, identity);
      const gitOriginal = this.context.workspaceState.get<{path: string; hash: string; commit: string}>(this.gitOriginalKey(uri, raw.generation));
      let cached = this.context.workspaceState.get<string>(key);
      if (gitOriginal && cached !== undefined && requestFingerprint(requestModelText(cached)) !== gitOriginal.hash) cached = undefined;
      const target = await this.targetUri(uri, {path: request.path, before: '', after: ''});
      const current = decode(await vscode.workspace.fs.readFile(target));
      const review = this.resolveReview(request, current, cached);
      if (gitOriginal && (gitOriginal.path !== request.path || requestFingerprint(requestModelText(review.baseline)) !== gitOriginal.hash)) {
        throw new Error('This request uses Git commit ' + gitOriginal.commit.slice(0, 8) +
          ' as its original. Review it in a workspace whose target matches that version.');
      }
      const savedTracking = this.context.workspaceState.get<TrackedReview>(sourceKey);
      let tracking: TrackedReview | undefined;
      let trackingChanged = false;
      const dirty = vscode.workspace.textDocuments.some(document => document.uri.toString() === target.toString() && document.isDirty);
      if (savedTracking !== undefined) {
        tracking = validateTrackedReview(savedTracking);
        const originalHunks = new Map(review.hunks.map(hunk => [hunk.id, hunk]));
        if (tracking.path !== request.path || tracking.entries.length !== review.hunks.length || tracking.entries.some(entry => {
          const hunk = originalHunks.get(entry.hunk.id);
          return !hunk || hunk.before !== entry.hunk.before || hunk.after !== entry.hunk.after ||
            hunk.start !== entry.hunk.start || hunk.end !== entry.hunk.end || hunk.index !== entry.hunk.index ||
            hunk.oldStart !== entry.hunk.oldStart || hunk.oldLines !== entry.hunk.oldLines || hunk.newLines !== entry.hunk.newLines ||
            review.decisions[hunk.id] !== entry.decision;
        })) throw new Error('The stored request statuses or proposals do not match this review. Create a fresh request.');
        if (!dirty && tracking.text !== current) {
          tracking = rebaseTrackedReview(tracking, current);
          trackingChanged = true;
        }
      } else if (!dirty && current === review.expectedTarget) {
        // First establish an exact local baseline. Unknown/imported mismatches are never relocated.
        tracking = createTrackedReview(review.file, review.decisions);
        trackingChanged = true;
      }
      await this.assertRawRequest(uri, raw);
      if (decode(await vscode.workspace.fs.readFile(target)) !== current) throw new Error('The original changed while refreshing this review. Try again.');
      if (cached === undefined) await this.context.workspaceState.update(key, review.baseline);
      if (tracking && trackingChanged) await this.context.workspaceState.update(sourceKey, tracking);
      const decisions: Decisions = {};
      for (const [hunk, decision] of Object.entries(review.decisions)) decisions[keyFor(request.path, hunk)] = decision;
      return {...raw, revision: this.trackedRevision(raw.fingerprint, tracking), tracking,
        request: {title: path.basename(request.path), files: [review.file]}, decisions,
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
    const request = this.parseReviewRequest(text);
    return {request, review: this.resolveReview(request, '', baseline)};
  }
  private recoverReview(uri: vscode.Uri): Promise<'old' | 'new' | undefined> {
    return this.withTracking(uri, () => this.recoverReviewUnlocked(uri));
  }
  private async recoverReviewUnlocked(uri: vscode.Uri): Promise<'old' | 'new' | undefined> {
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
    const oldTracking = journal.oldTracking && validateTrackedReview(journal.oldTracking);
    const newTracking = journal.newTracking && validateTrackedReview(journal.newTracking);
    const matchesOld = current === (oldTracking?.text ?? old.review.expectedTarget);
    const matchesNew = current === (newTracking?.text ?? next.review.expectedTarget);
    if (!matchesOld && !matchesNew) throw new Error('An interrupted review conflicts with newer original contents. The files were kept unchanged.');
    // Recovery only reconciles metadata with the saved source; it NEVER writes the original.
    const outcome = matchesNew && (!matchesOld || raw.savedText === journal.newRequest) ? 'new' : 'old';
    const chosen = outcome === 'new' ? next : old;
    const text = outcome === 'new' ? journal.newRequest : journal.oldRequest;
    const tracking = outcome === 'new' ? newTracking : oldTracking;
    if (text !== raw.savedText) {
      await this.assertRawRequest(uri, raw);
      if (decode(await vscode.workspace.fs.readFile(target)) !== current || open?.isDirty) throw new Error('The original changed during recovery.');
      await this.writeRawRequest(uri, raw, text);
    }
    if (decode(await vscode.workspace.fs.readFile(target)) !== (tracking?.text ?? chosen.review.expectedTarget) || open?.isDirty) {
      throw new Error('The original changed during recovery.');
    }
    await this.context.workspaceState.update(this.baselineKey(uri, journal.generation, chosen.review.identity), journal.baseline);
    if (tracking) await this.context.workspaceState.update(this.trackingKey(uri, journal.generation, chosen.review.identity), tracking);
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
  private commitReview(uri: vscode.Uri, loaded: Awaited<ReturnType<ReviewService['load']>>, text: string, origin: DecisionOrigin, editedHunkId?: string) {
    return this.withTracking(uri, async () => {
      const next = this.projection(text, loaded.resolved.review.baseline);
      if (next.request.path !== loaded.resolved.request.path) throw new Error('A review cannot change its target path.');
      const target = await this.inspectTarget(uri, loaded.request.files[0]!, loaded.decisions, loaded.tracking);
      await this.assertRawRequest(uri, loaded);
      const oldTracking = loaded.tracking ?? createTrackedReview(loaded.resolved.review.file, loaded.resolved.review.decisions);
      const oldEntries = loaded.resolved.review.entryIndexByHunkId;
      const removedIndex = editedHunkId && next.request.request.length < loaded.resolved.request.request.length ? oldEntries[editedHunkId] : undefined;
      const oldByIndex = new Map(Object.entries(oldEntries).map(([id, index]) => [index, id]));
      const mappings: Record<string, string> = {};
      for (const hunk of next.review.hunks) {
        const index = next.review.entryIndexByHunkId[hunk.id]!;
        const prior = oldByIndex.get(removedIndex !== undefined && index >= removedIndex ? index + 1 : index);
        if (prior) mappings[hunk.id] = prior;
      }
      const newTracking = reconfigureTrackedReview(oldTracking, next.review.file, next.review.decisions, mappings);
      const journal: ReviewTransaction = {generation: loaded.generation, baseline: loaded.resolved.review.baseline,
        oldRequest: loaded.savedText, newRequest: text, oldTracking, newTracking};
      await this.context.workspaceState.update(this.journalKey(uri), journal);
      try {
        await this.assertRawRequest(uri, loaded);
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === target.uri.toString());
        if (open?.isDirty || decode(await vscode.workspace.fs.readFile(target.uri)) !== target.expected) throw new Error('The original changed while preparing this action. Nothing was applied.');
        assertDecisionOrigin(origin);
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying changes.');
        if (newTracking.text !== target.expected) {
          await vscode.workspace.fs.writeFile(target.uri, Buffer.from(newTracking.text, 'utf8'));
          if (decode(await vscode.workspace.fs.readFile(target.uri)) !== newTracking.text) throw new Error('The original changed while applying this action.');
        }
        await this.writeRawRequest(uri, loaded, text);
        if (open?.isDirty || decode(await vscode.workspace.fs.readFile(target.uri)) !== newTracking.text) throw new Error('The original changed while saving the review status.');
        const baselineKey = this.baselineKey(uri, loaded.generation, next.review.identity);
        if (this.context.workspaceState.get<string>(baselineKey) !== journal.baseline) {
          await this.context.workspaceState.update(baselineKey, journal.baseline);
        }
        await this.context.workspaceState.update(this.trackingKey(uri, loaded.generation, next.review.identity), newTracking);
        await this.context.workspaceState.update(this.journalKey(uri), undefined);
      } catch (error) {
        const outcome = await this.recoverReviewUnlocked(uri).catch(() => undefined);
        if (outcome !== 'new') throw error;
      }
      return this.loadReview(uri);
    });
  }

  private pdfExportKey(uri: vscode.Uri) { return this.reviewPrefix(uri) + 'pdf-export'; }
  private pdfFileKey(filename: string) { return process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename); }
  // A delayed watcher event must not discard a newer explicit import.
  // getState and Apply compare metadata before using the cached snapshot.
  pdfChanged(_uri: vscode.Uri) { this.changed(); }
  private async companionPdfInfo(uri: vscode.Uri): Promise<{filename: string; parent: string; stat?: BigIntStats; stamp?: string}> {
    const filename = uri.fsPath + '.pdf';
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || !folder || folder.uri.scheme !== 'file') throw new Error('PDF review requires a local workspace.');
    const root = await fs.realpath(folder.uri.fsPath), parent = await fs.realpath(path.dirname(filename));
    if (!inside(root, parent) || path.relative(root, parent).split(path.sep).some(part => part.toLowerCase() === '.git')) {
      throw new Error('The companion PDF must stay inside this workspace.');
    }
    let stat;
    try { stat = await fs.lstat(filename, {bigint: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {this.pdfImports.delete(this.pdfFileKey(filename)); return {filename, parent};} throw error; }
    checkPdfFile(stat);
    return {filename, parent, stat, stamp: pdfStamp(stat)};
  }
  private async companionPdf(uri: vscode.Uri): Promise<{filename: string; bytes?: Buffer; hash?: string; stamp?: string}> {
    const {filename, parent, stat, stamp} = await this.companionPdfInfo(uri);
    if (!stat) return {filename};
    const bytes = await readBoundedPdf(filename, stat);
    if (await fs.realpath(path.dirname(filename)) !== parent) throw new Error('The companion PDF location changed while reading. Import it again.');
    return {filename, bytes, stamp, hash: createHash('sha256').update(bytes).digest('hex')};
  }
  private async pdfReview(uri: vscode.Uri, loaded?: Awaited<ReturnType<ReviewService['load']>>, force = false) {
    const state: PdfReviewState = {supported: /\.(?:tex|ltx|latex)\.rr$/i.test(uri.fsPath),
      available: false, filename: path.basename(uri.fsPath) + '.pdf'};
    let imported: ImportedPdfReview | undefined, record: PdfExportRecord | undefined, stamp: string | undefined;
    const key = this.pdfFileKey(uri.fsPath + '.pdf');
    state.imported = false; state.canApply = false;
    try {
      const info = await this.companionPdfInfo(uri);
      state.available = info.stat !== undefined;
      if (!info.stat) return {state};
      stamp = info.stamp;
      if (force) {
        const companion = await this.companionPdf(uri);
        if (!companion.bytes || !companion.hash || companion.stamp !== stamp) throw new Error('The PDF changed while opening. Import it again.');
        imported = await this.pdfTools.read(companion.bytes);
        if (imported.pdfHash !== companion.hash || (await this.companionPdfInfo(uri)).stamp !== stamp) {
          throw new Error('The PDF changed while its review data was read. Import it again.');
        }
      } else {
        const snapshot = this.pdfImports.get(key);
        if (!snapshot || snapshot.stamp !== stamp) {
          this.pdfImports.delete(key);
          return {state};
        }
        imported = snapshot.review;
      }
      state.imported = true;
      state.pdfHash = imported.pdfHash;
      state.pending = Object.values(imported.decisions).filter(value => value === 'pending').length;
      state.accepted = Object.values(imported.decisions).filter(value => value === 'accepted').length;
      state.ignored = Object.values(imported.decisions).filter(value => value === 'ignored').length;
      record = this.context.workspaceState.get<PdfExportRecord>(this.pdfExportKey(uri));
      if (!record || JSON.stringify(record.manifest) !== JSON.stringify(imported.manifest)) {
        throw new Error('This PDF does not match a review exported from this request. Keep the original .rr and generate a new review PDF.');
      }
      state.warnings = record.warnings;
      if (!loaded) throw new Error('The request and original must be verified before importing PDF decisions.');
      if (loaded.generation !== record.generation || loaded.resolved.identity !== record.manifest.proposalIdentity) {
        throw new Error('The request changed since this PDF was generated. Generate a new review PDF.');
      }
      const target = await this.inspectTarget(uri, loaded.request.files[0]!, loaded.decisions, loaded.tracking);
      const sourceHash = requestFingerprint(target.current);
      const application = record.application;
      const sameDecisions = (a: Record<string, Decision>, b: Record<string, Decision>) =>
        Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(id => a[id] === b[id]);
      if (application && application.requestHash === loaded.fingerprint && application.sourceHash === sourceHash) {
        if (!sameDecisions(application.decisions, imported.decisions)) throw new Error('This PDF has different decisions from the review already applied. The original was kept unchanged.');
        state.applied = true; state.canApply = false;
        return {state, imported, record, stamp};
      }
      if (sourceHash !== record.manifest.sourceHash || loaded.resolved.request.request.some((entry, index) =>
          entry.status !== record!.manifest.request.request[index]?.status)) {
        throw new Error('The original or local review decisions changed since this PDF was generated. Generate a new review PDF.');
      }
      if (loaded.tracking?.entries.some(entry => entry.decision === 'pending' && entry.conflict)) {
        throw new Error('Resolve pending source conflicts before using PDF review.');
      }
      const ids = record.manifest.entries.map(entry => entry.id);
      if (!ids.length || Object.keys(imported.decisions).length !== ids.length || ids.some(id =>
          !['pending', 'accepted', 'ignored'].includes(imported!.decisions[id]!))) {
        throw new Error('The PDF review decisions are incomplete or invalid.');
      }
      state.applied = false;
      state.canApply = state.pending === 0 && vscode.workspace.isTrusted;
    } catch (error) { this.pdfImports.delete(key); state.imported = false; state.error = failure(error); state.canApply = false; }
    return {state, imported, record, stamp};
  }
  async generateReviewPdf(uri: vscode.Uri, revision: string, replace = false) {
    return this.runExclusive(async () => {
      const startedAt = Date.now(), key = uri.toString();
      const report: PdfCompilationProgressReporter = progress => {
        const current = {...progress, startedAt};
        this.pdfGenerations.set(key, current);
        this.pdfProgress.fire({uri, progress: {...current}});
      };
      let result: PdfGenerationResult = {outcome: 'failed'};
      report({stage: 'preparing', message: 'Checking request and source…'});
      try {
        result = {outcome: await this.generateReviewPdfNow(uri, revision, replace, report)};
      } catch (error) {
        result = {outcome: 'failed', error: failure(error)};
        throw error;
      } finally {
        this.pdfGenerations.delete(key);
        this.pdfProgress.fire({uri, progress: null});
        this.pdfFinished.fire({uri, ...result});
      }
    });
  }
  private async generateReviewPdfNow(uri: vscode.Uri, revision: string, replace: boolean,
    report: PdfCompilationProgressReporter): Promise<'created' | 'cancelled'> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before generating a review PDF.');
    await this.prepareReview(uri);
    const loaded = await this.load(uri);
    if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before generating a PDF.');
    if (!/\.(?:tex|ltx|latex)$/i.test(loaded.resolved.request.path)) throw new Error('Review PDF generation currently supports LaTeX files.');
    const file = loaded.request.files[0]!;
    const tracking = loaded.tracking ?? createTrackedReview(file, loaded.resolved.review.decisions);
    const entries = tracking.entries.filter(entry => entry.decision === 'pending')
      .sort((a, b) => a.start - b.start || loaded.resolved.review.entryIndexByHunkId[a.hunk.id]! - loaded.resolved.review.entryIndexByHunkId[b.hunk.id]!);
    if (!entries.length) throw new Error('There are no pending changes to export.');
    if (entries.some(entry => entry.conflict)) throw new Error('Resolve pending source conflicts before generating a review PDF.');
    const target = await this.inspectTarget(uri, file, loaded.decisions, tracking);
    const prior = await this.companionPdf(uri);
    if (prior.bytes && !replace) throw new Error('A review PDF already exists. Use Generate PDF from RR to confirm replacing it.');
    report({stage: 'confirming', message: 'Waiting for PDF build confirmation…'});
    if (!await this.confirmBuild(path.basename(uri.fsPath), loaded.resolved.request.path, prior.bytes !== undefined)) return 'cancelled';
    report({stage: 'preparing', message: 'Preparing the LaTeX review…'});
    // Consent applies only to the exact request/source the user was shown.
    // The prompt can stay open while files or workspace trust change.
    await this.assertRawRequest(uri, loaded);
    const confirmedTarget = await this.inspectTarget(uri, file, loaded.decisions, tracking);
    if (confirmedTarget.current !== target.current || !vscode.workspace.isTrusted) {
      throw new Error('The source or workspace trust changed before PDF generation. Nothing was compiled.');
    }
    if ((await this.companionPdf(uri)).hash !== prior.hash) {
      throw new Error('The companion PDF changed before generation. Its saved review was kept.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri)!;
    if (!this.context.globalStorageUri || !['file', 'vscode-userdata'].includes(this.context.globalStorageUri.scheme) ||
        !path.isAbsolute(this.context.globalStorageUri.fsPath)) throw new Error('Local extension storage is required to compile a review PDF.');
    const storage = path.resolve(this.context.globalStorageUri.fsPath, '.codex-pdf-review');
    const outputDirectory = path.join(storage, randomUUID());
    const manifest: PdfReviewManifest = {format: 'revision-request-pdf', formatVersion: 1, exportId: randomUUID(),
      createdAt: new Date().toISOString(), path: loaded.resolved.request.path, proposalIdentity: loaded.resolved.identity,
      sourceHash: requestFingerprint(target.current), request: loaded.resolved.request,
      entries: entries.map(entry => { const index = loaded.resolved.review.entryIndexByHunkId[entry.hunk.id]!;
        return {id: entry.hunk.id, index, originalDecision: entry.decision, reason: loaded.resolved.request.request[index]!.reason}; })};
    await fs.mkdir(outputDirectory, {recursive: true});
    try {
      const compiled = await this.pdfTools.compile({workspaceRoot: folder.uri.fsPath, targetPath: target.uri.fsPath,
        source: target.current, outputDirectory,
        entries: entries.map(entry => { const index = loaded.resolved.review.entryIndexByHunkId[entry.hunk.id]!;
          return {id: entry.hunk.id, index, start: entry.start, end: entry.end,
            before: target.current.slice(entry.start, entry.end), after: entry.hunk.after,
            reason: loaded.resolved.request.request[index]!.reason}; })}, report);
      report({stage: 'annotating', message: 'Adding review buttons to the PDF…'});
      const bytes = await this.pdfTools.create(compiled.pdf, manifest, compiled.anchors);
      if (bytes.length > 50 * 1024 * 1024) throw new Error('The generated PDF exceeds the 50 MiB size limit.');
      await this.assertRawRequest(uri, loaded);
      const current = await this.inspectTarget(uri, file, loaded.decisions, tracking);
      if (current.current !== target.current || !vscode.workspace.isTrusted) throw new Error('The source or workspace trust changed during PDF generation. Nothing was exported.');
      const latest = await this.companionPdf(uri);
      if (latest.hash !== prior.hash) throw new Error('The companion PDF changed during generation. Its saved review was kept.');
      const key = this.pdfExportKey(uri), previous = this.context.workspaceState.get<PdfExportRecord>(key);
      const record: PdfExportRecord = {manifest, generation: loaded.generation, warnings: compiled.warnings};
      // Sibling staging keeps displacement and exclusive installation on one
      // filesystem even when extension storage is on another disk. No source
      // or persistent project configuration is changed by this transaction.
      report({stage: 'saving', message: 'Saving the review PDF…'});
      const stageParent = path.dirname(latest.filename);
      const stageDirectory = path.join(stageParent, '.codex-pdf-review-' + randomUUID());
      await fs.mkdir(stageDirectory);
      let retainStage = false;
      try {
        const staged = path.join(stageDirectory, 'review.pdf');
        await fs.writeFile(staged, bytes, {flag: 'wx'});
        await this.assertRawRequest(uri, loaded);
        await this.inspectTarget(uri, file, loaded.decisions, tracking);
        if ((await this.companionPdf(uri)).hash !== prior.hash || !vscode.workspace.isTrusted) {
          throw new Error('The companion PDF or workspace trust changed before export. Its saved review was kept.');
        }
        await this.context.workspaceState.update(key, record);
        const displaced = path.join(stageDirectory, 'previous.pdf');
        let hasDisplaced = false;
        try {
          await this.assertRawRequest(uri, loaded);
          await this.inspectTarget(uri, file, loaded.decisions, tracking);
          if ((await this.companionPdf(uri)).hash !== prior.hash || !vscode.workspace.isTrusted) {
            throw new Error('The companion PDF or workspace trust changed before export. Its saved review was kept.');
          }
          if (prior.bytes) {
            // Verify the exact file displaced, closing the final check/rename
            // race. A returned review arriving at the live path is never replaced.
            await fs.rename(latest.filename, displaced);
            hasDisplaced = true;
            const moved = await fs.lstat(displaced, {bigint: true});
            if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1n || moved.size > BigInt(MAX_REVIEW_PDF_BYTES) ||
                createHash('sha256').update(await readBoundedPdf(displaced, moved)).digest('hex') !== prior.hash) {
              throw new Error('The companion PDF was replaced during export. Its returned review was preserved.');
            }
          }
          // Atomic exclusive installation also refuses a PDF copied into the
          // gap after displacement. Rename-overwrite would silently lose it.
          await fs.link(staged, latest.filename);
        } catch (error) {
          let detail = failure(error);
          if (hasDisplaced) {
            try {
              const moved = await fs.lstat(displaced);
              if (!moved.isFile() || moved.isSymbolicLink()) throw new Error('The displaced companion is not a regular file.');
              await fs.link(displaced, latest.filename); // never overwrite an arriving review
            } catch {
              retainStage = true;
              detail += ' The displaced PDF was kept at "' + displaced + '" because its original path is occupied or cannot be restored.';
            }
          }
          try { await this.context.workspaceState.update(key, previous); }
          catch (restoreError) { detail += ' Export metadata could not be restored: ' + failure(restoreError); }
          throw new Error(detail);
        }
      } finally {
        if (!retainStage && path.dirname(path.resolve(stageDirectory)) === stageParent) await fs.rm(stageDirectory, {recursive: true, force: true}).catch(() => undefined);
      }
      this.pdfImports.delete(this.pdfFileKey(uri.fsPath + '.pdf'));
      return 'created';
    } finally {
      // This UUID directory is owned by this operation, outside the source project.
      if (path.dirname(path.resolve(outputDirectory)) === storage) await fs.rm(outputDirectory, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  async importPdfReview(uri: vscode.Uri, revision: string) {
    return this.runExclusive(async () => {
      const key = this.pdfFileKey(uri.fsPath + '.pdf');
      this.pdfImports.delete(key);
      const loaded = await this.load(uri);
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before importing.');
      const result = await this.pdfReview(uri, loaded, true);
      if (result.state.error) throw new Error(result.state.error);
      if (!result.state.available || !result.imported || !result.stamp) throw new Error('No companion review PDF was found.');
      this.pdfImports.set(key, {stamp: result.stamp, review: result.imported});
      while (this.pdfImports.size > 2) this.pdfImports.delete(this.pdfImports.keys().next().value!);
      return result.state;
    });
  }
  async applyPdfReview(uri: vscode.Uri, revision: string, pdfHash: string) {
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying PDF decisions.');
      await this.prepareReview(uri);
      const loaded = await this.load(uri);
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before applying PDF decisions.');
      const key = this.pdfFileKey(uri.fsPath + '.pdf'), snapshot = this.pdfImports.get(key);
      if (!snapshot || snapshot.review.pdfHash !== pdfHash || (await this.companionPdfInfo(uri)).stamp !== snapshot.stamp) {
        this.pdfImports.delete(key);
        throw new Error('The review PDF changed or has not been imported. Import its latest decisions before applying.');
      }
      const result = await this.pdfReview(uri, loaded, true);
      if (result.state.error) throw new Error(result.state.error);
      if (!result.state.available || !result.imported || !result.record || result.state.pdfHash !== pdfHash) {
        throw new Error('The review PDF changed. Import its latest decisions before applying.');
      }
      if (result.state.applied) return;
      if (!result.state.canApply) throw new Error('Complete every PDF decision before applying the reviewed changes.');
      const {imported, record} = result;
      const updates: Record<number, Decision> = {}, changes: Record<string, Decision> = {};
      for (const entry of record.manifest.entries) {
        updates[entry.index] = imported.decisions[entry.id]!;
        changes[entry.id] = imported.decisions[entry.id]!;
      }
      const text = patchRequestStatuses(loaded.savedText, updates);
      const tracking = loaded.tracking ?? createTrackedReview(loaded.resolved.review.file, loaded.resolved.review.decisions);
      const next = transitionTrackedReview(tracking, changes);
      // Persist an exact receipt before the transaction: recovery can recognize a
      // committed result after a crash without applying the source a second time.
      await this.context.workspaceState.update(this.pdfExportKey(uri), {...record, application: {
        decisions: imported.decisions, sourceHash: requestFingerprint(next.text), requestHash: requestFingerprint(text)}} satisfies PdfExportRecord);
      if ((await this.companionPdf(uri)).hash !== pdfHash) throw new Error('The review PDF changed before applying. Import its latest decisions first.');
      this.completionPrompts.delete(uri.toString());
      const committed = await this.commitReview(uri, loaded, text, 'user');
      const completionPrompt = await this.finishCompletedReview(uri, committed, 'user');
      if (completionPrompt) return {completionPrompt};
    });
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
    if (stat.nlink !== 1) throw new Error('The target must not have hard links; review an independent source file.');
    if (stat.size > 20 * 1024 * 1024) throw new Error('The target is too large for this review.');
    const uri = vscode.Uri.file(candidate);
    this.watchedTargets.add(uri.toString());
    return uri;
  }
  private async inspectTarget(requestUri: vscode.Uri, file: RequestFile, decisions: Decisions, tracking?: TrackedReview) {
    if (file.before.startsWith('\uFEFF') !== file.after.startsWith('\uFEFF')) {
      throw new Error('Keep the original UTF-8 BOM unchanged in the proposal.');
    }
    const uri = await this.targetUri(requestUri, file);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open?.isDirty) throw new Error('This file has unsaved edits. Save or undo them before accepting a proposal.');
    const expected = tracking?.text ?? renderAccepted(file.before, computeHunks(file), this.fileDecisions(file, decisions));
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
      base.revision = raw.fingerprint; base.rawRevision = raw.fingerprint;
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
      base.revision = loaded.revision; base.rawRevision = fingerprint;
      base.title = request.title;
      base.requestIdentity = loaded.resolved.identity;
      base.closed = loaded.resolved.request.request.length > 0 && loaded.resolved.request.request.every(entry => entry.status !== 'pending');
      base.verified = true;
      base.pdfReview = (await this.pdfReview(uri, loaded)).state;
      for (const file of request.files) {
        const display = loaded.tracking ? projectTrackedReview(loaded.tracking).file : file;
        let issue: string | undefined;
        let currentText: string | undefined;
        try {
          const target = await this.inspectTarget(uri, file, decisions, loaded.tracking);
          currentText = target.current;
          base.verifiedTargetHash = requestFingerprint(target.current);
        } catch (error) {
          issue = failure(error); base.verified = false; base.verificationIssue = issue;
          if (base.closed) {
            try { currentText = decode(await vscode.workspace.fs.readFile(await this.targetUri(uri, file))); } catch { /* A closed summary may have no current source. */ }
          }
        }
        const hunks = computeHunks(display);
        const trackedEntries = new Map(loaded.tracking?.entries.map(entry => [entry.hunk.id, entry]));
        const bomLength = display.before.startsWith('\uFEFF') ? 1 : 0;
        const inlineChanges = includeInlineChanges ? computeFileInlineChanges(display, hunks, this.fileDecisions(file, decisions)) : undefined;
        base.files.push({
          path: file.path, before: display.before.slice(bomLength),
          currentText: currentText?.replace(/^\uFEFF/, ''), reason: file.reason, issue,
          hunks: hunks.map(hunk => {
            // An insertion after an unterminated final row needs a physical
            // separator, but its preview and editable draft contain only the new row.
            const preview = {...hunk, start: Math.max(0, hunk.start - bomLength), end: Math.max(0, hunk.end - bomLength),
              after: hunk.displayAfter ?? hunk.after};
            return {...preview,
              decision: decisions[keyFor(file.path, hunk.id)] ?? 'pending',
              conflict: trackedEntries.get(hunk.id)?.conflict,
              undoBlocked: trackedEntries.get(hunk.id)?.undoBlocked,
              explanation: loaded.resolved.request.request[loaded.resolved.review.entryIndexByHunkId[hunk.id]!]!.reason,
              inlineChanges: inlineChanges?.get(hunk.id)
            };
          })
        });
      }
    } catch (error) {
      if (error instanceof ResolutionError) {
        base.revision = error.revision; base.rawRevision = error.revision;
        base.requestIdentity = proposalIdentity(error.request);
        base.closed = error.request.request.length > 0 && error.request.request.every(entry => entry.status !== 'pending');
      }
      base.pdfReview = (await this.pdfReview(uri)).state;
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
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before deciding.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const hunks = computeHunks(file);
      const selected = hunks.filter(hunk => (!hunkId || hunk.id === hunkId) &&
        (loaded.decisions[keyFor(file.path, hunk.id)] ?? 'pending') === 'pending');
      if (!selected.length) throw new Error('There are no pending changes for this action.');
      this.completionPrompts.delete(uri.toString());
      const updates: Record<number, Decision> = {};
      for (const hunk of selected) updates[loaded.resolved.review.entryIndexByHunkId[hunk.id]!] = decision;
      const committed = await this.commitReview(uri, loaded, patchRequestStatuses(loaded.savedText, updates), origin);
      const completionPrompt = await this.finishCompletedReview(uri, committed, origin);
      if (completionPrompt) return {completionPrompt};
    });
  }
  async acceptThrough(uri: vscode.Uri, filePath: string, hunkId: string, revision: string, draft?: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accepting proposals.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof revision !== 'string' ||
        (draft !== undefined && typeof draft !== 'string')) throw new Error('Choose a pending change to accept up to.');
    return this.runExclusive(async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accepting proposals.');
      await this.prepareReview(uri);
      const loaded = await this.load(uri);
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before accepting.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      // Use the same current source order as the preview, not JSON array order.
      const hunks = (loaded.tracking ? projectTrackedReview(loaded.tracking).hunks : computeHunks(file))
        .slice().sort((a, b) => a.start - b.start || a.index - b.index);
      const through = hunks.findIndex(hunk => hunk.id === hunkId);
      if (through < 0 || loaded.decisions[keyFor(file.path, hunkId)] !== 'pending') {
        throw new Error('Choose a pending change to accept up to.');
      }
      const selected = hunks.slice(0, through + 1).filter(hunk => loaded.decisions[keyFor(file.path, hunk.id)] === 'pending');
      const selectedIds = new Set(selected.map(hunk => hunk.id));
      const conflict = loaded.tracking?.entries.find(entry => selectedIds.has(entry.hunk.id) && entry.conflict)?.conflict;
      if (conflict) throw new Error(conflict);
      await this.inspectTarget(uri, file, loaded.decisions, loaded.tracking);
      let text = loaded.savedText;
      const anchorIndex = loaded.resolved.review.entryIndexByHunkId[hunkId]!;
      let removed = false;
      if (draft !== undefined) {
        const edited = editPendingRequest(text, loaded.resolved.review.baseline, hunkId, draft);
        if (edited.review.expectedTarget !== loaded.resolved.review.expectedTarget) throw new Error('Editing a proposal must preserve accepted source content.');
        text = edited.text;
        removed = edited.request.request.length < loaded.resolved.request.request.length;
      }
      const updates: Record<number, Decision> = {};
      for (const hunk of selected) {
        const index = loaded.resolved.review.entryIndexByHunkId[hunk.id]!;
        if (removed && index === anchorIndex) continue;
        updates[removed && index > anchorIndex ? index - 1 : index] = 'accepted';
      }
      text = patchRequestStatuses(text, updates);
      this.completionPrompts.delete(uri.toString());
      // One guarded source/RR transaction preserves partial decisions and external edits.
      const committed = await this.commitReview(uri, loaded, text, 'user', draft === undefined ? undefined : hunkId);
      const completionPrompt = await this.finishCompletedReview(uri, committed, 'user');
      return {changed: true, revision: committed.revision, completionPrompt};
    });
  }
  private completedReview(loaded: Awaited<ReturnType<ReviewService['load']>>) {
    const hunks = loaded.request.files.flatMap(file => computeHunks(file).map(hunk => ({file: file.path, id: hunk.id})));
    // An accepted draft restored to the original can remove the final entry.
    // Completion prompts are created only after a successful pending action.
    return hunks.every(hunk => {
      const decision = loaded.decisions[keyFor(hunk.file, hunk.id)];
      return decision === 'accepted' || decision === 'ignored';
    });
  }
  private async finishCompletedReview(uri: vscode.Uri, committed: Awaited<ReturnType<ReviewService['commitReview']>>, origin: DecisionOrigin): Promise<CompletionPrompt | undefined> {
    if (!this.completedReview(committed)) return;
    // Persist the final outcome before prompting or automatic cleanup clears decisions.
    try { await this.completionRecorder?.(uri, 'retained'); }
    catch (error) {
      void vscode.window.showWarningMessage('Review completed. The .rr request was kept because its completion record could not be saved: ' + failure(error));
      return;
    }
    if (origin === 'user' &&
        !vscode.workspace.getConfiguration('revisionRequest', uri).get<boolean>('skipCompletedDeleteConfirmation', false)) {
      const completionPrompt: CompletionPrompt = {completionId: randomUUID(), revision: committed.revision, requestName: path.basename(uri.fsPath)};
      this.completionPrompts.set(uri.toString(), completionPrompt);
      return completionPrompt;
    }
    await this.removeCompletedRequest(uri, committed.document, committed.fingerprint);
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
            current = loaded.revision === revision && this.completedReview(loaded);
            if (current) await this.assertRequestUnchanged(uri, loaded.document, loaded.fingerprint);
          } catch { current = false; }
          if (current) await this.rememberCompletionChoice(uri, false);
        }
        this.completionPrompts.delete(uri.toString());
        return {deleted: false};
      }
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before deleting a request.');
      const loaded = await this.load(uri);
      if (loaded.revision !== revision || !this.completedReview(loaded)) {
        throw new Error('The request changed or has pending changes. The .rr request was kept.');
      }
      await this.assertRequestUnchanged(uri, loaded.document, loaded.fingerprint);
      if (rememberChoice) await this.rememberCompletionChoice(uri, true);
      await this.trashRequest(uri, true, async () => {
        const latest = await this.load(uri);
        if (latest.revision !== revision || !this.completedReview(latest)) {
          throw new Error('The request changed or has pending changes. The .rr request was kept.');
        }
        await this.assertRequestUnchanged(uri, latest.document, latest.fingerprint);
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
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before undoing.');
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
  async undoFile(uri: vscode.Uri, filePath: string, revision: string, origin: DecisionOrigin = 'user') {
    assertDecisionOrigin(origin);
    if (typeof filePath !== 'string' || !filePath || typeof revision !== 'string' || !revision) {
      throw new Error('Choose a request file to return to pending.');
    }
    return this.runExclusive(async () => {
      assertDecisionOrigin(origin);
      await this.prepareReview(uri);
      const loaded = await this.load(uri);
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before undoing.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      const selected = computeHunks(file).filter(hunk => {
        const previous = loaded.decisions[keyFor(file.path, hunk.id)];
        return previous === 'accepted' || previous === 'ignored';
      });
      if (!selected.length) throw new Error('There are no accepted or ignored changes to return to pending.');
      const selectedIds = new Set(selected.map(hunk => hunk.id));
      const blocked = loaded.tracking?.entries.find(entry => selectedIds.has(entry.hunk.id) && entry.undoBlocked)?.undoBlocked;
      if (blocked) throw new Error(blocked);
      const updates: Record<number, Decision> = {};
      for (const hunk of selected) updates[loaded.resolved.review.entryIndexByHunkId[hunk.id]!] = 'pending';
      // Restore every decision with one guarded source/RR transaction. A conflict
      // must not leave a partly reset request, and reopening is not completion.
      await this.commitReview(uri, loaded, patchRequestStatuses(loaded.savedText, updates), origin);
      this.completionPrompts.delete(uri.toString());
    });
  }
  private assertEditable(loaded: Awaited<ReturnType<ReviewService['load']>>, hunkId: string) {
    const entry = loaded.tracking?.entries.find(item => item.hunk.id === hunkId);
    if (entry?.conflict) throw new Error(entry.conflict);
  }
  /** Review-menu operations return a local draft; they do not save either file. */
  private async reviewActionContext(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing a proposal.');
    if (typeof filePath !== 'string' || typeof hunkId !== 'string' || !hunkId || typeof draft !== 'string' || typeof revision !== 'string') {
      throw new Error('Choose a pending change and provide its complete draft text.');
    }
    if (this.busy) throw new Error('Wait for the current review action to finish.');
    const loaded = await this.load(uri);
    if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before editing.');
    const file = loaded.request.files.find(item => item.path === filePath);
    if (!file) throw new Error('This file is not part of the request.');
    const hunks = computeHunks(file), hunk = hunks.find(item => item.id === hunkId);
    if (!hunk || (loaded.decisions[keyFor(file.path, hunk.id)] ?? 'pending') !== 'pending') {
      throw new Error('Only pending changes can be edited.');
    }
    this.assertEditable(loaded, hunkId);
    const target = await this.inspectTarget(uri, file, loaded.decisions, loaded.tracking);
    // This validates Unicode, size, and entry boundaries without saving the draft.
    editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
    const start = loaded.tracking?.entries.find(item => item.hunk.id === hunkId)?.start ?? hunk.start;
    const input: ReviewActionInput = {path: file.path, hasOriginal: hunk.end > hunk.start, hasProposed: hunk.newLines > 0,
      before: hunk.before.replace(/\r\n|\r/g, '\n').replace(/\n$/, ''),
      after: draft.replace(/\r\n|\r/g, '\n'), prefix: target.current.slice(0, start).replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')};
    return {loaded, file, hunk, input, target};
  }
  async reviewActions(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string) {
    const context = await this.reviewActionContext(uri, filePath, hunkId, draft, revision);
    const actions = getReviewActions(context.input);
    await this.assertRawRequest(uri, context.loaded);
    return actions;
  }
  async transformDraft(uri: vscode.Uri, filePath: string, hunkId: string, draft: string, revision: string, action: ReviewAction) {
    if (action !== 'comment') throw new Error('Unknown proposal action.');
    const context = await this.reviewActionContext(uri, filePath, hunkId, draft, revision);
    const actions = getReviewActions(context.input);
    const selected = actions.find(item => item.id === action);
    if (!selected?.enabled) throw new Error(selected?.reason || 'This action is unavailable for this change.');
    const transformed = applyReviewAction(context.input, action);
    editPendingRequest(context.loaded.savedText, context.loaded.resolved.review.baseline, hunkId, transformed);
    await this.assertRawRequest(uri, context.loaded);
    return {draft: transformed, reviewActions: getReviewActions({...context.input, after: transformed})};
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
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before editing.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      this.assertEditable(loaded, hunkId);
      const target = await this.inspectTarget(uri, file, loaded.decisions, loaded.tracking);
      const edited = editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
      await this.assertRawRequest(uri, loaded);
      if (!edited.changed) return {changed: false, revision: loaded.revision};
      if (edited.review.expectedTarget !== loaded.resolved.review.expectedTarget) throw new Error('Editing a proposal must preserve accepted source content.');
      const committed = await this.commitReview(uri, loaded, edited.text, 'user', hunkId);
      return {changed: true, revision: committed.revision};
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
      if (loaded.revision !== revision) throw new Error('The request changed. Review its refreshed contents before accepting.');
      const file = loaded.request.files.find(candidate => candidate.path === filePath);
      if (!file) throw new Error('This file is not part of the request.');
      this.assertEditable(loaded, hunkId);
      const target = await this.inspectTarget(uri, file, loaded.decisions, loaded.tracking);
      const edited = editPendingRequest(loaded.savedText, loaded.resolved.review.baseline, hunkId, draft);
      await this.assertRawRequest(uri, loaded);
      if (edited.review.expectedTarget !== loaded.resolved.review.expectedTarget) throw new Error('Editing a proposal must preserve accepted source content.');
      const index = loaded.resolved.review.entryIndexByHunkId[hunkId]!;
      // Returning to the original removes this entry. Never accept its shifted neighbor.
      const removed = edited.request.request.length < loaded.resolved.request.request.length;
      const text = removed ? edited.text : patchRequestStatuses(edited.text, {[index]: 'accepted'});
      this.completionPrompts.delete(uri.toString());
      // The draft and its decision share one source/RR journal and one guarded commit.
      const committed = await this.commitReview(uri, loaded, text, 'user', hunkId);
      const completionPrompt = await this.finishCompletedReview(uri, committed, 'user');
      return {changed: true, revision: committed.revision, completionPrompt};
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
  async openTargetLine(requestUri: vscode.Uri, filePath: string, hunkId: string, revision: string, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active) {
    const loaded = await this.load(requestUri);
    if (loaded.revision !== revision) throw new Error('The request changed. Refresh the preview before navigating to the original.');
    const file = loaded.request.files.find(item => item.path === filePath);
    if (!file) throw new Error('Unknown request file.');
    const hunks = computeHunks(file), decisions = this.fileDecisions(file, loaded.decisions);
    const index = hunks.findIndex(item => item.id === hunkId), hunk = hunks[index];
    if (!hunk || hunk.oldLines === 0 || decisions[hunk.id] !== 'pending') {
      throw new Error('Choose an existing original line in a pending change.');
    }
    this.assertEditable(loaded, hunkId);
    const target = await this.inspectTarget(requestUri, file, loaded.decisions, loaded.tracking);
    const document = await vscode.workspace.openTextDocument(target.uri);
    await this.assertRequestUnchanged(requestUri, loaded.document, loaded.fingerprint);
    if (document.isDirty) throw new Error('Save or undo unsaved original edits before navigating to this request line.');
    if (requestModelText(document.getText()) !== requestModelText(target.current.replace(/^\uFEFF/, ''))) {
      throw new Error('The original changed while opening its line. Refresh the preview and try again.');
    }
    const mapped = loaded.tracking?.entries.find(item => item.hunk.id === hunkId);
    const line = mapped ? target.current.slice(0, mapped.start).split(/\r\n|\r|\n/).length - 1 :
      hunk.oldStart - 1 + hunks.slice(0, index).reduce((offset, item) => offset + (decisions[item.id] === 'accepted' ? item.newLines - item.oldLines : 0), 0);
    if (line < 0 || line >= document.lineCount) throw new Error('The original line is no longer available. Refresh the preview.');
    const position = new vscode.Position(line, 0), selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn, preserveFocus: false, preview: false, selection
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    return editor;
  }
  async openTargetPdf(requestUri: vscode.Uri, filePath: string, hunkId: string, revision: string) {
    if (!/\.(?:tex|ltx|latex)$/i.test(filePath)) throw new Error('PDF navigation is available for LaTeX source files only.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using LaTeX Workshop PDF navigation.');
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    if (!workshop) throw new Error('Install or enable LaTeX Workshop to navigate from this change to its PDF.');
    try { await workshop.activate(); }
    catch (error) { throw new Error('Could not activate LaTeX Workshop: ' + failure(error)); }
    const editor = await this.openTargetLine(requestUri, filePath, hunkId, revision);
    if (!['latex', 'latex-expl3', 'context', 'doctex', 'pweave', 'jlweave', 'rsweave'].includes(editor.document.languageId)) {
      throw new Error('Select a LaTeX language mode for the original file before navigating to its PDF.');
    }
    // SyncTeX requires the active native source editor. The View command also
    // awaits LaTeX Workshop's root discovery, avoiding a stale project root on
    // the first click from a webview. It opens an existing PDF without building.
    const pdfView = captureLatexPdfView(editor.viewColumn);
    try { await vscode.commands.executeCommand('latex-workshop.view'); }
    catch (error) { throw new Error('Could not open the PDF with LaTeX Workshop: ' + failure(error)); }
    const pdfTab = resolveLatexPdfView(pdfView);
    // Viewing can move focus or take time; revalidate and restore the exact
    // source location before invoking the same command as SyncTeX from cursor.
    await this.openTargetLine(requestUri, filePath, hunkId, revision, editor.viewColumn);
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using LaTeX Workshop PDF navigation.');
    try { await vscode.commands.executeCommand('latex-workshop.synctex'); }
    catch (error) { throw new Error('Could not run LaTeX Workshop SyncTeX: ' + failure(error)); }
    // Workshop's forward search does not focus its viewer, and cannot reveal a
    // PDF hidden behind TeX in the same group. Finish on the actual output PDF.
    if (pdfTab) await focusLatexPdfView(pdfTab);
  }
  async snapshots(requestUri: vscode.Uri, filePath: string, revision: string) {
    const loaded = await this.load(requestUri);
    if (loaded.revision !== revision) throw new Error('The request changed. Open the comparison again.');
    const file = loaded.request.files.find(item => item.path === filePath);
    if (!file) throw new Error('Unknown request file.');
    const target = await this.inspectTarget(requestUri, file, loaded.decisions, loaded.tracking);
    const tracking = loaded.tracking ?? createTrackedReview(file, this.fileDecisions(file, loaded.decisions));
    const changes = Object.fromEntries(tracking.entries.filter(entry => entry.decision === 'pending').map(entry => [entry.hunk.id, 'accepted' as Decision]));
    return {before: target.current, after: transitionTrackedReview(tracking, changes).text};
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
    return {enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.file(__dirname)]};
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
    let panelWasActive = panel.active;
    let actionError: string | undefined;
    let pdfActionError: string | undefined;
    let refreshRequested = false;
    let refreshTask: Promise<void> | undefined;
    let notifiedBusy = false;
    let lastPostedFingerprint: string | undefined;
    let deliveries = 0, forcedDelivery = 0, fulfilledDelivery = 0;
    const update = (invalidate = true, force = false): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (invalidate) ++generation;
      if (force) ++forcedDelivery;
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
            if (pdfActionError) state.pdfReview = {supported: false, available: false, filename: path.basename(uri.fsPath) + '.pdf',
              ...state.pdfReview, error: pdfActionError, canApply: false};
            // Disk/document notifications can arrive again after a write has
            // finished. Verify them, but do not redraw identical review rows.
            const fingerprint = requestFingerprint(JSON.stringify(state));
            if (fingerprint === lastPostedFingerprint && !notifiedBusy && forcedDelivery === fulfilledDelivery) continue;
            notifiedBusy = false;
            lastPostedFingerprint = fingerprint; fulfilledDelivery = forcedDelivery; deliveries++;
            await panel.webview.postMessage(state);
          }
        } finally { refreshTask = undefined; }
      });
      return refreshTask;
    };
    const disposables = [
      this.service.onDidChangePdfGeneration(event => {
        if (!disposed && event.uri.toString() === uri.toString()) {
          void panel.webview.postMessage({type: 'pdfGenerationProgress', progress: event.progress});
        }
      }),
      this.service.onDidFinishPdfGeneration(event => {
        if (!disposed && event.uri.toString() === uri.toString()) {
          void panel.webview.postMessage({type: 'pdfGenerationResult', outcome: event.outcome, error: event.error});
        }
      }),
      this.service.onDidChange(() => { pdfActionError = undefined; void update(); }),
      this.service.onDidDeleteRequest(deleted => {
        if (deleted.toString() === uri.toString()) {
          if (this.sourceOnlyUri === uri.toString()) this.sourceOnlyUri = undefined;
          panel.dispose();
        }
      }),
      panel.onDidChangeViewState(event => {
        panelWasActive = event.webviewPanel.active;
        if (panelWasActive) { this.activeUri = uri; this.syncQuickReviewContext(); }
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
            if (message.type === 'transformDraft' && message.action !== 'comment') throw new Error('Unknown proposal action.');
            const result = message.type === 'transformDraft'
              ? await this.service.transformDraft(uri, message.filePath, message.hunkId, message.draft, message.revision, message.action)
              : {reviewActions: await this.service.reviewActions(uri, message.filePath, message.hunkId, message.draft, message.revision)};
            if (!disposed) await panel.webview.postMessage({...response, ...result});
          } catch (error) {
            if (!disposed) await panel.webview.postMessage({...response, error: failure(error)});
          }
          return; // A local draft must not trigger a preview refresh or any file write.
        }
        const deliveriesBeforeAction = deliveries;
        let editResult: Awaited<ReturnType<ReviewService['editPending']>> | undefined;
        let decisionResult: Awaited<ReturnType<ReviewService['decide']>>;
        let completionSucceeded = false;
        let quickDecisionSucceeded = false;
        let pdfGenerationStarted = false;
        try {
          actionError = undefined; pdfActionError = undefined;
          switch (message.type) {
            case 'ready':
              this.readyCount++;
              this.quickReview.get(panel)!.ready = true;
              {
                const progress = this.service.getPdfGenerationProgress(uri);
                if (progress) {
                  // PDF generation never modifies the source/request. A new or
                  // reloaded panel can read one initial state while it runs.
                  // Stage messages themselves never request full review state.
                  const state = await this.service.getState(uri);
                  if (disposed) return;
                  // Do not replay an old busy snapshot after completion.
                  // The normal settled refresh below owns that state.
                  if (this.service.getPdfGenerationProgress(uri)) {
                    await panel.webview.postMessage(state);
                    lastPostedFingerprint = requestFingerprint(JSON.stringify(state));
                    deliveries++;
                    const currentProgress = this.service.getPdfGenerationProgress(uri);
                    if (currentProgress) await panel.webview.postMessage({type: 'pdfGenerationProgress', progress: currentProgress});
                  }
                }
              }
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
            case 'acceptThrough':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' || !message.hunkId ||
                  typeof message.revision !== 'string' ||
                  (('draft' in message || 'editId' in message) &&
                    (typeof message.draft !== 'string' || typeof message.editId !== 'string' || !message.editId)) ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'revision', 'draft', 'editId'].includes(key))) {
                throw new Error('Invalid acceptance range.');
              }
              {
                const accepted = await this.service.acceptThrough(uri, message.filePath, message.hunkId, message.revision, message.draft);
                if (message.editId !== undefined) editResult = {changed: accepted.changed, revision: accepted.revision};
                if (accepted.completionPrompt) decisionResult = {completionPrompt: accepted.completionPrompt};
              }
              break;
            case 'generateReviewPdf':
            case 'regenerateReviewPdf':
            case 'importPdfReview':
            case 'applyPdfReview':
              if (typeof message.revision !== 'string' || !message.revision ||
                  Object.keys(message).some(key => !['type', 'revision', ...(message.type === 'applyPdfReview' ? ['pdfHash'] : [])].includes(key)) ||
                  (message.type === 'applyPdfReview' && (typeof message.pdfHash !== 'string' || !/^[a-f0-9]{64}$/.test(message.pdfHash)))) {
                throw new Error('Invalid PDF review action.');
              }
              if (message.type === 'applyPdfReview') decisionResult = await this.service.applyPdfReview(uri, message.revision, message.pdfHash);
              else if (message.type === 'importPdfReview') await this.service.importPdfReview(uri, message.revision);
              else {
                pdfGenerationStarted = true;
                await this.service.generateReviewPdf(uri, message.revision, message.type === 'regenerateReviewPdf');
              }
              break;
            case 'undo':
              if (typeof message.filePath !== 'string' || typeof message.revision !== 'string' ||
                  typeof message.hunkId !== 'string') throw new Error('Invalid undo action.');
              await this.service.undo(uri, message.filePath, message.hunkId, message.revision);
              break;
            case 'undoFile':
              if (typeof message.filePath !== 'string' || !message.filePath || typeof message.revision !== 'string' || !message.revision ||
                  Object.keys(message).some(key => !['type', 'filePath', 'revision'].includes(key))) throw new Error('Invalid pending-all action.');
              await this.service.undoFile(uri, message.filePath, message.revision);
              break;
            case 'editPending':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' || !message.hunkId ||
                  typeof message.draft !== 'string' || typeof message.revision !== 'string' || typeof message.editId !== 'string' ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'draft', 'revision', 'editId'].includes(key))) {
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
              {
                const accepted = await this.service.editAndAccept(uri, message.filePath, message.hunkId, message.draft, message.revision);
                editResult = {changed: accepted.changed, revision: accepted.revision};
                if (accepted.completionPrompt) decisionResult = {completionPrompt: accepted.completionPrompt};
              }
              break;
            case 'ignoreEdited':
              if (typeof message.filePath !== 'string' || typeof message.hunkId !== 'string' || !message.hunkId ||
                  typeof message.revision !== 'string' || typeof message.editId !== 'string' ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'revision', 'editId'].includes(key))) {
                throw new Error('Invalid proposal ignore action.');
              }
              {
                const ignored = await this.service.decide(uri, message.filePath, message.hunkId, 'ignored', message.revision);
                editResult = {changed: true, revision: (await this.service.getState(uri, false)).revision};
                decisionResult = ignored;
              }
              break;
            case 'resolveCompletion':
              await this.service.resolveCompletion(uri, message.completionId, message.revision, message.deleteRequest, message.rememberChoice);
              completionSucceeded = true;
              break;
            case 'deleteRequest': await this.service.deleteRequest(uri); break;
            case 'openTargetLine':
            case 'openTargetPdf':
              if (typeof message.filePath !== 'string' || !message.filePath || typeof message.hunkId !== 'string' || !message.hunkId ||
                  typeof message.revision !== 'string' || !message.revision ||
                  Object.keys(message).some(key => !['type', 'filePath', 'hunkId', 'revision'].includes(key))) {
                throw new Error('Invalid original-line navigation.');
              }
              if (message.type === 'openTargetPdf') await this.service.openTargetPdf(uri, message.filePath, message.hunkId, message.revision);
              else await this.service.openTargetLine(uri, message.filePath, message.hunkId, message.revision);
              break;
            case 'openTarget': await this.service.openTarget(uri, message.filePath, {preserveFocus: false}); break;
            case 'openSource': await this.openSource(uri); break;
            case 'openDiff': await this.openDiff(uri, message.filePath, message.revision); break;
            default: return;
          }
        } catch (error) {
          if (!pdfGenerationStarted && ['generateReviewPdf', 'regenerateReviewPdf'].includes(message.type) && !disposed) {
            await panel.webview.postMessage({type: 'pdfGenerationProgress', progress: null});
            await panel.webview.postMessage({type: 'pdfGenerationResult', outcome: 'failed', error: failure(error)});
          }
          if (['generateReviewPdf', 'regenerateReviewPdf', 'importPdfReview', 'applyPdfReview'].includes(message.type)) pdfActionError = failure(error);
          else actionError = failure(error);
        }
        if (message.type === 'decide' && typeof message.quickDecisionId === 'string' && !disposed) {
          await panel.webview.postMessage({type: 'quickDecisionResult', quickDecisionId: message.quickDecisionId,
            filePath: message.filePath, hunkId: message.hunkId, decision: message.decision,
            success: quickDecisionSucceeded, error: actionError});
        }
        if ((['editPending', 'editAndAccept', 'ignoreEdited'].includes(message.type) ||
            (message.type === 'acceptThrough' && typeof message.editId === 'string')) && !disposed) {
          await panel.webview.postMessage({type: 'editResult', editId: message.editId, filePath: message.filePath,
            hunkId: message.hunkId, success: editResult !== undefined, error: actionError, ...editResult});
          actionError = undefined; // The draft editor owns edit errors and keeps the draft.
        }
        if (message.type === 'resolveCompletion' && !disposed) {
          await panel.webview.postMessage({type: 'completionResult', completionId: message.completionId, revision: message.revision,
            success: completionSucceeded, error: actionError});
          actionError = undefined;
        }
        // Actions join their final refresh; readiness and errors need a new delivery.
        await update(message.type === 'ready' || actionError !== undefined || pdfActionError !== undefined,
          message.type === 'ready' || actionError !== undefined || pdfActionError !== undefined || deliveries === deliveriesBeforeAction);
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
        // VS Code may invalidate all panel getters before this callback. Remove
        // the binding first and use the last live focus state during cleanup.
        this.panels.delete(uri.toString());
        this.quickReview.delete(panel);
        // Closing a preview may expose its source tab. Keep that viewing session
        // as JSON; a subsequent activation after switching away can open again.
        const hasSource = vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString());
        if (hasSource && (panelWasActive || this.activeSourceDocument?.uri.toString() === uri.toString() ||
            (!this.activeSourceDocument && this.activeUri?.toString() === uri.toString()))) this.suppressSource(uri);
        if (this.activeUri?.toString() === uri.toString()) this.activeUri = undefined;
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
  let confirmNextPdfBuildForTest = false;
  const service = new ReviewService(context, context.extensionMode === vscode.ExtensionMode.Test ? async (uri, bytes) => {
    await vscode.workspace.fs.writeFile(uri, bytes);
    if (failNextRequestWriteAfterSave) {
      failNextRequestWriteAfterSave = false;
      throw new Error('Injected request-write failure after saving bytes.');
    }
  } : undefined, undefined, context.extensionMode === vscode.ExtensionMode.Test ? async (...args) => {
    if (confirmNextPdfBuildForTest) {confirmNextPdfBuildForTest = false; return true;}
    return confirmPdfBuild(...args);
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
  const reviewPdfs = vscode.workspace.createFileSystemWatcher('**/*.rr.pdf');
  const changed = (uri: vscode.Uri) => {
    if (uri.path.endsWith('.rr')) { tree.refresh(); service.changed(); }
    else if (service.isTarget(uri)) service.changed();
  };
  context.subscriptions.push(
    service, tree, requests, targets, reviewPdfs, editor,
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
    reviewPdfs.onDidCreate(uri => service.pdfChanged(uri)), reviewPdfs.onDidChange(uri => service.pdfChanged(uri)), reviewPdfs.onDidDelete(uri => service.pdfChanged(uri)),
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
        } else {
          await editor.openPreview(created.uri);
          if (created.generatePdf) {
            // Creation has released the review queue; PDF generation owns its
            // own transaction and keeps the same compiler-consent checks.
            try {
              const state = await service.getState(created.uri);
              await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
                title: 'Generating review PDF…'}, () => service.generateReviewPdf(created.uri, state.revision));
            } catch (error) {
              void vscode.window.showWarningMessage('Created ' + path.basename(created.uri.fsPath) +
                ', but the review PDF could not be generated. ' + failure(error));
            } finally { service.changed(); }
          }
        }
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
      testConfirmNextPdfBuild: () => {confirmNextPdfBuildForTest = true;},
      testRestorePreview: (panel: vscode.WebviewPanel, state: unknown) => editor.deserializeWebviewPanel(panel, state),
      resolveCompletion: (uri: vscode.Uri, completionId: string, revision: string, deleteRequest: boolean, rememberChoice: boolean) =>
        service.resolveCompletion(uri, completionId, revision, deleteRequest, rememberChoice),
      deleteRequest: (uri: vscode.Uri) => service.deleteRequest(uri),
      generateReviewPdf: (uri: vscode.Uri, revision: string, replace = false) => service.generateReviewPdf(uri, revision, replace),
      importPdfReview: (uri: vscode.Uri, revision: string) => service.importPdfReview(uri, revision),
      applyPdfReview: (uri: vscode.Uri, revision: string, pdfHash: string) => service.applyPdfReview(uri, revision, pdfHash),
      editPending: (uri: vscode.Uri, file: string, hunk: string, draft: string, revision: string) =>
        service.editPending(uri, file, hunk, draft, revision),
      editAndAccept: (uri: vscode.Uri, file: string, hunk: string, draft: string, revision: string) =>
        service.editAndAccept(uri, file, hunk, draft, revision)
    } : {}),
    getState: (uri: vscode.Uri) => service.getState(uri),
    decide: (uri: vscode.Uri, file: string, hunk: string | undefined, decision: 'accepted' | 'ignored', revision: string) =>
      service.decide(uri, file, hunk, decision, revision),
    undo: (uri: vscode.Uri, file: string, hunk: string, revision: string) =>
      service.undo(uri, file, hunk, revision),
    undoFile: (uri: vscode.Uri, file: string, revision: string) =>
      service.undoFile(uri, file, revision)
  };
}
export function deactivate() {}
