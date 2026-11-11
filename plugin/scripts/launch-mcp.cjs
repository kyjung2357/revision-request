"use strict";
const {spawn} = require('node:child_process');
const {parseArgs} = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const {configurationPath, readConfiguration} = require('./connection.cjs');
// Missing or malformed metadata denotes an older/incomplete plugin, not a launch failure.
async function readPluginMetadata(root = path.resolve(__dirname, '..')) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin.json'), 'utf8'));
    const compatibility = JSON.parse(await fs.readFile(path.join(root, 'compatibility.json'), 'utf8'));
    if (manifest.name !== 'revision-request' || typeof manifest.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
        !Array.isArray(compatibility.features) || compatibility.features.length > 64 ||
        !compatibility.features.every(value => typeof value === 'string' && value.length > 0 && value.length <= 128) ||
        !/^[a-f0-9]{64}$/.test(compatibility.formatGuideSha256)) return undefined;
    return {version: manifest.version, features: compatibility.features, formatGuideSha256: compatibility.formatGuideSha256};
  } catch { return undefined; }
}
async function main() {
  const {values} = parseArgs({options: {config: {type: 'string'}, diagnose: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}}, strict: true, allowPositionals: false});
  if (values.help) {
    process.stderr.write('Revision Request plugin MCP launcher\nnode launch-mcp.cjs [--config <absolute-connection-json>] [--diagnose]\n--diagnose checks the selected workspace and reports connection/version details without starting an MCP session.\nRun configure.cjs first using the Generic JSON copied from VS Code.\n');
    return;
  }
  const entry = await readConfiguration(configurationPath(values.config));
  const metadata = await readPluginMetadata();
  const env = {...process.env, ...entry.env};
  // Always describe this installed plugin; never forward stale identity from a parent process.
  delete env.RR_PLUGIN_METADATA;
  if (metadata) env.RR_PLUGIN_METADATA = JSON.stringify(metadata);
  const args = values.diagnose ? [...entry.args, '--diagnose'] : entry.args;
  // stdout and stdin belong exclusively to the MCP protocol. Never use a shell.
  const child = spawn(entry.command, args, {
    env, stdio: 'inherit', shell: false, windowsHide: true,
  });
  const stop = signal => {if (!child.killed) child.kill(signal);};
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  child.once('error', error => {
    process.stderr.write('Revision Request plugin: Could not start the configured runtime: ' + error.message + '\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {process.exitCode = code ?? (signal ? 1 : 0);});
}
module.exports = {readPluginMetadata};
if (require.main === module) void main().catch(error => {process.stderr.write('Revision Request plugin: ' + error.message + '\n'); process.exitCode = 1;});
