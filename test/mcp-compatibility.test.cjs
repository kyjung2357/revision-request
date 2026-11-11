'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {test} = require('node:test');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
require('tsx/cjs');
const {CURRENT_COMPATIBILITY, compatibilityWarnings, pluginFromEnvironment} = require('../src/mcpCompatibility.ts');
const {McpBridgeError} = require('../src/mcpTypes.ts');
const previous = require.extensions['.md'];
require.extensions['.md'] = (module, name) => { module.exports = fs.readFileSync(name, 'utf8'); };
let createMcpServer, diagnoseMcpConnection;
try { ({createMcpServer, diagnoseMcpConnection} = require('../src/mcpServer.ts')); }
finally { if (previous) require.extensions['.md'] = previous; else delete require.extensions['.md']; }
const plugin = {...CURRENT_COMPATIBILITY};
const caps = {extensionVersion: CURRENT_COMPATIBILITY.version, features: CURRENT_COMPATIBILITY.features,
  formatGuideSha256: CURRENT_COMPATIBILITY.formatGuideSha256, workspaceUri:'file:///test', allowAgentDecisions:false};

test('compatibility distinguishes matching releases, older features, and same-version stale guides', () => {
  assert.deepEqual(compatibilityWarnings(CURRENT_COMPATIBILITY), []);
  assert.match(compatibilityWarnings({version:'0.1.2',features:[]}).join(' '), /versions differ/);
  assert.match(compatibilityWarnings({version:'0.1.2',features:[]}).join(' '), /multiline-blocks/);
  assert.match(compatibilityWarnings({...CURRENT_COMPATIBILITY,formatGuideSha256:'0'.repeat(64)}).join(' '), /guides differ/);
  assert.match(compatibilityWarnings({}).join(' '), /not reported/);
  assert.deepEqual(pluginFromEnvironment(JSON.stringify(plugin)), plugin);
  for (const raw of ['{}','[]','bad',JSON.stringify({...plugin,version:'secret\nvalue'}),JSON.stringify({...plugin,features:['<html>']})]) {
    assert.equal(pluginFromEnvironment(raw), undefined);
  }
});

test('offline diagnostics returns actionable status without leaking raw errors or mutating files', async () => {
  let calls = 0;
  const report = await diagnoseMcpConnection({call:async method => {calls++; assert.equal(method,'capabilities'); throw new Error('credential-secret');}}, {workspaceUri:'file:///test',plugin});
  assert.equal(calls,1); assert.equal(report.bridge.status,'unavailable');
  assert.ok(report.nextSteps.length); assert.ok(!JSON.stringify(report).includes('credential-secret'));
  assert.match(report.clientToolExposure,/Not checked/);
});

test('real MCP discovery reports observed client metadata and exposes diagnosis without decision tools', async t => {
  const reports = [];
  const bridge = {call:async (method,args) => {
    if (method === 'capabilities') return caps;
    if (method === 'client_status') {reports.push(args); return {recorded:true};}
    throw new Error('Unexpected mutation ' + method);
  }};
  const server = createMcpServer(bridge,{workspaceUri:'file:///test',plugin});
  const client = new Client({name:'diagnostic-client',version:'1.0.0'});
  const [left,right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right),client.connect(left)]);
  t.after(async()=>{await client.close();await server.close();});
  const tools = (await client.listTools()).tools.map(item=>item.name);
  assert.ok(tools.includes('rr_diagnose')); assert.ok(!tools.includes('rr_decide'));
  for (let i=0;i<50 && !reports.some(item=>item.stage==='tools_listed');i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(reports.some(item=>item.stage==='tools_listed' && item.name==='diagnostic-client' && item.plugin.version===plugin.version));
  const result = await client.callTool({name:'rr_diagnose',arguments:{}});
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.bridge.status,'connected');
  assert.deepEqual(result.structuredContent.warnings,[]);
  assert.match(result.structuredContent.clientToolExposure,/successfully called/);
  const format = (await client.callTool({name:'rr_get_format',arguments:{}})).structuredContent;
  assert.deepEqual(format.compatibility.adapter,CURRENT_COMPATIBILITY);
  assert.equal(Object.hasOwn(format.example,'version'),false);
});

test('explicit lack of multiline support blocks creation before the host writes', async t => {
  let creates=0;
  const bridge={call:async(method)=>{
    if(method==='capabilities')return {...caps,features:[]};
    if(method==='client_status')return {recorded:true};
    if(method==='create_request'){creates++;return {status:'pending'};}
    throw new McpBridgeError('UNKNOWN_METHOD','unknown');
  }};
  const server=createMcpServer(bridge,{plugin});
  const client=new Client({name:'feature-test',version:'1.0.0'});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right),client.connect(left)]);
  t.after(async()=>{await client.close();await server.close();});
  const result=await client.callTool({name:'rr_create_request',arguments:{path:'test.txt',expectedHash:'a'.repeat(64),clientRequestId:'one',request:[{line:1,before:null,after:'a\nb'}]}});
  assert.equal(result.isError,true); assert.equal(creates,0);
  assert.match(result.content[0].text,/UNSUPPORTED_FEATURE/);
});


test('a stuck observation cannot delay a successful proposal response', async t => {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const bridge = {call:async(method)=>{
    if(method==='capabilities')return caps;
    if(method==='client_status')return stalled;
    if(method==='create_request')return {status:'pending'};
    throw new Error('Unexpected call');
  }};
  const server=createMcpServer(bridge,{plugin});
  const client=new Client({name:'slow-observation',version:'1.0.0'});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right),client.connect(left)]);
  t.after(async()=>{release({recorded:true});await client.close();await server.close();});
  const result=await Promise.race([
    client.callTool({name:'rr_create_request',arguments:{path:'test.txt',expectedHash:'a'.repeat(64),clientRequestId:'one',request:[{line:1,before:'old',after:'new'}]}}),
    new Promise(resolve=>{ const timer=setTimeout(()=>resolve('timed out'),500);timer.unref(); }),
  ]);
  assert.notEqual(result,'timed out');
  assert.equal(result.structuredContent.status,'pending');
});
