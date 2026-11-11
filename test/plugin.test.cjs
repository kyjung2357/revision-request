"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {test, before} = require('node:test');
const {build} = require('esbuild');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
require('tsx/cjs');
const {startMcpBridge} = require('../src/mcpBridge.ts');
const {configurationPath, parseConfiguration, readConfiguration, saveConfiguration} = require('../plugin/scripts/connection.cjs');
const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugin');
let scratch, adapter, originalWorkspace;
let counter = 0;
before(async () => {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /(^|\n)\.codex-\*\//);
  await fs.mkdir(path.join(root, '.codex-test'), {recursive: true});
  scratch = await fs.mkdtemp(path.join(root, '.codex-test', 'plugin-'));
  adapter = path.join(scratch, 'mcp-server.cjs');
  originalWorkspace = path.join(scratch, 'original workspace');
  await fs.mkdir(originalWorkspace);
  await build({entryPoints: [path.join(root, 'src/mcpServer.ts')], outfile: adapter, bundle: true,
    platform: 'node', format: 'cjs', loader: {'.md': 'text'}, logLevel: 'silent'});
});
function configuration(workspace = originalWorkspace, registry = path.join(scratch, 'registry')) {
  return {mcpServers: {revision_request: {command: process.execPath,
    args: [adapter, '--registry-dir', registry, '--workspace', pathToFileURL(workspace).href],
    env: {ELECTRON_RUN_AS_NODE: '1'}}}};
}
function location() {return path.join(scratch, 'connection-' + (++counter), 'mcp.json');}
function run(script, args = [], input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => {stdout += bytes;});
    child.stderr.on('data', bytes => {stderr += bytes;});
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(input);
  });
}
test('configuration keeps only the explicitly selected generated MCP entry', async () => {
  const input = configuration();
  input.mcpServers.unrelated = {command: 'not-run'};
  const filename = location();
  await saveConfiguration(JSON.stringify(input), filename);
  const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(Object.keys(stored.mcpServers), ['revision_request']);
  assert.deepEqual(stored.mcpServers.revision_request, input.mcpServers.revision_request);
  const parsed = await readConfiguration(filename);
  assert.equal(parsed.workspace, originalWorkspace);
  assert.equal(configurationPath(undefined, {REVISION_REQUEST_MCP_CONFIG: filename}), filename);
  assert.throws(() => configurationPath('relative.json'), /absolute/);
});
test('configuration rejects malformed, shell-like, unrelated, or unpinned entries', () => {
  const make = () => structuredClone(configuration());
  assert.throws(() => parseConfiguration('not JSON'), /Generic JSON/);
  assert.throws(() => parseConfiguration(JSON.stringify({mcpServers: {other: {command: process.execPath}}})), /generated/);
  for (const mutate of [
    value => {value.command = 'node';},
    value => {value.args[0] = 'relative.cjs';},
    value => {value.args = ['-e', 'process.exit(0)'];},
    value => {value.args[2] = 'relative-registry';},
    value => {value.args[4] = 'https://example.com/workspace';},
    value => {value.args[4] += '#different';},
    value => {value.args.push('--guess-workspace');},
    value => {value.env.ELECTRON_RUN_AS_NODE = '0';},
    value => {value.env.EXTRA = 'not-generated';},
  ]) {
    const input = make(); mutate(input.mcpServers.revision_request);
    assert.throws(() => parseConfiguration(JSON.stringify(input)));
  }
});
test('configuration never switches a workspace without explicit replacement', async () => {
  const filename = location();
  await saveConfiguration(JSON.stringify(configuration()), filename);
  const original = await fs.readFile(filename);
  const second = path.join(scratch, 'second workspace'); await fs.mkdir(second);
  const input = JSON.stringify(configuration(second));
  await assert.rejects(saveConfiguration(input, filename), /--replace/);
  assert.deepEqual(await fs.readFile(filename), original);
  await saveConfiguration(input, filename, true);
  assert.equal((await readConfiguration(filename)).workspace, second);
});
test('missing runtime or workspace cannot replace a working connection', async () => {
  const filename = location(); await saveConfiguration(JSON.stringify(configuration()), filename);
  const original = await fs.readFile(filename);
  for (const field of ['runtime', 'workspace']) {
    const input = configuration();
    if (field === 'runtime') input.mcpServers.revision_request.command = path.join(scratch, 'missing-runtime');
    else input.mcpServers.revision_request.args[4] = pathToFileURL(path.join(scratch, 'missing-workspace')).href;
    await assert.rejects(saveConfiguration(JSON.stringify(input), filename, true), /unavailable/);
    assert.deepEqual(await fs.readFile(filename), original);
  }
});
test('setup accepts stdin and checks paths without launching the configured program', async () => {
  const filename = location(), marker = path.join(scratch, 'must-not-run.txt');
  const fakeAdapter = path.join(scratch, 'not-executed', 'rr-mcp.cjs');
  await fs.mkdir(path.dirname(fakeAdapter));
  await fs.writeFile(fakeAdapter, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "executed");');
  const input = configuration(); input.mcpServers.revision_request.args[0] = fakeAdapter;
  const command = path.join(plugin, 'scripts', 'configure.cjs');
  const saved = await run(command, ['--stdin', '--config', filename], JSON.stringify(input));
  assert.equal(saved.code, 0, saved.stderr);
  const checked = await run(command, ['--check', '--config', filename]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /does not verify a live/);
  await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
});
test('an unconfigured launcher fails clearly without contaminating protocol stdout', async () => {
  const result = await run(path.join(plugin, 'scripts', 'launch-mcp.cjs'), ['--config', location()]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /not configured/);
});
test('copied plugin launcher carries real MCP protocol to only its configured workspace', async t => {
  const registry = path.join(scratch, 'live-registry');
  const workspaceUri = pathToFileURL(originalWorkspace).href;
  let decisions = 0, creates = 0;
  const bridge = await startMcpBridge({registryDir: registry,
    workspaces: () => [{uri: workspaceUri, name: 'Isolated plugin test'}],
    handler: async (method, args, uri) => {
      assert.equal(uri, workspaceUri);
      if (method === 'capabilities') return {allowAgentDecisions: false, workspaceUri: uri};
      if (method === 'list_requests') return {requests: [], workspaceUri: uri};
      if (method === 'read_target') return {path: args.path, content: 'x + x\n', hash: 'a'.repeat(64)};
      if (method === 'create_request') {creates++; return {requestId: 'test-request', status: 'pending'};}
      if (method === 'decide' || method === 'undo') {decisions++; throw new Error('Decision must not dispatch.');}
      throw new Error('Unexpected operation ' + method);
    }});
  t.after(() => bridge.dispose());
  const filename = location(); await saveConfiguration(JSON.stringify(configuration(originalWorkspace, registry)), filename);
  const installed = path.join(scratch, 'installed plugin with spaces');
  await fs.cp(path.join(plugin, 'scripts'), path.join(installed, 'scripts'), {recursive: true});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.join(installed, 'scripts', 'launch-mcp.cjs'), '--config', filename], stderr: 'pipe'});
  let stderr = ''; transport.stderr?.on('data', bytes => {stderr += bytes;});
  const client = new Client({name: 'revision-request-plugin-test', version: '1.0.0'});
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('rr_create_request'));
  assert.ok(!names.includes('rr_decide') && !names.includes('rr_undo'));
  const listed = await client.callTool({name: 'rr_list_requests', arguments: {}});
  assert.equal(listed.structuredContent.workspaceUri, workspaceUri);
  assert.equal((await client.callTool({name: 'rr_read_target', arguments: {path: 'source.txt'}})).structuredContent.hash, 'a'.repeat(64));
  const created = await client.callTool({name: 'rr_create_request', arguments: {
    path: 'source.txt', expectedHash: 'a'.repeat(64), clientRequestId: 'plugin-proposal',
    request: [{line: 1, before: 'x + x', after: 'x * x', reason: 'Multiply.'}],
  }});
  assert.equal(created.structuredContent.status, 'pending'); assert.equal(creates, 1);
  for (const name of ['rr_decide', 'rr_undo']) {
    const result = await client.callTool({name, arguments: {requestId: 'test-request', revision: 'a'.repeat(64), hunkId: 'change', decision: 'accepted'}});
    assert.equal(result.isError, true);
  }
  assert.equal(decisions, 0);
  bridge.dispose();
  const guide = await client.callTool({name: 'rr_get_format', arguments: {}});
  assert.equal(guide.isError, undefined);
  assert.ok(guide.structuredContent.guide.includes('before'));
  assert.equal(stderr, '', 'Successful protocol output must have no setup chatter.');
});
