'use strict';
// Source-only ReviewService integration: tsx transpiles in memory, with a small
// VS Code API double and real disposable files. No extension bundle is built.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const Module = require('node:module');
const {test, before} = require('node:test');
const root = path.resolve(__dirname, '..');
let scratch;
const documents = new Map();
const sourceWrites = [];
const settings = new Map([['autoDeleteCompleted', false], ['skipCompletedDeleteConfirmation', false]]);
let sourceFault;
class Uri {
  constructor(filePath) { this.fsPath = path.resolve(filePath); this.path = this.fsPath.replaceAll('\\', '/'); this.scheme = 'file'; }
  toString() { return pathToFileURL(this.fsPath).href; }
  static file(filePath) { return new Uri(filePath); }
  static parse(value) { return new Uri(require('node:url').fileURLToPath(value)); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
}
const vscode = {
  Uri, ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
  EventEmitter: class { constructor() {this.event = () => ({dispose(){}});} fire(){} dispose(){} },
  TabInputText: class {},
  workspace: {
    isTrusted: true,
    get workspaceFolders() { return scratch ? [{uri: Uri.file(scratch), name: 'request-test'}] : []; },
    get textDocuments() { return [...documents.values()]; },
    getWorkspaceFolder(uri) { return scratch && !path.relative(scratch, uri.fsPath).startsWith('..') ? {uri: Uri.file(scratch), name: 'request-test'} : undefined; },
    getConfiguration() { return {
      get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
      inspect: key => ({globalValue: settings.get(key)}),
      update: async (key, value) => {settings.set(key, value);}
    }; },
    async openTextDocument(uri) {
      if (!documents.has(uri.toString())) documents.set(uri.toString(), {
        uri, isDirty: false, isClosed: false,
        getText() {return this.staleText ?? syncFs.readFileSync(uri.fsPath, 'utf8').replace(/^\uFEFF/, '');}
      });
      return documents.get(uri.toString());
    },
    fs: {
      readFile: uri => fs.readFile(uri.fsPath),
      async writeFile(uri, bytes) {
        const isSource = !uri.fsPath.endsWith('.rr');
        if (isSource) {
          if (sourceFault?.path === uri.fsPath && sourceFault.when === 'before') {sourceFault = undefined; throw new Error('Injected source failure before write');}
          sourceWrites.push(uri.fsPath);
        }
        await fs.writeFile(uri.fsPath, bytes);
        if (isSource && sourceFault?.path === uri.fsPath && sourceFault.when === 'after') {sourceFault = undefined; throw new Error('Injected source failure after write');}
      },
      delete: uri => fs.unlink(uri.fsPath)
    }
  },
  window: {tabGroups: {all: [], close: async () => true}, showWarningMessage: () => undefined},
};
const load = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : load.call(this, name, parent, main); };
require('tsx/cjs');
const {ReviewService} = require('../src/extension.ts');
const {McpHost} = require('../src/mcpHost.ts');
Module._load = load;
function context() {
  const values = new Map();
  return {workspaceState: {get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    update: async (key, value) => {if (value === undefined) values.delete(key); else values.set(key, structuredClone(value));},
    keys: () => [...values.keys()]}};
}
function service(state = context(), requestFault = {remaining: 0, when: 'before'}) {
  return {state, requestFault, api: new ReviewService(state, async (uri, bytes) => {
    if (requestFault.remaining > 0 && requestFault.when === 'before') {requestFault.remaining--; throw new Error('Injected RR failure before write');}
    const previous = requestFault.lagMilliseconds ? await fs.readFile(uri.fsPath, 'utf8') : undefined;
    await fs.writeFile(uri.fsPath, bytes);
    if (requestFault.remaining > 0 && requestFault.when === 'after') {
      if (requestFault.lagMilliseconds) {
        const document = documents.get(uri.toString());
        document.staleText = previous.replace(/^\uFEFF/, '');
        setTimeout(() => {delete document.staleText;}, requestFault.lagMilliseconds);
      }
      requestFault.remaining--; throw new Error('Injected RR failure after write');
    }
  })};
}
let serial = 0;
async function fixture(beforeText = 'one\ncontext\nthree\n', entries = [{line: 1, before: 'one', after: 'ONE', status: 'pending'}, {line: 3, before: 'three', after: 'THREE', status: 'pending'}], withTime = true) {
  const folder = 'case-' + (++serial);
  await fs.mkdir(path.join(scratch, folder));
  const relative = folder + '/source.txt';
  const target = Uri.file(path.join(scratch, relative));
  const request = Uri.file(target.fsPath + '.rr');
  const value = {path: relative, ...(withTime ? {time: '2026-11-10T00:00:00Z'} : {}), request: entries};
  await fs.writeFile(target.fsPath, beforeText);
  await fs.writeFile(request.fsPath, JSON.stringify(value, null, 2) + '\n');
  return {request, target, relative, before: beforeText};
}
const read = uri => fs.readFile(uri.fsPath, 'utf8');
const statuses = async item => JSON.parse(await read(item.request)).request.map(entry => entry.status);
const journals = state => state.workspaceState.keys().filter(key => key.endsWith('.transaction'));
async function ready(api, item) {const state = await api.getState(item.request); assert.equal(state.error, undefined, state.error); assert.equal(state.verified, true, state.verificationIssue); return state;}
before(async () => {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /(^|\n)\.codex-\*\//);
  await fs.mkdir(path.join(root, '.codex-test'), {recursive: true});
  scratch = await fs.mkdtemp(path.join(root, '.codex-test', 'request-host-'));
  console.log('Source-host fixtures: ' + scratch);
});
test('Statuses persist, revisions change, and opening never writes original', async () => {
  const item = await fixture(); const {api} = service(); const initialWrites = sourceWrites.length;
  let state = await ready(api, item); assert.equal(sourceWrites.length, initialWrites); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  const initialRevision = state.revision;
  await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'pending']);
  state = await ready(api, item); assert.notEqual(state.revision, initialRevision);
  await assert.rejects(api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', initialRevision), /request changed/i);
  await api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', state.revision);
  state = await ready(api, item); assert.equal(state.closed, true); assert.deepEqual(await statuses(item), ['accepted', 'ignored']);
  await api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'ignored']);
});
test('missing creation time is added once from file creation without modifying original', async () => {
  const item = await fixture(undefined, undefined, false); const {api} = service(); const count = sourceWrites.length;
  await ready(api, item); const created = JSON.parse(await read(item.request)).time; assert.ok(Number.isFinite(Date.parse(created)));
  const raw = await read(item.request); await ready(api, item); assert.equal(await read(item.request), raw); assert.equal(sourceWrites.length, count);
});
test('accepted deletion baseline survives restart and a different pending entry edit', async () => {
  const item = await fixture('remove\ncontext\nold\n', [{line: 1, before: 'remove', after: null, status: 'pending'}, {line: 3, before: 'old', after: 'new', status: 'pending'}]);
  const first = service(); let state = await ready(first.api, item);
  await first.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  const restarted = service(first.state); state = await ready(restarted.api, item);
  const pending = state.files[0].hunks.find(hunk => hunk.decision === 'pending');
  await restarted.api.editPending(item.request, item.relative, pending.id, 'edited', state.revision);
  state = await ready(service(first.state).api, item); assert.equal(await read(item.target), 'context\nold\n');
  assert.deepEqual(await statuses(item), ['accepted', 'pending']); assert.equal(state.files[0].hunks.find(hunk => hunk.decision === 'pending').after, 'edited\n');
  await restarted.api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision); assert.equal(await read(item.target), item.before);
});
test('source failure before write keeps both files and clears a wholly uncommitted journal', async () => {
  const item = await fixture(); const {api, state: contextState} = service(); const state = await ready(api, item); const raw = await read(item.request);
  sourceFault = {path: item.target.fsPath, when: 'before'};
  await assert.rejects(api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision), /Injected source failure/);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), item.before); assert.equal(journals(contextState).length, 0);
});
test('source write that commits then rejects reconciles status without replaying source', async () => {
  const item = await fixture(); const {api} = service(); const state = await ready(api, item); const count = sourceWrites.length;
  sourceFault = {path: item.target.fsPath, when: 'after'};
  await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(sourceWrites.length, count + 1); assert.deepEqual(await statuses(item), ['accepted', 'pending']); await ready(api, item);
});
test('RR failure after source commit survives restart; preview repairs only RR metadata', async () => {
  const item = await fixture(); const first = service(); const state = await ready(first.api, item);
  first.requestFault.remaining = Infinity; const count = sourceWrites.length;
  await assert.rejects(first.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision), /Injected RR failure/);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['pending', 'pending']); assert.equal(journals(first.state).length, 1);
  await ready(service(first.state).api, item);
  assert.equal(sourceWrites.length, count + 1, 'Restart/open must not replay or roll back the original write');
  assert.deepEqual(await statuses(item), ['accepted', 'pending']); assert.equal(journals(first.state).length, 0);
});
test('RR write that commits then rejects waits for a lagging clean model before reporting actual status', async () => {
  const item = await fixture(); const created = service(); const state = await ready(created.api, item);
  created.requestFault.remaining = 1; created.requestFault.when = 'after'; created.requestFault.lagMilliseconds = 100;
  await created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'ignored', state.revision);
  assert.deepEqual(await statuses(item), ['ignored', 'pending']); assert.equal(await read(item.target), item.before); assert.equal(journals(created.state).length, 0);
});
test('recovery refuses an externally changed source and never overwrites it', async () => {
  const item = await fixture(); const created = service(); const state = await ready(created.api, item);
  created.requestFault.remaining = Infinity;
  await assert.rejects(created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision));
  await fs.writeFile(item.target.fsPath, 'USER EDIT\n'); const count = sourceWrites.length;
  const after = await service(created.state).api.getState(item.request);
  assert.equal(after.verified, false); assert.ok(after.error); assert.equal(await read(item.target), 'USER EDIT\n'); assert.equal(sourceWrites.length, count); assert.equal(journals(created.state).length, 1);
});
test('closed unresolved imports are summaries, not verified completion; valid accepted imports verify', async () => {
  const unresolved = await fixture('context\n', [{line: 1, before: 'deleted', after: 'missing-after', status: 'accepted'}]);
  const state = await service().api.getState(unresolved.request); assert.equal(state.closed, true); assert.equal(state.error, undefined); assert.equal(state.verified, false); assert.equal(state.files.length, 0);
  const deleted = await fixture('context\n', [{line: 1, before: 'deleted', after: null, status: 'accepted'}]);
  const unavailable = await service().api.getState(deleted.request);
  assert.equal(unavailable.closed, true); assert.equal(unavailable.verified, false); assert.equal(unavailable.files.length, 0);
  const valid = await fixture('new\n', [{line: 1, before: 'old', after: 'new', status: 'accepted'}]);
  const resolved = await ready(service().api, valid); assert.equal(resolved.closed, true); assert.equal(await read(valid.target), 'new\n');
});
test('external status tampering cannot make an unchanged source verified/complete', async () => {
  const item = await fixture(); const {api} = service(); await ready(api, item);
  const raw = JSON.parse(await read(item.request)); raw.request.forEach(entry => {entry.status = 'accepted';});
  await fs.writeFile(item.request.fsPath, JSON.stringify(raw)); const state = await api.getState(item.request);
  assert.equal(state.closed, true); assert.equal(state.verified, false); assert.ok(state.verificationIssue); assert.equal(state.files[0].issue, state.verificationIssue); assert.equal(state.files[0].currentText, item.before); assert.equal(await read(item.target), item.before);
});

test('Ignore and Undo ignored persist status without a source write', async () => {
  const item = await fixture(); const {api} = service(); let state = await ready(api, item); const count = sourceWrites.length;
  await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'ignored', state.revision);
  state = await ready(api, item); await api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.deepEqual(await statuses(item), ['pending', 'pending']); assert.equal(sourceWrites.length, count); assert.equal(await read(item.target), item.before);
});

test('retained or failed deletion keeps baselines; successful manual deletion clears every identity cache', async () => {
  const item = await fixture(); const created = service(); let state = await ready(created.api, item);
  await created.api.editPending(item.request, item.relative, state.files[0].hunks[0].id, 'EDITED', state.revision);
  const retained = created.state.workspaceState.keys(); assert.ok(retained.filter(key => key.includes('.baseline.')).length >= 2);
  const originalDelete = vscode.workspace.fs.delete;
  vscode.workspace.fs.delete = async () => {throw new Error('Injected delete refusal');};
  try {await assert.rejects(created.api.deleteRequest(item.request), /delete refusal/);}
  finally {vscode.workspace.fs.delete = originalDelete;}
  assert.deepEqual(created.state.workspaceState.keys(), retained); assert.equal(await read(item.target), item.before);
  await created.api.deleteRequest(item.request);
  assert.deepEqual(created.state.workspaceState.keys(), []); assert.equal(await read(item.target), item.before);
});
test('manual deletion clears an interrupted journal without rolling back the already written original', async () => {
  const item = await fixture(); const created = service(); const state = await ready(created.api, item);
  created.requestFault.remaining = Infinity;
  await assert.rejects(created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision));
  assert.equal(journals(created.state).length, 1); const saved = await read(item.target); const count = sourceWrites.length;
  await created.api.deleteRequest(item.request);
  assert.deepEqual(created.state.workspaceState.keys(), []); assert.equal(await read(item.target), saved); assert.equal(sourceWrites.length, count);
});
test('automatic deletion clears caches even when its post-delete receipt update fails', async () => {
  const item = await fixture(); const created = service(); let state = await ready(created.api, item);
  created.api.setCompletionRecorder(async (_uri, cleanup) => {if (cleanup === 'deleted') throw new Error('Injected receipt failure');});
  settings.set('autoDeleteCompleted', true);
  try {
    await created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'ignored', state.revision);
    state = await ready(created.api, item);
    await created.api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', state.revision);
    await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
    assert.deepEqual(created.state.workspaceState.keys(), []); assert.equal(await read(item.target), item.before);
  } finally {settings.set('autoDeleteCompleted', false);}
});

test('line selects the original row while snippets contain only the changed character', async () => {
  const item = await fixture('let x = 1;\nlet x = 1;\n', [{line: 2, before: '1', after: '2', reason: 'Second row only', status: 'pending'}]);
  const {api} = service(); let state = await ready(api, item);
  assert.equal(state.files[0].hunks[0].oldStart, 2);
  await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(await read(item.target), 'let x = 1;\nlet x = 2;\n');
  state = await ready(api, item);
  await api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.equal(await read(item.target), item.before);
});

test('EOF append previews one row while writing the required separator and preserving Undo', async () => {
  const item = await fixture('A', [{line: 2, before: null, after: 'B', status: 'pending'}]);
  const {api} = service(); let state = await ready(api, item);
  const initial = state.files[0].hunks[0];
  assert.equal(initial.after, 'B'); assert.equal(initial.oldLines, 0); assert.equal(initial.newLines, 1);
  await api.editPending(item.request, item.relative, initial.id, 'C', state.revision);
  assert.equal(await read(item.target), 'A');
  assert.equal(JSON.parse(await read(item.request)).request[0].after, 'C');
  state = await ready(api, item);
  assert.equal(state.files[0].hunks[0].after, 'C');
  await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(await read(item.target), 'A\nC');
  state = await ready(api, item);
  await api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.equal(await read(item.target), 'A');
});

test('BOM stays outside first-row insertion and deletion while preview offsets omit its marker', async () => {
  for (const entry of [{line: 1, before: null, after: 'X', status: 'pending'}, {line: 1, before: 'A', after: null, status: 'pending'}]) {
    const item = await fixture('\uFEFFA\nB\n', [entry]); const {api} = service(); let state = await ready(api, item);
    assert.equal(state.files[0].before, 'A\nB\n'); assert.equal(state.files[0].currentText, 'A\nB\n');
    assert.equal(state.files[0].hunks[0].start, 0);
    assert.equal(state.files[0].hunks[0].before.includes('\uFEFF'), false);
    assert.equal(state.files[0].hunks[0].after.includes('\uFEFF'), false);
    await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
    assert.equal(await read(item.target), entry.before === null ? '\uFEFFX\nA\nB\n' : '\uFEFFB\n');
    state = await ready(api, item);
    await api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
    assert.equal(await read(item.target), item.before);
  }
});

test('insertion and replacement at one original row retain independent buttons and reasons', async () => {
  const item = await fixture('A\n', [
    {line: 1, before: null, after: 'X', reason: 'Insert before A', status: 'pending'},
    {line: 1, before: 'A', after: 'B', reason: 'Replace A', status: 'pending'},
  ]);
  const {api} = service(); let state = await ready(api, item);
  assert.deepEqual(state.files[0].hunks.map(hunk => [hunk.oldStart, hunk.explanation]), [[1, 'Insert before A'], [1, 'Replace A']]);
  const [inserted, replaced] = state.files[0].hunks;
  assert.notEqual(inserted.id, replaced.id);
  await api.decide(item.request, item.relative, inserted.id, 'accepted', state.revision);
  state = await ready(api, item); assert.equal(await read(item.target), 'X\nA\n');
  await api.decide(item.request, item.relative, replaced.id, 'ignored', state.revision);
  state = await ready(api, item);
  assert.deepEqual(state.files[0].hunks.map(hunk => hunk.decision), ['accepted', 'ignored']);
  assert.equal(await read(item.target), 'X\nA\n');
});


test('real MCP host persists omitted reasons without changing legacy empty-reason retry hashes', async () => {
  const folder = 'mcp-case-' + (++serial); await fs.mkdir(path.join(scratch, folder));
  const relative = folder + '/source.txt', target = Uri.file(path.join(scratch, relative));
  const source = 'old\nline\n'; await fs.writeFile(target.fsPath, source);
  const {api, state: stateContext} = service(), writesBefore = sourceWrites.length;
  const host = new McpHost(stateContext, api, async () => {}, () => false);
  const workspace = Uri.file(scratch).toString();
  const readTarget = await host.handler('read_target', {path: relative}, workspace);
  const entries = [{line: 1, before: 'old', after: 'NEW'}, {line: 2, before: 'line', after: 'LINE', reason: ''}];
  const args = {path: relative, expectedHash: readTarget.hash, clientRequestId: 'omitted-reason-fixture', request: entries};
  const created = await host.handler('create_request', args, workspace);
  const requestPath = path.join(scratch, relative + '.rr'), savedText = await fs.readFile(requestPath, 'utf8');
  const saved = JSON.parse(savedText);
  assert.equal(Object.hasOwn(saved.request[0], 'reason'), false);
  assert.equal(Object.hasOwn(saved.request[1], 'reason'), true); assert.equal(saved.request[1].reason, '');
  assert.equal(await read(target), source); assert.equal(sourceWrites.length, writesBefore);
  const expectedLegacyHash = require('node:crypto').createHash('sha256').update(JSON.stringify({path: relative, expectedHash: readTarget.hash,
    request: entries.map(entry => ({line: entry.line, before: entry.before, after: entry.after, reason: entry.reason ?? '', status: 'pending'}))})).digest('hex');
  const record = stateContext.workspaceState.get('mcp.requestRegistry.v1').find(item => item.requestId === created.requestId);
  assert.equal(record.inputHash, expectedLegacyHash);
  const retry = await host.handler('create_request', {...args, request: entries.map(({reason, ...entry}) => ({...entry, ...(reason === undefined ? {reason: ''} : {})}))}, workspace);
  assert.equal(retry.requestId, created.requestId); assert.equal(await fs.readFile(requestPath, 'utf8'), savedText);
  const changedReason = entries.map(entry => ({...entry, reason: 'Different proposal'}));
  await assert.rejects(host.handler('create_request', {...args, request: changedReason}, workspace), error => error.code === 'IDEMPOTENCY_CONFLICT');
});


test('collapsing mixed-EOL blocks are refused before source or request writes', async () => {
  const item = await fixture('middle\rlast\ntail', [{line: 1, before: 'middle\nlast', after: '\n', status: 'pending'}]);
  const {api, state: contextState} = service(), targetBefore = await read(item.target), requestBefore = await read(item.request);
  const writesBefore = sourceWrites.length, state = await api.getState(item.request);
  assert.match(state.error, /merge separate CR and LF/); assert.equal(state.verified, false);
  await assert.rejects(api.decide(item.request, item.relative, 'unresolved', 'accepted', state.revision), /merge separate CR and LF/);
  assert.equal(await read(item.target), targetBefore); assert.equal(await read(item.request), requestBefore);
  assert.equal(sourceWrites.length, writesBefore); assert.equal(journals(contextState).length, 0);
});

test('cached multiline Undo after restart preserves mixed EOL bytes exactly', async () => {
  const item = await fixture('middle\rlast\ntail', [{line: 1, before: 'middle\nlast', after: 'MIDDLE\nLAST', status: 'pending'}]);
  const initial = service(); let state = await ready(initial.api, item);
  await initial.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(await read(item.target), 'MIDDLE\rLAST\ntail');
  const restarted = service(initial.state); state = await ready(restarted.api, item);
  await restarted.api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending']);
});
