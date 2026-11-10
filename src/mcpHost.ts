import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { computeHunks, parseRequest, requestFingerprint } from './core';
import type { ReviewService } from './extension';
import { McpBridgeError, type McpHandler, type McpStatus } from './mcpTypes';

const REGISTRY_KEY = 'mcp.requestRegistry.v1';
const MAX_RECEIPTS = 256;
const MAX_ACTIVE = 1000;
interface RequestRecord {
  requestId: string; workspaceUri: string; uri: string; path: string;
  fingerprint: string; stamp: string; createdAt: number;
  clientRequestId?: string; inputHash?: string; receipt?: McpStatus;
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
function utf8(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    if (value.includes('\0')) throw new Error('binary');
    return value;
  } catch { throw new McpBridgeError('UNSUPPORTED_TEXT', 'Only existing UTF-8 text files without NUL characters are supported.'); }
}
function requiredString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new McpBridgeError('INVALID_ARGUMENT', label + ' must be a nonempty string within its size limit.');
  }
  return value;
}
function validatePath(value: unknown): string {
  // Reuse the actual format validator; do not maintain a weaker MCP path syntax.
  const result = requiredString(value, 'path');
  parseRequest(JSON.stringify({version: 1, title: 'Path validation', files: [{path: result, before: '', after: ''}]}));
  if (result.split('/').some(part => part.toLowerCase() === '.git')) throw new McpBridgeError('OUTSIDE_WORKSPACE', 'Git metadata cannot be a revision target.');
  return result;
}

/** Business operations stay in the VS Code host, alongside authoritative review state. */
export class McpHost {
  private registryQueue: Promise<unknown> = Promise.resolve();
  readonly handler: McpHandler;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ReviewService,
    private readonly openPreview: (uri: vscode.Uri) => Promise<void>,
    private readonly agentDecisionsAllowed: () => boolean,
  ) {
    this.handler = (method, args, workspaceUri) => this.handle(method, args, workspaceUri);
    service.setCompletionRecorder((uri, cleanup) => this.recordCompletion(uri, cleanup));
  }
  private workspace(workspaceUri: string): vscode.WorkspaceFolder {
    if (!vscode.workspace.isTrusted) throw new McpBridgeError('UNTRUSTED_WORKSPACE', 'Trust the workspace before using Revision Request MCP.');
    const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === workspaceUri && item.uri.scheme === 'file');
    if (!folder) throw new McpBridgeError('UNKNOWN_WORKSPACE', 'Choose an explicitly opened local workspace folder.');
    return folder;
  }
  private records(): RequestRecord[] { return this.context.workspaceState.get<RequestRecord[]>(REGISTRY_KEY, []); }
  private mutate<T>(action: (records: RequestRecord[]) => Promise<T>): Promise<T> {
    const task = async () => {
      const records = this.records();
      const result = await action(records);
      const receipts = records.filter(item => item.receipt).sort((a, b) => (b.receipt!.completedAt ?? '').localeCompare(a.receipt!.completedAt ?? ''));
      const retainedReceipts = new Set(receipts.slice(0, MAX_RECEIPTS).map(item => item.requestId));
      const completed = records.filter(item => item.receipt?.cleanup === 'deleted' && retainedReceipts.has(item.requestId)).sort((a, b) => b.createdAt - a.createdAt);
      for (const record of records) {
        if (record.receipt?.cleanup !== 'deleted' && !retainedReceipts.has(record.requestId)) delete record.receipt;
      }
      const active = records.filter(item => item.receipt?.cleanup !== 'deleted').sort((a, b) => b.createdAt - a.createdAt);
      await this.context.workspaceState.update(REGISTRY_KEY, [...active.slice(0, MAX_ACTIVE), ...completed.slice(0, MAX_RECEIPTS)]);
      return result;
    };
    const pending = this.registryQueue.then(task, task);
    this.registryQueue = pending.catch(() => undefined);
    return pending;
  }
  private async rejectDirty(uri: vscode.Uri, real: string) {
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      if (samePath(document.uri.fsPath, uri.fsPath) || samePath(await fs.realpath(document.uri.fsPath).catch(() => ''), real)) {
        throw new McpBridgeError('DIRTY_DOCUMENT', 'Save or undo unsaved edits before reading or proposing changes to this file.');
      }
    }
  }
  private async resolveTarget(folder: vscode.WorkspaceFolder, filePath: string) {
    const uri = vscode.Uri.file(path.resolve(folder.uri.fsPath, validatePath(filePath)));
    if (!inside(folder.uri.fsPath, uri.fsPath) || vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
      throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The file must belong to the explicitly selected workspace folder.');
    }
    const [root, real] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(uri.fsPath)]);
    if (!inside(root, real) || path.relative(root, real).split(path.sep).some(part => part.toLowerCase() === '.git')) {
      throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The file resolves outside this workspace or into Git metadata.');
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new McpBridgeError('NOT_A_FILE', 'The target must be an existing regular file.');
    if (stat.size > 5 * 1024 * 1024) throw new McpBridgeError('TEXT_TOO_LARGE', 'The .rr format supports source snapshots up to 5 MiB.');
    await this.rejectDirty(uri, real);
    return {uri, real};
  }
  private async readTarget(folder: vscode.WorkspaceFolder, filePath: string) {
    this.workspace(folder.uri.toString());
    const target = await this.resolveTarget(folder, filePath);
    const bytes = await fs.readFile(target.real);
    if (bytes.length > 5 * 1024 * 1024) throw new McpBridgeError('TEXT_TOO_LARGE', 'The source exceeds the 5 MiB snapshot limit.');
    await this.rejectDirty(target.uri, target.real);
    const checked = await this.resolveTarget(folder, filePath);
    if (!samePath(checked.real, target.real)) throw new McpBridgeError('STALE_TARGET', 'The target path changed while reading it.');
    this.workspace(folder.uri.toString());
    return {path: filePath, content: utf8(bytes), hash: hash(bytes)};
  }
  private async inspectRequest(folder: vscode.WorkspaceFolder, uri: vscode.Uri) {
    this.workspace(folder.uri.toString());
    if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.rr' ||
        vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
      throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The request must belong to this local workspace.');
    }
    const [root, real] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(uri.fsPath)]);
    if (!inside(root, real) || path.relative(root, real).split(path.sep).some(part => part.toLowerCase() === '.git')) {
      throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The request resolves outside this workspace or into Git metadata.');
    }
    await this.rejectDirty(uri, real);
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new McpBridgeError('INVALID_REQUEST', 'The request must be a regular .rr file within the format size limit.');
    const bytes = await fs.readFile(real);
    if (bytes.length > 20 * 1024 * 1024) throw new McpBridgeError('INVALID_REQUEST', 'The request exceeds the format size limit.');
    const text = utf8(bytes).replace(/^\uFEFF/, '');
    const request = parseRequest(text);
    if (path.basename(uri.fsPath) !== path.basename(request.files[0]!.path) + '.rr') throw new McpBridgeError('INVALID_REQUEST', 'The request filename must be the complete original filename followed by .rr.');
    if (!samePath(await fs.realpath(uri.fsPath), real)) throw new McpBridgeError('REQUEST_CHANGED', 'The request path changed while reading it.');
    await this.rejectDirty(uri, real);
    this.workspace(folder.uri.toString());
    return {request, fingerprint: requestFingerprint(text), stamp: stat.dev + ':' + stat.ino + ':' + stat.birthtimeMs};
  }
  private async registerRequest(folder: vscode.WorkspaceFolder, uri: vscode.Uri, identity?: {clientRequestId: string; inputHash: string}) {
    return this.mutate(async records => {
      const {request, fingerprint, stamp} = await this.inspectRequest(folder, uri);
      const existing = records.find(item => item.workspaceUri === folder.uri.toString() && item.uri === uri.toString() && item.fingerprint === fingerprint && item.stamp === stamp && item.receipt?.cleanup !== 'deleted');
      if (existing) {
        if (identity) Object.assign(existing, identity);
        return {...existing};
      }
      const record: RequestRecord = {
        requestId: randomUUID(), workspaceUri: folder.uri.toString(), uri: uri.toString(),
        path: request.files[0]!.path, fingerprint, stamp, createdAt: Date.now(), ...identity,
      };
      records.push(record);
      return {...record};
    });
  }
  private recordFor(folder: vscode.WorkspaceFolder, requestId: unknown): RequestRecord {
    const id = requiredString(requestId, 'requestId', 256);
    const record = this.records().find(item => item.workspaceUri === folder.uri.toString() && item.requestId === id);
    if (!record) throw new McpBridgeError('UNKNOWN_REQUEST', 'Unknown requestId in this workspace. List or create requests first.');
    return record;
  }
  private unavailable(record: RequestRecord, issue: string): McpStatus {
    return {
      requestId: record.requestId, requestPath: path.relative(vscode.Uri.parse(record.workspaceUri).fsPath, vscode.Uri.parse(record.uri).fsPath).split(path.sep).join('/'),
      path: record.path, revision: record.fingerprint, status: 'unavailable', pending: 0, accepted: 0, ignored: 0, hunks: [], issue,
    };
  }
  private async status(record: RequestRecord): Promise<McpStatus> {
    if (record.receipt?.cleanup === 'deleted') return {...record.receipt};
    const uri = vscode.Uri.parse(record.uri);
    let inspected: Awaited<ReturnType<McpHost['inspectRequest']>>;
    try { inspected = await this.inspectRequest(this.workspace(record.workspaceUri), uri); }
    catch (error) { return this.unavailable(record, error instanceof Error ? error.message : 'The request is unavailable.'); }
    if (inspected.stamp !== record.stamp || inspected.fingerprint !== record.fingerprint) {
      return this.unavailable(record, 'This path now contains changed contents or a different request generation. List requests again.');
    }
    const state = await this.service.getState(uri, false);
    if (state.error || state.revision !== record.fingerprint) return this.unavailable(record, state.error ?? 'The request contents changed. List requests again to obtain its new requestId.');
    const file = state.files[0]!;
    const hunks = file.hunks.map(({id, oldStart, newStart, oldLines, newLines, decision}) => ({id, oldStart, newStart, oldLines, newLines, decision}));
    const pending = hunks.filter(item => item.decision === 'pending').length;
    const accepted = hunks.filter(item => item.decision === 'accepted').length;
    const ignored = hunks.filter(item => item.decision === 'ignored').length;
    const result: McpStatus = {
      ...this.unavailable(record, ''), status: pending || !hunks.length ? (file.issue ? 'stale' : 'pending') : 'completed',
      pending, accepted, ignored, hunks, issue: file.issue,
    };
    if (!pending && hunks.length) {
      result.cleanup = record.receipt?.cleanup ?? 'retained';
      result.completedAt = record.receipt?.completedAt;
      result.targetHash = record.receipt?.targetHash;
    }
    return result;
  }
  private async recordCompletion(uri: vscode.Uri, cleanup: 'retained' | 'deleted' | 'failed') {
    if (!vscode.workspace.isTrusted) return;
    if (cleanup !== 'retained') {
      await this.mutate(async records => {
        const record = records.filter(item => item.uri === uri.toString() && item.receipt).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (record?.receipt) record.receipt.cleanup = cleanup;
      });
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file') return;
    const record = await this.registerRequest(folder, uri);
    const status = await this.status(record);
    if (status.pending || !status.hunks.length) return;
    let targetHash: string | undefined;
    try { targetHash = (await this.readTarget(folder, record.path)).hash; } catch { /* Decisions remain authoritative even if the source changed externally. */ }
    const receipt: McpStatus = {...status, status: 'completed', cleanup: 'retained', completedAt: new Date().toISOString(), targetHash,
      hunks: status.hunks.map(({id, oldStart, newStart, oldLines, newLines, decision}) => ({id, oldStart, newStart, oldLines, newLines, decision}))};
    await this.mutate(async records => {
      const current = records.find(item => item.requestId === record.requestId);
      if (current) current.receipt = receipt;
    });
  }
  private async createRequest(folder: vscode.WorkspaceFolder, args: Record<string, unknown>): Promise<McpStatus> {
    const filePath = validatePath(args.path);
    const expectedHash = requiredString(args.expectedHash, 'expectedHash', 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new McpBridgeError('INVALID_ARGUMENT', 'expectedHash must be the SHA-256 hash returned by read_target.');
    const clientRequestId = requiredString(args.clientRequestId, 'clientRequestId', 256);
    const title = args.title === undefined ? 'Review ' + path.basename(filePath) : args.title;
    // Parse both metadata and text before evaluating idempotency; canonical keys
    // make retries insensitive to incoming JSON property order.
    const validated = parseRequest(JSON.stringify({version: 1, title, files: [{path: filePath, before: '', after: args.after, reason: args.reason, explanations: args.explanations}]}));
    const proposal = validated.files[0]!;
    if (Buffer.from(proposal.after, 'utf8').toString('utf8') !== proposal.after) throw new McpBridgeError('UNSUPPORTED_TEXT', 'The proposed text contains an unpaired Unicode surrogate and cannot be saved exactly as UTF-8.');
    const inputHash = hash(JSON.stringify({path: filePath, expectedHash, title: validated.title, after: proposal.after, reason: proposal.reason, explanations: proposal.explanations}));
    return this.service.runExclusive(async () => {
      this.workspace(folder.uri.toString());
      const retry = this.records().find(item => item.workspaceUri === folder.uri.toString() && item.clientRequestId === clientRequestId);
      if (retry) {
        if (retry.inputHash !== inputHash) throw new McpBridgeError('IDEMPOTENCY_CONFLICT', 'This clientRequestId was already used with different proposal contents.');
        return this.status(retry);
      }
      const source = await this.readTarget(folder, filePath);
      if (source.hash !== expectedHash) throw new McpBridgeError('STALE_TARGET', 'The saved target changed. Read it again before creating a request.');
      const request = parseRequest(JSON.stringify({version: 1, title: validated.title, files: [{...proposal, before: source.content}]}));
      if (source.content.startsWith('\uFEFF') !== proposal.after.startsWith('\uFEFF')) throw new McpBridgeError('BOM_CHANGED', 'Keep the original UTF-8 BOM unchanged in the proposal.');
      if (!computeHunks(request.files[0]!).length) throw new McpBridgeError('NO_CHANGES', 'The proposal is identical to the saved source.');
      const uri = vscode.Uri.file(path.resolve(folder.uri.fsPath, filePath + '.rr'));
      const text = JSON.stringify(request, null, 2) + '\n';
      const root = await fs.realpath(folder.uri.fsPath);
      const parent = await fs.realpath(path.dirname(uri.fsPath));
      if (!inside(root, parent) || path.relative(root, parent).split(path.sep).some(part => part.toLowerCase() === '.git')) throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The request directory resolves outside this workspace.');
      const writePath = path.join(parent, path.basename(uri.fsPath));
      // Exclusive creation prevents replacing a request, including a symlink.
      const latest = await this.readTarget(folder, filePath);
      if (latest.hash !== expectedHash) throw new McpBridgeError('STALE_TARGET', 'The target changed while preparing the request.');
      this.workspace(folder.uri.toString());
      let handle: fs.FileHandle;
      try { handle = await fs.open(writePath, 'wx'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new McpBridgeError('REQUEST_EXISTS', 'A request already exists beside this target. Review or remove it before creating another.');
        throw error;
      }
      const createdStat = await handle.stat();
      try {
        const openedPath = await fs.realpath(writePath);
        if (!inside(root, openedPath) || path.relative(root, openedPath).split(path.sep).some(part => part.toLowerCase() === '.git')) throw new McpBridgeError('OUTSIDE_WORKSPACE', 'The request path changed outside this workspace.');
        const finalSource = await this.readTarget(folder, filePath);
        if (finalSource.hash !== expectedHash) throw new McpBridgeError('STALE_TARGET', 'The target changed before the request could be written.');
        this.workspace(folder.uri.toString());
        await handle.writeFile(text, 'utf8');
      } catch (error) {
        await handle.close();
        const current = await fs.stat(writePath).catch(() => undefined);
        if (current?.ino === createdStat.ino && current.birthtimeMs === createdStat.birthtimeMs) await fs.unlink(writePath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      const record = await this.registerRequest(folder, uri, {clientRequestId, inputHash});
      this.service.changed();
      return this.status(record);
    });
  }
  private async handle(method: Parameters<McpHandler>[0], args: Record<string, unknown>, workspaceUri: string): Promise<unknown> {
    const folder = this.workspace(workspaceUri);
    switch (method) {
      case 'capabilities': return {workspaceUri, allowAgentDecisions: this.agentDecisionsAllowed()};
      case 'read_target': return this.readTarget(folder, validatePath(args.path));
      case 'create_request': return this.createRequest(folder, args);
      case 'list_requests': {
        if (args.includeCompleted !== undefined && typeof args.includeCompleted !== 'boolean') throw new McpBridgeError('INVALID_ARGUMENT', 'includeCompleted must be a boolean.');
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.rr'), '**/{node_modules,.git,.codex-*}/**', MAX_ACTIVE);
        const requests: McpStatus[] = [];
        for (const uri of uris) {
          if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== workspaceUri) continue;
          try { requests.push(await this.status(await this.registerRequest(folder, uri))); }
          catch { /* Invalid, dirty, or out-of-workspace requests cannot be acted on. */ }
        }
        if (args.includeCompleted === true) {
          const seen = new Set(requests.map(item => item.requestId));
          for (const record of this.records()) {
            if (record.workspaceUri !== workspaceUri || !record.receipt || seen.has(record.requestId)) continue;
            const completed = await this.status(record);
            if (completed.status === 'completed') { requests.push(completed); seen.add(record.requestId); }
          }
        }
        return {requests};
      }
      case 'get_request_status': return this.status(this.recordFor(folder, args.requestId));
      case 'open_preview': {
        const record = this.recordFor(folder, args.requestId);
        const status = await this.status(record);
        if (status.status === 'unavailable' || status.cleanup === 'deleted') throw new McpBridgeError('REQUEST_UNAVAILABLE', 'This request is no longer available to preview.');
        await this.openPreview(vscode.Uri.parse(record.uri));
        return status;
      }
      case 'decide':
      case 'undo': {
        if (!this.agentDecisionsAllowed()) throw new McpBridgeError('AGENT_DECISIONS_DISABLED', 'Agent decisions are disabled in User settings.');
        const record = this.recordFor(folder, args.requestId);
        const status = await this.status(record);
        if (status.status === 'unavailable' || status.cleanup === 'deleted') throw new McpBridgeError('REQUEST_UNAVAILABLE', 'This request is no longer available for decisions.');
        const revision = requiredString(args.revision, 'revision', 64);
        const uri = vscode.Uri.parse(record.uri);
        if (method === 'undo') {
          await this.service.undo(uri, record.path, requiredString(args.hunkId, 'hunkId', 256), revision, 'agent');
        } else {
          if (args.decision !== 'accepted' && args.decision !== 'ignored') throw new McpBridgeError('INVALID_ARGUMENT', 'decision must be accepted or ignored.');
          const hunkId = args.hunkId === undefined ? undefined : requiredString(args.hunkId, 'hunkId', 256);
          await this.service.decide(uri, record.path, hunkId, args.decision, revision, 'agent');
        }
        return this.status(this.recordFor(folder, record.requestId));
      }
      default: throw new McpBridgeError('UNKNOWN_METHOD', 'Unsupported Revision Request operation.');
    }
  }
}
