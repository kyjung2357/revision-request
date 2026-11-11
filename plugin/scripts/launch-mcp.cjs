"use strict";
const {spawn} = require('node:child_process');
const {parseArgs} = require('node:util');
const {configurationPath, readConfiguration} = require('./connection.cjs');
async function main() {
  const {values} = parseArgs({options: {config: {type: 'string'}, help: {type: 'boolean', short: 'h'}}, strict: true, allowPositionals: false});
  if (values.help) {
    process.stderr.write('Revision Request plugin MCP launcher\nnode launch-mcp.cjs [--config <absolute-connection-json>]\nRun configure.cjs first using the Generic JSON copied from VS Code.\n');
    return;
  }
  const entry = await readConfiguration(configurationPath(values.config));
  // stdout and stdin belong exclusively to the MCP protocol. Never use a shell.
  const child = spawn(entry.command, entry.args, {
    env: {...process.env, ...entry.env}, stdio: 'inherit', shell: false, windowsHide: true,
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
if (require.main === module) void main().catch(error => {process.stderr.write('Revision Request plugin: ' + error.message + '\n'); process.exitCode = 1;});
