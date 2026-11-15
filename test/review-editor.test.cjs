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
  active = true; visible = true; viewColumn = 1; disposed = false; reveals = 0; title = 'Preview';
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
    assert.equal(this.disposed, false); this.reveals++; this.active = true; this.visible = true;
    this.changed.fire({webviewPanel: this});
  }
  dispose() { if (!this.disposed) {this.disposed = true; this.closed.fire();} }
}
let current;
const vscode = {
  Uri, EventEmitter: Emitter, ViewColumn: {Active: -1},
  workspace: {
    get textDocuments() {return current.documents;},
    getConfiguration: () => ({
      inspect: key => ({globalValue: current[key], ...current.settingScopes?.[key]}),
      get: (key, fallback) => {
        const values = {globalValue: current[key], ...current.settingScopes?.[key]};
        return ['workspaceFolderLanguageValue', 'workspaceLanguageValue', 'globalLanguageValue',
          'workspaceFolderValue', 'workspaceValue', 'globalValue'].map(scope => values[scope]).find(value => value !== undefined) ?? fallback;
      },
    }),
    getWorkspaceFolder(uri) {
      const relative = path.relative(current.workspace.fsPath, uri.fsPath);
      return uri.scheme === 'file' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        ? {uri: current.workspace} : undefined;
    },
  },
  commands: {executeCommand: async (command,key,value) => {if(command==='setContext')current.context.set(key,value);}},
  window: {
    createWebviewPanel(_viewType, title, _column, options) {
      current.attempts++;
      if (current.failCreate) {current.failCreate = false; throw new Error('Injected create failure');}
      const panel = new Panel(); panel.title = title; panel.webview.options = options;
      panel.failReveal = current.failReveal; current.failReveal = false;
      current.created.push(panel); return panel;
    },
    showOpenDialog: async () => {current.picks++; return current.pick;},
    showErrorMessage: async message => {current.errors.push(message);},
    showTextDocument: async uri => {current.sourceOpens.push(uri.toString());},
  },
};
const originalLoad = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
require('tsx/cjs');
const {ReviewEditor} = require('../src/extension.ts');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function setup(t) {
  current = {workspace: Uri.file(path.join(__dirname, 'virtual-workspace')), attempts: 0, created: [], errors: [], sourceOpens: [], requests: [], documents: [], context: new Map(), picks: 0};
  const changed = new Emitter(), deleted = new Emitter(), pdfProgress = new Emitter(), pdfFinished = new Emitter();
  const progressByUri = new Map();
  const service = {
    onDidChange: changed.event, onDidDeleteRequest: deleted.event,
    onDidChangePdfGeneration: pdfProgress.event, onDidFinishPdfGeneration: pdfFinished.event,
    getPdfGenerationProgress: uri => progressByUri.get(uri.toString()),
    getState: async uri => {current.requests.push(uri.toString()); return {type: 'state', files: [], revision: 'test'};},
  };
  const context = {extensionUri: Uri.file(path.resolve(__dirname, '..'))};
  const editor = new ReviewEditor(context, service, {});
  t.after(() => editor.dispose());
  const uri = Uri.joinPath(current.workspace, 'inventory_report.py.rr');
  const document = {uri}; current.documents.push(document);
  return {editor, uri, document, service, changed, deleted, pdfProgress, pdfFinished, progressByUri};
}
test('Python RR automatically previews once per open source document, including after preview close', async t => {
  const {editor, uri, document} = setup(t); current.previewMode = 'once';
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
  const {editor, document} = setup(t); current.previewMode = 'once'; current.failCreate = true;
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
  assert.deepEqual(restored.webview.options.localResourceRoots.map(uri => uri.fsPath),
    [path.resolve(__dirname, '../media'), path.resolve(__dirname, '../src')]);
  const scripts = [...restored.webview.html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)];
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0][2], Uri.file(path.resolve(__dirname, '../src/review-highlight.js')).toString());
  assert.equal(scripts[1][2], Uri.file(path.resolve(__dirname, '../media/review.js')).toString());
  assert.equal(scripts[0][1], scripts[1][1]);
  assert.ok(restored.webview.html.includes("script-src 'nonce-" + scripts[0][1] + "'"));
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
  const {editor, uri, document} = setup(t), restored = new Panel(); current.previewMode = 'once';
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

test('unchanged external notifications verify source without redelivering identical rows', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0]; let reads = 0;
  const view = {type: 'state', busy: false, revision: 'saved', files: [], unchangedOpacity: 20};
  service.getState = async () => {reads++; return structuredClone(view);};
  changed.fire(); await tick(); panel.webview.messages = [];
  for (let index = 0; index < 5; index++) {changed.fire(); await tick();}
  assert.equal(reads, 6, 'Every late filesystem notification still verifies current source');
  assert.deepEqual(panel.webview.messages, [], 'Five identical notifications do not rerender the document');
  view.unchangedOpacity = 35; changed.fire(); await tick();
  assert.equal(panel.webview.messages.length, 1, 'Settings changes deliver even with the same source revision');
  view.files = [{path: 'inventory_report.py', issue: 'Save the original before reviewing.'}];
  changed.fire(); await tick();
  assert.equal(panel.webview.messages.length, 2, 'Dirty/conflict changes are never hidden by revision deduplication');
});

test('an unchanged final state clears busy controls and readiness can redeliver it', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.getState = async () => ({type: 'state', busy: false, revision: 'same', files: []});
  changed.fire(); await tick(); panel.webview.messages = [];
  service.busy = true; changed.fire();
  service.busy = false; changed.fire(); await tick();
  assert.deepEqual(panel.webview.messages.map(message => message.type), ['busy', 'state']);
  panel.webview.messages = [];
  await receive({type: 'ready'}); await receive({type: 'ready'});
  assert.equal(panel.webview.messages.filter(message => message.type === 'state').length, 2);
});

test('a no-op action receives a final state even without a change event', async t => {
  const {editor, uri, service, changed} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.getState = async () => ({type: 'state', busy: false, revision: 'same', files: []});
  service.decide = async () => undefined;
  changed.fire(); await tick(); panel.webview.messages = [];
  await receive({type: 'decide', filePath: 'inventory_report.py', hunkId: 'h1', decision: 'ignored', revision: 'same'});
  assert.deepEqual(panel.webview.messages.map(message => message.type), ['state'], 'A waiting client is always unlocked');
  panel.webview.messages = [];
  changed.fire(); await tick();
  assert.deepEqual(panel.webview.messages, []);
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
  assert.deepEqual(panel.webview.messages.filter(message => message.type === 'state').map(message => message.revision), ['delivery-1', 'delivery-2']);
  assert.equal(panel.webview.messages.at(-1).type, 'revealFirstChange');
});


test('edited Accept routes one guarded action and acknowledges only its correlated result', async t => {
  const {editor,uri,service}=setup(t);
  await editor.openPreview(uri); await tick();
  const panel=current.created[0], receive=[...panel.received.listeners][0], calls=[];
  service.editPending=async()=>assert.fail('Do not save a draft in a separate transaction before accepting');
  service.decide=async()=>assert.fail('Do not decide separately after saving a draft');
  service.editAndAccept=async(...args)=>{calls.push(args);return {changed:true,revision:'edited-accepted'};};
  panel.webview.messages=[];
  const message={type:'editAndAccept',filePath:'inventory_report.py',hunkId:'selected',draft:'new\nblock',revision:'before',editId:'attempt-1'};
  await receive(message);
  assert.deepEqual(calls,[[uri,message.filePath,message.hunkId,message.draft,message.revision]]);
  const result=panel.webview.messages.find(item=>item.type==='editResult');
  assert.equal(result.success,true); assert.equal(result.editId,'attempt-1');
  assert.equal(result.hunkId,'selected'); assert.equal(result.filePath,message.filePath);
  assert.equal(result.revision,'edited-accepted');
  service.editAndAccept=async()=>{throw Error('Stale source; draft kept.');};
  panel.webview.messages=[];
  await receive({...message,editId:'attempt-2'});
  const failed=panel.webview.messages.find(item=>item.type==='editResult');
  assert.equal(failed.success,false); assert.equal(failed.editId,'attempt-2');
  assert.match(failed.error,/Stale source/);
  assert.equal(panel.webview.messages.some(item=>item.type==='completionPrompt'),false);
});

for (const changed of [true, false]) test('saving a proposal alone acknowledges ' + (changed ? 'changed' : 'unchanged') + ' content without deciding it', async t => {
  const {editor, uri, service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], calls = [], acknowledged = deferred();
  service.editAndAccept = service.decide = service.undo = async () => assert.fail('Saving a proposal must not accept, ignore, or undo it');
  service.editPending = async (...args) => {calls.push(args); return {changed, revision: 'saved-proposal'};};
  service.getState = async () => ({type: 'state', revision: 'saved-proposal', files: []});
  panel.webview.messages = [];
  panel.webview.postMessage = async message => {
    panel.webview.messages.push(message);
    if (message.type === 'editResult') await acknowledged.promise;
    return true;
  };
  const message = {type: 'editPending', filePath: 'inventory_report.py', hunkId: 'selected', draft: 'new\nblock', revision: 'before', editId: 'save-1'};
  const saving = receive(message); await tick();
  assert.deepEqual(calls, [[uri, message.filePath, message.hunkId, message.draft, message.revision]]);
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult']);
  assert.deepEqual(panel.webview.messages[0], {type: 'editResult', editId: 'save-1', filePath: message.filePath,
    hunkId: 'selected', success: true, error: undefined, changed, revision: 'saved-proposal'});
  acknowledged.resolve(); await saving;
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult', 'state']);
});

test('a failed proposal-only save keeps a correlated draft error and refreshes without a completion prompt', async t => {
  const {editor, uri, service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.editAndAccept = service.decide = service.undo = async () => assert.fail('A failed save cannot submit a decision');
  service.editPending = async () => {throw Error('The request changed. Review its refreshed contents before editing.');};
  panel.webview.messages = [];
  await receive({type: 'editPending', filePath: 'inventory_report.py', hunkId: 'selected', draft: 'kept draft', revision: 'stale', editId: 'save-failed'});
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult', 'state']);
  const result = panel.webview.messages[0];
  assert.equal(result.success, false); assert.equal(result.editId, 'save-failed');
  assert.equal(result.hunkId, 'selected'); assert.equal(result.filePath, 'inventory_report.py');
  assert.match(result.error, /request changed/i);
});

test('malformed proposal-only saves cannot reach the file service', async t => {
  const {editor, uri, service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.editPending = service.editAndAccept = service.decide = async () => assert.fail('An invalid save cannot write or decide');
  const base = {type: 'editPending', filePath: 'inventory_report.py', hunkId: 'selected', draft: 'draft', revision: 'before', editId: 'invalid-save'};
  for (const message of [
    {...base, decision: 'accepted'}, {...base, hunkId: ''}, {...base, draft: undefined},
    {...base, filePath: undefined}, {...base, revision: undefined}, {...base, editId: undefined}
  ]) {
    panel.webview.messages = []; await receive(message);
    assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult', 'state']);
    assert.equal(panel.webview.messages[0].success, false);
    assert.match(panel.webview.messages[0].error, /Invalid proposal edit/);
  }
});

test('Ignore while editing records the original decision without saving the draft', async t => {
  const {editor,uri,service}=setup(t);
  await editor.openPreview(uri); await tick();
  const panel=current.created[0], receive=[...panel.received.listeners][0], calls=[];
  service.editPending=service.editAndAccept=async()=>assert.fail('Ignore must not write the edited draft');
  service.decide=async(...args)=>{calls.push(args);};
  service.getState=async()=>({type:'state',revision:'ignored',files:[]});
  panel.webview.messages=[];
  const message={type:'ignoreEdited',filePath:'inventory_report.py',hunkId:'selected',revision:'before',editId:'ignore-1'};
  await receive(message);
  assert.deepEqual(calls,[[uri,message.filePath,message.hunkId,'ignored',message.revision]]);
  const result=panel.webview.messages.find(item=>item.type==='editResult');
  assert.equal(result.success,true); assert.equal(result.editId,'ignore-1'); assert.equal(result.revision,'ignored');
  service.decide=async()=>{throw Error('Request changed.');};
  panel.webview.messages=[];
  await receive({...message,editId:'ignore-2'});
  const failed=panel.webview.messages.find(item=>item.type==='editResult');
  assert.equal(failed.success,false); assert.equal(failed.editId,'ignore-2'); assert.match(failed.error,/Request changed/);
  assert.equal(panel.webview.messages.some(item=>item.type==='completionPrompt'),false);
});

for (const action of ['editAndAccept', 'ignoreEdited']) test(`${action} acknowledges the edit and refreshes before its completion prompt`, async t => {
  const {editor, uri, service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], acknowledged = deferred();
  const completionPrompt = {completionId: 'last-' + action, revision: 'completed', requestName: 'inventory_report.py.rr'};
  service.editAndAccept = async () => ({changed: true, revision: 'completed', completionPrompt});
  service.decide = async () => ({completionPrompt});
  service.getState = async () => ({type: 'state', revision: 'completed', files: []});
  panel.webview.messages = [];
  panel.webview.postMessage = async message => {
    panel.webview.messages.push(message);
    if (message.type === 'editResult') await acknowledged.promise;
    return true;
  };
  const message = {type: action, filePath: 'inventory_report.py', hunkId: 'last', revision: 'before', editId: 'edit-last',
    ...(action === 'editAndAccept' ? {draft: 'edited'} : {})};
  const pending = receive(message); await tick();
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult']);
  const result = panel.webview.messages[0];
  assert.equal(result.success, true); assert.equal(result.editId, message.editId); assert.equal(result.revision, 'completed');
  assert.equal(result.completionPrompt, undefined, 'Only the dedicated prompt message opens deletion confirmation');
  acknowledged.resolve(); await pending;
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['editResult', 'state', 'completionPrompt']);
  assert.deepEqual(panel.webview.messages.at(-1), {type: 'completionPrompt', ...completionPrompt});
});

test('malformed edited decisions never reach the file service', async t => {
  const {editor,uri,service}=setup(t);
  await editor.openPreview(uri); await tick();
  const panel=current.created[0], receive=[...panel.received.listeners][0];
  service.editAndAccept=service.decide=async()=>assert.fail('Invalid payload must not decide');
  const base={filePath:'inventory_report.py',hunkId:'selected',revision:'before',editId:'invalid'};
  for(const message of [
    {type:'editAndAccept',...base},
    {type:'editAndAccept',...base,draft:'new',decision:'accepted'},
    {type:'ignoreEdited',...base,draft:'must not save'},
    {type:'ignoreEdited',...base,hunkId:undefined}
  ]) {
    panel.webview.messages=[]; await receive(message);
    const result=panel.webview.messages.find(item=>item.type==='editResult');
    assert.equal(result.success,false); assert.ok(result.error);
  }
});

test('menu draft transformation replies locally without refreshing or submitting a decision', async t => {
  const {editor, uri, service} = setup(t);
  const calls = [];
  service.transformDraft = async (...args) => {calls.push(args); return {draft:'# original\nedited',reviewActions:[]};};
  service.reviewActions = async () => [{id:'comment',enabled:true,label:'Keep original as comments'}];
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], refreshes = current.requests.length;
  panel.received.fire({type:'transformDraft',filePath:'sample.py',hunkId:'h1',draft:'edited',revision:'r1',action:'comment',editId:'transform-1'});
  await tick(); await tick();
  assert.equal(calls.length,1);
  assert.deepEqual(panel.webview.messages.at(-1),{type:'transformResult',editId:'transform-1',draft:'# original\nedited',reviewActions:[]});
  assert.equal(current.requests.length,refreshes);
  panel.received.fire({type:'reviewActions',filePath:'sample.py',hunkId:'h1',draft:'edited',revision:'r1',editId:'menu-1'});
  await tick();
  assert.equal(panel.webview.messages.at(-1).type,'reviewActionsResult');
  assert.equal(current.requests.length,refreshes);
});
test('menu transformation failures keep a correlated draft error and reject unknown message keys', async t => {
  const {editor, uri, service} = setup(t);
  service.transformDraft = async () => {throw Error('Unsupported comment context');};
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], refreshes = current.requests.length;
  const message = {type:'transformDraft',filePath:'sample.tex',hunkId:'h1',draft:'edited',revision:'r1',action:'comment',editId:'transform-2'};
  panel.received.fire(message); await tick();
  assert.deepEqual(panel.webview.messages.at(-1),{type:'transformResult',editId:'transform-2',error:'Unsupported comment context'});
  panel.received.fire({...message,override:true}); await tick();
  assert.match(panel.webview.messages.at(-1).error,/Invalid/);
  assert.equal(current.requests.length,refreshes);
});

test('removed color actions and macro setup messages cannot reach file operations', async t => {
  const {editor,uri,service} = setup(t);
  const forbidden = async () => assert.fail('Removed actions must not reach the service');
  service.transformDraft = service.setupMacros = service.editAndAccept = service.decide = forbidden;
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], refreshes = current.requests.length;
  for (const action of ['markAdded','markRemoved','invented']) {
    await receive({type:'transformDraft',filePath:'sample.tex',hunkId:'h1',draft:'new',revision:'r1',action,editId:action});
    assert.deepEqual(panel.webview.messages.at(-1),{type:'transformResult',editId:action,error:'Unknown proposal action.'});
  }
  const messages = panel.webview.messages.length;
  await receive({type:'setupReviewMacros',filePath:'sample.tex'});
  assert.equal(panel.webview.messages.length,messages);
  assert.equal(current.requests.length,refreshes);
});

test('sidebar Quick Review opens a request and waits for ready plus initial state before enabling', async t => {
  const {editor,uri} = setup(t);
  await editor.toggleQuickReview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  assert.equal(panel.webview.messages.some(message => message.type === 'toggleQuickReview'),false);
  await receive({type:'quickReviewState',enabled:false});
  await receive({type:'ready'});
  const toggleIndex = panel.webview.messages.findIndex(message => message.type === 'toggleQuickReview');
  assert.ok(toggleIndex > 1); assert.equal(panel.webview.messages[toggleIndex-2].type,'state');
  assert.equal(panel.webview.messages[toggleIndex-1].type,'revealFirstChange');
  assert.deepEqual(panel.webview.messages[toggleIndex],{type:'toggleQuickReview',enabled:true});
  await receive({type:'quickReviewState',enabled:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),true);
  panel.active = false; // Sidebar keyboard/mouse focus must still address this preview.
  await editor.toggleQuickReview();
  assert.deepEqual(panel.webview.messages.at(-1),{type:'toggleQuickReview',enabled:false});
  await receive({type:'quickReviewState',enabled:false});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
});
test('rapid sidebar toggles before ready resolve to the last requested state', async t => {
  const {editor,uri} = setup(t);
  await editor.toggleQuickReview(uri);
  await editor.toggleQuickReview();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  await receive({type:'ready'});
  assert.deepEqual(panel.webview.messages.filter(message => message.type==='toggleQuickReview'),[{type:'toggleQuickReview',enabled:false}]);
  await receive({type:'quickReviewState',enabled:false});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
});
test('sidebar Quick Review prompts only without an open request and respects cancellation/workspace scope', async t => {
  const {editor,uri} = setup(t);
  await editor.toggleQuickReview();
  assert.equal(current.picks,1); assert.equal(current.attempts,0);
  current.pick = [Uri.file(path.resolve(__dirname,'outside.tex.rr'))];
  await assert.rejects(editor.toggleQuickReview(),/inside an open workspace/);
  assert.equal(current.attempts,0);
  current.pick = [uri];
  await editor.toggleQuickReview(); await tick();
  assert.equal(current.picks,3); assert.equal(current.attempts,1);
  const receive = [...current.created[0].received.listeners][0];
  await receive({type:'ready'});
  assert.deepEqual(current.created[0].webview.messages.at(-1),{type:'toggleQuickReview',enabled:true});
  current.created[0].dispose();
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
});
test('Quick Review state follows the selected preview and cannot leak from background or malformed panels', async t => {
  const {editor,uri} = setup(t);
  await editor.openPreview(uri); await tick();
  const first = current.created[0], receiveFirst = [...first.received.listeners][0];
  await receiveFirst({type:'quickReviewState',enabled:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),true);
  first.active = false;
  const other = Uri.joinPath(current.workspace,'other.tex.rr');
  await editor.openPreview(other); await tick();
  const second = current.created[1], receiveSecond = [...second.received.listeners][0];
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  await receiveFirst({type:'quickReviewState',enabled:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  await receiveSecond({type:'quickReviewState',enabled:'true'});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  await receiveSecond({type:'quickReviewState',enabled:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),true);
  second.dispose();
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  await editor.openPreview(uri);
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),true);
  const unbound = new Panel();
  await editor.deserializeWebviewPanel(unbound,{});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
});
test('quick decisions acknowledge only the correlated completed operation and retain failure details', async t => {
  const {editor,uri,service} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], gate = deferred(), calls = [];
  const completionPrompt = {completionId:'quick-complete',revision:'completed'};
  service.decide = async (...args) => {calls.push(args); await gate.promise; return {completionPrompt};};
  panel.webview.messages = [];
  const message = {type:'decide',filePath:'inventory_report.py',hunkId:'pending-1',decision:'accepted',revision:'before',quickDecisionId:'quick-1'};
  const pending = receive(message); await tick();
  assert.equal(panel.webview.messages.some(item=>item.type==='quickDecisionResult'),false);
  gate.resolve(); await pending;
  assert.deepEqual(calls,[[uri,message.filePath,message.hunkId,message.decision,message.revision]]);
  assert.deepEqual(panel.webview.messages.find(item=>item.type==='quickDecisionResult'),{
    type:'quickDecisionResult',quickDecisionId:'quick-1',filePath:message.filePath,hunkId:message.hunkId,decision:'accepted',success:true,error:undefined
  });
  assert.deepEqual(panel.webview.messages.map(item=>item.type), ['quickDecisionResult','state','completionPrompt']);
  assert.deepEqual(panel.webview.messages.at(-1), {type:'completionPrompt',...completionPrompt});
  service.decide = async () => {throw Error('The request changed. Review it again.');};
  panel.webview.messages = [];
  await receive({...message,quickDecisionId:'quick-2',decision:'ignored'});
  const failed = panel.webview.messages.find(item=>item.type==='quickDecisionResult');
  assert.equal(failed.success,false); assert.equal(failed.quickDecisionId,'quick-2'); assert.equal(failed.decision,'ignored');
  assert.match(failed.error,/request changed/);
  assert.match(panel.webview.messages.find(item=>item.type==='state').error,/request changed/);
  assert.equal(panel.webview.messages.some(item=>item.type==='completionPrompt'),false);
});
test('malformed quick decisions cannot reach the review service', async t => {
  const {editor,uri,service} = setup(t);
  await editor.openPreview(uri); await tick();
  const receive = [...current.created[0].received.listeners][0];
  service.decide = async () => assert.fail('Malformed quick decisions must not write.');
  const base = {type:'decide',filePath:'inventory_report.py',hunkId:'pending-1',decision:'accepted',revision:'before'};
  for (const quickDecisionId of ['',42,'a'.repeat(129)]) await receive({...base,quickDecisionId});
  await receive({...base,type:'decideFile',quickDecisionId:'bulk-not-allowed'});
});
test('Quick Review sidebar icons are filled flat bolts and have no editor-title duplicate', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname,'../package.json'),'utf8'));
  const title = manifest.contributes.menus['view/title'];
  for (const command of ['revisionRequest.enableQuickReview','revisionRequest.disableQuickReview']) {
    const item = title.find(item => item.command === command);
    assert.equal(item.group,'navigation@1'); assert.match(item.when,/revisionRequest\.requests/);
    assert.match(item.when,/revisionRequest\.quickReviewActive/);
    assert.equal(manifest.contributes.menus['editor/title'].some(item=>item.command === command),false);
    const contribution = manifest.contributes.commands.find(item=>item.command === command);
    const svg = fs.readFileSync(path.resolve(__dirname,'..',contribution.icon),'utf8');
    assert.match(svg,/<path[^>]*stroke="none"/); assert.doesNotMatch(svg,/<filter|<linearGradient|fill="none"|stroke-width=/);
    if (command.endsWith("enableQuickReview")) {assert.match(svg,/<path[^>]*fill="#f2d64b"[^>]*stroke="none"/);assert.doesNotMatch(svg,/<rect/);}
    else {assert.match(svg,/<rect[^>]*fill="#f2d64b"/);assert.match(svg,/<path[^>]*fill="#3a3215"[^>]*stroke="none"/);}
  }
});

test('a reloaded preview replays a sidebar request after its explicit startup reset and ready', async t => {
  const {editor,uri} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  await receive({type:'ready'});
  panel.webview.messages = [];
  await editor.toggleQuickReview();
  assert.deepEqual(panel.webview.messages.at(-1),{type:'toggleQuickReview',enabled:true});
  // The message targeted the disappearing webview; its replacement announces
  // that it is unarmed before registering readiness.
  await receive({type:'quickReviewState',enabled:false,initial:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  await receive({type:'ready'});
  assert.deepEqual(panel.webview.messages.filter(message=>message.type==='toggleQuickReview'),[
    {type:'toggleQuickReview',enabled:true},{type:'toggleQuickReview',enabled:true}
  ]);
  await receive({type:'quickReviewState',enabled:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),true);
  await receive({type:'quickReviewState',enabled:false,initial:true});
  assert.equal(current.context.get('revisionRequest.quickReviewActive'),false);
  panel.webview.messages = [];
  await receive({type:'ready'});
  assert.equal(panel.webview.messages.some(message=>message.type==='toggleQuickReview'),false,
    'Reloading alone cannot rearm a previously acknowledged mode');
});

test('always is the default and normally reselecting an RR reveals its preview again', async t => {
  const {editor, document, uri} = setup(t);
  editor.autoPreview({document}); await tick();
  const panel = current.created[0]; assert.equal(panel.reveals, 1);
  editor.autoPreview(undefined);
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1); assert.equal(panel.reveals, 2);
  panel.dispose();
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1, 'Closing the preview cannot recursively reopen it');
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 2, 'Returning normally after another source reopens the preview');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const settings = manifest.contributes.configuration.properties;
  assert.equal(settings['revisionRequest.previewMode'].default, 'always');
  assert.deepEqual(settings['revisionRequest.previewMode'].enum, ['always', 'once', 'manual']);
  assert.ok(settings['revisionRequest.previewOnOpen'].deprecationMessage);
});
for (const sourceFirst of [true, false]) test('closing always preview suppresses source fallback when source activation is ' + (sourceFirst ? 'before disposal' : 'after disposal'), async t => {
  const {editor, document, uri} = setup(t);
  await editor.openPreview(uri); await tick();
  const panel = current.created[0];
  editor.autoPreview(undefined); panel.active = false;
  if (sourceFirst) editor.autoPreview({document});
  panel.dispose();
  if (!sourceFirst) editor.autoPreview({document});
  await tick();
  editor.autoPreview({document}); await tick();
  assert.equal(current.attempts, 1);
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 2);
});
test('Open RR as JSON remains editable through redundant activation and configuration changes', async t => {
  const {editor, document, uri} = setup(t);
  await editor.openPreview(uri); const panel = current.created[0];
  await editor.openSource(uri);
  editor.autoPreview({document}); await tick();
  editor.autoPreview(undefined); editor.autoPreview({document}); await tick();
  current.previewMode = 'manual'; editor.autoPreview({document}); await tick();
  current.previewMode = 'always'; editor.autoPreview({document}); await tick();
  assert.equal(panel.reveals, 1, 'Transient events and changing settings must not steal JSON focus');
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'another.py.rr')}}); await tick();
  editor.autoPreview({document}); await tick();
  assert.equal(panel.reveals, 2, 'An ordinary activation after selecting another document rearms always mode');
});
test('JSON escape belongs to an open document, not every later document with the same URI', async t => {
  const {editor, document, uri} = setup(t);
  await editor.openSource(uri); editor.autoPreview({document}); await tick();
  current.documents = [];
  const reopened = {uri}; current.documents.push(reopened);
  editor.autoPreview({document: reopened}); await tick(); assert.equal(current.attempts, 1);
});
test('manual mode keeps JSON while explicit preview and sidebar Quick Review remain available', async t => {
  const {editor, document, uri} = setup(t); current.previewMode = 'manual';
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 0);
  await editor.openPreview(uri); assert.equal(current.attempts, 1);
  current.created[0].dispose();
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 1);
  await editor.toggleQuickReview(uri); assert.equal(current.attempts, 2);
  const panel = current.created[1]; panel.received.fire({type: 'ready'}); await tick();
  const navigation = panel.webview.messages.findIndex(message => message.type === 'revealFirstChange');
  const toggle = panel.webview.messages.findIndex(message => message.type === 'toggleQuickReview');
  assert.ok(navigation >= 0 && toggle > navigation);
});
test('explicit previewMode overrides legacy values at any configuration scope', async t => {
  const {editor, document} = setup(t);
  current.previewOnOpen = false;
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 0);
  current.settingScopes = {previewMode: {workspaceFolderValue: 'always'}};
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 1);
  current.created[0].dispose();
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  current.previewOnOpen = true;
  current.settingScopes = {previewMode: {workspaceValue: 'manual'}};
  editor.autoPreview({document}); await tick(); assert.equal(current.attempts, 1);
});
test('normal opening jumps to first change after ready; focus and updates do not jump', async t => {
  const {editor, uri, changed} = setup(t);
  await editor.openPreview(uri); const panel = current.created[0];
  assert.equal(panel.webview.messages.some(message => message.type === 'revealFirstChange'), false);
  panel.received.fire({type: 'ready'}); await tick();
  assert.equal(panel.webview.messages.filter(message => message.type === 'revealFirstChange').length, 1);
  panel.changed.fire({webviewPanel: panel}); changed.fire(); await tick();
  assert.equal(panel.webview.messages.filter(message => message.type === 'revealFirstChange').length, 1);
  await editor.openPreview(uri);
  assert.equal(panel.webview.messages.filter(message => message.type === 'revealFirstChange').length, 2);
});

test('an explicitly configured legacy true preserves once behavior without changing settings', async t => {
  const {editor, document} = setup(t); current.previewOnOpen = true;
  editor.autoPreview({document}); await tick();
  editor.autoPreview(undefined);
  editor.autoPreview({document: {uri: Uri.joinPath(current.workspace, 'notes.md')}});
  editor.autoPreview({document}); await tick();
  assert.equal(current.created[0].reveals, 1);
  assert.equal(current.previewMode, undefined);
  assert.equal(current.previewOnOpen, true);
});

test('toggling Quick Review in its active preview preserves position; revealing a hidden preview navigates', async t => {
  const {editor, uri} = setup(t);
  await editor.toggleQuickReview(uri);
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  await receive({type: 'ready'}); await receive({type: 'quickReviewState', enabled: true});
  const count = () => panel.webview.messages.filter(message => message.type === 'revealFirstChange').length;
  assert.equal(count(), 1);
  await editor.toggleQuickReview(uri);
  assert.equal(count(), 1, 'Disabling Quick Review must not jump to the first change');
  assert.equal(panel.reveals, 1);
  assert.deepEqual(panel.webview.messages.at(-1), {type: 'toggleQuickReview', enabled: false});
  await receive({type: 'quickReviewState', enabled: false});
  await editor.toggleQuickReview(uri);
  assert.equal(count(), 1, 'Enabling the active preview also retains its position');
  await receive({type: 'quickReviewState', enabled: true});
  panel.active = false; // Focus is in the sidebar, while this remains the visible request.
  await editor.toggleQuickReview(uri);
  assert.equal(count(), 1, 'Sidebar focus must not turn disabling Quick Review into reopening');
  assert.equal(panel.reveals, 2, 'The selected visible request still receives focus');
  await receive({type: 'quickReviewState', enabled: false});
  panel.active = false; panel.visible = false;
  await editor.toggleQuickReview(uri);
  assert.equal(count(), 2, 'Revealing a hidden preview is an ordinary reopening');
  assert.equal(panel.reveals, 3);
});


for (const type of ['openTargetLine', 'openTargetPdf']) test(type + ' messages bind navigation to the panel request, hunk and revision', async t => {
  const {editor,uri,service}=setup(t),calls=[];
  service[type]=async(...args)=>{calls.push(args);};
  await editor.openPreview(uri);const panel=current.created[0];
  const message={type,filePath:'inventory_report.py',hunkId:'pending-id',revision:'current-revision'};
  panel.received.fire(message);await tick();
  assert.deepEqual(calls,[[uri,message.filePath,message.hunkId,message.revision]]);
  for(const invalid of [{...message,revision:undefined},{...message,hunkId:1},{...message,filePath:[]},{...message,line:9000},{...message,hunkId:''},{...message,revision:''},{...message,filePath:''}]) {
    panel.webview.messages=[];panel.received.fire(invalid);await tick();
    assert.equal(calls.length,1,'The webview cannot supply a raw line or malformed identity');
    assert.match(panel.webview.messages.find(item=>item.error)?.error??'',/Invalid original-line navigation/);
  }
  service[type]=async()=>{throw Error('The original has changed since this request was created.');};
  panel.webview.messages=[];panel.received.fire(message);await tick();
  assert.match(panel.webview.messages.find(item=>item.error)?.error??'',/original has changed/);
});


for (const edited of [false, true]) test('acceptThrough routes one inclusive-prefix action'+(edited?' with its current draft':''), async t => {
  const {editor,uri,service}=setup(t);await editor.openPreview(uri);await tick();
  const panel=current.created[0],receive=[...panel.received.listeners][0],calls=[];
  service.decide=service.editPending=service.editAndAccept=async()=>assert.fail('A prefix must use one dedicated atomic service action');
  const completionPrompt={completionId:'prefix-done',revision:'accepted-prefix',requestName:'inventory_report.py.rr'};
  service.acceptThrough=async(...args)=>{calls.push(args);return{changed:true,revision:'accepted-prefix',completionPrompt};};
  service.getState=async()=>({type:'state',files:[],revision:'accepted-prefix'});
  panel.webview.messages=[];
  const message={type:'acceptThrough',filePath:'inventory_report.py',hunkId:'through',revision:'before',...(edited?{draft:'edited\nblock',editId:'through-edit'}:{})};
  await receive(message);
  assert.deepEqual(calls,[[uri,'inventory_report.py','through','before',edited?'edited\nblock':undefined]]);
  assert.deepEqual(panel.webview.messages.map(item=>item.type),edited?['editResult','state','completionPrompt']:['state','completionPrompt']);
  if(edited){const result=panel.webview.messages[0];assert.equal(result.success,true);assert.equal(result.editId,'through-edit');assert.equal(result.hunkId,'through');assert.equal(result.revision,'accepted-prefix');}
  assert.equal(panel.webview.messages.at(-1).completionId,'prefix-done');
});

for (const edited of [false, true]) test('acceptThrough keeps failed'+(edited?' drafts':' ranges')+' pending without a completion prompt', async t => {
  const {editor,uri,service}=setup(t);await editor.openPreview(uri);await tick();
  const panel=current.created[0],receive=[...panel.received.listeners][0];
  service.acceptThrough=async()=>{throw Error('A pending change in this range conflicts.');};
  panel.webview.messages=[];
  await receive({type:'acceptThrough',filePath:'inventory_report.py',hunkId:'through',revision:'before',...(edited?{draft:'kept',editId:'failed-edit'}:{})});
  assert.equal(panel.webview.messages.some(item=>item.type==='completionPrompt'),false);
  if(edited){const result=panel.webview.messages.find(item=>item.type==='editResult');assert.equal(result.success,false);assert.equal(result.editId,'failed-edit');assert.match(result.error,/conflicts/);}
  else assert.match(panel.webview.messages.find(item=>item.type==='state').error,/conflicts/);
});

test('malformed acceptThrough ranges cannot reach file operations', async t => {
  const {editor,uri,service}=setup(t);await editor.openPreview(uri);await tick();
  const panel=current.created[0],receive=[...panel.received.listeners][0];
  service.acceptThrough=service.decide=service.editPending=async()=>assert.fail('Malformed range reached service');
  const base={type:'acceptThrough',filePath:'inventory_report.py',hunkId:'through',revision:'before'};
  for(const message of [
    {...base,hunkId:''},{...base,hunkId:undefined},{...base,filePath:undefined},{...base,revision:undefined},
    {...base,draft:'unsaved'},{...base,editId:'missing-draft'},{...base,draft:'value',editId:''},
    {...base,draft:12,editId:'bad-draft'},{...base,decision:'accepted'},{...base,quickDecisionId:'must-not-run'},
    {...base,draft:'value',editId:'bad-extra',other:true}
  ]){panel.webview.messages=[];await receive(message);assert.equal(panel.webview.messages.some(item=>item.type==='completionPrompt'),false);const error=panel.webview.messages.find(item=>item.type==='editResult')?.error||panel.webview.messages.find(item=>item.type==='state')?.error;assert.match(error,/Invalid acceptance range/);}
});


for (const type of ['generateReviewPdf', 'regenerateReviewPdf', 'importPdfReview', 'applyPdfReview']) test(type + ' binds the PDF action to its preview request and refreshes after completion', async t => {
  const {editor, uri, service} = setup(t); await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0], calls = [];
  const completionPrompt = {completionId: 'pdf-done', revision: 'after-pdf', requestName: 'inventory_report.py.rr'};
  service.generateReviewPdf = async (...args) => calls.push(['generate', ...args]);
  service.importPdfReview = async (...args) => calls.push(['import', ...args]);
  service.applyPdfReview = async (...args) => {calls.push(['apply', ...args]); return {completionPrompt};};
  service.getState = async () => ({type: 'state', files: [], revision: 'after-pdf'});
  panel.webview.messages = [];
  await receive({type, revision: 'before-pdf', ...(type === 'applyPdfReview' ? {pdfHash: 'a'.repeat(64)} : {})});
  const expected = type === 'applyPdfReview' ? ['apply', uri, 'before-pdf', 'a'.repeat(64)]
    : type === 'importPdfReview' ? ['import', uri, 'before-pdf'] : ['generate', uri, 'before-pdf', type === 'regenerateReviewPdf'];
  assert.deepEqual(calls, [expected]);
  assert.deepEqual(panel.webview.messages.map(item => item.type), type === 'applyPdfReview' ? ['state', 'completionPrompt'] : ['state']);
});

test('malformed PDF actions cannot choose another request or apply unbound result bytes', async t => {
  const {editor, uri, service} = setup(t); await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.generateReviewPdf = service.importPdfReview = service.applyPdfReview = async () => assert.fail('Malformed PDF action reached service');
  for (const type of ['generateReviewPdf', 'regenerateReviewPdf', 'importPdfReview', 'applyPdfReview']) {
    const base = {type, revision: 'current', ...(type === 'applyPdfReview' ? {pdfHash: 'b'.repeat(64)} : {})};
    const invalid = [{...base, revision: undefined}, {...base, revision: ''}, {...base, uri: 'file:///other.rr'}, {...base, filePath: 'other.tex'}];
    if (type === 'applyPdfReview') invalid.push({...base, pdfHash: undefined}, {...base, pdfHash: 'not-a-hash'}, {...base, pdfHash: 42});
    else invalid.push({...base, pdfHash: 'b'.repeat(64)});
    for (const message of invalid) {
      panel.webview.messages = []; await receive(message);
      assert.match(panel.webview.messages.find(item => item.type === 'state').pdfReview.error, /Invalid PDF review action/);
      assert.equal(panel.webview.messages.find(item => item.type === 'state').error, undefined, 'PDF errors must not block ordinary review');
      assert.equal(panel.webview.messages.some(item => item.type === 'completionPrompt'), false);
    }
  }
});


test('an updated companion clears an old PDF action error without blocking regular review', async t => {
  const {editor, uri, service, changed} = setup(t); await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  service.importPdfReview = async () => {throw Error('Older PDF cannot be imported');};
  await receive({type: 'importPdfReview', revision: 'test'});
  assert.match(panel.webview.messages.at(-1).pdfReview.error, /Older PDF/); assert.equal(panel.webview.messages.at(-1).error, undefined);
  service.getState = async () => ({type: 'state', files: [], revision: 'test', pdfReview: {supported: true, available: true,
    filename: 'example.tex.rr.pdf', imported: false, canApply: false}});
  changed.fire(); await tick();
  assert.equal(panel.webview.messages.at(-1).pdfReview.error, undefined); assert.equal(panel.webview.messages.at(-1).pdfReview.canApply, false);
  assert.equal(panel.webview.messages.at(-1).pdfReview.imported, false);
});


test('disposed VS Code panels with throwing getters are unbound before an explicit reopen', async t => {
  const {editor, uri} = setup(t); await editor.openPreview(uri); await tick();
  const panel = current.created[0], live = {active: panel.active, visible: panel.visible, viewColumn: panel.viewColumn};
  for (const key of Object.keys(live)) Object.defineProperty(panel, key, {configurable: true,
    get() {if (this.disposed) throw Error('Webview is disposed: ' + key); return live[key];}, set(value) {live[key] = value;}});
  assert.doesNotThrow(() => panel.dispose(), 'The real API invalidates getters before disposal listeners run');
  await editor.openPreview(uri); await tick();
  assert.equal(current.created.length, 2); assert.notEqual(current.created[1], panel); assert.equal(current.created[1].disposed, false);
});


test('Pending all uses the bound request and batches the reset into one refreshed state without completion', async t => {
  const {editor,uri,service,changed}=setup(t);await editor.openPreview(uri);await tick();
  const panel=current.created[0],receive=[...panel.received.listeners][0],gate=deferred();let calls=0,reads=0;
  service.getState=async()=>{reads++;return {type:'state',files:[],revision:'reset'};};
  service.undoFile=async(...args)=>{
    calls++;assert.deepEqual(args,[uri,'inventory_report.py','reviewed']);
    service.busy=true;changed.fire();changed.fire();await gate.promise;service.busy=false;changed.fire();
  };
  panel.webview.messages=[];
  const pending=receive({type:'undoFile',filePath:'inventory_report.py',revision:'reviewed'});await tick();
  assert.equal(calls,1);assert.equal(reads,0);assert.deepEqual(panel.webview.messages,[{type:'busy',busy:true}]);
  gate.resolve();await pending;
  assert.equal(reads,1);assert.deepEqual(panel.webview.messages.map(message=>message.type),['busy','state']);
});

test('Pending all rejects malformed webview messages before invoking the file service', async t => {
  const {editor,uri,service}=setup(t);await editor.openPreview(uri);await tick();
  const panel=current.created[0],receive=[...panel.received.listeners][0];service.undoFile=async()=>assert.fail('Invalid reset must not reach file service');
  const base={type:'undoFile',filePath:'inventory_report.py',revision:'reviewed'};
  for(const message of [{...base,filePath:''},{...base,filePath:1},{...base,revision:''},{...base,revision:null},
      {...base,hunkId:'not-a-single-undo'},{...base,decision:'pending'},{...base,requestUri:'file:///other.rr'}]) {
    panel.webview.messages=[];await receive(message);
    assert.match(panel.webview.messages.find(item=>item.type==='state').error,/Invalid pending-all action/);
  }
});

test('PDF stage events update only their bound panel without full review reads', async t => {
  const {editor, uri, service, pdfProgress, pdfFinished} = setup(t);
  await editor.openPreview(uri);
  const other = Uri.joinPath(current.workspace, 'another.tex.rr'); await editor.openPreview(other); await tick();
  const [panel, unrelated] = current.created;
  panel.webview.messages = []; unrelated.webview.messages = [];
  let reads = 0; service.getState = async () => {reads++; return {type: 'state', files: []};};
  for (const pass of [1, 2, 3]) pdfProgress.fire({uri, progress: {stage: 'compiling', startedAt: 42, message: 'Compiling PDF — pass ' + pass + ' of 3…'}});
  pdfProgress.fire({uri, progress: null}); pdfFinished.fire({uri, outcome: 'created'});
  await tick();
  assert.equal(reads, 0);
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['pdfGenerationProgress', 'pdfGenerationProgress', 'pdfGenerationProgress', 'pdfGenerationProgress', 'pdfGenerationResult']);
  assert.match(panel.webview.messages[1].progress.message, /pass 2/);
  assert.deepEqual(unrelated.webview.messages, []);
  panel.dispose(); pdfProgress.fire({uri, progress: {stage: 'saving', startedAt: 42, message: 'Saving…'}});
  assert.equal(panel.webview.messages.length, 5, 'disposed previews unsubscribe');
});

test('a preview opened during PDF compilation receives its initial state and current stage on ready', async t => {
  const {editor, uri, service, progressByUri, pdfProgress, pdfFinished, changed} = setup(t);
  service.busy = true;
  const progress = {stage: 'compiling', startedAt: 1000, message: 'Compiling PDF — pass 2 of 3…'};
  progressByUri.set(uri.toString(), progress);
  let reads = 0; service.getState = async () => {reads++; return {type: 'state', files: [], revision: 'current', busy: service.busy, pdfReview: {supported: true, filename: 'test.tex.rr.pdf'}};};
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0];
  panel.webview.messages = [];
  await receive({type: 'ready'});
  assert.equal(reads, 1, 'one initial read while the source-preserving compiler runs');
  assert.equal(panel.webview.messages[0].type, 'state');
  assert.equal(panel.webview.messages[0].pdfReview.supported, true);
  assert.deepEqual(panel.webview.messages[1], {type: 'pdfGenerationProgress', progress});
  pdfProgress.fire({uri, progress: {...progress, message: 'Compiling PDF — pass 3 of 3…'}});
  assert.equal(reads, 1);
  progressByUri.delete(uri.toString()); pdfProgress.fire({uri, progress: null}); pdfFinished.fire({uri, outcome: 'created'});
  service.busy = false; changed.fire(); await tick();
  assert.equal(reads, 2);
  assert.equal(panel.webview.messages.at(-1).type, 'state');
  assert.equal(panel.webview.messages.at(-1).busy, false);
});

test('malformed Generate clears the local spinner with a failed result before the final state', async t => {
  const {editor, uri, service} = setup(t); await editor.openPreview(uri); await tick();
  service.generateReviewPdf = async () => assert.fail('Invalid generation reached service');
  const panel = current.created[0], receive = [...panel.received.listeners][0]; panel.webview.messages = [];
  await receive({type: 'generateReviewPdf', revision: ''});
  assert.deepEqual(panel.webview.messages.map(item => item.type), ['pdfGenerationProgress', 'pdfGenerationResult', 'state']);
  assert.equal(panel.webview.messages[0].progress, null);
  assert.equal(panel.webview.messages[1].outcome, 'failed');
  assert.match(panel.webview.messages[1].error, /Invalid PDF review action/);
});

test('completion during a ready state read never replays an obsolete busy snapshot', async t => {
  const {editor, uri, service, progressByUri, pdfProgress, pdfFinished, changed} = setup(t);
  service.busy = true;
  progressByUri.set(uri.toString(), {stage: 'saving', startedAt: 99, message: 'Saving…'});
  const initialRead = deferred(); let reads = 0;
  service.getState = async () => ++reads === 1 ? initialRead.promise : {type: 'state', files: [], revision: 'finished', busy: false};
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], receive = [...panel.received.listeners][0]; panel.webview.messages = [];
  const ready = receive({type: 'ready'}); await tick();
  progressByUri.delete(uri.toString()); pdfProgress.fire({uri, progress: null}); pdfFinished.fire({uri, outcome: 'created'});
  service.busy = false; changed.fire(); await tick();
  initialRead.resolve({type: 'state', files: [], revision: 'old', busy: true}); await ready;
  const states = panel.webview.messages.filter(item => item.type === 'state');
  assert.ok(states.length >= 1); assert.ok(states.every(item => item.busy === false));
  assert.equal(states.at(-1).revision, 'finished');
  assert.equal(panel.webview.messages.some(item => item.type === 'pdfGenerationProgress' && item.progress), false);
});
