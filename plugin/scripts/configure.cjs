"use strict";
const fs = require('node:fs/promises');
const {parseArgs} = require('node:util');
const {MAX_CONFIG_BYTES, configurationPath, readConfiguration, saveConfiguration} = require('./connection.cjs');
async function readStdin() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_CONFIG_BYTES) throw new Error('The connection JSON exceeds 64 KiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function main() {
  const {values} = parseArgs({options: {
    from: {type: 'string'}, stdin: {type: 'boolean'}, config: {type: 'string'},
    replace: {type: 'boolean'}, check: {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
  }, strict: true, allowPositionals: false});
  if (values.help) {
    process.stdout.write('Configure the Revision Request plugin from VS Code Generic JSON.\n\n' +
      'node configure.cjs --from <json-file> [--config <absolute-path>] [--replace]\n' +
      'node configure.cjs --stdin [--config <absolute-path>] [--replace]\n' +
      'node configure.cjs --check [--config <absolute-path>]\n\n' +
      'Default: ~/.revision-request/mcp.json (or REVISION_REQUEST_MCP_CONFIG).\n' +
      'This saves connection settings only; it does not install the plugin or change AI client settings.\n');
    return;
  }
  const filename = configurationPath(values.config);
  if (values.check) {
    if (values.from || values.stdin || values.replace) throw new Error('--check cannot be combined with input or replacement options.');
    const entry = await readConfiguration(filename);
    process.stdout.write('Connection settings are valid for ' + entry.args[4] + '\nThis does not verify a live VS Code bridge; call rr_list_requests after reconnecting.\n');
    return;
  }
  if (Boolean(values.from) === Boolean(values.stdin)) throw new Error('Provide exactly one of --from <json-file> or --stdin.');
  let text;
  if (values.from) {
    const info = await fs.stat(values.from);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error('Use a regular Generic JSON file no larger than 64 KiB.');
    text = await fs.readFile(values.from, 'utf8');
  } else text = await readStdin();
  const entry = await saveConfiguration(text, filename, values.replace);
  process.stdout.write('Saved ' + filename + '\nWorkspace: ' + entry.args[4] + '\nReconnect the plugin MCP server, then use rr_list_requests to verify workspace access.\n');
}
if (require.main === module) void main().catch(error => {process.stderr.write('Revision Request setup: ' + error.message + '\n'); process.exitCode = 1;});
