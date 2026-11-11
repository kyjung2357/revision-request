"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {test, before} = require('node:test');
const {build} = require('esbuild');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
require('tsx/cjs');
const {startMcpBridge} = require('../src/mcpBridge.ts');
const {CURRENT_COMPATIBILITY} = require('../src/mcpCompatibility.ts');
const {syncPlugin} = require('../scripts/sync-plugin.cjs');
const {readPluginMetadata} = require('../plugin/scripts/launch-mcp.cjs');
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
function run(script, args = [], input = '', env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {cwd: root, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
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
      if (method === 'capabilities') return {allowAgentDecisions: false, workspaceUri: uri, ...CURRENT_COMPATIBILITY};
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
  for (const name of ['plugin.json', 'compatibility.json']) await fs.copyFile(path.join(plugin, name), path.join(installed, name));
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

test('plugin release references and versions come from the canonical extension sources', async () => {
  assert.deepEqual((await syncPlugin({check: true})).changed, []);
  const normalize = text => text.replace(/\r\n?/g, '\n');
  const guide = normalize(await fs.readFile(path.join(root, 'docs/FORMAT.md'), 'utf8'));
  assert.equal(normalize(await fs.readFile(path.join(plugin, 'skills/revision-request/references/format.md'), 'utf8')), guide);
  assert.equal(normalize(await fs.readFile(path.join(plugin, 'skills/revision-request/references/schema.json'), 'utf8')),
    normalize(await fs.readFile(path.join(root, 'schemas/revision-request.schema.json'), 'utf8')));
  const meta = await readPluginMetadata();
  assert.equal(meta.version, require('../package.json').version);
  assert.equal(meta.formatGuideSha256, createHash('sha256').update(guide).digest('hex'));
  assert.deepEqual(meta.features, require('../compatibility.json').features);
  for (const name of ['plugin.json', '.codex-plugin/plugin.json']) {
    const doc = JSON.parse(await fs.readFile(path.join(plugin, name), 'utf8'));
    assert.equal(doc.version, meta.version);
    const presentation = doc.extensions?.['com.openai']?.interface ?? doc.interface;
    assert.ok(presentation.shortDescription.length <= 30);
  }
});

test('sync check detects version and guide drift without rewriting, then sync repairs it idempotently', async () => {
  const fixture = path.join(scratch, 'sync-fixture');
  const inputs = ['package.json', 'compatibility.json', 'docs/FORMAT.md', 'schemas/revision-request.schema.json',
    'plugin/plugin.json', 'plugin/.codex-plugin/plugin.json'];
  for (const name of inputs) {
    await fs.mkdir(path.dirname(path.join(fixture, name)), {recursive: true});
    await fs.copyFile(path.join(root, name), path.join(fixture, name));
  }
  await syncPlugin({root: fixture});
  const manifestPath = path.join(fixture, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.version = '0.1.99';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const guidePath = path.join(fixture, 'docs/FORMAT.md');
  await fs.appendFile(guidePath, '\r\nUpdated canonical guide.\r\n');
  const pluginPath = path.join(fixture, 'plugin/plugin.json');
  const previousManifest = await fs.readFile(pluginPath);
  const previousGuide = await fs.readFile(path.join(fixture, 'plugin/skills/revision-request/references/format.md'));
  await assert.rejects(syncPlugin({root: fixture, check: true}), /out of sync.*plugin\/plugin.json.*format.md/);
  assert.deepEqual(await fs.readFile(pluginPath), previousManifest);
  assert.deepEqual(await fs.readFile(path.join(fixture, 'plugin/skills/revision-request/references/format.md')), previousGuide);
  const result = await syncPlugin({root: fixture});
  assert.equal(result.version, '0.1.99');
  assert.ok(result.changed.includes('plugin/compatibility.json'));
  assert.equal(JSON.parse(await fs.readFile(pluginPath, 'utf8')).version, '0.1.99');
  const expectedGuide = (await fs.readFile(guidePath, 'utf8')).replace(/\r\n?/g, '\n');
  assert.equal(await fs.readFile(path.join(fixture, 'plugin/skills/revision-request/references/format.md'), 'utf8'), expectedGuide);
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture, 'plugin/compatibility.json'), 'utf8')).formatGuideSha256,
    createHash('sha256').update(expectedGuide).digest('hex'));
  assert.deepEqual((await syncPlugin({root: fixture})).changed, []);
  assert.deepEqual((await syncPlugin({root: fixture, check: true})).changed, []);
  await fs.writeFile(path.join(fixture, 'plugin/skills/revision-request/references/schema.json'), '{}\n');
  await assert.rejects(syncPlugin({root: fixture, check: true}), /schema.json/);
  await fs.writeFile(path.join(fixture, 'compatibility.json'), JSON.stringify({features: ['duplicate', 'duplicate']}));
  await assert.rejects(syncPlugin({root: fixture}), /unique/);
});

test('launcher forwards only its own metadata and diagnosis flag without changing connection settings', async () => {
  const installed = path.join(scratch, 'metadata plugin');
  await fs.cp(path.join(plugin, 'scripts'), path.join(installed, 'scripts'), {recursive: true});
  for (const name of ['plugin.json', 'compatibility.json']) await fs.copyFile(path.join(plugin, name), path.join(installed, name));
  const fakeAdapter = path.join(scratch, 'metadata-adapter', 'rr-mcp.cjs');
  await fs.mkdir(path.dirname(fakeAdapter));
  await fs.writeFile(fakeAdapter, 'process.stdout.write(JSON.stringify({args: process.argv.slice(2), metadata: process.env.RR_PLUGIN_METADATA ?? null, electron: process.env.ELECTRON_RUN_AS_NODE}));');
  const config = configuration(); config.mcpServers.revision_request.args[0] = fakeAdapter;
  const filename = location(); await saveConfiguration(JSON.stringify(config), filename);
  const previous = await fs.readFile(filename);
  const launcher = path.join(installed, 'scripts/launch-mcp.cjs');
  const env = {...process.env, RR_PLUGIN_METADATA: JSON.stringify({version: 'old inherited value'})};
  const result = await run(launcher, ['--config', filename, '--diagnose'], '', env);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, [...config.mcpServers.revision_request.args.slice(1), '--diagnose']);
  assert.deepEqual(JSON.parse(output.metadata), await readPluginMetadata(installed));
  assert.equal(output.electron, '1');
  assert.deepEqual(await fs.readFile(filename), previous);
  await fs.writeFile(path.join(installed, 'compatibility.json'), '{broken');
  assert.equal(await readPluginMetadata(installed), undefined);
  const legacy = await run(launcher, ['--config', filename], '', env);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).metadata, null, 'Incomplete packages must not reuse inherited plugin identity.');
  assert.deepEqual(await fs.readFile(filename), previous);
});
