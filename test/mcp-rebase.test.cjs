'use strict';
// MCP-only transport/state binding tests. Source rebase and file writes are
// covered separately by ReviewService integration tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const Module = require('node:module');
const {test, before} = require('node:test');
const root = path.resolve(__dirname, '..');
let scratch, current;
const hash = text => createHash('sha256').update(text).digest('hex');
class Uri {
  constructor(value) {this.fsPath = path.resolve(value); this.scheme = 'file';}
  toString() {return pathToFileURL(this.fsPath).href;}
  static file(value) {return new Uri(value);}
  static parse(value) {return new Uri(fileURLToPath(value));}
}
const vscode = {
  Uri, RelativePattern: class {},
  workspace: {
    isTrusted: true,
    get workspaceFolders() {return [{uri: current.folder, name: 'Fixture'}];},
    get textDocuments() {return [];},
    getWorkspaceFolder(uri) {
      const relative = path.relative(current.folder.fsPath, uri.fsPath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? {uri: current.folder, name: 'Fixture'} : undefined;
    },
    findFiles: async () => [current.request],
  }
};
const originalLoad = Module._load;
Module._load = function(name, parent, main) {return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main);};
require('tsx/cjs');
const {McpHost} = require('../src/mcpHost.ts');
Module._load = originalLoad;
before(async () => {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /(^|\n)\.codex-\*\//);
  await fs.mkdir(path.join(root, '.codex-test'), {recursive: true});
  scratch = await fs.mkdtemp(path.join(root, '.codex-test', 'mcp-rebase-'));
});
let serial = 0;
async function setup() {
  const folder = Uri.file(path.join(scratch, String(++serial)));
  await fs.mkdir(folder.fsPath);
  const request = Uri.file(path.join(folder.fsPath, 'source.txt.rr'));
  const text = JSON.stringify({path: 'source.txt', time: '2026-11-10T00:00:00Z', request: [
    {line: 1, before: 'one', after: 'ONE', status: 'pending'},
    {line: 3, before: 'three', after: 'THREE', status: 'pending'},
    {line: 5, before: 'five', after: 'FIVE', status: 'accepted'}
  ]}, null, 2) + '\n';
  await fs.writeFile(request.fsPath, text);
  await fs.writeFile(path.join(folder.fsPath, 'source.txt'), 'one\ncontext\nthree\ncontext\nFIVE\n');
  const rawRevision = hash(text), values = new Map();
  current = {folder, request, allowed: false, calls: [],
    state: {type: 'state', rawRevision, revision: hash(rawRevision + ':source-1'), verified: true,
      files: [{path: 'source.txt', before: 'one\ncontext\nthree\ncontext\nFIVE\n', hunks: [
        {id: 'first', oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, decision: 'pending'},
        {id: 'second', oldStart: 3, newStart: 3, oldLines: 1, newLines: 1, decision: 'pending'},
        {id: 'reviewed', oldStart: 5, newStart: 5, oldLines: 1, newLines: 1, decision: 'accepted'}
      ]}]}}
  const context = {workspaceState: {
    get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    update: async (key, value) => {values.set(key, structuredClone(value));}
  }};
  const service = {setCompletionRecorder() {}, getState: async () => structuredClone(current.state),
    decide: async (...args) => {current.calls.push({method: 'decide', args});},
    undo: async (...args) => {current.calls.push({method: 'undo', args});}
  };
  const host = new McpHost(context, service, async () => {}, () => current.allowed);
  const call = (method, args = {}) => host.handler(method, args, folder.toString());
  const {requests} = await call('list_requests');
  assert.equal(requests.length, 1);
  return {call, listed: requests[0], text};
}

test('MCP binds raw JSON independently and returns source-aware review revisions with stable request IDs', async () => {
  const {call, listed, text} = await setup();
  assert.equal(listed.status, 'pending');
  assert.equal(listed.rawRevision, hash(text));
  assert.equal(listed.revision, current.state.revision);
  assert.notEqual(listed.revision, listed.rawRevision);
  current.state.revision = hash(listed.rawRevision + ':source-2');
  current.state.files[0].hunks[1].oldStart = 6;
  current.state.files[0].hunks[1].newStart = 6;
  const refreshed = await call('get_request_status', {requestId: listed.requestId});
  const {requests} = await call('list_requests');
  assert.equal(refreshed.status, 'pending');
  assert.equal(refreshed.requestId, listed.requestId);
  assert.equal(requests[0].requestId, listed.requestId);
  assert.equal(refreshed.rawRevision, listed.rawRevision);
  assert.notEqual(refreshed.revision, listed.revision);
  assert.equal(refreshed.hunks[1].oldStart, 6);
});

test('MCP reports per-item conflicts without globally blocking unrelated decisions or explicit Ignore', async () => {
  const {call, listed} = await setup();
  current.allowed = true;
  current.state.files[0].hunks[0].conflict = 'The original block was edited.';
  current.state.files[0].hunks[2].undoBlocked = 'Manually edited after review.';
  const status = await call('get_request_status', {requestId: listed.requestId});
  assert.equal(status.status, 'pending');
  assert.equal(status.issue, undefined);
  assert.equal(status.pending, 2);
  assert.equal(status.hunks[0].conflict, 'The original block was edited.');
  assert.equal(status.hunks[2].undoBlocked, 'Manually edited after review.');
  await call('decide', {requestId: listed.requestId, hunkId: 'first', decision: 'ignored', revision: status.revision});
  await call('decide', {requestId: listed.requestId, hunkId: 'second', decision: 'accepted', revision: status.revision});
  assert.deepEqual(current.calls.map(item => [item.args[2], item.args[3], item.args[4], item.args[5]]), [
    ['first', 'ignored', status.revision, 'agent'], ['second', 'accepted', status.revision, 'agent']
  ]);
});

test('MCP rejects old review tokens and raw JSON hashes for decisions and retains default permission denial', async () => {
  const {call, listed} = await setup();
  const args = {requestId: listed.requestId, hunkId: 'first', decision: 'accepted', revision: listed.revision};
  await assert.rejects(call('decide', args), error => error.code === 'AGENT_DECISIONS_DISABLED');
  assert.equal(current.calls.length, 0);
  current.allowed = true;
  current.state.revision = hash(listed.rawRevision + ':source-2');
  for (const revision of [listed.revision, listed.rawRevision]) {
    await assert.rejects(call('decide', {...args, revision}), error => error.code === 'REQUEST_CHANGED');
    await assert.rejects(call('undo', {requestId: listed.requestId, hunkId: 'first', revision}), error => error.code === 'REQUEST_CHANGED');
  }
  assert.equal(current.calls.length, 0);
  await call('decide', {...args, revision: current.state.revision});
  assert.equal(current.calls[0].args[4], current.state.revision);
  assert.equal(current.calls[0].args[5], 'agent');
});

test('MCP still rejects a mismatched saved JSON revision even if the source-aware token is available', async () => {
  const {call, listed} = await setup();
  current.state.rawRevision = hash('wrong JSON');
  const result = await call('get_request_status', {requestId: listed.requestId});
  assert.equal(result.status, 'unavailable');
  assert.match(result.issue, /request changed/i);
  assert.equal(current.calls.length, 0);
});