import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeClient, callBridge, startMcpBridge } from '../src/mcpBridge';
import { BRIDGE_MAX_BYTES, type BridgeManifest, type BridgeMethod, type BridgeResponse, type McpHandler } from '../src/mcpTypes';

const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.codex-test');
const workspace = pathToFileURL(path.join(scratch, 'mcp-workspace')).href;
const otherWorkspace = pathToFileURL(path.join(scratch, 'mcp-other-workspace')).href;
const hasCode = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);

async function registry(t: TestContext): Promise<string> {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.split(/\r?\n/).some(line => /^\/?\.codex-\*\/?$/.test(line.trim())), 'Temporary MCP paths must be ignored.');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'mcp-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(scratch) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function bridge(t: TestContext, directory: string, handler: McpHandler, uri = workspace) {
  const server = await startMcpBridge({ registryDir: directory,
    workspaces: () => [{ uri, name: 'MCP isolated fixture' }], handler });
  t.after(() => server.dispose());
  const manifest = JSON.parse(await fs.readFile(path.join(directory, server.instanceId + '.json'), 'utf8')) as BridgeManifest;
  return { server, manifest };
}
async function raw(manifest: BridgeManifest, frame: string | Buffer): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: manifest.port });
    let buffer = '', finished = false;
    const finish = (error?: Error, response?: BridgeResponse) => {
      if (finished) return;
      finished = true; socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    socket.setTimeout(10_000, () => finish(new Error('Local bridge test timed out')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, newline)) as BridgeResponse); }
      catch (error) { finish(error as Error); }
    });
    socket.once('end', () => { if (!finished) finish(new Error('Bridge closed without a response')); });
  });
}
function frame(manifest: BridgeManifest, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: randomUUID(), version: 1, instanceId: manifest.instanceId, token: manifest.token,
    workspaceUri: workspace, method: 'capabilities', args: {}, ...overrides }) + '\n';
}

test('authenticated bridge dispatches only to the explicitly selected workspace', async t => {
  const directory = await registry(t);
  const received: { method: BridgeMethod; args: Record<string, unknown>; uri: string }[] = [];
  const { manifest } = await bridge(t, directory, async (method, args, uri) => {
    received.push({ method, args, uri }); return { method, args, workspaceUri: uri };
  });
  assert.deepEqual(await callBridge(manifest, workspace, 'read_target', { path: 'sample.tex' }),
    { method: 'read_target', args: { path: 'sample.tex' }, workspaceUri: workspace });
  await assert.rejects(callBridge(manifest, otherWorkspace, 'read_target', { path: 'sample.tex' }), hasCode('WORKSPACE_UNAVAILABLE'));
  assert.equal(received.length, 1, 'A wrong workspace must never reach the application handler');
});

test('invalid authentication, instance, protocol and unknown methods cannot reach the handler', async t => {
  const directory = await registry(t); let calls = 0;
  const { manifest } = await bridge(t, directory, async () => { calls++; return {}; });
  await assert.rejects(callBridge({ ...manifest, token: 'x'.repeat(43) }, workspace, 'capabilities'), hasCode('UNAUTHORIZED'));
  await assert.rejects(callBridge({ ...manifest, instanceId: randomUUID() }, workspace, 'capabilities'), hasCode('UNAUTHORIZED'));
  for (const overrides of [{ method: 'execute_command' }, { version: 99 }, { args: [] }]) {
    const response = await raw(manifest, frame(manifest, overrides));
    assert.equal(response.error?.code, 'INVALID_MESSAGE');
  }
  assert.equal(calls, 0, 'Rejected bridge frames must not dispatch any application method');
});

test('server enforces the frame bound even when a raw client bypasses the SDK', async t => {
  const directory = await registry(t); let calls = 0;
  const { manifest } = await bridge(t, directory, async () => { calls++; return {}; });
  const response = await raw(manifest, Buffer.alloc(BRIDGE_MAX_BYTES + 1, 65));
  assert.equal(response.error?.code, 'MESSAGE_TOO_LARGE');
  assert.equal(calls, 0);
});

test('discovery refuses ambiguous windows and explicit instance selection is stable', async t => {
  const directory = await registry(t);
  const first = await bridge(t, directory, async (method, _args, uri) => ({ method, workspaceUri: uri, window: 'first' }));
  await bridge(t, directory, async (method, _args, uri) => ({ method, workspaceUri: uri, window: 'second' }));
  await assert.rejects(new BridgeClient({ registryDir: directory, workspaceUri: workspace }).call('capabilities'), hasCode('AMBIGUOUS_WORKSPACE'));
  const selected = new BridgeClient({ registryDir: directory, workspaceUri: workspace, instanceId: first.server.instanceId });
  assert.deepEqual(await selected.call('read_target', { path: 'sample.tex' }),
    { method: 'read_target', workspaceUri: workspace, window: 'first' });
  await assert.rejects(new BridgeClient({ registryDir: directory, workspaceUri: otherWorkspace }).call('capabilities'), hasCode('WORKSPACE_UNAVAILABLE'));
  await assert.rejects(new BridgeClient({ registryDir: directory, workspaceUri: workspace, instanceId: randomUUID() }).call('capabilities'), hasCode('WORKSPACE_UNAVAILABLE'));
});

test('workspace publication changes are honored instead of falling back to another folder', async t => {
  const directory = await registry(t); let current = workspace;
  const server = await startMcpBridge({ registryDir: directory,
    workspaces: () => [{ uri: current, name: 'Changing fixture' }],
    handler: async (_method, _args, uri) => ({ workspaceUri: uri }) });
  t.after(() => server.dispose());
  const client = new BridgeClient({ registryDir: directory, workspaceUri: workspace });
  assert.deepEqual(await client.call('capabilities'), { workspaceUri: workspace });
  current = otherWorkspace; await server.publish();
  await assert.rejects(client.call('capabilities'), hasCode('WORKSPACE_UNAVAILABLE'));
  assert.deepEqual(await new BridgeClient({ registryDir: directory, workspaceUri: otherWorkspace }).call('capabilities'),
    { workspaceUri: otherWorkspace });
});

test('bundled stdio adapter speaks real SDK protocol, validates tools and revokes cached decision calls', async t => {
  const directory = await registry(t); let allowed = false, decisions = 0, reads = 0, creates = 0;
  const { server } = await bridge(t, directory, async (method, args, uri) => {
    if (method === 'capabilities') return {workspaceUri: uri, allowAgentDecisions: allowed};
    if (method === 'create_request') { creates++; return {status: 'pending', input: args}; }
    if (method === 'read_target') { reads++; return {path: args.path, content: '한글 😀\r\nsource', hash: 'a'.repeat(64)}; }
    if (method === 'decide' || method === 'undo') { assert.equal(allowed, true); decisions++; return {status: 'pending'}; }
    throw new Error('Unexpected fake-host operation: ' + method);
  });
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.join(root, '.codex-build', 'mcp-server.cjs'), '--registry-dir', directory, '--workspace', workspace], stderr: 'pipe'});
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({name: 'rr-stdio-transport-test', version: '1.0.0'});
  t.after(() => client.close());
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('rr_get_format')); assert.ok(names.includes('rr_read_target'));
    assert.equal(names.includes('rr_decide'), false); assert.equal(names.includes('rr_undo'), false);
    const read = await client.callTool({name: 'rr_read_target', arguments: {path: 'source.tex'}});
    assert.deepEqual(read.structuredContent, {path: 'source.tex', content: '한글 😀\r\nsource', hash: 'a'.repeat(64)});
    assert.equal(reads, 1);
    for (const args of [{}, {path: 'source.tex', workspaceUri: otherWorkspace}]) {
      const invalid = await client.callTool({name: 'rr_read_target', arguments: args});
      assert.equal(invalid.isError, true, 'Missing required or additional routing fields must be rejected before dispatch');
    }
    assert.equal(reads, 1);
    const create = {path: 'source.tex', expectedHash: 'a'.repeat(64), clientRequestId: 'snippet-fixture', request: [{line: 1, before: 'old', after: 'new', reason: 'Reason'}]};
    assert.notEqual((await client.callTool({name: 'rr_create_request', arguments: create})).isError, true);
    assert.equal(creates, 1);
    for (const entry of [{line: 2, before: null, after: ''}, {line: 1, before: 'old', after: null},
      {line: 1, before: 'old\nline', after: 'new\nblock'}, {line: 2, before: null, after: 'first\nsecond', reason: ''},
      {line: 1, before: 'old\nline', after: null}, {line: 1, before: 'old\n', after: 'new'}]) {
      assert.notEqual((await client.callTool({name: 'rr_create_request', arguments: {...create, request: [entry]}})).isError, true);
    }
    assert.equal(creates, 7);
    for (const invalid of [
      {...create, request: [{...create.request[0], status: 'accepted'}]},
      {...create, request: [{...create.request[0], status: 'pending'}]},
      {...create, time: '2026-11-10T00:00:00Z'},
      {...create, request: [{before: 'old', after: 'new'}]},
      {...create, request: [{line: 0, before: 'old', after: 'new'}]},
      {...create, request: [{line: 1.5, before: 'old', after: 'new'}]},
      {...create, request: [{line: 1, before: 'old\rline', after: 'new'}]},
      {...create, request: [{line: 1, before: 'old\r\nline', after: 'new'}]},
      {...create, request: [{line: 1, before: 'old', after: 'new\r\n'}]},
      {...create, request: [{line: 1, before: 'old', after: 'new\rline'}]},
      {...create, request: [{line: 1, before: null, after: null}]},
      {...create, after: 'legacy full file'},
      {...create, title: 'Legacy title'},
    ]) assert.equal((await client.callTool({name: 'rr_create_request', arguments: invalid})).isError, true);
    assert.equal(creates, 7, 'Invalid line edits, status/time injection and unsupported fields never reach the host');
    assert.equal((await client.callTool({name: 'rr_create_request', arguments: {path: 'source.tex', expectedHash: 'a'.repeat(64), clientRequestId: 'unsupported-shape', after: 'full replacement', title: 'Unsupported'}})).isError, true);
    assert.equal(creates, 7);
    const args = {requestId: 'fixture-id', revision: 'a'.repeat(64), hunkId: 'fixture-hunk'};
    assert.equal((await client.callTool({name: 'rr_decide', arguments: {...args, decision: 'accepted'}})).isError, true);
    assert.equal((await client.callTool({name: 'rr_undo', arguments: args})).isError, true);
    assert.equal(decisions, 0);
    allowed = true;
    const enabled = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(enabled.includes('rr_decide')); assert.ok(enabled.includes('rr_undo'));
    assert.notEqual((await client.callTool({name: 'rr_decide', arguments: {...args, decision: 'accepted'}})).isError, true);
    assert.notEqual((await client.callTool({name: 'rr_undo', arguments: args})).isError, true);
    assert.equal(decisions, 2);
    allowed = false;
    assert.equal((await client.callTool({name: 'rr_decide', arguments: {...args, decision: 'ignored'}})).isError, true);
    assert.equal((await client.callTool({name: 'rr_undo', arguments: args})).isError, true);
    assert.equal(decisions, 2, 'Cached tools must recheck current permission before dispatch');
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map(item => item.uri), ['rr://format', 'rr://schema']);
    for (const resource of resources.resources) {
      const content = await client.readResource({uri: resource.uri}); assert.ok(content.contents.length > 0);
    }
    server.dispose();
    const guide = await client.callTool({name: 'rr_get_format', arguments: {}});
    assert.notEqual(guide.isError, true);
    assert.equal((guide.structuredContent as {language: string}).language, 'en');
    assert.equal((await client.callTool({name: 'rr_get_format', arguments: {language: 'ko'}})).isError, true);
    const format = guide.structuredContent as {example: Record<string, unknown>; schema: {properties: Record<string, unknown>; required: string[]}};
    assert.equal('formatVersion' in format, false);
    assert.equal('version' in format.example, false);
    assert.equal('version' in format.schema.properties, false);
    assert.deepEqual(format.schema.required, ['path', 'request']);
    assert.equal((await client.callTool({name: 'rr_get_format', arguments: {version: 1}})).isError, true);
    const schemaResource = await client.readResource({uri: 'rr://schema'});
    const content = schemaResource.contents[0]!;
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(String(content.text)), format.schema);
    await assert.rejects(client.readResource({uri: 'rr://format/v1'}), /Unknown Revision Request resource/);
    await assert.rejects(client.readResource({uri: 'rr://format/ko'}), /Unknown Revision Request resource/);
    assert.equal((await client.callTool({name: 'rr_read_target', arguments: {path: 'source.tex'}})).isError, true,
      'Source operations fail closed when the owning VS Code instance disappears');
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  }
});
