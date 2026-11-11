'use strict';
// Exercise the actual picker workflow against disposable files without building
// or launching the extension. Only the VS Code selection/editor APIs are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const Module = require('node:module');
const {test, before, beforeEach} = require('node:test');
const root = path.resolve(__dirname, '..');
let scratch;
let workspacePath;
let outsidePath;
let serial = 0;
let selectionQueue = [];
let dialogs = [];
let documents = [];
let saveCalls = 0;
class Uri {
  constructor(filePath) { this.fsPath = path.resolve(filePath); this.path = this.fsPath.replaceAll('\\', '/'); this.scheme = 'file'; }
  toString() { return pathToFileURL(this.fsPath).href; }
  static file(filePath) { return new Uri(filePath); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
}
const contains = (folder, target) => {
  const relative = path.relative(folder, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const vscode = {
  Uri,
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    get textDocuments() { return documents; },
    getWorkspaceFolder(uri) {
      return this.workspaceFolders?.filter(folder => uri.scheme === 'file' && contains(folder.uri.fsPath, uri.fsPath))
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
    },
  },
  window: {
    activeTextEditor: undefined,
    async showOpenDialog(options) {
      dialogs.push(options);
      assert.ok(selectionQueue.length, 'The command must not ask for an unexpected third file.');
      return selectionQueue.shift();
    },
    async showTextDocument() { assert.fail('Creating a request must not open or save either input editor.'); },
  },
};
const load = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : load.call(this, name, parent, main); };
require('tsx/cjs');
let createRequestFromFiles;
let resolveRequest;
try {
  ({createRequestFromFiles} = require('../src/createRequestCommand.ts'));
  ({resolveRequest} = require('../src/request.ts'));
} finally { Module._load = load; }

before(async () => {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /(^|\n)\.codex-\*\//);
  await fs.mkdir(path.join(root, '.codex-test'), {recursive: true});
  scratch = await fs.mkdtemp(path.join(root, '.codex-test', 'create-command-'));
  workspacePath = path.join(scratch, 'workspace');
  outsidePath = path.join(scratch, 'outside');
  await Promise.all([fs.mkdir(workspacePath), fs.mkdir(outsidePath)]);
  console.log('Create-command fixtures: ' + scratch);
});
beforeEach(() => {
  documents = [];
  selectionQueue = [];
  dialogs = [];
  saveCalls = 0;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{uri: Uri.file(workspacePath), name: 'Fixture workspace', index: 0}];
  vscode.window.activeTextEditor = undefined;
});
async function fixture() {
  const folder = 'case-' + (++serial);
  const target = Uri.file(path.join(workspacePath, folder, 'nested', '원고 sample.tex'));
  const modified = Uri.file(path.join(outsidePath, folder + '-modified.tex'));
  const output = Uri.file(target.fsPath + '.rr');
  const beforeBytes = Buffer.from('\uFEFFLet x > 0.\r\nunchanged\r\ncoefficient = 2;\r\n');
  const afterBytes = Buffer.from('\uFEFFLet x >= 0.\r\nunchanged\r\ncoefficient = 1;\r\n');
  await fs.mkdir(path.dirname(target.fsPath), {recursive: true});
  await Promise.all([fs.writeFile(target.fsPath, beforeBytes), fs.writeFile(modified.fsPath, afterBytes)]);
  return {target, modified, output, beforeBytes, afterBytes, relative: path.relative(workspacePath, target.fsPath).split(path.sep).join('/')};
}
function choose(item) { selectionQueue = [[item.target], [item.modified]]; }
function dirty(uri) {
  const document = {uri, isDirty: true, isUntitled: false, isClosed: false,
    getText: () => 'unsaved editor text',
    async save() { saveCalls++; assert.fail('The command must leave unsaved edits for the user to handle.'); }};
  documents.push(document);
  return document;
}
async function inputsUnchanged(item) {
  assert.deepEqual(await fs.readFile(item.target.fsPath), item.beforeBytes);
  assert.deepEqual(await fs.readFile(item.modified.fsPath), item.afterBytes);
  assert.equal(saveCalls, 0);
}
async function absent(uri) { await assert.rejects(fs.lstat(uri.fsPath), {code: 'ENOENT'}); }

test('Two selected saved files create original.ext.rr with pending changes and leave both inputs unchanged', async () => {
  const item = await fixture();
  choose(item);
  vscode.window.activeTextEditor = {document: {uri: item.target, isDirty: false}};
  let exclusiveCalls = 0;
  const created = await createRequestFromFiles(async action => { exclusiveCalls++; return action(); });
  assert.equal(created?.toString(), item.output.toString());
  assert.equal(exclusiveCalls, 1, 'Creation must use the shared review transaction queue.');
  assert.equal(dialogs.length, 2);
  assert.ok(dialogs.every(options => options.canSelectMany === false));
  const request = JSON.parse(await fs.readFile(created.fsPath, 'utf8'));
  assert.equal(request.path, item.relative);
  assert.ok(Number.isFinite(Date.parse(request.time)));
  assert.ok(request.request.length > 0);
  assert.ok(request.request.every(entry => entry.status === 'pending'));
  const resolved = resolveRequest(request, item.beforeBytes.toString('utf8'));
  assert.equal(resolved.expectedTarget, item.beforeBytes.toString('utf8'));
  assert.equal(resolved.file.after, item.afterBytes.toString('utf8'));
  await inputsUnchanged(item);
});

for (const picker of ['original', 'modified']) {
  test('Cancelling the ' + picker + ' picker creates nothing and leaves both inputs unchanged', async () => {
    const item = await fixture();
    selectionQueue = picker === 'original' ? [undefined] : [[item.target], undefined];
    assert.equal(await createRequestFromFiles(), undefined);
    assert.equal(dialogs.length, picker === 'original' ? 1 : 2);
    await absent(item.output);
    await inputsUnchanged(item);
  });
}

for (const input of ['original', 'modified']) {
  test('An unsaved ' + input + ' editor is refused without saving inputs or creating a request', async () => {
    const item = await fixture();
    choose(item);
    const document = dirty(input === 'original' ? item.target : item.modified);
    await assert.rejects(createRequestFromFiles(), /unsaved|dirty|save/i);
    assert.equal(document.isDirty, true);
    assert.equal(document.getText(), 'unsaved editor text');
    await absent(item.output);
    await inputsUnchanged(item);
  });
}

test('A dirty editor opened through a filesystem alias is refused', async () => {
  const item = await fixture();
  const alias = path.join(workspacePath, 'alias-' + serial);
  await fs.symlink(path.dirname(item.target.fsPath), alias, process.platform === 'win32' ? 'junction' : 'dir');
  dirty(Uri.file(path.join(alias, path.basename(item.target.fsPath))));
  choose(item);
  await assert.rejects(createRequestFromFiles(), /unsaved|dirty|save/i);
  await absent(item.output);
  await inputsUnchanged(item);
});

test('A dirty output editor is refused even when its saved request does not exist', async () => {
  const item = await fixture();
  choose(item);
  dirty(item.output);
  await assert.rejects(createRequestFromFiles(), /unsaved|dirty|save/i);
  await absent(item.output);
  await inputsUnchanged(item);
});

test('An original outside the opened workspace is refused without creating a request', async () => {
  const item = await fixture();
  selectionQueue = [[item.modified], [item.target]];
  await assert.rejects(createRequestFromFiles(), /workspace/i);
  await absent(Uri.file(item.modified.fsPath + '.rr'));
  await absent(item.output);
  await inputsUnchanged(item);
});

test('An existing request is preserved byte for byte', async () => {
  const item = await fixture();
  const existing = Buffer.from('existing request, including unsaved review history\r\n');
  await fs.writeFile(item.output.fsPath, existing);
  choose(item);
  await assert.rejects(createRequestFromFiles(), /exist|already/i);
  assert.deepEqual(await fs.readFile(item.output.fsPath), existing);
  await inputsUnchanged(item);
});

test('An untrusted workspace is refused before displaying a picker', async () => {
  vscode.workspace.isTrusted = false;
  await assert.rejects(createRequestFromFiles(), /trust/i);
  assert.equal(dialogs.length, 0);
});

test('No local workspace is refused before displaying a picker', async () => {
  vscode.workspace.workspaceFolders = [];
  await assert.rejects(createRequestFromFiles(), /workspace|folder/i);
  assert.equal(dialogs.length, 0);
});
