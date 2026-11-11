'use strict';
// Exercise the source MCP server and schemas without building a stdio bundle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
const {AjvJsonSchemaValidator} = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const previousMarkdown = require.extensions['.md'];
require.extensions['.md'] = (module, filename) => {module.exports = fs.readFileSync(filename, 'utf8');};
require('tsx/cjs');
let createMcpServer;
try {({createMcpServer} = require('../src/mcpServer.ts'));}
finally {
  if (previousMarkdown) require.extensions['.md'] = previousMarkdown;
  else delete require.extensions['.md'];
}
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/revision-request.schema.json'), 'utf8'));
const validate = new AjvJsonSchemaValidator().getValidator(schema);
const request = entry => ({path: 'source.py', request: [{line: 2, status: 'pending', ...entry}]});

test('saved request schema accepts LF blocks, optional reasons, and multiline insertion/deletion', () => {
  for (const entry of [
    {before: 'old\nline', after: 'new\nblock'},
    {before: null, after: 'first\nsecond', reason: ''},
    {before: 'first\nsecond', after: null},
    {before: 'old\n', after: 'new'},
  ]) assert.equal(validate(request(entry)).valid, true);
  for (const value of ['old\rline', 'old\r\nline', 'old\r']) {
    assert.equal(validate(request({before: value, after: 'new'})).valid, false);
    assert.equal(validate(request({before: 'old', after: value})).valid, false);
  }
  assert.equal(validate(request({before: null, after: null})).valid, false);
  assert.equal(validate(request({before: 'old', after: 'new', reason: null})).valid, false);
});

async function connected(t) {
  const calls = [];
  const server = createMcpServer({call: async (method, args) => {
    if (method === 'capabilities') return {allowAgentDecisions: false};
    calls.push({method, args}); return {status: 'pending', input: args};
  }});
  const client = new Client({name: 'rr-source-schema-test', version: '1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {await client.close(); await server.close();});
  return {client, calls};
}

test('MCP forwards each LF block as one entry without inventing a reason and rejects CR before dispatch', async t => {
  const {client, calls} = await connected(t);
  const base = {path: 'source.py', expectedHash: 'a'.repeat(64), clientRequestId: 'multiline-fixture'};
  for (const entry of [
    {line: 2, before: 'old\nline', after: 'new\nblock'},
    {line: 2, before: null, after: 'first\nsecond', reason: ''},
    {line: 2, before: 'first\nsecond', after: null},
  ]) {
    const result = await client.callTool({name: 'rr_create_request', arguments: {...base, request: [entry]}});
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls.at(-1), {method: 'create_request', args: {...base, request: [entry]}});
  }
  assert.equal(calls.length, 3);
  for (const entry of [
    {line: 2, before: 'old\rline', after: 'new'},
    {line: 2, before: 'old', after: 'new\r\nblock'},
    {line: 2, before: null, after: null},
    {line: 2, before: 'old', after: 'new', status: 'pending'},
  ]) assert.equal((await client.callTool({name: 'rr_create_request', arguments: {...base, request: [entry]}})).isError, true);
  assert.equal(calls.length, 3, 'Invalid entries never reach the workspace host');
});

test('format tool and schema resource publish the same multiline contract', async t => {
  const {client} = await connected(t);
  const result = await client.callTool({name: 'rr_get_format', arguments: {}});
  assert.notEqual(result.isError, true);
  const format = result.structuredContent;
  assert.match(format.guide, /Group related changes on consecutive lines/);
  assert.match(format.guide, /CR.*rejected/);
  assert.match(format.guide, /Omit it or use/);
  assert.ok(format.example.request[0].before.includes('\n'));
  assert.equal(Object.hasOwn(format.example.request[0], 'reason'), false);
  const resource = await client.readResource({uri: 'rr://schema'});
  assert.deepEqual(JSON.parse(resource.contents[0].text), schema);
  assert.deepEqual(format.schema, schema);
  assert.equal(validate(format.example).valid, true);
});
