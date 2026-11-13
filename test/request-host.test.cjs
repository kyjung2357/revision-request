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
async function fixture(beforeText = 'one\ncontext\nthree\n', entries = [{line: 1, before: 'one', after: 'ONE', status: 'pending'}, {line: 3, before: 'three', after: 'THREE', status: 'pending'}], withTime = true, extension = 'txt') {
  const folder = 'case-' + (++serial);
  await fs.mkdir(path.join(scratch, folder));
  const relative = folder + '/source.' + extension;
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
  settings.set('autoDeleteCompleted', true); settings.set('skipCompletedDeleteConfirmation', true);
  try {
    await created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'ignored', state.revision);
    state = await ready(created.api, item);
    await created.api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', state.revision);
    await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
    assert.deepEqual(created.state.workspaceState.keys(), []); assert.equal(await read(item.target), item.before);
  } finally {settings.set('autoDeleteCompleted', false); settings.set('skipCompletedDeleteConfirmation', false);}
});

for (const decision of ['accepted', 'ignored']) for (const deleteRequest of [false, true]) for (const rememberChoice of [false, true]) {
  test(`final individual ${decision} confirms ${deleteRequest ? 'deletion' : 'retention'} with remember=${rememberChoice}`, async () => {
    const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
    const {api} = service(), receipts = [];
    api.setCompletionRecorder(async (_uri, cleanup) => {receipts.push(cleanup);});
    settings.set('autoDeleteCompleted', true);
    try {
      const state = await ready(api, item);
      const result = await api.decide(item.request, item.relative, state.files[0].hunks[0].id, decision, state.revision);
      const prompt = result.completionPrompt, completed = await ready(api, item);
      assert.ok(prompt.completionId); assert.equal(prompt.revision, completed.revision);
      assert.equal(prompt.requestName, path.basename(item.request.fsPath));
      assert.deepEqual(await statuses(item), [decision]); assert.deepEqual(receipts, ['retained']);
      const expected = decision === 'accepted' ? 'new\n' : 'old\n';
      assert.equal(await read(item.target), expected);
      const writes = sourceWrites.length;
      assert.deepEqual(await api.resolveCompletion(item.request, prompt.completionId, prompt.revision, deleteRequest, rememberChoice), {deleted: deleteRequest});
      if (deleteRequest) await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
      else assert.deepEqual(await statuses(item), [decision]);
      assert.equal(await read(item.target), expected); assert.equal(sourceWrites.length, writes);
      assert.deepEqual(receipts, deleteRequest ? ['retained', 'deleted'] : ['retained']);
      assert.equal(settings.get('skipCompletedDeleteConfirmation'), rememberChoice);
      assert.equal(settings.get('autoDeleteCompleted'), rememberChoice ? deleteRequest : true);
    } finally {settings.set('autoDeleteCompleted', false); settings.set('skipCompletedDeleteConfirmation', false);}
  });
}

test('individual completion waits for the last pending entry and Undo invalidates its prompt without prompting', async () => {
  const item = await fixture(), {api} = service(), receipts = [];
  api.setCompletionRecorder(async (_uri, cleanup) => {receipts.push(cleanup);});
  let state = await ready(api, item);
  assert.equal(await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision), undefined);
  assert.deepEqual(receipts, []);
  state = await ready(api, item);
  const {completionPrompt: first} = await api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', state.revision);
  state = await ready(api, item); await ready(api, item);
  assert.deepEqual(receipts, ['retained'], 'Reopening a completed request must not start completion again');
  assert.equal(await api.undo(item.request, item.relative, state.files[0].hunks[1].id, state.revision), undefined);
  await assert.rejects(api.resolveCompletion(item.request, first.completionId, first.revision, true, false), /no longer current|pending|changed/);
  state = await ready(api, item);
  const {completionPrompt: second} = await api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'accepted', state.revision);
  assert.notEqual(second.completionId, first.completionId);
  await api.resolveCompletion(item.request, second.completionId, second.revision, false, false);
  assert.deepEqual(await statuses(item), ['accepted', 'accepted']);
});

for (const action of ['decide', 'editAndAccept']) for (const autoDelete of [false, true]) {
  test(`${action} final action respects skipped confirmation and autoDelete=${autoDelete}`, async () => {
    const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
    const {api} = service(), state = await ready(api, item);
    settings.set('skipCompletedDeleteConfirmation', true); settings.set('autoDeleteCompleted', autoDelete);
    try {
      const result = action === 'decide'
        ? await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision)
        : await api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'edited', state.revision);
      assert.equal(result?.completionPrompt, undefined);
      if (autoDelete) await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
      else assert.deepEqual(await statuses(item), ['accepted']);
      assert.equal(await read(item.target), action === 'decide' ? 'new\n' : 'edited\n');
    } finally {settings.set('autoDeleteCompleted', false); settings.set('skipCompletedDeleteConfirmation', false);}
  });
}

for (const autoDelete of [false, true]) test(`agent final decisions do not prompt and retain autoDelete=${autoDelete}`, async () => {
  const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
  const {api} = service(), state = await ready(api, item);
  settings.set('autoDeleteCompleted', autoDelete); settings.set('mcp.allowAgentDecisions', true);
  try {
    assert.equal(await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision, 'agent'), undefined);
    if (autoDelete) await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
    else assert.deepEqual(await statuses(item), ['accepted']);
    assert.equal(await read(item.target), 'new\n');
  } finally {settings.set('autoDeleteCompleted', false); settings.delete('mcp.allowAgentDecisions');}
});

for (const action of ['decide', 'editAndAccept']) test(`${action} completion record failure keeps the request without a prompt or deletion`, async () => {
  const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
  const {api} = service(), state = await ready(api, item);
  api.setCompletionRecorder(async () => {throw Error('Injected receipt failure');});
  settings.set('autoDeleteCompleted', true);
  try {
    const result = action === 'decide'
      ? await api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision)
      : await api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'edited', state.revision);
    assert.equal(result?.completionPrompt, undefined); assert.deepEqual(await statuses(item), ['accepted']);
    assert.equal(await read(item.target), action === 'decide' ? 'new\n' : 'edited\n');
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


async function comparisonFixture(options = {}) {
  const folder = 'mcp-files-' + (++serial); await fs.mkdir(path.join(scratch, folder));
  const extension = options.extension ?? 'txt';
  const originalPath = folder + '/source.' + extension, proposedPath = folder + '/source.proposed.' + extension;
  const original = Uri.file(path.join(scratch,originalPath)), proposed = Uri.file(path.join(scratch,proposedPath));
  const before = Buffer.from(options.before ?? '\uFEFFone\r\ntwo\r\nkeep\r\n');
  const after = Buffer.from(options.after ?? '\uFEFFONE\r\nTWO\r\nkeep\r\nadded\r\n');
  await fs.writeFile(original.fsPath,before); await fs.writeFile(proposed.fsPath,after);
  const {api,state:stateContext}=service();
  const host=new McpHost(stateContext,api,async()=>{assert.fail('Creation must not open the preview automatically');},()=>false);
  const workspace=Uri.file(scratch).toString();
  const readOriginal=await host.handler('read_target',{path:originalPath},workspace);
  const readProposed=await host.handler('read_target',{path:proposedPath},workspace);
  const args={path:originalPath,proposedPath,expectedHash:readOriginal.hash,expectedProposedHash:readProposed.hash,clientRequestId:'files-'+serial};
  return {original,proposed,before,after,api,host,workspace,args,output:original.fsPath+'.rr'};
}
const codeIs=code=>error=>error.code===code;
async function noComparisonOutput(item) { await assert.rejects(fs.stat(item.output),{code:'ENOENT'}); }

test('MCP compares two saved files into grouped pending requests and keeps both input bytes unchanged',async()=>{
  const item=await comparisonFixture(), writesBefore=sourceWrites.length;
  const made=await item.host.handler('create_request_from_files',item.args,item.workspace);
  assert.equal(made.status,'pending'); assert.equal(made.pending,2);
  const text=await fs.readFile(item.output,'utf8'), request=JSON.parse(text);
  assert.equal(request.path,item.args.path); assert.ok(request.time);
  assert.ok(request.request.every(entry=>entry.status==='pending' && !Object.hasOwn(entry,'reason')));
  assert.ok(request.request[0].before.includes('\n'));
  const {resolveRequest}=require('../src/request.ts');
  assert.equal(resolveRequest(request,item.before.toString()).file.after,item.after.toString());
  assert.deepEqual(await fs.readFile(item.original.fsPath),item.before);
  assert.deepEqual(await fs.readFile(item.proposed.fsPath),item.after);
  assert.equal(sourceWrites.length,writesBefore);
  const status=await item.host.handler('get_request_status',{requestId:made.requestId},item.workspace);
  assert.equal(status.requestId,made.requestId); assert.equal(status.pending,2);
  const retry=await item.host.handler('create_request_from_files',item.args,item.workspace);
  assert.equal(retry.requestId,made.requestId); assert.equal(await fs.readFile(item.output,'utf8'),text);
  await assert.rejects(item.host.handler('create_request_from_files',{...item.args,reason:'Different intent'},item.workspace),codeIs('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(item.host.handler('create_request_from_files',{...item.args,clientRequestId:'another-'+serial},item.workspace),codeIs('REQUEST_EXISTS'));
  assert.equal(await fs.readFile(item.output,'utf8'),text);
  const state=await item.api.getState(Uri.file(item.output));
  await item.api.decide(Uri.file(item.output),item.args.path,state.files[0].hunks[0].id,'accepted',state.revision);
  const reviewed=await item.host.handler('create_request_from_files',item.args,item.workspace);
  assert.equal(reviewed.requestId,made.requestId); assert.equal(reviewed.accepted,1,'Retry retrieves existing human decisions without regenerating from a changed source');
});

test('MCP file comparison separates LaTeX prose and equations and reviews each insertion independently', async () => {
  const blocks = [
    'Introduce the first equation.',
    '\\begin{equation*}\na = b\n\\end{equation*}',
    'Introduce the second equation.',
    '\\begin{equation*}\nc = d\n\\end{equation*}'
  ];
  const saved = selected => '\uFEFFheading\r\n' + selected.map(block => block.replaceAll('\n', '\r\n') + '\r\n').join('') + 'tail\r\n';
  const item = await comparisonFixture({extension: 'tex', before: saved([]), after: saved(blocks)});
  const writesBefore = sourceWrites.length;
  const made = await item.host.handler('create_request_from_files', item.args, item.workspace);
  assert.equal(made.pending, 4);
  const request = JSON.parse(await fs.readFile(item.output, 'utf8'));
  assert.deepEqual(request.request.map(({line, before, after}) => ({line, before, after})),
    blocks.map(after => ({line: 2, before: null, after})));
  const {resolveRequest} = require('../src/request.ts');
  assert.equal(resolveRequest(request, item.before.toString()).file.after, item.after.toString());
  assert.deepEqual(await fs.readFile(item.original.fsPath), item.before);
  assert.deepEqual(await fs.readFile(item.proposed.fsPath), item.after);
  assert.equal(sourceWrites.length, writesBefore);

  const review = {request: Uri.file(item.output), target: item.original, relative: item.args.path};
  let state = await ready(item.api, review);
  await item.api.decide(review.request, review.relative, state.files[0].hunks[1].id, 'accepted', state.revision);
  assert.equal(await read(item.original), saved([blocks[1]]));
  state = await ready(item.api, review);
  await item.api.decide(review.request, review.relative, state.files[0].hunks[3].id, 'accepted', state.revision);
  assert.equal(await read(item.original), saved([blocks[1], blocks[3]]));
  assert.deepEqual(await statuses(review), ['pending', 'accepted', 'pending', 'accepted']);

  state = await ready(item.api, review);
  await item.api.undo(review.request, review.relative, state.files[0].hunks[1].id, state.revision);
  assert.equal(await read(item.original), saved([blocks[3]]));
  assert.deepEqual(await statuses(review), ['pending', 'pending', 'pending', 'accepted']);
  assert.deepEqual(await fs.readFile(item.proposed.fsPath), item.after);
  const status = await item.host.handler('get_request_status', {requestId: made.requestId}, item.workspace);
  assert.equal(status.pending, 3); assert.equal(status.accepted, 1);
});

test('MCP file comparison rejects stale hashes, dirty inputs/output, identical files, and unknown fields',async()=>{
  for(const field of ['expectedHash','expectedProposedHash']) {
    const item=await comparisonFixture();
    await assert.rejects(item.host.handler('create_request_from_files',{...item.args,[field]:'0'.repeat(64)},item.workspace),codeIs(field==='expectedHash'?'STALE_TARGET':'STALE_PROPOSED'));
    await noComparisonOutput(item);
  }
  for(const target of ['original','proposed','output']) {
    const item=await comparisonFixture(); const uri=target==='output'?Uri.file(item.output):item[target];
    documents.set(uri.toString(),{uri,isDirty:true,getText:()=> 'unsaved'});
    try {await assert.rejects(item.host.handler('create_request_from_files',item.args,item.workspace),codeIs('DIRTY_DOCUMENT'));}
    finally {documents.delete(uri.toString());}
    await noComparisonOutput(item);
  }
  const item=await comparisonFixture();
  await assert.rejects(item.host.handler('create_request_from_files',{...item.args,proposedPath:item.args.path,expectedProposedHash:item.args.expectedHash},item.workspace),codeIs('SAME_FILE'));
  await assert.rejects(item.host.handler('create_request_from_files',{...item.args,status:'accepted'},item.workspace),codeIs('INVALID_ARGUMENT'));
  await fs.writeFile(item.proposed.fsPath,item.before);
  await assert.rejects(item.host.handler('create_request_from_files',{...item.args,expectedProposedHash:item.args.expectedHash},item.workspace),codeIs('NO_CHANGES'));
  await noComparisonOutput(item);
});

test('MCP file comparison stays inside the selected workspace and detects dirty aliases and late modified-copy edits',async()=>{
  const item=await comparisonFixture();
  for(const proposedPath of ['../outside.txt',item.proposed.fsPath,'.git/config']) {
    await assert.rejects(item.host.handler('create_request_from_files',{...item.args,proposedPath},item.workspace));
    await noComparisonOutput(item);
  }
  const alias=Uri.file(path.join(path.dirname(item.proposed.fsPath),'hardlink.txt'));
  await fs.link(item.proposed.fsPath,alias.fsPath);
  documents.set(alias.toString(),{uri:alias,isDirty:true,getText:()=> 'unsaved alias'});
  try {await assert.rejects(item.host.handler('create_request_from_files',item.args,item.workspace),codeIs('DIRTY_DOCUMENT'));}
  finally {documents.delete(alias.toString());}
  await noComparisonOutput(item);
  const originalRead=item.host.readTarget.bind(item.host); let reads=0;
  item.host.readTarget=async(folder,filePath)=>{
    const result=await originalRead(folder,filePath);
    if(filePath===item.args.proposedPath && ++reads===1) await fs.writeFile(item.proposed.fsPath,'changed later\n');
    return result;
  };
  await assert.rejects(item.host.handler('create_request_from_files',item.args,item.workspace),codeIs('STALE_PROPOSED'));
  await noComparisonOutput(item);
  assert.deepEqual(await fs.readFile(item.original.fsPath),item.before);
});

test('editAndAccept commits an unchanged draft directly as accepted with no intermediate pending write', async () => {
  const item = await fixture(), records = [], stored = context();
  const api = new ReviewService(stored, async (uri, bytes) => {records.push(JSON.parse(Buffer.from(bytes).toString('utf8'))); await fs.writeFile(uri.fsPath, bytes);});
  const state = await ready(api, item), count = sourceWrites.length;
  const result = await api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'ONE', state.revision);
  assert.equal(result.changed, true); assert.notEqual(result.revision, state.revision);
  assert.equal(result.completionPrompt, undefined, 'A remaining pending entry must not prompt');
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n');
  assert.deepEqual(await statuses(item), ['accepted', 'pending']);
  assert.equal(records.length, 1); assert.equal(records[0].request[0].status, 'accepted');
  assert.equal(sourceWrites.length, count + 1); assert.equal(journals(stored).length, 0);
});

test('editAndAccept commits the current multiline draft and Undo preserves other accepted entries', async () => {
  const item = await fixture(), created = service(); let state = await ready(created.api, item);
  await created.api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'accepted', state.revision);
  state = await ready(created.api, item);
  const result = await created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'edited first\nedited second', state.revision);
  assert.equal(await read(item.target), 'edited first\nedited second\ncontext\nTHREE\n');
  assert.deepEqual(await statuses(item), ['accepted', 'accepted']);
  state = await ready(service(created.state).api, item); assert.equal(result.revision, state.revision);
  const entry = JSON.parse(await read(item.request)).request[0];
  assert.equal(entry.after.includes('edited first\nedited second'), true);
  await created.api.undo(item.request, item.relative, state.files[0].hunks[0].id, state.revision);
  assert.equal(await read(item.target), 'one\ncontext\nTHREE\n');
  assert.deepEqual(await statuses(item), ['pending', 'accepted']);
});

test('editAndAccept removes a draft restored to the original without accepting the next entry', async () => {
  const item = await fixture(), created = service(), count = sourceWrites.length;
  const state = await ready(created.api, item);
  await created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'one', state.revision);
  const entries = JSON.parse(await read(item.request)).request;
  assert.equal(entries.length, 1); assert.equal(entries[0].line, 3); assert.equal(entries[0].status, 'pending');
  assert.equal(await read(item.target), item.before); assert.equal(sourceWrites.length, count);
  const solo = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
  const single = await ready(created.api, solo);
  settings.set('autoDeleteCompleted', true);
  try {
    const result = await created.api.editAndAccept(solo.request, solo.relative, single.files[0].hunks[0].id, 'old', single.revision);
    assert.deepEqual(await statuses(solo), []); assert.equal(await read(solo.target), 'old\n');
    assert.ok(result.completionPrompt, 'Accept removing the final pending entry still confirms deletion');
    const prompt = result.completionPrompt;
    await created.api.resolveCompletion(solo.request, prompt.completionId, prompt.revision, true, false);
    await assert.rejects(fs.stat(solo.request.fsPath), {code: 'ENOENT'});
    assert.equal(await read(solo.target), 'old\n');
  } finally {settings.set('autoDeleteCompleted', false);}
});

test('editAndAccept rejects stale request/source, dirty models, untrusted workspaces and invalid drafts before writes', async () => {
  for (const kind of ['request', 'source', 'dirty-source', 'dirty-request', 'untrusted', 'invalid-draft']) {
    const item = await fixture(), created = service(); const state = await ready(created.api, item);
    let dirty;
    if (kind === 'request') await fs.appendFile(item.request.fsPath, ' ');
    if (kind === 'source') await fs.writeFile(item.target.fsPath, 'EXTERNAL\n');
    if (kind.startsWith('dirty-')) {dirty = await vscode.workspace.openTextDocument(kind === 'dirty-source' ? item.target : item.request); dirty.isDirty = true;}
    const raw = await read(item.request), target = await read(item.target), count = sourceWrites.length;
    if (kind === 'untrusted') vscode.workspace.isTrusted = false;
    try {
      await assert.rejects(created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id,
        kind === 'invalid-draft' ? 'bad\0draft' : 'EDITED', state.revision), /changed|unsaved|Save|Trust|NUL/);
      assert.equal(await read(item.request), raw, kind); assert.equal(await read(item.target), target, kind);
      assert.equal(sourceWrites.length, count, kind); assert.equal(journals(created.state).length, 0, kind);
    } finally {if (dirty) dirty.isDirty = false; vscode.workspace.isTrusted = true;}
  }
});

test('editAndAccept source failure before writing preserves both files and a retry uses the same draft', async () => {
  const item = await fixture(), created = service(); const state = await ready(created.api, item), raw = await read(item.request);
  sourceFault = {path: item.target.fsPath, when: 'before'};
  await assert.rejects(created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'EDITED', state.revision), /Injected source failure/);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), item.before);
  assert.equal(journals(created.state).length, 0);
  await created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'EDITED', state.revision);
  assert.equal(await read(item.target), 'EDITED\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'pending']);
});

test('editAndAccept RR failure retains the combined draft and decision journal for exact restart recovery', async () => {
  const item = await fixture(), created = service(); const state = await ready(created.api, item);
  created.requestFault.remaining = Infinity;
  await assert.rejects(created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'EDITED\nSECOND', state.revision), /Injected RR failure/);
  assert.equal(await read(item.target), 'EDITED\nSECOND\ncontext\nthree\n');
  assert.deepEqual(await statuses(item), ['pending', 'pending']); assert.equal(journals(created.state).length, 1);
  const count = sourceWrites.length;
  const recovered = service(created.state); await ready(recovered.api, item);
  assert.equal(sourceWrites.length, count); assert.deepEqual(await statuses(item), ['accepted', 'pending']);
  assert.equal(journals(created.state).length, 0);
  assert.equal(JSON.parse(await read(item.request)).request[0].after, 'EDITED\nSECOND');
});

test('editAndAccept final completion confirms deletion after recording the edited accepted proposal', async () => {
  const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
  const created = service(), receipts = [];
  created.api.setCompletionRecorder(async (_uri, cleanup) => {receipts.push(cleanup);});
  const state = await ready(created.api, item);
  settings.set('autoDeleteCompleted', true);
  try {
    const result = await created.api.editAndAccept(item.request, item.relative, state.files[0].hunks[0].id, 'edited', state.revision);
    assert.ok(result.completionPrompt); assert.equal(result.changed, true);
    assert.equal(await read(item.target), 'edited\n'); assert.deepEqual(await statuses(item), ['accepted']);
    assert.equal((await ready(created.api, item)).files[0].hunks[0].after, 'edited\n');
    assert.deepEqual(receipts, ['retained']);
    const prompt = result.completionPrompt; assert.equal(prompt.revision, result.revision);
    await created.api.resolveCompletion(item.request, prompt.completionId, prompt.revision, true, false);
    await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
    assert.deepEqual(receipts, ['retained', 'deleted']); assert.deepEqual(created.state.workspaceState.keys(), []);
  } finally {settings.set('autoDeleteCompleted', false);}
});

test('opening an empty request or editing away its final entry does not start completion', async () => {
  const empty = await fixture('old\n', []), {api} = service(), receipts = [];
  api.setCompletionRecorder(async (_uri, cleanup) => {receipts.push(cleanup);});
  await ready(api, empty);
  const item = await fixture('old\n', [{line: 1, before: 'old', after: 'new', status: 'pending'}]);
  const state = await ready(api, item);
  const result = await api.editPending(item.request, item.relative, state.files[0].hunks[0].id, 'old', state.revision);
  assert.equal(result.completionPrompt, undefined); assert.deepEqual(await statuses(item), []);
  await ready(api, item); assert.deepEqual(receipts, []); assert.equal(await read(item.target), 'old\n');
});

test('review state validates and refreshes the configurable edit acceptance shortcut', async () => {
  const item = await fixture(), {api} = service();
  try {
    settings.delete('acceptShortcut'); assert.equal((await ready(api, item)).acceptShortcut, 'ctrlEnter');
    for (const choice of ['ctrlEnter', 'altEnter', 'tab', 'shiftTab', 'none']) {
      settings.set('acceptShortcut', choice); assert.equal((await ready(api, item)).acceptShortcut, choice);
    }
    for (const invalid of ['invalid', null, 42]) {
      settings.set('acceptShortcut', invalid); assert.equal((await ready(api, item)).acceptShortcut, 'ctrlEnter');
    }
  } finally {settings.delete('acceptShortcut');}
});


test('preview highlighting dispatches by the target language without changing request or source', async () => {
  for (const extension of ['tex', 'ltx', 'LaTeX', 'py']) {
    const item = await fixture('f(a)\n', [{line: 1, before: 'a', after: 'b', status: 'pending'}], true, extension);
    const originalRequest = await read(item.request), originalSource = await read(item.target);
    const {api} = service(), writesBefore = sourceWrites.length;
    const state = await ready(api, item), hunk = state.files[0].hunks[0], inline = hunk.inlineChanges[0];
    const changed = side => inline[side].filter(segment => segment.changed).map(segment => segment.text);
    assert.deepEqual(changed('before'), [extension === 'py' ? 'a' : '(a)']);
    assert.deepEqual(changed('after'), [extension === 'py' ? 'b' : '(b)']);
    assert.equal(inline.before.map(segment => segment.text).join(''), 'f(a)');
    assert.equal(inline.after.map(segment => segment.text).join(''), 'f(b)');
    const refreshed = await ready(api, item);
    assert.equal(refreshed.files[0].hunks[0].id, hunk.id, 'Presentation rules do not change review identity');
    assert.equal(await read(item.target), originalSource);
    assert.equal(await read(item.request), originalRequest);
    assert.equal(sourceWrites.length, writesBefore, 'Computing language-specific highlights never writes the source');
  }
});

test('preview uses full Markdown context and updates it after real review decisions', async () => {
  const item = await fixture('~~~unknown\na[i+1]\n~~~\n', [
    {line: 1, before: 'unknown', after: 'python', status: 'pending'},
    {line: 2, before: '1', after: '2', status: 'pending'}
  ], true, 'md');
  const {api} = service();
  let state = await ready(api, item);
  const highlights = () => state.files[0].hunks[1].inlineChanges[0].after.filter(part => part.changed).map(part => part.text);
  assert.deepEqual(highlights(), ['a[i+2]']);
  const firstId = state.files[0].hunks[0].id, secondId = state.files[0].hunks[1].id;
  await api.decide(item.request, item.relative, firstId, 'accepted', state.revision);
  state = await ready(api, item); assert.deepEqual(highlights(), ['2']);
  assert.equal(state.files[0].hunks[1].id, secondId);
  await api.undo(item.request, item.relative, firstId, state.revision);
  state = await ready(api, item); assert.deepEqual(highlights(), ['a[i+2]']);
  await api.decide(item.request, item.relative, firstId, 'ignored', state.revision);
  state = await ready(api, item); assert.deepEqual(highlights(), ['a[i+2]']);
  assert.equal(await read(item.target), item.before, 'Review context never applies pending text');
});

test('preview preserves string and comment context that begins outside a pending block', async () => {
  for (const [extension, opening, closing] of [['py','value = """','"""'], ['ts','/*','*/']]) {
    const item = await fixture(opening+'\na[i+1]\n'+closing+'\na[i+1]\n', [
      {line:2,before:'1',after:'2',status:'pending'}, {line:4,before:'1',after:'2',status:'pending'}
    ], true, extension);
    const {api} = service(), state = await ready(api,item);
    const values=state.files[0].hunks.map(hunk=>hunk.inlineChanges[0].after.filter(part=>part.changed).map(part=>part.text));
    assert.deepEqual(values,[['a[i+2]'],['2']]);
    assert.equal(await read(item.target),item.before);
  }
});

test('Git creation baselines block duplicate additions and survive restart, CRLF review and Undo', async () => {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  const {listGitFileHistory} = require('../src/gitOriginal.ts');
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  for(const ending of ['\n','\r\n']) {
    const baseline='start'+ending+'end'+ending, modified='start'+ending+'new'+ending+'end'+ending;
    const item=await fixture(modified,[{line:2,before:null,after:'new',status:'pending'}]);
    const repository=path.dirname(item.target.fsPath);
    const git=async(...args)=>(await run('git',['-C',repository,'-c','core.autocrlf=false',...args],
      {encoding:'utf8',windowsHide:true,timeout:10000,env})).stdout;
    await git('init','-q');await git('config','user.name','Revision Test');await git('config','user.email','test@example.invalid');
    await fs.writeFile(item.target.fsPath,'start\nend\n');
    await git('add','--',path.basename(item.target.fsPath));await git('commit','-q','-m','Original baseline');
    await fs.writeFile(item.target.fsPath,modified);
    const [original]=await listGitFileHistory(scratch,item.target.fsPath);
    assert.ok(original);
    const first=service();
    // Simulate a read that races creation metadata; it must not establish a wrong permanent baseline.
    const premature=await ready(first.api,item), id=premature.files[0].hunks[0].id;
    await first.api.rememberGitOriginal(item.request,original);
    const blocked=await first.api.getState(item.request);
    assert.equal(blocked.verified,false);assert.match(blocked.error,/Git commit.*matches that version/);
    const writes=sourceWrites.length;
    await assert.rejects(first.api.decide(item.request,item.relative,id,'accepted',blocked.revision),/Git commit/);
    assert.equal(sourceWrites.length,writes);assert.equal(await read(item.target),modified);
    const restarted=service(first.state);
    assert.equal((await restarted.api.getState(item.request)).verified,false,'Origin guard persists through extension restart');
    await fs.writeFile(item.target.fsPath,baseline);
    let state=await ready(restarted.api,item);
    const currentId=state.files[0].hunks[0].id;
    await restarted.api.decide(item.request,item.relative,currentId,'accepted',state.revision);
    assert.equal(await read(item.target),modified,'The added line appears exactly once with actual target line endings');
    state=await ready(restarted.api,item);
    await restarted.api.undo(item.request,item.relative,currentId,state.revision);
    assert.equal(await read(item.target),baseline);
    const pending=await ready(restarted.api,item);
    await restarted.api.editPending(item.request,item.relative,pending.files[0].hunks[0].id,'other',pending.revision);
    await ready(restarted.api,item);
    await restarted.api.deleteRequest(item.request);
    assert.deepEqual(first.state.workspaceState.keys(),[],'Deletion removes both baseline and Git-origin records');
    assert.equal(await read(item.target),baseline);
  }
});

test('review menu keeps original Python lines as comments and writes only on Accept', async () => {
  const item = await fixture('value = 1\n', [{line:1,before:'1',after:'2',status:'pending'}], true, 'py');
  const {api,state:contextState} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0];
  const originalRequest = await read(item.request), writeCount = sourceWrites.length;
  const capabilities = await api.reviewActions(item.request,item.relative,hunk.id,'value = 2 + 3',state.revision);
  assert.deepEqual(capabilities,[{id:'comment',label:'Keep original as comments',enabled:true}]);
  const result = await api.transformDraft(item.request,item.relative,hunk.id,'value = 2 + 3',state.revision,'comment');
  assert.equal(result.draft,'# value = 1\nvalue = 2 + 3');
  assert.equal(await read(item.request),originalRequest);
  assert.equal(await read(item.target),item.before); assert.equal(sourceWrites.length,writeCount);
  await api.editAndAccept(item.request,item.relative,hunk.id,result.draft,state.revision);
  assert.equal(await read(item.target),'# value = 1\nvalue = 2 + 3\n');
  assert.deepEqual(await statuses(item),['accepted']);
  const reopened = service(contextState).api, accepted = await ready(reopened,item);
  await reopened.undo(item.request,item.relative,accepted.files[0].hunks[0].id,accepted.revision);
  assert.equal(await read(item.target),item.before);
  assert.deepEqual(await statuses(item),['pending']);
});

test('review menu refuses stale, resolved, dirty, untrusted and removed operations without writes', async () => {
  const item = await fixture('value = 1\n', [{line:1,before:'1',after:'2',status:'pending'}], true, 'py');
  const {api} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0], raw = await read(item.request);
  const writeCount = sourceWrites.length;
  await assert.rejects(api.transformDraft(item.request,item.relative,hunk.id,'value = 2','stale','comment'),/request changed/i);
  for (const action of ['markAdded','markRemoved','invented']) {
    await assert.rejects(api.transformDraft(item.request,item.relative,hunk.id,'value = 2',state.revision,action),/Unknown proposal action/);
  }
  const targetDocument = await vscode.workspace.openTextDocument(item.target);
  targetDocument.isDirty = true;
  try { await assert.rejects(api.transformDraft(item.request,item.relative,hunk.id,'value = 2',state.revision,'comment'),/unsaved edits/); }
  finally {targetDocument.isDirty = false;}
  const requestDocument = await vscode.workspace.openTextDocument(item.request);
  requestDocument.isDirty = true;
  try { await assert.rejects(api.reviewActions(item.request,item.relative,hunk.id,'value = 2',state.revision),/Save the .rr request/); }
  finally {requestDocument.isDirty = false;}
  vscode.workspace.isTrusted = false;
  try {
    await assert.rejects(api.reviewActions(item.request,item.relative,hunk.id,'value = 2',state.revision),/Trust/);
    await assert.rejects(api.transformDraft(item.request,item.relative,hunk.id,'value = 2',state.revision,'comment'),/Trust/);
  } finally {vscode.workspace.isTrusted = true;}
  assert.equal(await read(item.request),raw); assert.equal(await read(item.target),item.before);
  assert.equal(sourceWrites.length,writeCount);
  await api.decide(item.request,item.relative,hunk.id,'ignored',state.revision);
  const ignored = await ready(api,item);
  await assert.rejects(api.reviewActions(item.request,item.relative,ignored.files[0].hunks[0].id,'value = 2',ignored.revision),/pending/);
});

test('TeX math lines keep their original labels in comments and proposed lines active without setup', async () => {
  const oldLines = '  x &= 1, \\\\\n  y &= 2.\\label{eq:old}';
  const proposed = '  x &= 3, \\\\\n  y &= 4.\\label{eq:new}';
  const original = '\\begin{align}\n' + oldLines + '\n\\end{align}\n';
  const item = await fixture(original,[{line:2,before:oldLines,after:proposed,status:'pending'}],true,'tex');
  const {api} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0];
  const raw = await read(item.request), files = await fs.readdir(path.dirname(item.target.fsPath));
  const result = await api.transformDraft(item.request,item.relative,hunk.id,proposed,state.revision,'comment');
  const commented = '  % x &= 1, \\\\\n  % y &= 2.\\label{eq:old}';
  assert.equal(result.draft,commented + '\n' + proposed);
  assert.equal(await read(item.request),raw); assert.equal(await read(item.target),original);
  assert.deepEqual(await fs.readdir(path.dirname(item.target.fsPath)),files,'The menu creates no macro or import files');
  await api.editAndAccept(item.request,item.relative,hunk.id,result.draft,state.revision);
  assert.equal(await read(item.target),'\\begin{align}\n' + commented + '\n' + proposed + '\n\\end{align}\n');
  const accepted = await ready(api,item);
  await api.undo(item.request,item.relative,accepted.files[0].hunks[0].id,accepted.revision);
  assert.equal(await read(item.target),original);
});

test('comment availability distinguishes inserted content from an existing blank line', async () => {
  const inserted = await fixture('tail\n',[{line:1,before:null,after:'value = 2',status:'pending'}],true,'py');
  const {api} = service(); let state = await ready(api,inserted), hunk = state.files[0].hunks[0];
  const actions = await api.reviewActions(inserted.request,inserted.relative,hunk.id,'value = 2',state.revision);
  assert.equal(actions.length,1); assert.equal(actions[0].enabled,false);
  await assert.rejects(api.transformDraft(inserted.request,inserted.relative,hunk.id,'value = 2',state.revision,'comment'),/original/i);
  const blank = await fixture('\ntail\n',[{line:1,before:'',after:'value = 2',status:'pending'}],true,'py');
  state = await ready(api,blank); hunk = state.files[0].hunks[0];
  const transformed = await api.transformDraft(blank.request,blank.relative,hunk.id,'value = 2',state.revision,'comment');
  assert.equal(transformed.draft,'#\nvalue = 2');
  assert.equal(await read(inserted.target),inserted.before); assert.equal(await read(blank.target),blank.before);
});

test('deletion retains the original full line as a comment and can be undone exactly', async () => {
  const item = await fixture('value = 1\ntail\n',[{line:1,before:'value = 1',after:null,status:'pending'}],true,'py');
  const {api} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0];
  const result = await api.transformDraft(item.request,item.relative,hunk.id,'',state.revision,'comment');
  assert.equal(result.draft,'# value = 1'); assert.equal(await read(item.target),item.before);
  await api.editAndAccept(item.request,item.relative,hunk.id,result.draft,state.revision);
  assert.equal(await read(item.target),'# value = 1\ntail\n');
  const accepted = await ready(api,item);
  await api.undo(item.request,item.relative,accepted.files[0].hunks[0].id,accepted.revision);
  assert.equal(await read(item.target),item.before);
});

test('an empty replacement draft keeps its active blank line after the original comments', async () => {
  for (const after of ['', 'value = 2']) {
    const item = await fixture('value = 1\ntail\n',[{line:1,before:'value = 1',after,status:'pending'}],true,'py');
    const {api} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0];
    const raw = await read(item.request);
    const result = await api.transformDraft(item.request,item.relative,hunk.id,'',state.revision,'comment');
    assert.equal(result.draft,'# value = 1\n');
    assert.equal(await read(item.request),raw); assert.equal(await read(item.target),item.before);
    await api.editAndAccept(item.request,item.relative,hunk.id,result.draft,state.revision);
    assert.equal(await read(item.target),'# value = 1\n\ntail\n');
    const accepted = await ready(api,item);
    await api.undo(item.request,item.relative,accepted.files[0].hunks[0].id,accepted.revision);
    assert.equal(await read(item.target),item.before);
  }
});

test('original comments preserve UTF-8 BOM, line endings and final-newline state through Accept and Undo', async () => {
  for (const ending of ['\n','\r\n','']) {
    const item = await fixture('\uFEFFvalue = 1' + ending,[{line:1,before:'1',after:'2',status:'pending'}],true,'py');
    const {api} = service(), state = await ready(api,item), hunk = state.files[0].hunks[0];
    const result = await api.transformDraft(item.request,item.relative,hunk.id,'value = 2',state.revision,'comment');
    assert.equal(result.draft,'# value = 1\nvalue = 2'); assert.equal(await read(item.target),item.before);
    await api.editAndAccept(item.request,item.relative,hunk.id,result.draft,state.revision);
    assert.equal(await read(item.target),'\uFEFF# value = 1' + (ending || '\n') + 'value = 2' + ending);
    const accepted = await ready(api,item);
    await api.undo(item.request,item.relative,accepted.files[0].hunks[0].id,accepted.revision);
    assert.equal(await read(item.target),item.before);
  }
});
