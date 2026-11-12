"use strict";
// Real create-form lifecycle and saved-file creation; only VS Code UI APIs are mocked.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fileURLToPath,pathToFileURL}=require('node:url');
const Module=require('node:module');
const {test,before,beforeEach}=require('node:test');
const root=path.resolve(__dirname,'..');
let scratch,current,serial=0;
class Uri {
  constructor(value){this.value=new URL(value);this.scheme=this.value.protocol.slice(0,-1);this.path=decodeURIComponent(this.value.pathname);this.fsPath=this.scheme==='file'?fileURLToPath(this.value):this.path;}
  toString(){return this.value.href;}
  static file(value){return new Uri(pathToFileURL(path.resolve(value)).href);}
  static parse(value){return new Uri(value);}
  static joinPath(uri,...parts){return Uri.file(path.join(uri.fsPath,...parts));}
}
class Emitter {
  listeners=new Set();
  event=listener=>{this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};
  async fire(value){await Promise.all([...this.listeners].map(listener=>listener(value)));}
}
class Panel {
  disposed=false;reveals=0;received=new Emitter();closed=new Emitter();
  onDidDispose=this.closed.event;
  webview={html:'',options:{},cspSource:'vscode-webview:',messages:[],asWebviewUri:uri=>uri,
    onDidReceiveMessage:this.received.event,
    postMessage:async message=>{assert.equal(this.disposed,false,'A closed form must not receive late messages');this.webview.messages.push(structuredClone(message));return true;}};
  reveal(){assert.equal(this.disposed,false);this.reveals++;}
  dispose(){if(!this.disposed){this.disposed=true;void this.closed.fire();}}
}
const contains=(folder,target)=>{const relative=path.relative(folder,target);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};
const vscode={Uri,ViewColumn:{Active:-1},workspace:{
  isTrusted:true,textDocuments:[],
  get workspaceFolders(){return [{uri:Uri.file(current.workspace),name:'Fixture'}];},
  getWorkspaceFolder(uri){return uri.scheme==='file'&&contains(current.workspace,uri.fsPath)?{uri:Uri.file(current.workspace)}:undefined;},
},window:{
  createWebviewPanel(type,title,column,options){const panel=new Panel();Object.assign(panel,{type,title,column});panel.webview.options=options;current.panels.push(panel);return panel;},
  async showOpenDialog(options){current.dialogs.push(options);assert.ok(current.picks.length,'Unexpected native picker');return await current.picks.shift();},
}};
const originalLoad=Module._load;
Module._load=function(name,parent,main){return name==='vscode'?vscode:originalLoad.call(this,name,parent,main);};
require('tsx/cjs');
let showCreateRequestView,createRequestViewHtml,createRequestFromSelection,resolveRequest;
try{({showCreateRequestView,createRequestViewHtml}=require('../src/createRequestView.ts'));({createRequestFromSelection}=require('../src/createRequestCommand.ts'));({resolveRequest}=require('../src/request.ts'));}
finally{Module._load=originalLoad;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
before(async()=>{assert.match(await fs.readFile(path.join(root,'.gitignore'),'utf8'),/(^|\n)\.codex-\*\//);await fs.mkdir(path.join(root,'.codex-test'),{recursive:true});scratch=await fs.mkdtemp(path.join(root,'.codex-test','create-view-'));console.log('Create-view fixtures: '+scratch);});
beforeEach(async()=>{const caseRoot=path.join(scratch,'case-'+(++serial));current={workspace:path.join(caseRoot,'workspace'),outside:path.join(caseRoot,'outside'),panels:[],dialogs:[],picks:[],createCalls:[]};await Promise.all([fs.mkdir(current.workspace,{recursive:true}),fs.mkdir(current.outside,{recursive:true})]);vscode.workspace.isTrusted=true;vscode.workspace.textDocuments=[];});
async function fixture(){const original=Uri.file(path.join(current.workspace,'원고 & original.tex')),proposed=Uri.file(path.join(current.outside,'modified.tex'));const before='PRIVATE ORIGINAL marker\r\nLet x > 0.\r\n',after='PRIVATE PROPOSED marker\r\nLet x >= 0.\r\n';await Promise.all([fs.writeFile(original.fsPath,before),fs.writeFile(proposed.fsPath,after)]);return {original,proposed,before,after,output:Uri.file(original.fsPath+'.rr')};}
async function unchanged(item){assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.before);assert.equal(await fs.readFile(item.proposed.fsPath,'utf8'),item.after);}
async function absent(item){await assert.rejects(fs.lstat(item.output.fsPath),{code:'ENOENT'});}
async function open(t,create=async(original,proposed,isCancelled)=>createRequestFromSelection(original,proposed,action=>action(),isCancelled)){
  const options={extensionUri:Uri.file(root),defaultUri:Uri.file(current.workspace),create:async(...args)=>{current.createCalls.push(args);return create(...args);}};
  const result=showCreateRequestView(options),panel=current.panels.at(-1);t.after(()=>panel.dispose());await send(panel,'ready');return {options,panel,result};
}
async function send(panel,command){await panel.received.fire(typeof command==='string'?{command}:command);await tick();}
const state=panel=>panel.webview.messages.at(-1);
async function choose(panel,item){current.picks.push([item.original],[item.proposed]);await send(panel,'selectOriginal');await send(panel,'selectProposed');}

test('Opening explains the workflow and waits for explicit selections without any native picker or write',async t=>{
  const item=await fixture(),{panel,result}=await open(t);
  assert.equal(current.dialogs.length,0);assert.equal(current.createCalls.length,0);
  for(const id of ['original-path','proposed-path','output-path','error-message','select-original','select-proposed','create-request','cancel'])assert.ok(panel.webview.html.includes('id="'+id+'"'));
  assert.match(panel.webview.html,/Both input files stay unchanged/);assert.match(panel.webview.html,/default-src 'none'/);
  assert.equal(panel.webview.options.enableScripts,true);assert.deepEqual(panel.webview.options.localResourceRoots.map(uri=>uri.fsPath),[path.join(root,'media')]);
  assert.equal(state(panel).original,undefined);assert.equal(state(panel).proposed,undefined);assert.equal(state(panel).busy,false);
  await send(panel,'cancel');assert.equal(await result,undefined);assert.equal(panel.disposed,true);await absent(item);await unchanged(item);
});
test('Selected paths and the output location are retained when either picker is cancelled',async t=>{
  const item=await fixture(),{panel,result}=await open(t);await choose(panel,item);
  const selected=state(panel);assert.equal(selected.original,item.original.fsPath);assert.equal(selected.proposed,item.proposed.fsPath);assert.equal(selected.output,item.output.fsPath);
  for(const command of ['selectOriginal','selectProposed']){current.picks.push(undefined);await send(panel,command);assert.equal(state(panel).original,selected.original);assert.equal(state(panel).proposed,selected.proposed);assert.equal(state(panel).selecting,false);}
  assert.ok(current.dialogs.every(dialog=>dialog.canSelectMany===false&&dialog.canSelectFiles===true&&dialog.canSelectFolders===false));
  assert.equal(current.createCalls.length,0);await absent(item);await unchanged(item);await send(panel,'cancel');assert.equal(await result,undefined);
});
test('Create ignores webview-supplied paths and cannot run before both native selections',async t=>{
  const item=await fixture(),{panel,result}=await open(t);
  await send(panel,{command:'create',original:item.original.fsPath,proposed:item.proposed.fsPath});
  current.picks.push([item.original]);await send(panel,'selectOriginal');await send(panel,{command:'create',proposed:item.proposed.toString()});
  assert.equal(current.createCalls.length,0);assert.equal(state(panel).proposed,undefined);await absent(item);await unchanged(item);panel.dispose();assert.equal(await result,undefined);
});
test('Explicit Create uses the real saved-file helper once and leaves both inputs unchanged',async t=>{
  const item=await fixture();let exclusiveCalls=0;
  const {panel,result}=await open(t,(original,proposed,isCancelled)=>createRequestFromSelection(original,proposed,async action=>{exclusiveCalls++;return action();},isCancelled));
  await choose(panel,item);await absent(item);await send(panel,'create');const created=await result;
  assert.equal(created.toString(),item.output.toString());assert.equal(panel.disposed,true);assert.equal(current.createCalls.length,1);assert.equal(exclusiveCalls,1);
  const request=JSON.parse(await fs.readFile(item.output.fsPath,'utf8'));assert.ok(request.request.every(entry=>entry.status==='pending'));
  assert.equal(resolveRequest(request,item.before).file.after,item.after);await unchanged(item);
  const messages=JSON.stringify(panel.webview.messages);assert.ok(!messages.includes('PRIVATE ORIGINAL')&&!messages.includes('PRIVATE PROPOSED'),'Only file paths and UI state are sent to the webview');
});
test('A creation error stays inline with both selections and allows an explicit retry',async t=>{
  const item=await fixture();let attempts=0;
  const {panel,result}=await open(t,(original,proposed,isCancelled)=>{if(++attempts===1)throw new Error('Cannot create <img src=x onerror=1>.');return createRequestFromSelection(original,proposed,action=>action(),isCancelled);});
  await choose(panel,item);await send(panel,'create');assert.equal(panel.disposed,false);assert.equal(state(panel).busy,false);assert.match(state(panel).error,/Cannot create/);assert.equal(state(panel).original,item.original.fsPath);assert.equal(state(panel).proposed,item.proposed.fsPath);await absent(item);await unchanged(item);
  await send(panel,'create');assert.equal((await result).toString(),item.output.toString());assert.equal(attempts,2);await unchanged(item);
});
test('Invalid local workspace or remote original selection shows an error without replacing a previous selection',async t=>{
  const item=await fixture(),{panel,result}=await open(t);await choose(panel,item);
  for(const selected of [item.proposed,Uri.parse('untitled:unsaved.tex')]){current.picks.push([selected]);await send(panel,'selectOriginal');assert.ok(state(panel).error);assert.equal(state(panel).original,item.original.fsPath);assert.equal(state(panel).proposed,item.proposed.fsPath);assert.equal(state(panel).selecting,false);}
  assert.equal(current.createCalls.length,0);await absent(item);await send(panel,'cancel');assert.equal(await result,undefined);
});
test('Opening again reveals the same form and returns its existing result',async t=>{
  const {options,panel,result}=await open(t);const again=showCreateRequestView({...options,create:async()=>assert.fail('A second command must not replace the active creation callback')});
  assert.equal(again,result);assert.equal(current.panels.length,1);assert.equal(panel.reveals,1);await send(panel,'cancel');assert.equal(await again,undefined);
  const reopened=await open(t);assert.equal(current.panels.length,2);await send(reopened.panel,'cancel');assert.equal(await reopened.result,undefined);
});
test('Closing during a pending picker ignores its later result and creates nothing',async t=>{
  const item=await fixture(),{panel,result}=await open(t),pick=deferred();current.picks.push(pick.promise);
  const selecting=send(panel,'selectOriginal');await tick();assert.equal(state(panel).selecting,true);
  await send(panel,'selectProposed');await send(panel,'create');assert.equal(current.dialogs.length,1);assert.equal(current.createCalls.length,0);
  panel.dispose();assert.equal(await result,undefined);const count=panel.webview.messages.length;pick.resolve([item.original]);await selecting;
  assert.equal(panel.webview.messages.length,count);await absent(item);await unchanged(item);
});
test('Closing while Create waits for the transaction queue cancels before any write and duplicate Create is ignored',async t=>{
  const item=await fixture(),gate=deferred();let exclusiveCalls=0;
  const {panel,result}=await open(t,(original,proposed,isCancelled)=>createRequestFromSelection(original,proposed,async action=>{exclusiveCalls++;await gate.promise;return action();},isCancelled));
  await choose(panel,item);const creating=send(panel,'create');await tick();assert.equal(state(panel).busy,true);
  await send(panel,'create');await send(panel,'selectOriginal');assert.equal(current.createCalls.length,1);assert.equal(exclusiveCalls,1);assert.equal(current.dialogs.length,2);
  panel.dispose();assert.equal(await result,undefined);gate.resolve();await creating;await absent(item);await unchanged(item);
});
test('HTML resource references are escaped and scoped to packaged media',()=>{
  const html=createRequestViewHtml({cspSource:'custom-webview:',asWebviewUri:uri=>({toString:()=>uri.toString()+'?token="<&'})},Uri.file(root));
  assert.match(html,/create-request\.css/);assert.match(html,/create-request\.js/);assert.ok(html.includes('&quot;&lt;&amp;'));
  assert.equal((html.match(/<script /g)||[]).length,1);assert.match(html,/script-src 'nonce-[A-Za-z0-9_-]+'/);
});
