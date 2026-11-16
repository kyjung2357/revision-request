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
const sourceNavigations = [];
const pdfCommands = [];
let workshopAvailable = true, workshopActivate, pdfCommandHook;
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
  Uri, ViewColumn: {Active: -1}, TextEditorRevealType: {InCenter: 1},
  Position: class {constructor(line, character) {this.line = line; this.character = character;}},
  Range: class {constructor(start, end) {this.start = start; this.end = end;}},
  ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
  EventEmitter: class {
    listeners = new Set();
    event = listener => {this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)};};
    fire(value) {for (const listener of this.listeners) listener(value);}
    dispose() {this.listeners.clear();}
  },
  TabInputText: class {},
  TabInputCustom: class {constructor(uri,viewType){this.uri=uri;this.viewType=viewType;}},
  TabInputWebview: class {constructor(viewType){this.viewType=viewType;}},
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
        uri, isDirty: false, isClosed: false, languageId: /\.(tex|ltx|latex)$/i.test(uri.fsPath) ? 'latex' : 'plaintext',
        getText() {return this.staleText ?? syncFs.readFileSync(uri.fsPath, 'utf8').replace(/^\uFEFF/, '');},
        get lineCount() {return this.getText().split(/\r\n|\r|\n/).length;}
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
  extensions: {getExtension(id) {
    assert.equal(id, 'James-Yu.latex-workshop');
    return workshopAvailable ? {activate: async () => {await workshopActivate?.();}} : undefined;
  }},
  commands: {async executeCommand(command, ...args) {
    pdfCommands.push({command, args, editor: vscode.window.activeTextEditor});
    const source=vscode.window.activeTextEditor;
    const handled=await pdfCommandHook?.(command,args);
    if(command==='latex-workshop.view' && handled!=='handled' && source) {
      const uri=Uri.file(source.document.uri.fsPath.replace(/\.[^.]+$/,'.pdf'));
      const tab={input:new vscode.TabInputCustom(uri,'latex-workshop-pdf-hook'),isActive:true};
      const group={viewColumn:source.viewColumn+1,tabs:[tab],activeTab:tab};
      vscode.window.tabGroups.all=[group];
    }
    if(command==='vscode.openWith') {
      const [uri,viewType,options]=args;
      const group=vscode.window.tabGroups.all.find(group=>group.viewColumn===options.viewColumn);
      const tab=group?.tabs.find(tab=>tab.input instanceof vscode.TabInputCustom&&tab.input.uri.toString()===uri.toString()&&tab.input.viewType===viewType);
      if(!tab)throw Error('Wrong PDF tab');
      group.activeTab=tab;for(const item of group.tabs)item.isActive=item===tab;
      vscode.window.activeTextEditor=undefined;vscode.window.tabGroups.activeTabGroup=group;
    }
  }},
  window: {tabGroups: {all: [], close: async () => true}, showWarningMessage: (_message, _options, action) => action === 'Build PDF' ? action : undefined,
    async showTextDocument(document, options) {
      const navigation = {document, options}; sourceNavigations.push(navigation);
      const editor = {document, viewColumn: options.viewColumn === -1 ? 2 : options.viewColumn, selection: options.selection, revealRange: (range, type) => {navigation.reveal = {range, type};}};
      const group=vscode.window.tabGroups.all.find(group=>group.viewColumn===editor.viewColumn);
      if(group){const input=new vscode.TabInputText();input.uri=document.uri;const tab={input,isActive:true};for(const t of group.tabs)t.isActive=false;group.tabs.push(tab);group.activeTab=tab;}
      vscode.window.activeTextEditor = editor;
      return editor;
    }
  },
};
const load = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : load.call(this, name, parent, main); };
require('tsx/cjs');
const {ReviewService} = require('../src/extension.ts');
const {McpHost} = require('../src/mcpHost.ts');
Module._load = load;
function context() {
  const values = new Map();
  return {globalStorageUri: Uri.file(path.join(scratch, '.codex-storage')), workspaceState: {get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    update: async (key, value) => {if (value === undefined) values.delete(key); else values.set(key, structuredClone(value));},
    keys: () => [...values.keys()]}};
}
function service(state = context(), requestFault = {remaining: 0, when: 'before'}, pdfTools) {
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
  }, pdfTools)};
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
  assert.equal(state.closed, true); assert.equal(state.verified, false); assert.ok(state.verificationIssue); assert.equal(state.files.length, 0, 'Tampered decisions cannot produce a verified comparison'); assert.equal(await read(item.target), item.before);
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


test('original-line navigation accounts only for earlier accepted edits including same-anchor insertion', async () => {
  const item = await fixture('drop\nexpand\nkeep\nfocus\nlast\n', [
    {line:1,before:'drop',after:null,status:'pending'},
    {line:2,before:'expand',after:'one\ntwo\nthree',status:'pending'},
    {line:3,before:'keep',after:'ignored\nextra',status:'pending'},
    {line:4,before:null,after:'insert a\ninsert b',status:'pending'},
    {line:4,before:'focus',after:'FOCUS',status:'pending'}
  ]);
  const {api} = service(); let state = await ready(api,item);
  for(const [index,decision] of [[0,'accepted'],[1,'accepted'],[2,'ignored'],[3,'accepted']]) {
    await api.decide(item.request,item.relative,state.files[0].hunks[index].id,decision,state.revision);
    state = await ready(api,item);
  }
  const beforeSource=await read(item.target),beforeRequest=await read(item.request),writes=sourceWrites.length;
  await api.openTargetLine(item.request,item.relative,state.files[0].hunks[4].id,state.revision);
  const navigation=sourceNavigations.at(-1),selection=navigation.options.selection;
  assert.equal(navigation.document.uri.toString(),item.target.toString());
  assert.deepEqual([selection.start.line,selection.start.character,selection.end.line,selection.end.character],[6,0,6,0]);
  assert.equal(navigation.document.getText().split('\n')[selection.start.line],'focus');
  assert.equal(navigation.options.preserveFocus,false);assert.equal(navigation.options.preview,false);
  assert.equal(navigation.options.viewColumn,vscode.ViewColumn.Active);
  assert.deepEqual(navigation.reveal,{range:selection,type:vscode.TextEditorRevealType.InCenter});
  assert.equal(await read(item.target),beforeSource);assert.equal(await read(item.request),beforeRequest);assert.equal(sourceWrites.length,writes);
});

test('original-line navigation works with BOM and all line endings without requiring workspace write trust', async () => {
  for(const ending of ['\n','\r\n','\r']) {
    const item=await fixture('\uFEFFhead'+ending+'focus'+ending,[{line:2,before:'focus',after:'FOCUS',status:'pending'}]);
    const {api}=service(),state=await ready(api,item);
    vscode.workspace.isTrusted=false;
    try {await api.openTargetLine(item.request,item.relative,state.files[0].hunks[0].id,state.revision);}
    finally {vscode.workspace.isTrusted=true;}
    assert.equal(sourceNavigations.at(-1).options.selection.start.line,1);
    assert.equal(await read(item.target),item.before);
  }
});

test('original-line navigation refuses stale requests, source mismatches, dirty buffers and unavailable original rows', async () => {
  for(const kind of ['revision','source','dirty-source','dirty-request','stale-model','unknown-hunk','unknown-file','resolved','insertion']) {
    const item=kind==='insertion'?await fixture(undefined,[{line:1,before:null,after:'inserted',status:'pending'}]):await fixture();
    const {api}=service();let state=await ready(api,item),hunkId=state.files[0].hunks[0].id,dirty;
    if(kind==='source')await fs.writeFile(item.target.fsPath,'external\n'+item.before);
    if(kind.startsWith('dirty-')) {dirty=await vscode.workspace.openTextDocument(kind==='dirty-source'?item.target:item.request);dirty.isDirty=true;}
    if(kind==='stale-model') {dirty=await vscode.workspace.openTextDocument(item.target);dirty.staleText='outdated model';}
    if(kind==='resolved') {await api.decide(item.request,item.relative,hunkId,'ignored',state.revision);state=await ready(api,item);}
    const beforeSource=await read(item.target),beforeRequest=await read(item.request),opens=sourceNavigations.length,writes=sourceWrites.length;
    try {
      await assert.rejects(api.openTargetLine(item.request,kind==='unknown-file'?'../outside.txt':item.relative,
        kind==='unknown-hunk'?'missing':hunkId,kind==='revision'?'obsolete':state.revision),
        /request changed|original has changed|unsaved|Save the .rr|original changed|existing original line|Unknown request file/i);
      assert.equal(sourceNavigations.length,opens);assert.equal(sourceWrites.length,writes);
      assert.equal(await read(item.target),beforeSource);assert.equal(await read(item.request),beforeRequest);
    } finally {if(dirty){dirty.isDirty=false;delete dirty.staleText;}}
  }
});

test('external gray edits preserve request bytes and IDs, shift current lines, and survive Accept Undo and restart', async () => {
  const item=await fixture(), first=service();let state=await ready(first.api,item);
  const ids=state.files[0].hunks.map(h=>h.id), raw=await read(item.request), oldRevision=state.revision, oldRawRevision=state.rawRevision;
  const manual='heading\none\ncontext revised manually\nextra context\nthree\n';
  await fs.writeFile(item.target.fsPath,manual);
  state=await ready(first.api,item);
  assert.equal(await read(item.request),raw);assert.equal(state.rawRevision,oldRawRevision);
  assert.notEqual(state.revision,oldRevision);assert.deepEqual(state.files[0].hunks.map(h=>h.id),ids);
  assert.deepEqual(state.files[0].hunks.map(h=>h.oldStart),[2,5]);assert.ok(state.files[0].hunks.every(h=>!h.conflict));
  await assert.rejects(first.api.decide(item.request,item.relative,ids[1],'accepted',oldRevision),/request changed/i);
  const restarted=service(first.state).api;state=await ready(restarted,item);
  await restarted.openTargetLine(item.request,item.relative,ids[1],state.revision);
  assert.equal(sourceNavigations.at(-1).options.selection.start.line,4);
  const comparison=await restarted.snapshots(item.request,item.relative,state.revision);
  assert.equal(comparison.before,manual);assert.equal(comparison.after,manual.replace('one\n','ONE\n').replace('three\n','THREE\n'));
  await restarted.decide(item.request,item.relative,ids[1],'accepted',state.revision);state=await ready(restarted,item);
  assert.equal(await read(item.target),manual.replace('three\n','THREE\n'));
  await restarted.undo(item.request,item.relative,ids[1],state.revision);
  assert.equal(await read(item.target),manual);assert.deepEqual(JSON.parse(await read(item.request)).request.map(e=>e.line),[1,3]);
});

test('external pending overlap blocks only that Accept while unrelated decisions and explicit conflict Ignore preserve the source', async () => {
  const item=await fixture(),{api}=service();let state=await ready(api,item);const ids=state.files[0].hunks.map(h=>h.id);
  const manual='manually replaced\ncontext\nthree\n';await fs.writeFile(item.target.fsPath,manual);state=await ready(api,item);
  assert.ok(state.files[0].hunks[0].conflict);assert.equal(state.files[0].hunks[1].conflict,undefined);assert.equal(state.files[0].issue,undefined);
  const raw=await read(item.request),writes=sourceWrites.length;
  await assert.rejects(api.decide(item.request,item.relative,undefined,'accepted',state.revision),/original changed|pending block|ambiguous/i);
  await assert.rejects(api.editAndAccept(item.request,item.relative,ids[0],'edited',state.revision),/original changed|pending block|ambiguous/i);
  assert.equal(await read(item.request),raw);assert.equal(sourceWrites.length,writes);
  await api.decide(item.request,item.relative,ids[1],'accepted',state.revision);state=await ready(api,item);
  assert.equal(await read(item.target),manual.replace('three\n','THREE\n'));assert.equal(state.closed,false);
  const approvedSource=await read(item.target);await api.decide(item.request,item.relative,ids[0],'ignored',state.revision);state=await ready(api,item);
  assert.equal(await read(item.target),approvedSource);assert.deepEqual(await statuses(item),['ignored','accepted']);
  assert.ok(state.files[0].hunks[0].undoBlocked);assert.equal(state.closed,true);
  await assert.rejects(api.undo(item.request,item.relative,ids[0],state.revision),/Undo is unavailable/i);
  await api.undo(item.request,item.relative,ids[1],state.revision);assert.equal(await read(item.target),manual);
});

test('external edits to decided gray text retain statuses and block only affected Undo', async () => {
  for(const decision of ['accepted','ignored']) {
    const item=await fixture(),created=service();let state=await ready(created.api,item);const ids=state.files[0].hunks.map(h=>h.id);
    await created.api.decide(item.request,item.relative,ids[0],decision,state.revision);
    await fs.writeFile(item.target.fsPath,'manual decided text\ncontext\nthree\n');
    const restarted=service(created.state).api;state=await ready(restarted,item);
    assert.equal(state.files[0].hunks[0].decision,decision);assert.ok(state.files[0].hunks[0].undoBlocked);
    assert.equal(state.files[0].hunks[0].before,'manual decided text\n');assert.equal(state.files[0].hunks[0].after,'manual decided text\n');
    await assert.rejects(restarted.undo(item.request,item.relative,ids[0],state.revision),/Undo is unavailable/i);
    await restarted.decide(item.request,item.relative,ids[1],'accepted',state.revision);
    assert.equal(await read(item.target),'manual decided text\ncontext\nTHREE\n');
  }
});

test('external gray edits survive editing a proposal and removing a no-op without deciding its neighbor', async () => {
  const item=await fixture(),created=service();let state=await ready(created.api,item);
  await fs.writeFile(item.target.fsPath,'heading\none\ncontext changed\nthree\n');state=await ready(created.api,item);
  await created.api.editPending(item.request,item.relative,state.files[0].hunks[1].id,'edited third',state.revision);
  let api=service(created.state).api;state=await ready(api,item);
  await api.editAndAccept(item.request,item.relative,state.files[0].hunks[0].id,'one',state.revision);
  state=await ready(api,item);assert.equal(state.files[0].hunks.length,1);assert.equal(state.files[0].hunks[0].decision,'pending');
  assert.equal(await read(item.target),'heading\none\ncontext changed\nthree\n');
  await api.editAndAccept(item.request,item.relative,state.files[0].hunks[0].id,'final third',state.revision);
  assert.equal(await read(item.target),'heading\none\ncontext changed\nfinal third\n');
});

test('external dirty original pauses synchronization until save and unknown imports never relocate themselves', async () => {
  const item=await fixture(),created=service();let state=await ready(created.api,item);const old=state.revision;
  const document=await vscode.workspace.openTextDocument(item.target);document.isDirty=true;
  try {
    const paused=await created.api.getState(item.request);assert.equal(paused.verified,false);assert.match(paused.files[0].issue,/unsaved/i);
    await assert.rejects(created.api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',old),/unsaved/i);
    await fs.writeFile(item.target.fsPath,'header\n'+item.before);
  } finally {document.isDirty=false;}
  state=await ready(created.api,item);assert.equal(state.files[0].hunks[0].oldStart,2);assert.notEqual(state.revision,old);
  const imported=await service().api.getState(item.request);assert.equal(imported.verified,false);assert.ok(imported.error);assert.equal(await read(item.target),'header\n'+item.before);
});

test('external source updates serialize with refresh and a late edit prevents source writes', async () => {
  const item=await fixture(),created=service();let state=await ready(created.api,item);
  await fs.writeFile(item.target.fsPath,'heading\n'+item.before);
  const views=await Promise.all(Array.from({length:5},()=>created.api.getState(item.request)));
  assert.ok(views.every(view=>view.verified));assert.equal(new Set(views.map(view=>view.revision)).size,1);
  state=views[0];const source=await read(item.target),request=await read(item.request),writes=sourceWrites.length;
  const update=created.state.workspaceState.update;let injected=false;
  created.state.workspaceState.update=async(key,value)=>{
    await update(key,value);
    if(!injected&&key.endsWith('.transaction')&&value){injected=true;await fs.writeFile(item.target.fsPath,source+'late edit\n');}
  };
  await assert.rejects(created.api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',state.revision),/original changed/i);
  assert.equal(sourceWrites.length,writes);assert.equal(await read(item.request),request);assert.equal(await read(item.target),source+'late edit\n');
});

test('external gray edits survive interrupted accepted write and exact metadata-only recovery', async () => {
  const item=await fixture(),created=service();let state=await ready(created.api,item);
  const manual='heading\none\nmanual context\nthree\n';await fs.writeFile(item.target.fsPath,manual);state=await ready(created.api,item);
  created.requestFault.remaining=2;const writes=sourceWrites.length;
  await assert.rejects(created.api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',state.revision),/Injected RR/);
  assert.equal(await read(item.target),manual.replace('one\n','ONE\n'));assert.equal(journals(created.state).length,1);
  state=await ready(service(created.state).api,item);
  assert.deepEqual(await statuses(item),['accepted','pending']);assert.equal(journals(created.state).length,0);assert.equal(sourceWrites.length,writes+1);
  assert.equal(state.files[0].before,manual.replace('one\n','ONE\n'));
});


test('warm parsing and projection caches still reject changed JSON, dirty buffers and pending source conflicts', async () => {
  const item = await fixture(); const {api} = service();
  const original = await ready(api, item);
  await ready(api, item); await ready(api, item);
  const raw = await read(item.request), writes = sourceWrites.length;
  await fs.writeFile(item.request.fsPath, raw.replace('"ONE"', '"NEW"'));
  await assert.rejects(api.decide(item.request, item.relative, original.files[0].hunks[0].id, 'accepted', original.revision), /request changed/i);
  let latest = await ready(api, item);
  assert.notEqual(latest.revision, original.revision);
  assert.equal(latest.files[0].hunks[0].after, 'NEW\n');
  const document = await vscode.workspace.openTextDocument(item.target); document.isDirty = true;
  const dirty = await api.getState(item.request); assert.equal(dirty.verified, false); assert.match(dirty.verificationIssue, /unsaved/i);
  await assert.rejects(api.decide(item.request, item.relative, latest.files[0].hunks[0].id, 'accepted', latest.revision), /unsaved/i);
  document.isDirty = false;
  await fs.writeFile(item.target.fsPath, 'manual\ncontext\nthree\n');
  latest = await ready(api, item); assert.ok(latest.files[0].hunks[0].conflict);
  await assert.rejects(api.decide(item.request, item.relative, latest.files[0].hunks[0].id, 'accepted', latest.revision), /changed inside|conflict/i);
  assert.equal(sourceWrites.length, writes); assert.equal(await read(item.target), 'manual\ncontext\nthree\n');
  await fs.writeFile(item.request.fsPath, '{invalid');
  assert.match((await api.getState(item.request)).error, /JSON syntax error/);
});

test('decisions retain their persisted baseline without rewriting it and new proposal generations still survive restart', async () => {
  const item = await fixture(), state = context(), updates = [];
  const update = state.workspaceState.update;
  state.workspaceState.update = async (key, value) => {updates.push(key); await update(key, value);};
  const {api} = service(state); let view = await ready(api, item);
  updates.length = 0;
  await api.decide(item.request, item.relative, view.files[0].hunks[0].id, 'accepted', view.revision);
  assert.equal(updates.filter(key => key.includes('.baseline.')).length, 0, 'A status-only action has no immutable baseline storage roundtrip');
  assert.equal(updates.filter(key => key.endsWith('.transaction')).length, 2, 'Journal creation and cleanup still both persist');
  assert.equal(updates.filter(key => key.includes('.source.')).length, 1, 'The new tracked source still persists before journal cleanup');
  view = await ready(api, item); updates.length = 0;
  await api.editPending(item.request, item.relative, view.files[0].hunks[1].id, 'revised', view.revision);
  assert.equal(updates.filter(key => key.includes('.baseline.')).length, 1, 'A new proposal generation gets its own persisted baseline');
  view = await ready(service(state).api, item);
  assert.deepEqual(view.files[0].hunks.map(hunk => hunk.decision), ['accepted', 'pending']);
  assert.equal(view.files[0].hunks[1].after, 'revised\n');
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n');
});


test('acceptThrough accepts the inclusive visual prefix once while preserving reviewed and later entries', async () => {
  const before='one\ntwo\nthree\nfour\nfive\nsix\n';
  const entries=[5,1,4,2,3,6].map(line=>({line,before:['one','two','three','four','five','six'][line-1],after:['ONE','TWO','THREE','FOUR','FIVE','SIX'][line-1],status:'pending'}));
  const item=await fixture(before,entries),{api}=service();let state=await ready(api,item);
  const at=line=>state.files[0].hunks.find(h=>h.oldStart===line);
  await api.decide(item.request,item.relative,at(1).id,'accepted',state.revision);state=await ready(api,item);
  await api.decide(item.request,item.relative,at(2).id,'ignored',state.revision);state=await ready(api,item);
  const writes=sourceWrites.length;
  const result=await api.acceptThrough(item.request,item.relative,at(4).id,state.revision);
  assert.equal(sourceWrites.length-writes,1,'The whole prefix uses one source write');
  assert.equal(await read(item.target),'ONE\ntwo\nTHREE\nFOUR\nfive\nsix\n');
  assert.deepEqual(await statuses(item),['pending','accepted','accepted','ignored','accepted','pending']);
  assert.equal(result.completionPrompt,undefined);assert.equal(result.changed,true);
});

test('acceptThrough respects array order for insertions sharing a source anchor', async () => {
  const item=await fixture('head\nanchor\ntail\n',[
    {line:2,before:null,after:'first',status:'pending'},
    {line:2,before:null,after:'second',status:'pending'},
    {line:2,before:'anchor',after:'ANCHOR',status:'pending'},
    {line:3,before:'tail',after:'TAIL',status:'pending'}]);
  const {api}=service(),state=await ready(api,item);
  const anchor=state.files[0].hunks.find(h=>h.index===1);
  await api.acceptThrough(item.request,item.relative,anchor.id,state.revision);
  assert.equal(await read(item.target),'head\nfirst\nsecond\nanchor\ntail\n');
  assert.deepEqual(await statuses(item),['accepted','accepted','pending','pending']);
});

test('acceptThrough preserves adopted gray edits and prompts only when the selected prefix completes review', async () => {
  const item=await fixture();const {api}=service();let state=await ready(api,item);
  await fs.writeFile(item.target.fsPath,'header\none\ncontext\nthree\nmanual footer\n');state=await ready(api,item);
  const result=await api.acceptThrough(item.request,item.relative,state.files[0].hunks.at(-1).id,state.revision);
  assert.equal(await read(item.target),'header\nONE\ncontext\nTHREE\nmanual footer\n');
  assert.deepEqual(await statuses(item),['accepted','accepted']);
  assert.ok(result.completionPrompt);assert.equal(result.completionPrompt.revision,result.revision);
});

test('acceptThrough rejects a conflict in the prefix without partially accepting safe entries', async () => {
  const item=await fixture();const {api}=service();let state=await ready(api,item);
  await fs.writeFile(item.target.fsPath,'manual\ncontext\nthree\n');state=await ready(api,item);
  assert.ok(state.files[0].hunks[0].conflict);
  const raw=await read(item.request),source=await read(item.target),writes=sourceWrites.length;
  await assert.rejects(api.acceptThrough(item.request,item.relative,state.files[0].hunks[1].id,state.revision),/original changed|pending block|ambiguous/i);
  assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);assert.equal(sourceWrites.length,writes);
});

test('acceptThrough ignores later conflicts outside its selected prefix', async () => {
  const item=await fixture();const {api}=service();let state=await ready(api,item);
  await fs.writeFile(item.target.fsPath,'one\ncontext\nmanual\n');state=await ready(api,item);
  assert.ok(state.files[0].hunks[1].conflict);
  await api.acceptThrough(item.request,item.relative,state.files[0].hunks[0].id,state.revision);
  assert.equal(await read(item.target),'ONE\ncontext\nmanual\n');assert.deepEqual(await statuses(item),['accepted','pending']);
});

test('acceptThrough rejects stale, dirty, untrusted, missing and resolved anchors without writes', async () => {
  for(const kind of ['request','source','dirty-source','dirty-request','untrusted','missing','resolved','invalid-draft']) {
    const item=await fixture(),{api}=service();let state=await ready(api,item);let anchor=state.files[0].hunks[0].id;
    if(kind==='resolved'){await api.decide(item.request,item.relative,anchor,'ignored',state.revision);state=await ready(api,item);}
    if(kind==='request')await fs.appendFile(item.request.fsPath,' ');
    if(kind==='source')await fs.writeFile(item.target.fsPath,'manual\ncontext\nthree\n');
    if(kind==='dirty-source')(await vscode.workspace.openTextDocument(item.target)).isDirty=true;
    if(kind==='dirty-request')(await vscode.workspace.openTextDocument(item.request)).isDirty=true;
    if(kind==='untrusted')vscode.workspace.isTrusted=false;
    if(kind==='missing')anchor='absent';
    const raw=await read(item.request),source=await read(item.target),writes=sourceWrites.length;
    try {await assert.rejects(api.acceptThrough(item.request,item.relative,anchor,state.revision,kind==='invalid-draft'?'bad\0text':undefined));}
    finally {vscode.workspace.isTrusted=true;}
    assert.equal(await read(item.request),raw,kind);assert.equal(await read(item.target),source,kind);assert.equal(sourceWrites.length,writes,kind);
  }
});

test('acceptThrough atomically includes the current multiline draft and keeps other accepted changes on Undo', async () => {
  const item=await fixture('one\ntwo\nthree\nfour\n',[
    {line:1,before:'one',after:'ONE',status:'pending'},
    {line:2,before:'two',after:'TWO',status:'pending'},
    {line:4,before:'four',after:'FOUR',status:'pending'}]);
  const {api}=service();let state=await ready(api,item);const writes=sourceWrites.length;
  await api.acceptThrough(item.request,item.relative,state.files[0].hunks[1].id,state.revision,'edited\nsecond');
  assert.equal(sourceWrites.length-writes,1);assert.equal(await read(item.target),'ONE\nedited\nsecond\nthree\nfour\n');
  assert.deepEqual(await statuses(item),['accepted','accepted','pending']);state=await ready(api,item);
  await api.undo(item.request,item.relative,state.files[0].hunks.find(h=>h.index===1).id,state.revision);
  assert.equal(await read(item.target),'ONE\ntwo\nthree\nfour\n');assert.deepEqual(await statuses(item),['accepted','pending','pending']);
});

test('acceptThrough no-op draft removal remaps unordered JSON indices without deciding the shifted later entry', async () => {
  const item=await fixture('one\ntwo\nthree\nfour\n',[
    {line:3,before:'three',after:'THREE',status:'pending'},
    {line:1,before:'one',after:'ONE',status:'pending'},
    {line:2,before:'two',after:'TWO',status:'pending'},
    {line:4,before:'four',after:'FOUR',status:'pending'}]);
  const {api}=service();const state=await ready(api,item);
  await api.acceptThrough(item.request,item.relative,state.files[0].hunks.find(h=>h.oldStart===3).id,state.revision,'three');
  assert.equal(await read(item.target),'ONE\nTWO\nthree\nfour\n');assert.deepEqual(await statuses(item),['accepted','accepted','pending']);
  assert.deepEqual(JSON.parse(await read(item.request)).request.map(entry=>entry.line),[1,2,4]);
  const solo=await fixture('old\n',[{line:1,before:'old',after:'new',status:'pending'}]);const initial=await ready(api,solo),writes=sourceWrites.length;
  const result=await api.acceptThrough(solo.request,solo.relative,initial.files[0].hunks[0].id,initial.revision,'old');
  assert.ok(result.completionPrompt);assert.deepEqual(await statuses(solo),[]);assert.equal(sourceWrites.length,writes);assert.equal(await read(solo.target),'old\n');
});

test('acceptThrough recovers an interrupted prefix status save without replaying source changes', async () => {
  const item=await fixture(),created=service();const initial=await ready(created.api,item),writes=sourceWrites.length;
  created.requestFault.remaining=2;
  await assert.rejects(created.api.acceptThrough(item.request,item.relative,initial.files[0].hunks[1].id,initial.revision),/Injected RR failure/);
  assert.equal(await read(item.target),'ONE\ncontext\nTHREE\n');assert.equal(sourceWrites.length-writes,1);
  const restarted=service(created.state);await ready(restarted.api,item);
  assert.deepEqual(await statuses(item),['accepted','accepted']);assert.equal(sourceWrites.length-writes,1);assert.equal(journals(created.state).length,0);
});


test('PDF navigation uses the mapped original cursor and awaits root discovery before SyncTeX without writing', async () => {
  const item=await fixture('head\nold\ncontext\nfocus\n',[
    {line:2,before:'old',after:'new\nextra',status:'pending'},
    {line:4,before:'focus',after:'FOCUS',status:'pending'}],true,'tex');
  const first=service();let state=await ready(first.api,item);
  await first.api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',state.revision);
  await fs.writeFile(item.target.fsPath,'manual header\n'+await read(item.target));
  state=await ready(first.api,item);
  const api=service(first.state).api;state=await ready(api,item);
  const raw=await read(item.request),source=await read(item.target),writes=sourceWrites.length,start=pdfCommands.length,opens=sourceNavigations.length;
  let activated=false;
  workshopActivate=async()=>{activated=true;};
  pdfCommandHook=async command=>{
    assert.equal(activated,true);
    const editor=vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(),item.target.toString());
    assert.equal(editor.selection.start.line,5);
    assert.equal(editor.selection.start.character,0);
    assert.equal(editor.document.getText().split('\n')[5],'focus');
    if(command==='latex-workshop.view')vscode.window.activeTextEditor=undefined;
  };
  try {await api.openTargetPdf(item.request,item.relative,state.files[0].hunks[1].id,state.revision);}
  finally {workshopActivate=pdfCommandHook=undefined;}
  assert.deepEqual(pdfCommands.slice(start).map(({command,args})=>({command,args})),[
    {command:'latex-workshop.view',args:[]},{command:'latex-workshop.synctex',args:[]},
    {command:'vscode.openWith',args:[Uri.file(item.target.fsPath.replace(/\.tex$/,'.pdf')),'latex-workshop-pdf-hook',{viewColumn:3,preserveFocus:false,preview:false}]}
  ]);
  assert.equal(vscode.window.activeTextEditor,undefined,'PDF, not TeX, has final focus');
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType,'latex-workshop-pdf-hook');
  assert.equal(sourceNavigations.length,opens+2,'Restore source focus after the PDF viewer opens');
  assert.equal(sourceNavigations.at(-1).options.viewColumn,2,'Keep the original source editor group when PDF view changes focus');
  assert.equal(sourceWrites.length,writes);assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);
});

test('PDF navigation requires LaTeX Workshop and a trusted LaTeX target, and reports activation failures', async () => {
  for(const kind of ['missing-workshop','untrusted','not-tex','activation','language']) {
    const item=await fixture(undefined,undefined,true,kind==='not-tex'?'py':'tex'),{api}=service(),state=await ready(api,item);
    const raw=await read(item.request),source=await read(item.target),start=pdfCommands.length,opens=sourceNavigations.length;
    workshopAvailable=kind!=='missing-workshop';vscode.workspace.isTrusted=kind!=='untrusted';
    if(kind==='activation')workshopActivate=async()=>{throw Error('disabled extension');};
    if(kind==='language')(await vscode.workspace.openTextDocument(item.target)).languageId='plaintext';
    try {
      await assert.rejects(api.openTargetPdf(item.request,item.relative,state.files[0].hunks[0].id,state.revision),
        /Install or enable LaTeX Workshop|Trust this workspace|LaTeX source files only|Could not activate LaTeX Workshop: disabled extension|LaTeX language mode/);
    } finally {workshopAvailable=true;vscode.workspace.isTrusted=true;workshopActivate=undefined;}
    assert.equal(pdfCommands.length,start);
    assert.equal(sourceNavigations.length,opens+(kind==='language'?1:0));
    assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);
  }
});

test('PDF navigation shares original-line guards and never dispatches commands for invalid requests', async () => {
  for(const kind of ['revision','source','dirty-source','dirty-request','stale-model','unknown-hunk','unknown-file','resolved','insertion']) {
    const item=await fixture(undefined,kind==='insertion'?[{line:1,before:null,after:'inserted',status:'pending'}]:undefined,true,'tex');
    const {api}=service();let state=await ready(api,item),hunkId=state.files[0].hunks[0].id,dirty;
    if(kind==='source')await fs.writeFile(item.target.fsPath,'external\n'+item.before);
    if(kind.startsWith('dirty-')) {dirty=await vscode.workspace.openTextDocument(kind==='dirty-source'?item.target:item.request);dirty.isDirty=true;}
    if(kind==='stale-model') {dirty=await vscode.workspace.openTextDocument(item.target);dirty.staleText='outdated model';}
    if(kind==='resolved') {await api.decide(item.request,item.relative,hunkId,'ignored',state.revision);state=await ready(api,item);}
    const raw=await read(item.request),source=await read(item.target),start=pdfCommands.length,opens=sourceNavigations.length;
    try {
      await assert.rejects(api.openTargetPdf(item.request,kind==='unknown-file'?'../outside.tex':item.relative,
        kind==='unknown-hunk'?'missing':hunkId,kind==='revision'?'obsolete':state.revision),
        /request changed|original has changed|unsaved|Save the .rr|original changed|existing original line|Unknown request file/i);
    } finally {if(dirty){dirty.isDirty=false;delete dirty.staleText;}}
    assert.equal(pdfCommands.length,start);assert.equal(sourceNavigations.length,opens);
    assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);
  }
});

test('PDF navigation rechecks source and request after awaiting the viewer and propagates command errors', async () => {
  for(const kind of ['source','request','dirty','view-error','synctex-error']) {
    const item=await fixture(undefined,undefined,true,'tex'),{api}=service(),state=await ready(api,item);
    const start=pdfCommands.length,writes=sourceWrites.length;
    pdfCommandHook=async command=>{
      if(command==='latex-workshop.view') {
        if(kind==='source')await fs.writeFile(item.target.fsPath,'external\n'+item.before);
        if(kind==='request'){const raw=JSON.parse(await read(item.request));raw.request[0].after='changed';await fs.writeFile(item.request.fsPath,JSON.stringify(raw));}
        if(kind==='dirty')(await vscode.workspace.openTextDocument(item.target)).isDirty=true;
        if(kind==='view-error')throw Error('PDF unavailable');
      }
      if(command==='latex-workshop.synctex'&&kind==='synctex-error')throw Error('SyncTeX unavailable');
    };
    try {
      await assert.rejects(api.openTargetPdf(item.request,item.relative,state.files[0].hunks[0].id,state.revision),
        /request changed|unsaved|PDF unavailable|SyncTeX unavailable/i);
    } finally {pdfCommandHook=undefined;const document=documents.get(item.target.toString());if(document)document.isDirty=false;}
    assert.deepEqual(pdfCommands.slice(start).map(item=>item.command),kind==='synctex-error'?['latex-workshop.view','latex-workshop.synctex']:['latex-workshop.view']);
    assert.equal(sourceWrites.length,writes);
  }
});


// Host tests exercise real source/RR/sidecar files; compiler/form internals have
// their own artifact tests and are injected here to make transaction faults exact.
function fakePdfTools(hooks = {}) {
  const calls = {compile: [], read: 0};
  const tools = {
    async compile(input, onProgress) {calls.compile.push(input); await hooks.compile?.(input, onProgress); return {pdf: Buffer.from('compiled'), anchors: input.entries.map((entry, index) => ({entryId: entry.id, page: 0, x: 1, y: 100 - index})), warnings: ['Host test compiler']};},
    async create(_pdf, manifest, anchors) {assert.deepEqual(anchors.map(item => item.entryId), manifest.entries.map(item => item.id)); return Buffer.from(JSON.stringify({manifest, decisions: Object.fromEntries(manifest.entries.map(entry => [entry.id, 'pending']))}));},
    async read(bytes) {calls.read++; await hooks.read?.(); const value = JSON.parse(Buffer.from(bytes).toString('utf8')); return {...value, pdfHash: require('node:crypto').createHash('sha256').update(bytes).digest('hex')};}
  };
  return {tools, calls};
}
async function readReady(api, item) {
  const state = await ready(api, item);
  await api.readPdfReview(item.request, state.revision);
  return ready(api, item);
}
async function pdfFixture(hooks, entries, beforeText) {
  const item = await fixture(beforeText, entries, true, 'tex');
  const fake = fakePdfTools(hooks), created = service(undefined, undefined, fake.tools);
  let state = await ready(created.api, item);
  await created.api.generateReviewPdf(item.request, state.revision);
  state = await readReady(created.api, item);
  return {...item, ...created, ...fake, preview: state};
}
async function setPdfDecisions(item, decisions, shouldRead = true) {
  const filename = item.request.fsPath + '.pdf', value = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const [index, entry] of value.manifest.entries.entries()) value.decisions[entry.id] = decisions[index];
  await fs.writeFile(filename, JSON.stringify(value));
  if (shouldRead) await readReady(item.api, item);
  return value;
}

test('PDF export preserves source and local statuses without implicitly importing its pending entries', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), created = service(undefined, undefined, fake.tools);
  let state = await ready(created.api, item);
  await created.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  state = await ready(created.api, item);
  const source = await read(item.target), raw = await read(item.request), count = sourceWrites.length;
  await created.api.generateReviewPdf(item.request, state.revision);
  state = await ready(created.api, item);
  assert.equal(await read(item.target), source); assert.equal(await read(item.request), raw); assert.equal(sourceWrites.length, count);
  assert.equal(fake.calls.compile.length, 1); assert.equal(fake.calls.compile[0].source, source);
  assert.equal(fake.calls.compile[0].entries.length, 1); assert.equal(fake.calls.compile[0].entries[0].index, 1);
  assert.equal(state.pdfReview.available, true); assert.equal(state.pdfReview.imported, false); assert.equal(state.pdfReview.pending, undefined); assert.equal(state.pdfReview.canApply, false);
  assert.equal(state.pdfReview.error, undefined, state.pdfReview.error);
  await ready(created.api, item); assert.equal(fake.calls.read, 0, 'opening and refreshing never parse PDF bytes');
  await created.api.readPdfReview(item.request, state.revision); assert.equal(fake.calls.read, 1, 'manual Import reads exact form bytes');
  state = await ready(created.api, item); assert.equal(state.pdfReview.imported, true); assert.equal(state.pdfReview.pending, 1);
  await ready(created.api, item); assert.equal(fake.calls.read, 1, 'refresh uses only the explicitly imported snapshot');
  const artifact = JSON.parse(await fs.readFile(item.request.fsPath + '.pdf', 'utf8'));
  assert.deepEqual(artifact.manifest.request.request.map(entry => entry.status), ['accepted', 'pending']);
  assert.equal(artifact.manifest.entries[0].originalDecision, 'pending');
  assert.equal((await fs.readdir(path.join(created.state.globalStorageUri.fsPath, '.codex-pdf-review'))).length, 0, 'owned compiler scratch is removed');
});

test('an internal read-only PDF snapshot does not apply; compatibility Apply commits once and survives restart', async () => {
  const item = await pdfFixture(); const raw = await read(item.request), count = sourceWrites.length;
  await setPdfDecisions(item, ['accepted', 'ignored']);
  let state = await ready(item.api, item);
  assert.equal(state.pdfReview.accepted, 1); assert.equal(state.pdfReview.ignored, 1); assert.equal(state.pdfReview.pending, 0);
  assert.equal(state.pdfReview.canApply, true); assert.equal(state.pdfReview.applied, false);
  await item.api.readPdfReview(item.request, state.revision);
  assert.equal(await read(item.target), item.before); assert.equal(await read(item.request), raw); assert.equal(sourceWrites.length, count);
  const result = await item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash);
  assert.ok(result.completionPrompt); assert.equal(await read(item.target), 'ONE\ncontext\nthree\n');
  assert.deepEqual(await statuses(item), ['accepted', 'ignored']); assert.equal(sourceWrites.length, count + 1);
  const restarted = service(item.state, undefined, item.tools).api;
  state = await ready(restarted, item); assert.equal(state.pdfReview.imported, false);
  state = await readReady(restarted, item); assert.equal(state.pdfReview.applied, true); assert.equal(state.pdfReview.canApply, false);
  assert.equal(await restarted.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), undefined);
  assert.equal(sourceWrites.length, count + 1, 'the same applied export must never replay source writes');
});

test('partial compatibility Apply keeps pending entries and a changed PDF hash cannot replay stale decisions', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'pending']);
  let state = await ready(item.api, item);
  assert.equal(await item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), undefined);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'pending']);
  await setPdfDecisions(item, ['accepted', 'ignored']); state = await ready(item.api, item);
  const raw = await read(item.request), source = await read(item.target);
  await setPdfDecisions(item, ['ignored', 'accepted'], false);
  await assert.rejects(item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), /PDF changed/);
  assert.equal(await read(item.target), source); assert.equal(await read(item.request), raw);
});

test('PDF identity checks reject unrelated source edits while ordinary unaffected pending review still works', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']);
  const updated = item.before.replace('context', 'manually revised context'); await fs.writeFile(item.target.fsPath, updated);
  let state = await ready(item.api, item);
  assert.match(state.pdfReview.error, /original or local review decisions changed/); assert.equal(state.pdfReview.canApply, false);
  await assert.rejects(item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), /changed since|not been imported/);
  assert.equal(await read(item.target), updated); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  await item.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision);
  assert.equal(await read(item.target), updated.replace('one', 'ONE'));
});

test('local decisions and edited proposal generations cannot be overwritten by an older PDF', async () => {
  for (const mode of ['decision', 'proposal']) {
    const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'accepted']);
    let state = await ready(item.api, item);
    if (mode === 'decision') await item.api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'ignored', state.revision);
    else await item.api.editPending(item.request, item.relative, state.files[0].hunks[0].id, 'OTHER', state.revision);
    state = await ready(item.api, item); const raw = await read(item.request);
    assert.ok(state.pdfReview.error); assert.equal(state.pdfReview.canApply, false);
    await assert.rejects(item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash));
    assert.equal(await read(item.request), raw); assert.equal(await read(item.target), item.before);
  }
});

test('foreign and flattened PDFs fail only PDF review; source previews remain usable', async () => {
  const item = await pdfFixture(); const original = await fs.readFile(item.request.fsPath + '.pdf');
  const foreign = JSON.parse(original); foreign.manifest.exportId = 'another-export'; await fs.writeFile(item.request.fsPath + '.pdf', JSON.stringify(foreign));
  let state = await ready(item.api, item); assert.equal(state.pdfReview.imported, false); assert.equal(state.error, undefined);
  await assert.rejects(item.api.readPdfReview(item.request, state.revision), /does not match/);
  await fs.writeFile(item.request.fsPath + '.pdf', '%PDF-1.7 flattened without review fields');
  state = await ready(item.api, item); assert.equal(state.pdfReview.imported, false); assert.equal(state.error, undefined);
  await assert.rejects(item.api.readPdfReview(item.request, state.revision));
  await fs.writeFile(item.request.fsPath + '.pdf', original);
  const unrelated = service(undefined, undefined, item.tools).api;
  state = await ready(unrelated, item); assert.equal(state.pdfReview.imported, false);
  await assert.rejects(unrelated.readPdfReview(item.request, state.revision), /does not match/, 'PDF embedded claims are not local export authority');
});

test('explicit regeneration confirms replacement, cancellation keeps prior file, and compilation failure preserves it', async () => {
  let fail = false; const item = await pdfFixture({compile: () => {if (fail) throw Error('Compile failure');}});
  await setPdfDecisions(item, ['accepted', 'ignored']); let state = await ready(item.api, item);
  const bytes = await fs.readFile(item.request.fsPath + '.pdf'), warning = vscode.window.showWarningMessage;
  await assert.rejects(item.api.generateReviewPdf(item.request, state.revision), /already exists/);
  const prompts = []; vscode.window.showWarningMessage = async (...args) => {prompts.push(args); return undefined;};
  try {
    await item.api.generateReviewPdf(item.request, state.revision, true);
    assert.deepEqual(await fs.readFile(item.request.fsPath + '.pdf'), bytes); assert.equal(item.calls.compile.length, 1);
    assert.equal(prompts[0][1].modal, true); assert.equal(prompts[0][2], 'Build PDF');
    assert.match(prompts[0][1].detail, /saved review decisions discarded/);
    vscode.window.showWarningMessage = async () => 'Build PDF'; fail = true;
    await assert.rejects(item.api.generateReviewPdf(item.request, state.revision, true), /Compile failure/);
    assert.deepEqual(await fs.readFile(item.request.fsPath + '.pdf'), bytes);
    state = await ready(item.api, item); assert.equal(state.pdfReview.canApply, true);
    fail = false; await item.api.generateReviewPdf(item.request, state.revision, true);
    state = await ready(item.api, item); assert.equal(state.pdfReview.imported, false);
    state = await readReady(item.api, item); assert.equal(state.pdfReview.pending, 2); assert.equal(state.pdfReview.accepted, 0);
  } finally {vscode.window.showWarningMessage = warning;}
});

test('generation rechecks source, request, and companion after compilation without overwriting newer work', async () => {
  for (const mode of ['source', 'request', 'companion']) {
    const item = await fixture(undefined, undefined, true, 'tex');
    const fake = fakePdfTools({compile: async () => {
      if (mode === 'source') await fs.writeFile(item.target.fsPath, item.before.replace('context', 'new context'));
      else if (mode === 'request') await fs.appendFile(item.request.fsPath, ' ');
      else await fs.writeFile(item.request.fsPath + '.pdf', 'new incoming PDF');
    }}), {api} = service(undefined, undefined, fake.tools), state = await ready(api, item), count = sourceWrites.length;
    await assert.rejects(api.generateReviewPdf(item.request, state.revision), /changed/);
    assert.equal(sourceWrites.length, count);
    if (mode === 'companion') assert.equal(await fs.readFile(item.request.fsPath + '.pdf', 'utf8'), 'new incoming PDF');
    else await assert.rejects(fs.stat(item.request.fsPath + '.pdf'), {code: 'ENOENT'});
  }
});

test('generation rejects untrusted, unsupported, dirty, conflicted, and empty requests', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), {api} = service(undefined, undefined, fake.tools);
  let state = await ready(api, item); vscode.workspace.isTrusted = false;
  try {await assert.rejects(api.generateReviewPdf(item.request, state.revision), /Trust/);} finally {vscode.workspace.isTrusted = true;}
  const targetDoc = await vscode.workspace.openTextDocument(item.target); targetDoc.isDirty = true;
  try {await assert.rejects(api.generateReviewPdf(item.request, state.revision), /[Ss]ave|unsaved/);} finally {targetDoc.isDirty = false;}
  await fs.writeFile(item.target.fsPath, item.before.replace('one', 'conflicting'));
  state = await ready(api, item); await assert.rejects(api.generateReviewPdf(item.request, state.revision), /conflicts/);
  const empty = await fixture('nothing\n', [], true, 'tex'); state = await ready(api, empty);
  await assert.rejects(api.generateReviewPdf(empty.request, state.revision), /no pending/);
  const text = await fixture(); state = await ready(api, text); assert.equal(state.pdfReview.supported, false);
  await assert.rejects(api.generateReviewPdf(text.request, state.revision), /LaTeX/);
  assert.equal(fake.calls.compile.length, 0);
});

test('PDF apply uses existing source/RR recovery and its receipt prevents replay after a failed status write', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']);
  const state = await ready(item.api, item), count = sourceWrites.length; item.requestFault.remaining = Infinity;
  await assert.rejects(item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), /Injected RR failure/);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  const restarted = service(item.state, undefined, item.tools).api, recovered = await readReady(restarted, item);
  assert.deepEqual(await statuses(item), ['accepted', 'ignored']); assert.equal(recovered.pdfReview.applied, true);
  await restarted.applyPdfReview(item.request, recovered.revision, recovered.pdfReview.pdfHash);
  assert.equal(sourceWrites.length, count + 1);
});

test('failed source apply can retry without marking imported decisions applied', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']); let state = await ready(item.api, item);
  sourceFault = {path: item.target.fsPath, when: 'before'};
  await assert.rejects(item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash), /Injected source failure/);
  state = await ready(item.api, item); assert.equal(state.pdfReview.applied, false); assert.equal(state.pdfReview.canApply, true);
  await item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash);
  assert.deepEqual(await statuses(item), ['accepted', 'ignored']);
});

test('changed PDF choices cannot overwrite newer local source after an earlier import', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']); let state = await ready(item.api, item);
  await item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash);
  const modified = (await read(item.target)).replace('context', 'new local context');
  await fs.writeFile(item.target.fsPath, modified);
  await setPdfDecisions(item, ['ignored', 'accepted'], false); state = await ready(item.api, item);
  const raw = await read(item.request), count = sourceWrites.length;
  await assert.rejects(item.api.importPdfReview(item.request, state.revision), /changed|match|different/i);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), modified);
  assert.equal(sourceWrites.length, count);
});

test('hard-linked companion PDF cannot be read as authority or overwritten', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), {api} = service(undefined, undefined, fake.tools);
  const victim = path.join(scratch, 'do-not-overwrite-' + serial + '.pdf'); await fs.writeFile(victim, 'precious PDF');
  await fs.link(victim, item.request.fsPath + '.pdf'); const state = await ready(api, item);
  assert.match(state.pdfReview.error, /regular, unlinked/);
  await assert.rejects(api.generateReviewPdf(item.request, state.revision, true), /regular, unlinked/);
  assert.equal(await fs.readFile(victim, 'utf8'), 'precious PDF');
});


test('real PDF AcroForm outcomes bind to the retained export and apply through the host transaction', async () => {
  const {PDFDocument} = require('pdf-lib'), {createPortableReviewPdf, readPortableReviewPdf} = require('../src/portableReviewPdf.ts');
  const item = await fixture(undefined, undefined, true, 'tex');
  const tools = {
    create: createPortableReviewPdf, read: readPortableReviewPdf,
    async compile(input) {const pdf = await PDFDocument.create(); pdf.addPage([595, 842]); return {pdf: await pdf.save(), anchors: input.entries.map((entry, index) => ({entryId: entry.id, page: 0, x: 30, y: 720 - index * 80})), warnings: []};}
  };
  const created = service(undefined, undefined, tools); let state = await ready(created.api, item);
  await created.api.generateReviewPdf(item.request, state.revision);
  state = await readReady(created.api, item); assert.equal(state.pdfReview.error, undefined, state.pdfReview.error); assert.equal(state.pdfReview.pending, 2);
  const filename = item.request.fsPath + '.pdf', doc = await PDFDocument.load(await fs.readFile(filename));
  const groups = doc.getForm().getFields().filter(field => field.getName().startsWith('RRDecision_'));
  assert.equal(groups.length, 2); groups[0].select('accepted'); groups[1].select('ignored'); await fs.writeFile(filename, await doc.save());
  state = await ready(created.api, item);
  const count = sourceWrites.length; await created.api.importPdfReview(item.request, state.revision);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'ignored']); assert.equal(sourceWrites.length, count + 1);
  assert.equal((await ready(created.api, item)).pdfReview.applied, true);
});


test('PDF export metadata and late-file failures preserve the previous companion and export authority', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']); let state = await ready(item.api, item);
  const filename = item.request.fsPath + '.pdf', previous = await fs.readFile(filename), update = item.state.workspaceState.update;
  const warning = vscode.window.showWarningMessage; vscode.window.showWarningMessage = async () => 'Build PDF';
  try {
    item.state.workspaceState.update = async (key, value) => {if (key.endsWith('pdf-export')) throw Error('Export metadata unavailable'); return update(key, value);};
    await assert.rejects(item.api.generateReviewPdf(item.request, state.revision, true), /metadata unavailable/);
    assert.deepEqual(await fs.readFile(filename), previous);
    item.state.workspaceState.update = update;
    state = await ready(item.api, item); assert.equal(state.pdfReview.canApply, true, state.pdfReview.error);
    let replaced = false;
    item.state.workspaceState.update = async (key, value) => {
      await update(key, value);
      if (key.endsWith('pdf-export') && !replaced) {replaced = true; await fs.writeFile(filename, 'new externally returned review');}
    };
    await assert.rejects(item.api.generateReviewPdf(item.request, state.revision, true), /companion PDF.*changed/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'new externally returned review');
    item.state.workspaceState.update = update;
    await fs.writeFile(filename, previous); state = await readReady(item.api, item); assert.equal(state.pdfReview.canApply, true, state.pdfReview.error);
    assert.equal((await fs.readdir(path.dirname(filename))).some(name => name.startsWith('.codex-pdf-review-')), false);
  } finally {item.state.workspaceState.update = update; vscode.window.showWarningMessage = warning;}
});


test('preview and watcher only inspect PDF metadata; explicit Import alone refreshes decisions', async () => {
  const item = await pdfFixture(), filename = item.request.fsPath + '.pdf';
  const originalOpen = fs.open; let pdfReads = 0;
  fs.open = async (file, ...args) => {if (file === filename) pdfReads++; return originalOpen.call(fs, file, ...args);};
  try {
    let state = await ready(item.api, item); await ready(item.api, item);
    assert.equal(pdfReads, 0);
    await item.api.readPdfReview(item.request, state.revision); assert.equal(pdfReads, 1);
    item.api.pdfChanged(Uri.file(filename)); state = await ready(item.api, item);
    assert.equal(pdfReads, 1, 'a delayed watcher event never reads or discards the same imported snapshot');
    assert.equal(state.pdfReview.imported, true);
    await setPdfDecisions(item, ['accepted', 'ignored'], false); pdfReads = 0;
    item.api.pdfChanged(Uri.file(filename)); state = await ready(item.api, item);
    assert.equal(pdfReads, 0); assert.equal(state.pdfReview.imported, false); assert.equal(state.pdfReview.canApply, false);
    assert.equal(state.pdfReview.accepted, undefined);
    await ready(item.api, item); assert.equal(pdfReads, 0);
    state = await readReady(item.api, item); assert.equal(pdfReads, 1); assert.equal(state.pdfReview.canApply, true);
    await item.api.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash);
    assert.ok(pdfReads >= 3, 'Apply rereads imported bytes and the final replacement guard');
  } finally {fs.open = originalOpen;}
});


test('real compiler, portable PDF, reopen import and host Apply round-trip a grouped math example', {skip: process.env.RR_TEST_LATEX !== '1'}, async () => {
  const {PDFDocument} = require('pdf-lib'), {readPortableReviewPdf} = require('../src/portableReviewPdf.ts');
  const {resolveRequest} = require('../src/request.ts');
  const source = (await fs.readFile(path.join(root, 'examples', 'multiline-demo.tex'), 'utf8'))
    .replace('amsmath,amssymb}', 'amsmath,amssymb,host-smoke-style}');
  const request = JSON.parse(await fs.readFile(path.join(root, 'examples', 'multiline-demo.tex.rr'), 'utf8'));
  const item = await fixture(source, request.request, true, 'tex'), created = service();
  const dependency = path.join(path.dirname(item.target.fsPath), 'host-smoke-style.sty');
  const dependencyBytes = Buffer.from('\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesPackage{host-smoke-style}[2026/11/15 Host smoke]\n\\newcommand{\\hostsmokemarker}{Unchanged dependency}\n');
  await fs.writeFile(dependency, dependencyBytes);
  let state = await ready(created.api, item); const raw = await read(item.request), writeCount = sourceWrites.length;
  await created.api.generateReviewPdf(item.request, state.revision);
  const filename = item.request.fsPath + '.pdf', unreviewed = await fs.readFile(filename);
  assert.equal(await read(item.target), source); assert.equal(await read(item.request), raw); assert.equal(sourceWrites.length, writeCount);
  assert.deepEqual(await fs.readFile(dependency), dependencyBytes);
  const parsed = await readPortableReviewPdf(unreviewed); assert.equal(parsed.manifest.entries.length, request.request.length);
  assert.ok(Object.values(parsed.decisions).every(value => value === 'pending'));
  const doc = await PDFDocument.load(unreviewed), reviewedRequest = structuredClone(parsed.manifest.request);
  for (const entry of parsed.manifest.entries) {
    const choice = entry.index % 3 === 1 ? 'ignored' : 'accepted';
    doc.getForm().getRadioGroup('RRDecision_' + parsed.manifest.exportId + '_' + entry.id).select(choice);
    reviewedRequest.request[entry.index].status = choice;
  }
  await fs.writeFile(filename, await doc.save());
  const restarted = service(created.state).api; state = await readReady(restarted, item);
  assert.equal(state.pdfReview.canApply, true, state.pdfReview.error); assert.equal(state.pdfReview.pending, 0); assert.equal(state.pdfReview.applied, false);
  assert.equal(await read(item.target), source); assert.equal(await read(item.request), raw); assert.equal(sourceWrites.length, writeCount);
  const expected = resolveRequest(reviewedRequest, source, source).expectedTarget;
  const result = await restarted.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash); assert.ok(result.completionPrompt);
  assert.deepEqual(await fs.readFile(item.target.fsPath), Buffer.from(expected, 'utf8')); assert.deepEqual(await fs.readFile(dependency), dependencyBytes);
  assert.deepEqual(await statuses(item), reviewedRequest.request.map(entry => entry.status)); assert.equal(sourceWrites.length, writeCount + 1);
  state = await readReady(service(created.state).api, item); assert.equal(state.pdfReview.applied, true);
  await restarted.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash); assert.equal(sourceWrites.length, writeCount + 1);
  await fs.writeFile(path.join(root, '.codex-test', 'last-host-pdf-smoke.json'), JSON.stringify({pdf: filename, source: item.target.fsPath,
    request: item.request.fsPath, dependency, entries: parsed.manifest.entries.length, pages: doc.getPageCount(), warnings: state.pdfReview.warnings}, null, 2));
  console.log('Combined host PDF smoke: ' + filename);
});


test('regeneration preserves a PDF replaced after the final check instead of installing over it', async () => {
  const item = await pdfFixture(), state = await ready(item.api, item), filename = item.request.fsPath + '.pdf';
  const originalRename = fs.rename, warning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => 'Build PDF'; let displaced = false;
  fs.rename = async (from, to) => {
    if (from === filename && !displaced) {displaced = true; await fs.writeFile(filename, 'returned review at final rename');}
    return originalRename.call(fs, from, to);
  };
  try {
    await assert.rejects(item.api.generateReviewPdf(item.request, state.revision, true), /replaced during export/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'returned review at final rename');
    assert.equal((await fs.readdir(path.dirname(filename))).some(name => name.startsWith('.codex-pdf-review-')), false, 'restored displaced PDF needs no retained backup');
  } finally {fs.rename = originalRename; vscode.window.showWarningMessage = warning;}
});

test('regeneration keeps both PDFs if another returned file arrives after old-file displacement', async () => {
  const item = await pdfFixture(), state = await ready(item.api, item), filename = item.request.fsPath + '.pdf';
  const previous = await fs.readFile(filename), originalLink = fs.link, warning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => 'Build PDF'; let raced = false;
  fs.link = async (from, to) => {
    if (to === filename && path.basename(from) === 'review.pdf' && !raced) {raced = true; await fs.writeFile(filename, 'new returned review after displacement');}
    return originalLink.call(fs, from, to);
  };
  try {
    await assert.rejects(item.api.generateReviewPdf(item.request, state.revision, true), /displaced PDF was kept at/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'new returned review after displacement');
    const directories = (await fs.readdir(path.dirname(filename))).filter(name => name.startsWith('.codex-pdf-review-'));
    assert.equal(directories.length, 1);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(filename), directories[0], 'previous.pdf')), previous, 'recognized old review remains recoverable without overwriting the new one');
    assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  } finally {fs.link = originalLink; vscode.window.showWarningMessage = warning;}
});


test('desktop vscode-userdata storage compiles locally while remote storage is refused', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), saved = context();
  saved.globalStorageUri.scheme = 'vscode-userdata'; const {api} = service(saved, undefined, fake.tools), state = await ready(api, item);
  await api.generateReviewPdf(item.request, state.revision); assert.equal((await ready(api, item)).pdfReview.available, true);
  const remote = await fixture(undefined, undefined, true, 'tex'), remoteContext = context(); remoteContext.globalStorageUri.scheme = 'vscode-remote';
  const other = service(remoteContext, undefined, fake.tools).api;
  await assert.rejects(other.generateReviewPdf(remote.request, (await ready(other, remote)).revision), /Local extension storage/);
});


test('hard-linked originals cannot write outside the workspace during review', async () => {
  const item = await fixture(), {api} = service(), state = await ready(api, item);
  const sentinel = path.join(path.dirname(scratch), 'outside-source-' + path.basename(scratch) + '.txt');
  await fs.writeFile(sentinel, item.before);
  await fs.unlink(item.target.fsPath); await fs.link(sentinel, item.target.fsPath);
  const requestBefore = await read(item.request), writes = sourceWrites.length;
  await assert.rejects(api.decide(item.request, item.relative, state.files[0].hunks[0].id, 'accepted', state.revision), /hard.link|unlinked/i);
  assert.equal(await fs.readFile(sentinel, 'utf8'), item.before);
  assert.equal(await read(item.request), requestBefore); assert.equal(sourceWrites.length, writes);
});

test('hard-linked requests cannot write creation metadata or decisions outside the workspace', async () => {
  const item = await fixture(undefined, undefined, false), {api} = service();
  const raw = await read(item.request), sentinel = path.join(path.dirname(scratch), 'outside-request-' + path.basename(scratch) + '.rr');
  await fs.writeFile(sentinel, raw);
  await fs.unlink(item.request.fsPath); await fs.link(sentinel, item.request.fsPath);
  const state = await api.getState(item.request);
  assert.match(state.error, /hard.link|unlinked/i);
  assert.equal(await fs.readFile(sentinel, 'utf8'), raw);
  assert.equal(await read(item.target), item.before);
});


test('PDF import bounds a file that grows after its size check without parsing changed bytes', async () => {
  const item = await pdfFixture(), filename = item.request.fsPath + '.pdf', state = await ready(item.api, item);
  const initial = await fs.readFile(filename), originalOpen = fs.open, parserCalls = item.calls.read;
  let maxRead = 0, changed = false, closed = false;
  fs.open = async (file, ...args) => {
    const handle = await originalOpen.call(fs, file, ...args);
    if (file === filename) {
      const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
      handle.read = async (...readArgs) => {
        maxRead = Math.max(maxRead, readArgs[2]);
        if (!changed) {changed = true; await fs.appendFile(filename, Buffer.alloc(1024 * 1024, 32));}
        return originalRead(...readArgs);
      };
      handle.close = async () => {closed = true; return originalClose();};
    }
    return handle;
  };
  try {
    await assert.rejects(item.api.readPdfReview(item.request, state.revision), /changed while reading/);
    assert.equal(changed, true); assert.ok(maxRead <= initial.length + 1); assert.equal(closed, true);
    assert.equal(item.calls.read, parserCalls, 'changed bytes never reach the PDF parser');
    assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  } finally {fs.open = originalOpen;}
});

test('PDF import rejects a path replaced after opening even if the open file remains readable', async () => {
  const item = await pdfFixture(), filename = item.request.fsPath + '.pdf', state = await ready(item.api, item);
  const originalOpen = fs.open, originalBytes = await fs.readFile(filename), parserCalls = item.calls.read;
  let replaced = false;
  fs.open = async (file, ...args) => {
    const handle = await originalOpen.call(fs, file, ...args);
    if (file === filename && !replaced) {
      replaced = true;
      await fs.rename(filename, filename + '.saved');
      await fs.writeFile(filename, originalBytes);
    }
    return handle;
  };
  try {
    await assert.rejects(item.api.readPdfReview(item.request, state.revision), /changed while (reading|opening)/);
    assert.equal(replaced, true); assert.equal(item.calls.read, parserCalls);
    assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  } finally {fs.open = originalOpen;}
});


test('every PDF export requires explicit local compiler consent and cancellation starts no tools', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), created = service(undefined, undefined, fake.tools);
  const state = await ready(created.api, item), raw = await read(item.request), warning = vscode.window.showWarningMessage;
  const prompts = []; vscode.window.showWarningMessage = async (...args) => {prompts.push(args); return undefined;};
  try {
    await created.api.generateReviewPdf(item.request, state.revision);
    assert.equal(prompts.length, 1); assert.equal(prompts[0][0], 'Build this review PDF?');
    assert.equal(prompts[0][1].modal, true); assert.equal(prompts[0][2], 'Build PDF');
    assert.ok(prompts[0][1].detail.includes(path.basename(item.request.fsPath)));
    assert.ok(prompts[0][1].detail.includes(item.relative));
    assert.match(prompts[0][1].detail, /runs the proposed LaTeX using local tools/);
    assert.equal(fake.calls.compile.length, 0); assert.equal(await read(item.target), item.before); assert.equal(await read(item.request), raw);
    assert.equal(created.state.workspaceState.keys().some(key => key.endsWith('pdf-export')), false);
    await assert.rejects(fs.access(item.request.fsPath + '.pdf'), {code: 'ENOENT'});
    vscode.window.showWarningMessage = async (...args) => {prompts.push(args); return 'Build PDF';};
    await created.api.generateReviewPdf(item.request, state.revision);
    await created.api.generateReviewPdf(item.request, state.revision, true);
    assert.equal(prompts.length, 3, 'confirmation is never remembered'); assert.equal(fake.calls.compile.length, 2);
    assert.match(prompts[2][1].detail, /decisions discarded/);
  } finally {vscode.window.showWarningMessage = warning;}
});

test('source, request, trust, and returned-PDF changes while confirmation is open never reach the compiler', async () => {
  for (const mutation of ['source', 'request', 'trust', 'pdf']) {
    const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), {api} = service(undefined, undefined, fake.tools);
    const state = await ready(api, item), warning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async () => {
      if (mutation === 'source') await fs.writeFile(item.target.fsPath, 'new external source');
      if (mutation === 'request') {const request = JSON.parse(await read(item.request)); request.request[0].after = 'changed after consent'; await fs.writeFile(item.request.fsPath, JSON.stringify(request));}
      if (mutation === 'trust') vscode.workspace.isTrusted = false;
      if (mutation === 'pdf') await fs.writeFile(item.request.fsPath + '.pdf', 'new returned review');
      return 'Build PDF';
    };
    try {
      await assert.rejects(api.generateReviewPdf(item.request, state.revision), /changed|no longer matches/i, mutation);
      assert.equal(fake.calls.compile.length, 0, mutation);
      if (mutation === 'source') assert.equal(await read(item.target), 'new external source');
      else assert.equal(await read(item.target), item.before);
      if (mutation === 'pdf') assert.equal(await fs.readFile(item.request.fsPath + '.pdf', 'utf8'), 'new returned review');
    } finally {vscode.window.showWarningMessage = warning; vscode.workspace.isTrusted = true;}
  }
});


test('a known PDF hash never authorizes Apply until an explicit Import in this service session', async () => {
  const item = await fixture(undefined, undefined, true, 'tex'), fake = fakePdfTools(), created = service(undefined, undefined, fake.tools);
  let state = await ready(created.api, item);
  await created.api.generateReviewPdf(item.request, state.revision);
  const filename = item.request.fsPath + '.pdf';
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const entry of value.manifest.entries) value.decisions[entry.id] = 'accepted';
  await fs.writeFile(filename, JSON.stringify(value));
  const hash = require('node:crypto').createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  created.api.pdfChanged(Uri.file(filename));
  state = await ready(created.api, item); await ready(created.api, item);
  assert.equal(fake.calls.read, 0); assert.equal(state.pdfReview.available, true); assert.equal(state.pdfReview.imported, false);
  assert.equal(state.pdfReview.accepted, undefined); assert.equal(state.pdfReview.pdfHash, undefined); assert.equal(state.pdfReview.canApply, false);
  await assert.rejects(created.api.applyPdfReview(item.request, state.revision, hash), /not been imported/);
  assert.equal(fake.calls.read, 0, 'an unsolicited Apply must not parse or import the PDF');
  assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  state = await readReady(created.api, item); assert.equal(state.pdfReview.canApply, true); assert.equal(state.pdfReview.pdfHash, hash);
  const restarted = service(created.state, undefined, fake.tools).api;
  state = await ready(restarted, item); assert.equal(state.pdfReview.imported, false);
  await assert.rejects(restarted.applyPdfReview(item.request, state.revision, hash), /not been imported/);
  state = await readReady(restarted, item);
  await restarted.applyPdfReview(item.request, state.revision, state.pdfReview.pdfHash);
  assert.deepEqual(await statuses(item), ['accepted', 'accepted']);
});

test('a newer RR can generate a replacement PDF without importing stale PDF choices', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored']);
  let state = await ready(item.api, item);
  await item.api.editPending(item.request, item.relative, state.files[0].hunks[0].id, 'NEW PROPOSAL', state.revision);
  state = await ready(item.api, item); assert.equal(state.pdfReview.imported, false); assert.equal(state.pdfReview.canApply, false);
  const raw = await read(item.request), reads = item.calls.read;
  await item.api.generateReviewPdf(item.request, state.revision, true);
  state = await ready(item.api, item);
  assert.equal(state.pdfReview.available, true); assert.equal(state.pdfReview.imported, false); assert.equal(state.pdfReview.accepted, undefined);
  assert.equal(item.calls.read, reads, 'generation never imports the previous or newly generated form');
  const exported = JSON.parse(await fs.readFile(item.request.fsPath + '.pdf', 'utf8'));
  assert.equal(exported.manifest.request.request[0].after, 'NEW PROPOSAL');
  assert.deepEqual(Object.values(exported.decisions), ['pending', 'pending']);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), item.before);
});


test('Pending all restores mixed replacements additions and deletions in one write while preserving unrelated edits', async () => {
  const before = 'header\nold first\nold second\nkeep\ndelete me\nignore me\npending me\nfooter\n';
  const entries = [
    {line:2,before:'old first\nold second',after:'new first\nnew second\nnew third',status:'pending'},
    {line:4,before:null,after:'inserted a\ninserted b',status:'pending'},
    {line:5,before:'delete me',after:null,status:'pending'},
    {line:6,before:'ignore me',after:'ignored proposal',status:'pending'},
    {line:7,before:'pending me',after:'pending proposal',status:'pending'},
  ];
  const item = await fixture(before,entries), created = service();
  let state = await ready(created.api,item); const ids = state.files[0].hunks.map(hunk => hunk.id);
  for (const [index,decision] of [[0,'accepted'],[1,'accepted'],[2,'accepted'],[3,'ignored']]) {
    await created.api.decide(item.request,item.relative,ids[index],decision,state.revision); state = await ready(created.api,item);
  }
  await fs.writeFile(item.target.fsPath,(await read(item.target)).replace('header\n','user header\n'));
  state = await ready(created.api,item);
  const writes = sourceWrites.length, revision = state.revision;
  assert.equal(await created.api.undoFile(item.request,item.relative,revision),undefined);
  assert.equal(sourceWrites.length,writes+1,'All approved source changes are restored by one transaction');
  assert.equal(await read(item.target),before.replace('header\n','user header\n'));
  assert.deepEqual(await statuses(item),entries.map(()=>'pending'));
  assert.deepEqual(JSON.parse(await read(item.request)).request.map(entry=>entry.line),entries.map(entry=>entry.line));
  state = await ready(service(created.state).api,item);
  assert.equal(state.closed,false); assert.notEqual(state.revision,revision);
  assert.deepEqual(state.files[0].hunks.map(hunk=>hunk.id),ids);
  assert.equal(journals(created.state).length,0);
});

test('Pending all reopens ignored requests without a source write or a completion prompt and invalidates the old prompt', async () => {
  const item=await fixture(),{api}=service(); let state=await ready(api,item); let completions=0;
  api.setCompletionRecorder(async()=>{completions++;});
  const completed=await api.decide(item.request,item.relative,undefined,'ignored',state.revision);
  assert.ok(completed.completionPrompt); assert.equal(completions,1);
  state=await ready(api,item); const writes=sourceWrites.length;
  assert.equal(await api.undoFile(item.request,item.relative,state.revision),undefined);
  assert.equal(sourceWrites.length,writes); assert.equal(completions,1);
  assert.deepEqual(await statuses(item),['pending','pending']); assert.equal(await read(item.target),item.before);
  const prompt=completed.completionPrompt;
  await assert.rejects(api.resolveCompletion(item.request,prompt.completionId,prompt.revision,true,false),/no longer current/);
  assert.equal((await ready(api,item)).closed,false);
});

test('Pending all rejects stale dirty untrusted and empty actions without changing either file', async () => {
  for (const kind of ['stale','dirty-source','dirty-request','untrusted','no-reviewed','unknown-file']) {
    const item=await fixture(),{api}=service(); let state=await ready(api,item);
    if(kind!=='no-reviewed') {await api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',state.revision);state=await ready(api,item);}
    let dirty;
    if(kind.startsWith('dirty-')) {dirty=await vscode.workspace.openTextDocument(kind==='dirty-source'?item.target:item.request);dirty.isDirty=true;}
    if(kind==='untrusted')vscode.workspace.isTrusted=false;
    const raw=await read(item.request),source=await read(item.target),writes=sourceWrites.length;
    try {
      await assert.rejects(api.undoFile(item.request,kind==='unknown-file'?'outside.txt':item.relative,kind==='stale'?'obsolete':state.revision),
        /request changed|unsaved|Save the .rr|Trust this workspace|no accepted or ignored|not part of the request/i);
      assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);assert.equal(sourceWrites.length,writes);
    } finally {if(dirty)dirty.isDirty=false;vscode.workspace.isTrusted=true;}
  }
});

test('Pending all cannot partially reset a review when an accepted or ignored block has manual changes', async () => {
  for (const blockedDecision of ['accepted','ignored']) {
    const item=await fixture(),created=service();let state=await ready(created.api,item);
    const ids=state.files[0].hunks.map(h=>h.id);
    await created.api.decide(item.request,item.relative,ids[0],'accepted',state.revision);state=await ready(created.api,item);
    await created.api.decide(item.request,item.relative,ids[1],blockedDecision,state.revision);
    await fs.writeFile(item.target.fsPath,'ONE\ncontext\nmanual changed review\n');
    state=await ready(created.api,item); assert.ok(state.files[0].hunks[1].undoBlocked);
    const source=await read(item.target),raw=await read(item.request),writes=sourceWrites.length;
    await assert.rejects(created.api.undoFile(item.request,item.relative,state.revision),/Undo is unavailable/i);
    assert.equal(await read(item.target),source);assert.equal(await read(item.request),raw);assert.equal(sourceWrites.length,writes);
    assert.equal(journals(created.state).length,0);
  }
});

test('Pending all preserves an unrelated pending conflict and its manual source', async () => {
  const item=await fixture(),{api}=service();let state=await ready(api,item);
  await api.decide(item.request,item.relative,state.files[0].hunks[0].id,'accepted',state.revision);
  await fs.writeFile(item.target.fsPath,'ONE\ncontext\nmanual pending replacement\n');state=await ready(api,item);
  assert.ok(state.files[0].hunks[1].conflict);
  await api.undoFile(item.request,item.relative,state.revision);
  assert.equal(await read(item.target),'one\ncontext\nmanual pending replacement\n');
  assert.deepEqual(await statuses(item),['pending','pending']);
  assert.ok((await ready(api,item)).files[0].hunks[1].conflict);
});

test('Pending all source-write failure leaves every decision intact', async () => {
  const item=await fixture(),created=service();let state=await ready(created.api,item);
  await created.api.decide(item.request,item.relative,undefined,'accepted',state.revision);state=await ready(created.api,item);
  const raw=await read(item.request),source=await read(item.target);
  sourceFault={path:item.target.fsPath,when:'before'};
  await assert.rejects(created.api.undoFile(item.request,item.relative,state.revision),/Injected source failure/);
  assert.equal(await read(item.request),raw);assert.equal(await read(item.target),source);
  assert.deepEqual(await statuses(item),['accepted','accepted']);assert.equal(journals(created.state).length,0);
});


test('PDF navigation finishes on the actual output PDF in the same group, a split group, or an already visible viewer', async () => {
  for (const mode of ['current','right','left','existing','moved']) {
    const item=await fixture(undefined,undefined,true,'tex'),{api}=service(),state=await ready(api,item);
    const original=await read(item.target),request=await read(item.request),start=pdfCommands.length;
    const output=Uri.file(path.join(path.dirname(item.target.fsPath),'output','master-output.pdf'));
    const destination=mode==='left'?1:mode==='current'?2:3;
    const target={input:new vscode.TabInputCustom(output,'latex-workshop-pdf-hook'),isActive:mode==='existing'};
    const other={input:new vscode.TabInputCustom(Uri.file(path.join(scratch,'unrelated.rr.pdf')),'latex-workshop-pdf-hook'),isActive:true};
    const group={viewColumn:destination,tabs:[target],activeTab:target};
    vscode.window.tabGroups.all=[{viewColumn:4,tabs:[other],activeTab:other},...(mode==='existing'?[group]:[])];
    settings.set('view.pdf.tab.editorGroup',mode==='left'?'left':mode==='current'?'current':'right');
    let sawSourceAfterView=false;
    pdfCommandHook=async command=>{
      if(command==='latex-workshop.view'){
        target.isActive=true;
        if(mode!=='existing')vscode.window.tabGroups.all.push(group);
        return 'handled';
      }
      if(command==='latex-workshop.synctex'){
        assert.equal(vscode.window.activeTextEditor.document.uri.toString(),item.target.toString());
        sawSourceAfterView=true;
        if(mode==='current')assert.notEqual(group.activeTab,target,'Returning to TeX really hides same-group PDF');
        if(mode==='moved')group.viewColumn=5;
      }
    };
    try {
      await api.openTargetPdf(item.request,item.relative,state.files[0].hunks[0].id,state.revision);
      assert.ok(sawSourceAfterView);
      const last=pdfCommands.at(-1);
      assert.equal(last.command,'vscode.openWith');assert.equal(last.args[0].toString(),output.toString());
      assert.deepEqual(last.args.slice(1),['latex-workshop-pdf-hook',{viewColumn:group.viewColumn,preserveFocus:false,preview:false}]);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab,target);
      assert.equal(vscode.window.activeTextEditor,undefined);
      assert.equal(pdfCommands.slice(start).some(item=>item.command.includes('build')),false);
      assert.equal(await read(item.target),original);assert.equal(await read(item.request),request);
    } finally {
      pdfCommandHook=undefined;settings.delete('view.pdf.tab.editorGroup');vscode.window.tabGroups.all=[];
    }
  }
});

test('PDF navigation does not guess among unrelated PDFs or reopen a viewer closed during forwarding', async () => {
  for(const kind of ['ambiguous','missing','closed']){
    const item=await fixture(undefined,undefined,true,'tex'),{api}=service(),state=await ready(api,item),start=pdfCommands.length;
    const tabs=[1,4].map(n=>{const tab={input:new vscode.TabInputCustom(Uri.file(path.join(scratch,'unrelated-'+n+'.pdf')),'latex-workshop-pdf-hook'),isActive:true};return {viewColumn:n,tabs:[tab],activeTab:tab};});
    vscode.window.tabGroups.all=kind==='missing'?[]:[...tabs];settings.set('view.pdf.tab.editorGroup','right');
    pdfCommandHook=async command=>{
      if(command==='latex-workshop.view'){
        if(kind==='closed'){
          const tab={input:new vscode.TabInputCustom(Uri.file(path.join(scratch,'original-output.pdf')),'latex-workshop-pdf-hook'),isActive:true};
          vscode.window.tabGroups.all.push({viewColumn:3,tabs:[tab],activeTab:tab});
        }
        return 'handled';
      }
      if(command==='latex-workshop.synctex'&&kind==='closed')vscode.window.tabGroups.all=tabs;
    };
    try{
      await assert.rejects(api.openTargetPdf(item.request,item.relative,state.files[0].hunks[0].id,state.revision),/Could not identify|tab changed or closed/);
      assert.equal(pdfCommands.slice(start).some(item=>item.command==='vscode.openWith'),false);
    }finally{pdfCommandHook=undefined;settings.delete('view.pdf.tab.editorGroup');vscode.window.tabGroups.all=[];}
  }
});

test('PDF navigation preserves browser and external viewer preferences without switching an unrelated VS Code PDF', async () => {
  for(const mode of ['browser','external']){
    const item=await fixture(undefined,undefined,true,'tex'),{api}=service(),state=await ready(api,item),start=pdfCommands.length;
    settings.set('view.pdf.viewer',mode);pdfCommandHook=async()=> 'handled';
    try{
      await api.openTargetPdf(item.request,item.relative,state.files[0].hunks[0].id,state.revision);
      assert.deepEqual(pdfCommands.slice(start).map(item=>item.command),['latex-workshop.view','latex-workshop.synctex']);
    }finally{settings.delete('view.pdf.viewer');pdfCommandHook=undefined;vscode.window.tabGroups.all=[];}
  }
});

function pdfProgressGate() {
  let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};
}

test('PDF progress spans confirmation and deferred compiler passes with one stable start time', async () => {
  const item = await fixture(undefined, undefined, true, 'tex');
  const prompted = pdfProgressGate(), consent = pdfProgressGate(), compiling = pdfProgressGate(), finishCompile = pdfProgressGate();
  let compilerReport;
  const fake = fakePdfTools({compile: async (_input, report) => {
    compilerReport = report;
    report({stage: 'diffing', message: 'Generating comparison…'});
    report({stage: 'compiling', message: 'Compiling PDF — pass 1 of 3…'});
    compiling.resolve();
    await finishCompile.promise;
  }});
  const {api} = service(undefined, undefined, fake.tools), state = await ready(api, item), events = [];
  api.onDidChangePdfGeneration(event => events.push({kind: 'progress', ...event}));
  api.onDidFinishPdfGeneration(event => events.push({kind: 'result', ...event}));
  let refreshes = 0; api.onDidChange(() => {refreshes++;});
  const warning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => {prompted.resolve(); return consent.promise;};
  try {
    const pending = api.generateReviewPdf(item.request, state.revision);
    await prompted.promise;
    const first = api.getPdfGenerationProgress(item.request);
    assert.equal(first.stage, 'confirming'); assert.equal(api.busy, true);
    assert.ok(Number.isFinite(first.startedAt)); assert.ok(first.startedAt <= Date.now());
    assert.equal(api.getPdfGenerationProgress(Uri.file(item.request.fsPath + '.other')), undefined);
    first.message = 'mutated copy';
    assert.notEqual(api.getPdfGenerationProgress(item.request).message, first.message);
    consent.resolve('Build PDF'); await compiling.promise;
    const compilingState = api.getPdfGenerationProgress(item.request), previousRefreshes = refreshes;
    assert.match(compilingState.message, /pass 1/); assert.equal(compilingState.startedAt, first.startedAt);
    compilerReport({stage: 'compiling', message: 'Compiling PDF — pass 2 of 3…'});
    assert.match(api.getPdfGenerationProgress(item.request).message, /pass 2/);
    assert.equal(refreshes, previousRefreshes, 'compiler stages do not trigger full review refreshes');
    finishCompile.resolve(); await pending;
    assert.equal(api.busy, false); assert.equal(api.getPdfGenerationProgress(item.request), undefined);
    assert.ok(events.filter(event => event.progress).every(event => event.uri.toString() === item.request.toString() && event.progress.startedAt === first.startedAt));
    assert.deepEqual(events.filter(event => event.progress).slice(-2).map(event => event.progress.stage), ['annotating', 'saving']);
    assert.equal(events.at(-2).progress, null); assert.equal(events.at(-1).outcome, 'created');
    assert.equal(await read(item.target), item.before);
  } finally {consent.resolve('Build PDF'); finishCompile.resolve(); vscode.window.showWarningMessage = warning;}
});

for (const outcome of ['cancelled', 'compile failure', 'stale request']) test('PDF progress clears after ' + outcome, async () => {
  const item = await fixture(undefined, undefined, true, 'tex');
  const fake = fakePdfTools({compile: async () => {if (outcome === 'compile failure') throw Error('Progress compile failure');}});
  const {api} = service(undefined, undefined, fake.tools), state = await ready(api, item), events = [];
  api.onDidChangePdfGeneration(event => events.push({kind: 'progress', ...event}));
  api.onDidFinishPdfGeneration(event => events.push({kind: 'result', ...event}));
  const warning = vscode.window.showWarningMessage;
  if (outcome === 'cancelled') vscode.window.showWarningMessage = async () => undefined;
  try {
    const action = api.generateReviewPdf(item.request, outcome === 'stale request' ? 'outdated' : state.revision);
    if (outcome === 'cancelled') await action;
    else await assert.rejects(action, outcome === 'compile failure' ? /Progress compile failure/ : /request changed/);
    assert.equal(api.getPdfGenerationProgress(item.request), undefined); assert.equal(api.busy, false);
    assert.equal(events.at(-2).progress, null);
    assert.equal(events.at(-1).outcome, outcome === 'cancelled' ? 'cancelled' : 'failed');
    if (outcome !== 'cancelled') assert.match(events.at(-1).error, outcome === 'compile failure' ? /Progress compile failure/ : /request changed/);
    if (outcome !== 'compile failure') assert.equal(fake.calls.compile.length, 0);
    await assert.rejects(fs.access(item.request.fsPath + '.pdf'), {code: 'ENOENT'});
  } finally {vscode.window.showWarningMessage = warning;}
});


test('Import directly applies accepted and ignored PDF decisions in one source transaction', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored'], false);
  const state = await ready(item.api, item), count = sourceWrites.length;
  const result = await item.api.importPdfReview(item.request, state.revision);
  assert.ok(result?.completionPrompt, 'Finishing the review preserves the usual cleanup question');
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n');
  assert.deepEqual(await statuses(item), ['accepted', 'ignored']);
  assert.equal(sourceWrites.length, count + 1);
  const after = await ready(item.api, item);
  assert.equal(after.pdfReview.imported, true); assert.equal(after.pdfReview.applied, true);
  assert.equal(after.pdfReview.pending, 0); assert.equal(after.pdfReview.canApply, false);
});

test('partial Import applies decided entries, then later Import completes the same export', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'pending'], false);
  let state = await ready(item.api, item); const count = sourceWrites.length;
  assert.equal(await item.api.importPdfReview(item.request, state.revision), undefined);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n');
  assert.deepEqual(await statuses(item), ['accepted', 'pending']);
  state = await ready(item.api, item); assert.equal(state.pdfReview.pending, 1); assert.equal(state.pdfReview.accepted, 1);
  await setPdfDecisions(item, ['accepted', 'accepted'], false);
  state = await ready(item.api, item);
  const result = await item.api.importPdfReview(item.request, state.revision);
  assert.ok(result?.completionPrompt);
  assert.equal(await read(item.target), 'ONE\ncontext\nTHREE\n');
  assert.deepEqual(await statuses(item), ['accepted', 'accepted']);
  assert.equal(sourceWrites.length, count + 2);
});

test('later Import can revise previous PDF choices and return entries to pending against an unchanged receipt', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored'], false);
  let state = await ready(item.api, item); await item.api.importPdfReview(item.request, state.revision);
  await setPdfDecisions(item, ['ignored', 'accepted'], false); state = await ready(item.api, item);
  await item.api.importPdfReview(item.request, state.revision);
  assert.equal(await read(item.target), 'one\ncontext\nTHREE\n');
  assert.deepEqual(await statuses(item), ['ignored', 'accepted']);
  await setPdfDecisions(item, ['pending', 'pending'], false); state = await ready(item.api, item);
  assert.equal(await item.api.importPdfReview(item.request, state.revision), undefined);
  assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
});

test('repeated Import and restart preserve the same decisions without replaying writes or completion prompts', async () => {
  const item = await pdfFixture(); const rawPending = await read(item.request), count = sourceWrites.length;
  let state = await ready(item.api, item);
  assert.equal(await item.api.importPdfReview(item.request, state.revision), undefined);
  assert.equal(sourceWrites.length, count); assert.equal(await read(item.request), rawPending);
  await setPdfDecisions(item, ['accepted', 'ignored'], false); state = await ready(item.api, item);
  await item.api.importPdfReview(item.request, state.revision);
  const raw = await read(item.request), source = await read(item.target), afterCount = sourceWrites.length;
  state = await ready(item.api, item);
  assert.equal(await item.api.importPdfReview(item.request, state.revision), undefined);
  const restarted = service(item.state, undefined, item.tools).api;
  state = await ready(restarted, item);
  assert.equal(await restarted.importPdfReview(item.request, state.revision), undefined);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), source);
  assert.equal(sourceWrites.length, afterCount);
});

test('Import waits for this companion viewer to flush selections before reading or applying the PDF', async () => {
  const item = await pdfFixture(); let release, entered;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  item.api.setPdfReviewFlush(async uri => {
    assert.equal(uri.toString(), Uri.file(item.request.fsPath + '.pdf').toString());
    entered(); await gate;
    await setPdfDecisions(item, ['accepted', 'ignored'], false);
  });
  const state = await ready(item.api, item), reads = item.calls.read, count = sourceWrites.length;
  const importing = item.api.importPdfReview(item.request, state.revision);
  await started;
  try {
    assert.equal(item.calls.read, reads, 'Unsaved viewer choices are flushed before form bytes are parsed');
    assert.equal(sourceWrites.length, count); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  } finally {release();}
  await importing;
  assert.ok(item.calls.read > reads);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'ignored']);
});

test('a failed viewer flush aborts Import before reading or writing source decisions', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored'], false);
  item.api.setPdfReviewFlush(async () => {throw Error('Pending PDF selections could not be saved');});
  const state = await ready(item.api, item), raw = await read(item.request), reads = item.calls.read, count = sourceWrites.length;
  await assert.rejects(item.api.importPdfReview(item.request, state.revision), /could not be saved/);
  assert.equal(item.calls.read, reads); assert.equal(sourceWrites.length, count);
  assert.equal(await read(item.target), item.before); assert.equal(await read(item.request), raw); assert.equal(item.api.busy, false);
});

test('Import refuses untrusted workspaces before flushing or applying saved decisions', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored'], false);
  let flushes = 0; item.api.setPdfReviewFlush(async () => {flushes++;});
  const state = await ready(item.api, item), raw = await read(item.request), count = sourceWrites.length;
  vscode.workspace.isTrusted = false;
  try {await assert.rejects(item.api.importPdfReview(item.request, state.revision), /Trust/);}
  finally {vscode.workspace.isTrusted = true;}
  assert.equal(flushes, 0); assert.equal(sourceWrites.length, count);
  assert.equal(await read(item.target), item.before); assert.equal(await read(item.request), raw);
});

test('Import rejects changed local decisions after an earlier PDF application', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'pending'], false);
  let state = await ready(item.api, item); await item.api.importPdfReview(item.request, state.revision);
  state = await ready(item.api, item);
  await item.api.decide(item.request, item.relative, state.files[0].hunks[1].id, 'ignored', state.revision);
  await setPdfDecisions(item, ['accepted', 'accepted'], false); state = await ready(item.api, item);
  const raw = await read(item.request), source = await read(item.target), count = sourceWrites.length;
  await assert.rejects(item.api.importPdfReview(item.request, state.revision), /changed|match|different/i);
  assert.equal(await read(item.request), raw); assert.equal(await read(item.target), source); assert.equal(sourceWrites.length, count);
});

test('failed automatic Import can retry source application without losing the saved PDF review', async () => {
  const item = await pdfFixture(); await setPdfDecisions(item, ['accepted', 'ignored'], false);
  let state = await ready(item.api, item); sourceFault = {path: item.target.fsPath, when: 'before'};
  await assert.rejects(item.api.importPdfReview(item.request, state.revision), /Injected source failure/);
  assert.equal(await read(item.target), item.before); assert.deepEqual(await statuses(item), ['pending', 'pending']);
  state = await ready(item.api, item); await item.api.importPdfReview(item.request, state.revision);
  assert.equal(await read(item.target), 'ONE\ncontext\nthree\n'); assert.deepEqual(await statuses(item), ['accepted', 'ignored']);
});
