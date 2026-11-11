import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { collectMcpDiagnostics, formatMcpDiagnostics, type McpDiagnosticOptions } from '../src/mcpDiagnostics';
import { startMcpBridge } from '../src/mcpBridge';
import { CURRENT_COMPATIBILITY } from '../src/mcpCompatibility';

const scratchRoot = path.resolve(__dirname, '../.codex-test');
async function fixture(t: test.TestContext) {
  await fs.mkdir(scratchRoot, {recursive: true});
  const scratch = await fs.mkdtemp(path.join(scratchRoot, 'diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(scratch)), scratchRoot);
    assert.ok(path.basename(scratch).startsWith('diagnostics-'));
    await fs.rm(scratch, {recursive: true, force: true});
  });
  const bundledAdapterPath = path.join(scratch, 'bundled.cjs');
  const adapterPath = path.join(scratch, 'installed.cjs');
  await Promise.all([fs.writeFile(bundledAdapterPath, 'adapter'), fs.writeFile(adapterPath, 'adapter')]);
  const options: McpDiagnosticOptions = {extensionVersion: CURRENT_COMPATIBILITY.version,
    workspace: {name: 'Fixture', uri: pathToFileURL(scratch).href}, trusted: true,
    bundledAdapterPath, adapterPath, registryDir: path.join(scratch, 'instances'), bridgeInstanceId: 'test'};
  return {options, scratch};
}
const caps = (options: McpDiagnosticOptions) => ({workspaceUri: options.workspace!.uri, allowAgentDecisions: false,
  extensionVersion: CURRENT_COMPATIBILITY.version, features: CURRENT_COMPATIBILITY.features,
  formatGuideSha256: CURRENT_COMPATIBILITY.formatGuideSha256});
const check = (report: Awaited<ReturnType<typeof collectMcpDiagnostics>>, stage: string) => report.checks.find(item => item.stage === stage)!;

test('diagnostics remain available without a trusted workspace and never try to repair or probe', async t => {
  const {options} = await fixture(t);
  let calls = 0;
  const probe = async () => {calls++; throw new Error('Must not probe');};
  for (const current of [{...options, workspace: undefined}, {...options, trusted: false}]) {
    const report = await collectMcpDiagnostics(current, probe);
    assert.equal(check(report, 'Workspace').status, 'blocked');
    assert.equal(check(report, 'Bridge').status, 'blocked');
    assert.equal(check(report, 'Agent tool discovery').status, 'unknown');
  }
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(options.adapterPath, 'utf8'), 'adapter');
});

test('diagnostics authenticate a live bridge but do not claim agent discovery without client evidence', async t => {
  const {options} = await fixture(t);
  let calls = 0;
  const bridge = await startMcpBridge({registryDir: options.registryDir,
    workspaces: () => [options.workspace!], handler: async (method, _args, workspaceUri) => {
      assert.equal(method, 'capabilities'); assert.equal(workspaceUri, options.workspace!.uri); calls++;
      return caps(options);
    }});
  t.after(() => bridge.dispose());
  const report = await collectMcpDiagnostics({...options, bridgeInstanceId: bridge.instanceId});
  assert.equal(check(report, 'Adapter').status, 'ok');
  assert.equal(check(report, 'Bridge').status, 'ok');
  assert.equal(check(report, 'Format').status, 'ok');
  assert.equal(check(report, 'Agent client').status, 'unknown');
  assert.equal(check(report, 'Agent tool discovery').status, 'unknown');
  assert.equal(calls, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(options.registryDir, bridge.instanceId + '.json'), 'utf8'));
  assert.ok(!formatMcpDiagnostics(report).includes(manifest.token));
});

test('last tools/list observation is shown as historical evidence, not current agent visibility', async t => {
  const {options} = await fixture(t);
  const report = await collectMcpDiagnostics(options, async () => ({...caps(options), lastClient: {
    name: 'Fixture agent', version: '1.0.0', adapterVersion: CURRENT_COMPATIBILITY.version,
    plugin: CURRENT_COMPATIBILITY, stage: 'tools_listed', lastSeenAt: '2026-11-11T12:00:00Z',
  }}));
  assert.equal(check(report, 'Agent plugin').status, 'ok');
  assert.equal(check(report, 'Agent tool discovery').status, 'unknown');
  assert.match(check(report, 'Agent tool discovery').summary, /Last observed tools\/list/);
  assert.match(check(report, 'Agent tool discovery').summary, /not observable/);
});

test('stale adapter and old plugin produce distinct update steps without changing files', async t => {
  const {options} = await fixture(t);
  await fs.writeFile(options.adapterPath, 'old adapter');
  const report = await collectMcpDiagnostics(options, async () => ({...caps(options), lastClient: {
    name: 'Old agent', adapterVersion: '0.1.2', plugin: {version: '0.1.2', features: []},
    stage: 'initialized', lastSeenAt: '2026-11-11T12:00:00Z',
  }}));
  assert.equal(check(report, 'Adapter').status, 'warning');
  assert.equal(check(report, 'Adapter version').status, 'warning');
  assert.equal(check(report, 'Agent plugin').status, 'warning');
  assert.match(check(report, 'Agent plugin').nextStep!, /Update or reinstall/);
  assert.equal(await fs.readFile(options.adapterPath, 'utf8'), 'old adapter');
});

test('bridge errors cannot leak credential-bearing exception text into the report', async t => {
  const {options} = await fixture(t);
  const secret = 'secret-token-must-not-appear';
  const report = await collectMcpDiagnostics(options, async () => {throw new Error(secret);});
  assert.equal(check(report, 'Bridge').status, 'blocked');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!formatMcpDiagnostics(report).includes(secret));
});

test('a successful response for another workspace is not considered a working connection', async t => {
  const {options} = await fixture(t);
  const report = await collectMcpDiagnostics(options, async () => ({...caps(options), workspaceUri: 'file:///other-workspace'}));
  assert.equal(check(report, 'Bridge').status, 'blocked');
  assert.equal(check(report, 'Format').status, 'unknown');
});

test('missing adapter and failed startup are diagnosed without starting the bridge', async t => {
  const {options} = await fixture(t);
  await fs.unlink(options.adapterPath);
  let calls = 0;
  const report = await collectMcpDiagnostics({...options, bridgeInstanceId: undefined, bridgeStartFailed: true}, async () => {calls++; return caps(options);});
  assert.equal(check(report, 'Adapter').status, 'blocked');
  assert.match(check(report, 'Bridge').summary, /failed to start/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(options.adapterPath));
});
