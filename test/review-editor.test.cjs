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
  service.transformDraft = async (...args) => {calls.push(args); return {draft:'# edited',reviewActions:[]};};
  service.reviewActions = async () => [{id:'comment',enabled:true,label:'Comment out changed lines'}];
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], refreshes = current.requests.length;
  panel.received.fire({type:'transformDraft',filePath:'sample.py',hunkId:'h1',draft:'edited',revision:'r1',action:'comment',editId:'transform-1'});
  await tick(); await tick();
  assert.equal(calls.length,1);
  assert.deepEqual(panel.webview.messages.at(-1),{type:'transformResult',editId:'transform-1',draft:'# edited',reviewActions:[]});
  assert.equal(current.requests.length,refreshes);
  panel.received.fire({type:'reviewActions',filePath:'sample.py',hunkId:'h1',draft:'edited',revision:'r1',editId:'menu-1'});
  await tick();
  assert.equal(panel.webview.messages.at(-1).type,'reviewActionsResult');
  assert.equal(current.requests.length,refreshes);
});
test('menu transformation failures keep a correlated draft error and reject unknown message keys', async t => {
  const {editor, uri, service} = setup(t);
  service.transformDraft = async () => {throw Error('Unsafe TeX fragment');};
  await editor.openPreview(uri); await tick();
  const panel = current.created[0], refreshes = current.requests.length;
  const message = {type:'transformDraft',filePath:'sample.tex',hunkId:'h1',draft:'edited',revision:'r1',action:'markAdded',editId:'transform-2'};
  panel.received.fire(message); await tick();
  assert.deepEqual(panel.webview.messages.at(-1),{type:'transformResult',editId:'transform-2',error:'Unsafe TeX fragment'});
  panel.received.fire({...message,override:true}); await tick();
  assert.match(panel.webview.messages.at(-1).error,/Invalid/);
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
  service.decide = async (...args) => {calls.push(args); await gate.promise;};
  panel.webview.messages = [];
  const message = {type:'decide',filePath:'inventory_report.py',hunkId:'pending-1',decision:'accepted',revision:'before',quickDecisionId:'quick-1'};
  const pending = receive(message); await tick();
  assert.equal(panel.webview.messages.some(item=>item.type==='quickDecisionResult'),false);
  gate.resolve(); await pending;
  assert.deepEqual(calls,[[uri,message.filePath,message.hunkId,message.decision,message.revision]]);
  assert.deepEqual(panel.webview.messages.find(item=>item.type==='quickDecisionResult'),{
    type:'quickDecisionResult',quickDecisionId:'quick-1',filePath:message.filePath,hunkId:message.hunkId,decision:'accepted',success:true,error:undefined
  });
  service.decide = async () => {throw Error('The request changed. Review it again.');};
  panel.webview.messages = [];
  await receive({...message,quickDecisionId:'quick-2',decision:'ignored'});
  const failed = panel.webview.messages.find(item=>item.type==='quickDecisionResult');
  assert.equal(failed.success,false); assert.equal(failed.quickDecisionId,'quick-2'); assert.equal(failed.decision,'ignored');
  assert.match(failed.error,/request changed/);
  assert.match(panel.webview.messages.find(item=>item.type==='state').error,/request changed/);
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
