'use strict';
// Run the real ReviewEditor lifecycle with an in-memory VS Code API double.
// No extension bundle, workspace files, or target writes are needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');
const Module = require('node:module');
const {test} = require('node:test');
class Uri {
  constructor(value) {
    this.value = new URL(value); this.scheme = this.value.protocol.slice(0, -1);
    this.path = decodeURIComponent(this.value.pathname); this.query = this.value.search.slice(1);
    this.fragment = this.value.hash.slice(1);
    this.fsPath = this.scheme === 'file' ? fileURLToPath(this.value) : this.path;
  }
  toString() { return this.value.href; }
  static parse(value) { return new Uri(value); }
  static file(value) { return new Uri(pathToFileURL(path.resolve(value)).href); }
  static joinPath(uri, ...parts) { return Uri.file(path.join(uri.fsPath, ...parts)); }
}
class Emitter {
  listeners = new Set();
  event = listener => {this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)};};
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Panel {
  active = true; viewColumn = 1; disposed = false; reveals = 0; title = 'Preview';
  changed = new Emitter(); closed = new Emitter(); received = new Emitter();
  onDidChangeViewState = this.changed.event;
  onDidDispose = this.closed.event;
  webview = {
    options: {}, html: '', cspSource: 'vscode-webview:', messages: [],
    asWebviewUri: uri => uri,
    onDidReceiveMessage: this.received.event,
    postMessage: async message => {this.webview.messages.push(message); return true;},
  };
  reveal() {
    if (this.failReveal) {this.failReveal = false; throw new Error('Injected reveal failure');}
    assert.equal(this.disposed, false); this.reveals++; this.active = true;
    this.changed.fire({webviewPanel: this});
  }
  dispose() { if (!this.disposed) {this.disposed = true; this.closed.fire();} }
}
let current;
const vscode = {
  Uri, EventEmitter: Emitter, ViewColumn: {Active: -1},
  workspace: {
    get textDocuments() {return current.documents;},
    getConfiguration: () => ({get: (_key, fallback) => current.previewOnOpen ?? fallback}),
    getWorkspaceFolder(uri) {
      const relative = path.relative(current.workspace.fsPath, uri.fsPath);
      return uri.scheme === 'file' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        ? {uri: current.workspace} : undefined;
    },
  },
  window: {
    createWebviewPanel(_viewType, title, _column, options) {
      current.attempts++;
      if (current.failCreate) {current.failCreate = false; throw new Error('Injected create failure');}
      const panel = new Panel(); panel.title = title; panel.webview.options = options;
      panel.failReveal = current.failReveal; current.failReveal = false;
      current.created.push(panel); return panel;
    },
    showErrorMessage: async message => {current.errors.push(message);},
    showTextDocument: async uri => {current.sourceOpens.push(uri.toString());},
  },
};
const originalLoad = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
require('tsx/cjs');
const {ReviewEditor} = require('../src/extension.ts');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  current = {workspace: Uri.file(path.join(__dirname, 'virtual-workspace')), attempts: 0, created: [], errors: [], sourceOpens: [], requests: [], documents: []};
  const changed = new Emitter(), deleted = new Emitter();
  const service = {
    onDidChange: changed.event, onDidDeleteRequest: deleted.event,
    getState: async uri => {current.requests.push(uri.toString()); return {type: 'state', files: [], revision: 'test'};},
  };
  const context = {extensionUri: Uri.file(path.resolve(__dirname, '..'))};
  const editor = new ReviewEditor(context, service, {});
  t.after(() => editor.dispose());
  const uri = Uri.joinPath(current.workspace, 'inventory_report.py.rr');
  const document = {uri}; current.documents.push(document);
  return {editor, uri, document, service, changed, deleted};
}
test('Python RR automatically previews once per open source document, including after preview close', async t => {
  const {editor, uri, document} = setup(t);
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1);
  assert.match(current.created[0].webview.html, /data-request-uri="[^"]*inventory_report\.py\.rr"/);
  current.created[0].dispose();
  editor.autoPreview({document});
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'other.py')}});
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1, 'Closing preview and returning to JSON cannot create another automatic preview');
  await editor.openPreview(uri);
  assert.equal(current.attempts, 2, 'Explicit opening remains available');
  current.created[1].dispose();
  editor.autoPreview({document: {uri}}); await tick();
  assert.equal(current.attempts, 3, 'A newly opened TextDocument has its own automatic preview');
});
test('failed automatic creation can retry without reopening the source document', async t => {
  const {editor, document} = setup(t); current.failCreate = true;
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1); assert.deepEqual(current.errors, ['Injected create failure']);
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 2); assert.equal(current.created.length, 1);
  current.created[0].dispose(); editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 2, 'The successful retry still consumes only one automatic preview');
});
test('failed reveal disposes its incomplete panel before automatic retry', async t => {
  const {editor, document} = setup(t); current.failReveal = true;
  editor.autoPreview({document}); await tick();
  assert.equal(current.created[0].disposed, true); assert.equal(editor.activeUri, undefined);
  editor.autoPreview({document}); await tick();
  assert.equal(current.created.length, 2); assert.equal(current.created[1].disposed, false);
  assert.deepEqual(current.errors, ['Injected reveal failure']);
});
test('disabled automatic preview and explicit JSON viewing remain respected', async t => {
  const {editor, uri, document} = setup(t); current.previewOnOpen = false;
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 0);
  current.previewOnOpen = true; editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1);
  const other = Uri.joinPath(current.workspace, 'source-only.py.rr'), otherDocument = {uri: other};
  await editor.openSource(other); editor.autoPreview({document: otherDocument});
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'other.py')}});
  editor.autoPreview({document: otherDocument}); await tick();
  assert.deepEqual(current.sourceOpens, [other.toString()]); assert.equal(current.attempts, 1);
});
test('restored Python panel rebinds the saved request and is reused without duplicate panels', async t => {
  const {editor, uri} = setup(t), restored = new Panel();
  await editor.deserializeWebviewPanel(restored, {requestUri: uri.toString(), splitRatio: 0.4}); await tick();
  assert.deepEqual(current.requests, [uri.toString()]);
  assert.equal(restored.title, 'inventory_report.py.rr — Preview');
  assert.equal(restored.webview.options.enableScripts, true);
  assert.equal(restored.webview.options.localResourceRoots.length, 1);
  assert.equal(editor.activeUri.toString(), uri.toString());
  assert.match(restored.webview.html, /data-request-uri="[^"]*inventory_report\.py\.rr"/);
  await editor.openPreview(uri); assert.equal(current.created.length, 0); assert.equal(restored.reveals, 1);
  const duplicate = new Panel();
  await editor.deserializeWebviewPanel(duplicate, {requestUri: uri.toString()});
  assert.equal(duplicate.disposed, true); assert.equal(restored.disposed, false);
  await editor.openPreview(uri); assert.equal(current.created.length, 0);
  restored.received.fire({type: 'ready'}); await tick(); assert.equal(editor.readyCount, 1);
  restored.dispose(); await editor.openPreview(uri); assert.equal(current.created.length, 1);
});
test('restored or explicitly opened preview counts the existing source as already previewed', async t => {
  const {editor, uri, document} = setup(t), restored = new Panel();
  await editor.deserializeWebviewPanel(restored, {requestUri: uri.toString()}); await tick();
  restored.dispose(); editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 0);
  const other = Uri.joinPath(current.workspace, 'manual.py.rr'), otherDocument = {uri: other};
  current.documents.push(otherDocument);
  await editor.openPreview(other); current.created[0].dispose();
  editor.autoPreview({document: otherDocument}); await tick(); assert.equal(current.attempts, 1);
  current.documents = current.documents.filter(item => item !== otherDocument);
  const reopened = {uri: other}; current.documents.push(reopened);
  editor.autoPreview({document: reopened}); await tick(); assert.equal(current.attempts, 2);
});
test('editor-title Open Source maps the synthetic webview URI to its actual bound RR', async t => {
  const {editor, uri} = setup(t);
  await editor.openPreview(uri);
  await editor.openSource(Uri.parse('webview-panel:webview-panel/webview-revisionRequest.review-31456000-5163-42ab-86b1-adb9e09d2659'));
  assert.deepEqual(current.sourceOpens, [uri.toString()]);
  await assert.rejects(editor.openSource(Uri.parse('other:unrelated')), /Choose a local/);
  current.created[0].active = false;
  await editor.openSource(Uri.parse('webview-panel:webview-panel/webview-revisionRequest.review-inactive'));
  assert.deepEqual(current.sourceOpens, [uri.toString()], 'An inactive panel cannot resolve a synthetic resource');
  current.created[0].dispose();
  await editor.openSource(Uri.parse('webview-panel:webview-panel/webview-revisionRequest.review-old'));
  assert.deepEqual(current.sourceOpens, [uri.toString()], 'An unbound synthetic resource cannot guess a source');
});
test('layout title command targets only the active bound preview and never opens its synthetic URI', async t => {
  const {editor, uri} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0];
  panel.webview.messages = [];
  const virtual = Uri.parse('webview-panel:webview-panel/webview-revisionRequest.review-layout');
  await editor.toggleLayout(virtual);
  assert.deepEqual(panel.webview.messages, [{type: 'toggleLayout'}]);
  assert.deepEqual(current.sourceOpens, []);
  panel.active = false;
  await editor.toggleLayout(virtual);
  assert.equal(panel.webview.messages.length, 1);
  panel.active = true;
  await editor.toggleLayout(Uri.joinPath(current.workspace, 'another.py.rr'));
  assert.equal(panel.webview.messages.length, 1);
  await editor.toggleLayout();
  assert.equal(panel.webview.messages.length, 2);
  const unbound = new Panel();
  await editor.deserializeWebviewPanel(unbound, {});
  await editor.toggleLayout(virtual);
  assert.equal(panel.webview.messages.length, 2, 'An active unbound panel cannot target a previously active request');
  unbound.dispose();
});

test('legacy or invalid restored state never guesses a target or opens a synthetic URI as text', async t => {
  const {editor, uri} = setup(t);
  const states = [undefined, null, {}, {requestUri: 7}, {requestUri: 'not a uri'},
    {requestUri: 'webview-panel:webview-panel/webview-revisionRequest.review-123'},
    {requestUri: Uri.joinPath(current.workspace, 'inventory_report.py').toString()},
    {requestUri: Uri.file(path.join(__dirname, 'outside.py.rr')).toString()},
    {requestUri: uri.toString() + '?other'}, {requestUri: uri.toString() + '#other'}];
  for (const state of states) {
    const panel = new Panel(); panel.title = 'inventory_report.py.rr — Preview';
    editor.activeUri = uri;
    await editor.deserializeWebviewPanel(panel, state); await tick();
    assert.equal(panel.webview.options.enableScripts, false);
    assert.match(panel.webview.html, /Reopen the revision request/);
    assert.doesNotMatch(panel.webview.html, /data-request-uri|<script/);
    assert.equal(editor.activeUri, undefined);
    await editor.openSource(); panel.dispose();
  }
  assert.deepEqual(current.requests, []); assert.deepEqual(current.sourceOpens, []); assert.equal(current.attempts, 0);
});
test('saved request URI is escaped in HTML and serializer activation is declared', async t => {
  const {editor} = setup(t), uri = Uri.joinPath(current.workspace, 'inventory & orders.py.rr');
  await editor.openPreview(uri);
  assert.ok(current.created[0].webview.html.includes('data-request-uri="' + uri.toString().replaceAll('&', '&amp;') + '"'));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(manifest.activationEvents.includes('onWebviewPanel:revisionRequest.review'));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

for (const action of ['decide', 'undo']) test(action + ' batches write events into one final refresh and preserves completion ordering', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  const actionGate = deferred(), postedState = deferred();
  let reads = 0;
  service.busy = false;
  service.getState = async () => {reads++; return {type: 'state', busy: false, files: [], revision: 'new'};};
  service[action] = async () => {
    service.busy = true; changed.fire();
    for (let index = 0; index < 5; index++) changed.fire();
    await actionGate.promise;
    service.busy = false; changed.fire();
    return action === 'decide' ? {completionPrompt: {completionId: 'done', revision: 'new'}} : undefined;
  };
  panel.webview.messages = [];
  panel.webview.postMessage = async message => {
    panel.webview.messages.push(message);
    if (message.type === 'state') await postedState.promise;
    return true;
  };
  const pending = receive({type: action, filePath: 'inventory_report.py', hunkId: 'hunk', decision: 'accepted', revision: 'old'});
  await tick();
  assert.equal(reads, 0, 'Busy notifications and five write events cannot read partially committed files');
  assert.deepEqual(panel.webview.messages, [{type: 'busy', busy: true}]);
  actionGate.resolve(); await tick();
  assert.equal(reads, 1, 'Transaction-end and message-handler refreshes share one state read');
  assert.deepEqual(panel.webview.messages.map(message => message.type), ['busy', 'state']);
  postedState.resolve(); await pending;
  assert.equal(reads, 1);
  assert.deepEqual(panel.webview.messages.map(message => message.type), action === 'decide' ? ['busy', 'state', 'completionPrompt'] : ['busy', 'state']);
});

test('external refresh bursts keep one state read in flight and discard its superseded result', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], firstRead = deferred();
  let reads = 0, active = 0, maximum = 0;
  service.getState = async () => {
    reads++; active++; maximum = Math.max(maximum, active);
    try {return reads === 1 ? await firstRead.promise : {type: 'state', revision: 'latest', files: []};}
    finally {active--;}
  };
  panel.webview.messages = [];
  changed.fire(); await tick();
  for (let index = 0; index < 8; index++) changed.fire();
  await tick(); assert.equal(reads, 1);
  firstRead.resolve({type: 'state', revision: 'obsolete', files: []}); await tick();
  assert.equal(reads, 2, 'Eight later events require one trailing refresh');
  assert.equal(maximum, 1);
  assert.deepEqual(panel.webview.messages.map(message => message.revision), ['latest']);
});

test('an action invalidates a pending state read without publishing transient empty rows', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], firstRead = deferred(); let reads = 0;
  service.getState = async () => ++reads === 1 ? firstRead.promise : {type: 'state', busy: false, revision: 'committed', files: [{path: 'inventory_report.py'}]};
  panel.webview.messages = [];
  changed.fire(); await tick();
  service.busy = true; changed.fire(); changed.fire();
  firstRead.resolve({type: 'state', error: 'Intermediate metadata', files: []}); await tick();
  assert.equal(reads, 1);
  assert.deepEqual(panel.webview.messages, [{type: 'busy', busy: true}]);
  service.busy = false; changed.fire(); await tick();
  assert.equal(reads, 2);
  assert.deepEqual(panel.webview.messages.map(message => message.type), ['busy', 'state']);
  assert.equal(panel.webview.messages[1].revision, 'committed');
});

test('disposing a panel cancels its queued trailing refresh', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], firstRead = deferred(); let reads = 0;
  service.getState = async () => {reads++; return firstRead.promise;};
  panel.webview.messages = [];
  changed.fire(); await tick(); changed.fire(); panel.dispose();
  firstRead.resolve({type: 'state', revision: 'obsolete', files: []}); await tick();
  assert.equal(reads, 1); assert.deepEqual(panel.webview.messages, []);
});

test('ready arriving during an initial post receives a fresh state after its listener is ready', async t => {
  const {editor, uri, service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], firstPost = deferred();
  let reads = 0;
  service.getState = async () => ({type: 'state', revision: 'delivery-' + (++reads), files: []});
  panel.webview.messages = [];
  panel.webview.postMessage = async message => {
    panel.webview.messages.push(message);
    if (message.revision === 'delivery-1') await firstPost.promise;
    return true;
  };
  const firstReady = receive({type: 'ready'}); await tick();
  const listenerReady = receive({type: 'ready'}); await tick();
  assert.equal(reads, 1);
  firstPost.resolve(); await Promise.all([firstReady, listenerReady]);
  assert.deepEqual(panel.webview.messages.map(message => message.revision), ['delivery-1', 'delivery-2']);
});
