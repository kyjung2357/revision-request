'use strict';
// Exercise the actual custom PDF editor host without launching VS Code or a PDF viewer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');
const Module = require('node:module');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.codex-test-pdf-provider');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
class Uri {
  constructor(value) {this.value = new URL(value); this.scheme = this.value.protocol.slice(0, -1); this.path = decodeURIComponent(this.value.pathname); this.fsPath = this.scheme === 'file' ? fileURLToPath(this.value) : this.path;}
  toString() {return this.value.href;}
  static file(value) {return new Uri(pathToFileURL(path.resolve(value)).href);}
  static joinPath(uri, ...parts) {return Uri.file(path.join(uri.fsPath, ...parts));}
}
class Emitter {
  listeners = new Set();
  event = listener => {this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)};};
  async fire(value) {await Promise.all([...this.listeners].map(listener => listener(value)));}
}
class Panel {
  disposed = false; received = new Emitter(); closed = new Emitter();
  onDidDispose = this.closed.event;
  webview = {
    options: {}, html: '', cspSource: 'vscode-webview:', messages: [],
    asWebviewUri: uri => uri,
    onDidReceiveMessage: this.received.event,
    postMessage: async message => {this.webview.messages.push(message); return this.sendResult ?? true;},
  };
  async send(message) {await this.received.fire(message);}
  dispose() {if (!this.disposed) {this.disposed = true; void this.closed.fire();}}
}
let current;
const vscode = {Uri, workspace: {
  get isTrusted() {return current.trusted;},
  getWorkspaceFolder(uri) {
    if (current.claimEveryPath) return {uri: current.workspace};
    const relative = path.relative(current.workspace.fsPath, uri.fsPath);
    return uri.scheme === 'file' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? {uri: current.workspace} : undefined;
  },
}};
const originalLoad = Module._load;
Module._load = function(name, parent, main) {return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main);};
require('tsx/cjs');
const {ReviewPdfEditor, PDF_REVIEW_VIEW} = require('../src/reviewPdfEditor.ts');
Module._load = originalLoad;
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {const deadline = Date.now() + 3000; while (!predicate()) {if (Date.now() > deadline) assert.fail('Timed out waiting for host event'); await sleep(5);}}
function snapshot(hash = A, decisions = {'change-0': 'pending', 'change-1': 'ignored'}) {
  return {bytes: Buffer.from('%PDF-provider-test-' + hash[0]), review: {pdfHash: hash,
    manifest: {format: 'revision-request-pdf', exportId: 'provider-test', path: 'sample.tex', entries: [{id: 'change-0', index: 0}, {id: 'change-1', index: 1}]}, decisions}};
}
async function setup(t, options = {}) {
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.codex-\*\/$/m);
  fs.mkdirSync(scratch, {recursive: true});
  const folder = fs.mkdtempSync(path.join(scratch, 'host-')), workspace = path.join(folder, 'workspace');
  fs.mkdirSync(workspace);
  current = {workspace: Uri.file(workspace), trusted: options.trusted !== false};
  const uri = Uri.joinPath(current.workspace, 'sample.tex.rr.pdf'), panel = new Panel(), changed = [];
  const store = {
    state: snapshot(), loads: [], saves: [], flushes: [],
    async load(filename) {this.loads.push(filename); return this.onLoad ? this.onLoad(filename) : this.state;},
    async saveDecision(...args) {
      this.saves.push(args);
      if (this.onSave) return this.onSave(...args);
      assert.equal(args[1], this.state.review.pdfHash);
      this.state = snapshot(this.state.review.pdfHash === A ? B : C, {...this.state.review.decisions, [args[2]]: args[3]});
      return this.state;
    },
    async flush(filename) {this.flushes.push(filename); if (this.onFlush) await this.onFlush(filename);},
  };
  const editor = new ReviewPdfEditor(Uri.file(root), changedUri => changed.push(changedUri.toString()), store);
  t.after(() => {editor.dispose(); const resolved = path.resolve(folder); assert.equal(path.dirname(resolved), scratch); fs.rmSync(resolved, {recursive: true, force: true});});
  const document = await editor.openCustomDocument(uri);
  await editor.resolveCustomEditor(document, panel);
  if (options.ready !== false) await panel.send({type: 'ready'});
  const messages = type => panel.webview.messages.filter(message => message.type === type);
  const choice = (overrides = {}) => ({type: 'saveDecision', sequence: 1, expectedPdfHash: store.state.review.pdfHash, entryId: 'change-0', decision: 'accepted', ...overrides});
  return {editor, store, panel, uri, document, changed, folder, workspace, messages, choice};
}

test('ready loads the document bytes, verified manifest and existing choices into a local-only webview', async t => {
  const {panel, store, uri, messages} = await setup(t);
  assert.equal(PDF_REVIEW_VIEW, 'revisionRequest.pdfReview');
  assert.deepEqual(store.loads, [uri.fsPath, uri.fsPath]);
  assert.equal(messages('pdfState').length, 1);
  const state = messages('pdfState')[0];
  assert.deepEqual(Buffer.from(state.base64, 'base64'), store.state.bytes);
  assert.deepEqual(state.manifest, store.state.review.manifest);
  assert.deepEqual(state.decisions, {'change-0': 'pending', 'change-1': 'ignored'});
  assert.equal(state.pdfHash, A); assert.equal(state.readOnly, false);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.webview.options.localResourceRoots.length, 3);
  for (const uri of panel.webview.options.localResourceRoots) assert.ok(uri.fsPath.startsWith(root + path.sep));
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /%PDF-provider-test/);
});

test('valid decisions persist only to the opened document and acknowledge the new hash before notifying the request', async t => {
  const {panel, store, uri, changed, messages, choice} = await setup(t);
  await panel.send(choice());
  assert.deepEqual(store.saves, [[uri.fsPath, A, 'change-0', 'accepted', false]]);
  assert.deepEqual(messages('pdfSaved'), [{type: 'pdfSaved', sequence: 1, pdfHash: B, decisions: {'change-0': 'accepted', 'change-1': 'ignored'}}]);
  assert.deepEqual(changed, [uri.toString()]);
  await panel.send(choice({sequence: 2, decision: 'pending'}));
  assert.deepEqual(store.saves[1], [uri.fsPath, B, 'change-0', 'pending', false]);
  assert.equal(messages('pdfSaved')[1].pdfHash, C);
});

test('Accept up to here forwards only a validated true flag', async t => {
  const {panel, store, uri, choice} = await setup(t);
  await panel.send(choice({through: true}));
  assert.deepEqual(store.saves, [[uri.fsPath, A, 'change-0', 'accepted', true]]);
});

test('forged metadata, unsupported fields and malformed decisions cannot choose a path or reach the store', async t => {
  const {panel, store, messages, choice} = await setup(t);
  const invalid = [
    {uri: 'file:///outside.tex.rr.pdf'}, {filename: '../other.pdf'}, {path: 'other.pdf'}, {manifest: {}},
    {sequence: 0}, {sequence: 1.5}, {sequence: Number.MAX_SAFE_INTEGER + 1}, {sequence: '1'},
    {expectedPdfHash: 'not-a-hash'}, {expectedPdfHash: 'A'.repeat(64)}, {expectedPdfHash: A + 'a'},
    {entryId: ''}, {entryId: 'x'.repeat(129)}, {entryId: null}, {decision: 'approve'}, {decision: null},
    {through: 'true'}, {through: true, decision: 'ignored'}, {through: true, decision: 'pending'},
  ];
  for (const overrides of invalid) await panel.send(choice(overrides));
  assert.equal(store.saves.length, 0);
  assert.equal(messages('pdfSaveError').length, invalid.length);
  assert.ok(messages('pdfSaveError').every(message => message.error === 'Invalid PDF review choice.'));
});

test('untrusted workspaces are readable but cannot save, including trust revoked after ready', async t => {
  const {panel, store, messages, choice} = await setup(t, {trusted: false});
  assert.equal(messages('pdfState')[0].readOnly, true);
  await panel.send(choice());
  assert.match(messages('pdfSaveError')[0].error, /Trust this workspace/);
  current.trusted = true;
  await panel.send({type: 'ready'});
  assert.equal(messages('pdfState')[1].readOnly, false);
  current.trusted = false;
  await panel.send(choice({sequence: 2}));
  assert.match(messages('pdfSaveError')[1].error, /Trust this workspace/);
  assert.equal(store.saves.length, 0);
});

test('not-ready and stale-hash decisions are rejected without writing', async t => {
  const {panel, store, messages, choice} = await setup(t, {ready: false});
  await panel.send(choice());
  await panel.send({type: 'ready'});
  await panel.send(choice({sequence: 2, expectedPdfHash: B}));
  assert.equal(store.saves.length, 0);
  assert.equal(messages('pdfSaveError').length, 2);
  assert.ok(messages('pdfSaveError').every(message => /out of date/.test(message.error)));
});

test('save failures produce a correlated error and permit retry against the last acknowledged hash', async t => {
  const {panel, store, changed, messages, choice} = await setup(t);
  store.onSave = async () => {throw new Error('PDF changed on disk');};
  await panel.send(choice({sequence: 7}));
  assert.deepEqual(messages('pdfSaveError'), [{type: 'pdfSaveError', sequence: 7, error: 'PDF changed on disk'}]);
  assert.equal(messages('pdfSaved').length, 0); assert.deepEqual(changed, []);
  delete store.onSave;
  await panel.send(choice({sequence: 8}));
  assert.equal(messages('pdfSaved')[0].sequence, 8);
  assert.equal(store.saves[1][1], A);
});

test('load failures are reported and do not allow decisions from an uninitialized document', async t => {
  const {panel, store, messages, choice} = await setup(t, {ready: false});
  store.onLoad = async () => {throw new Error('Invalid review PDF');};
  await panel.send({type: 'ready'});
  assert.deepEqual(messages('pdfError'), [{type: 'pdfError', error: 'Invalid review PDF'}]);
  assert.equal(messages('pdfState').length, 0);
  await panel.send(choice());
  assert.equal(store.saves.length, 0);
});

test('flush waits for the matching client reply and then the durable store flush', async t => {
  const {editor, store, panel, uri, messages} = await setup(t);
  const disk = deferred(); store.onFlush = () => disk.promise;
  let completed = false;
  const flushing = editor.flush(uri).then(() => {completed = true;});
  await until(() => messages('flush').length === 1);
  const requestId = messages('flush')[0].requestId;
  await panel.send({type: 'flushed', requestId: 'unrelated', ok: true});
  await sleep(10);
  assert.deepEqual(store.flushes, []); assert.equal(completed, false);
  await panel.send({type: 'flushed', requestId, ok: true});
  await until(() => store.flushes.length === 1);
  assert.deepEqual(store.flushes, [uri.fsPath]); assert.equal(completed, false);
  disk.resolve(); await flushing;
  assert.equal(completed, true);
});

test('a dirty client save failure rejects import flush without proceeding to the store', async t => {
  const {editor, store, panel, uri, messages} = await setup(t);
  const flushing = editor.flush(uri), rejected = assert.rejects(flushing, /Resolve the unsaved PDF choice/);
  await until(() => messages('flush').length === 1);
  await panel.send({type: 'flushed', requestId: messages('flush')[0].requestId, ok: false, error: 'Resolve the unsaved PDF choice'});
  await rejected; assert.deepEqual(store.flushes, []);
});

test('a store flush failure prevents successful import even when the client reports saved', async t => {
  const {editor, store, panel, uri, messages} = await setup(t);
  store.onFlush = async () => {throw new Error('The last PDF write failed');};
  const rejected = assert.rejects(editor.flush(uri), /last PDF write failed/);
  await until(() => messages('flush').length === 1);
  await panel.send({type: 'flushed', requestId: messages('flush')[0].requestId, ok: true});
  await rejected; assert.deepEqual(store.flushes, [uri.fsPath]);
});

test('flush without an open ready client still checks the store', async t => {
  const {editor, store, panel, uri, messages} = await setup(t, {ready: false});
  await editor.flush(uri);
  assert.deepEqual(store.flushes, [uri.fsPath]); assert.deepEqual(messages('flush'), []);
  panel.dispose(); await editor.flush(uri);
  assert.deepEqual(store.flushes, [uri.fsPath, uri.fsPath]);
});

test('closing the panel rejects its pending flush instead of importing unsaved choices', async t => {
  const {editor, store, panel, uri, messages} = await setup(t);
  const rejected = assert.rejects(editor.flush(uri), /PDF view closed before saving finished/);
  await until(() => messages('flush').length === 1);
  panel.dispose(); await rejected;
  assert.deepEqual(store.flushes, []);
});

test('failed delivery of a flush request rejects immediately and does not import', async t => {
  const {editor, store, panel, uri} = await setup(t);
  panel.sendResult = false;
  await assert.rejects(editor.flush(uri), /PDF view is unavailable/);
  assert.deepEqual(store.flushes, []);
});

test('own save watcher events cannot replace the client state or reset existing decisions', async t => {
  const {editor, store, panel, uri, messages, choice} = await setup(t);
  const write = deferred();
  store.onSave = () => write.promise;
  const saving = panel.send(choice());
  await until(() => store.saves.length === 1);
  editor.pdfChanged(uri); await sleep(130);
  assert.equal(store.loads.length, 2, 'Do not reload in the middle of a save');
  store.state = snapshot(B, {'change-0': 'accepted', 'change-1': 'ignored'});
  write.resolve(store.state); await saving;
  editor.pdfChanged(uri); await sleep(150);
  assert.equal(store.loads.length, 3, 'A late watcher event checks the saved hash');
  assert.equal(messages('pdfState').length, 1, 'An own-save hash must not repaint or replace the client queue');
  store.state = snapshot(C, {'change-0': 'ignored', 'change-1': 'ignored'});
  editor.pdfChanged(uri); await until(() => messages('pdfState').length === 2);
  assert.equal(messages('pdfState')[1].pdfHash, C);
});

test('a load begun before a completed save cannot overwrite the new acknowledged state', async t => {
  const {editor, store, panel, uri, messages, choice} = await setup(t);
  const loading = deferred(), oldSnapshot = store.state;
  store.onLoad = () => loading.promise;
  editor.pdfChanged(uri);
  await until(() => store.loads.length === 3);
  await panel.send(choice());
  assert.equal(messages('pdfSaved')[0].pdfHash, B);
  loading.resolve(oldSnapshot); await sleep(20);
  assert.equal(messages('pdfState').length, 1, 'A stale load must not resend the pre-save bytes');
  await panel.send(choice({sequence: 2, decision: 'ignored'}));
  assert.equal(messages('pdfSaved').length, 2, 'The next choice must use the new acknowledged hash');
});

test('dispose suppresses late load responses and cancels scheduled watcher reloads', async t => {
  const {editor, store, panel, uri, messages} = await setup(t, {ready: false});
  const loading = deferred(); store.onLoad = () => loading.promise;
  const ready = panel.send({type: 'ready'});
  await until(() => store.loads.length === 2);
  editor.pdfChanged(uri); panel.dispose();
  loading.resolve(store.state); await ready; await sleep(130);
  assert.equal(messages('pdfState').length, 0);
  assert.equal(store.loads.length, 2);
});

test('only local RR PDFs inside the real workspace and outside Git metadata can be opened', async t => {
  const {editor, store, workspace, folder} = await setup(t);
  const before = store.loads.length;
  await assert.rejects(editor.openCustomDocument(Uri.file(path.join(workspace, 'plain.pdf'))), /local workspace/);
  await assert.rejects(editor.openCustomDocument(new Uri('https://example.com/sample.rr.pdf')), /local workspace/);
  const outside = path.join(folder, 'outside'); fs.mkdirSync(outside);
  await assert.rejects(editor.openCustomDocument(Uri.file(path.join(outside, 'sample.rr.pdf'))), /local workspace/);
  const metadata = path.join(workspace, '.git'); fs.mkdirSync(metadata);
  await assert.rejects(editor.openCustomDocument(Uri.file(path.join(metadata, 'sample.rr.pdf'))), /outside Git metadata/);
  current.claimEveryPath = true;
  await assert.rejects(editor.openCustomDocument(Uri.file(path.join(outside, 'sample.rr.pdf'))), /remain inside the workspace/);
  assert.equal(store.loads.length, before);
});

test('a failed stale load cannot hide a successful save behind an obsolete PDF error', async t => {
  const {editor, store, panel, uri, messages, choice} = await setup(t);
  const loading = deferred(); store.onLoad = () => loading.promise;
  editor.pdfChanged(uri); await until(() => store.loads.length === 3);
  await panel.send(choice());
  loading.reject(new Error('Obsolete load failed')); await sleep(20);
  assert.equal(messages('pdfSaved')[0].pdfHash, B);
  assert.deepEqual(messages('pdfError'), []);
  await panel.send(choice({sequence: 2, decision: 'ignored'}));
  assert.equal(messages('pdfSaved').length, 2);
});

test('a rejected webview delivery also aborts flush without reading stale disk choices', async t => {
  const {editor, store, panel, uri} = await setup(t);
  panel.webview.postMessage = async () => {throw new Error('Webview disconnected');};
  await assert.rejects(editor.flush(uri), /Webview disconnected/);
  assert.deepEqual(store.flushes, []);
});
