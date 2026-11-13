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
  async showQuickPick(items,options){current.quickDialogs.push({items,options});const chosen=current.quickPicks.length?await current.quickPicks.shift():items[0];return typeof chosen==='number'?items[chosen]:typeof chosen==='string'?items.find(item=>item.mode===chosen):chosen;},
  async showOpenDialog(options){current.dialogs.push(options);assert.ok(current.picks.length,'Unexpected native picker');return await current.picks.shift();},
}};
const originalLoad=Module._load;
Module._load=function(name,parent,main){return name==='vscode'?vscode:originalLoad.call(this,name,parent,main);};
require('tsx/cjs');
let showCreateRequestView,createRequestViewHtml,createRequestFromSelection,createRequestFromFiles,resolveRequest;
try{({showCreateRequestView,createRequestViewHtml}=require('../src/createRequestView.ts'));({createRequestFromSelection,createRequestFromFiles}=require('../src/createRequestCommand.ts'));({resolveRequest}=require('../src/request.ts'));}
finally{Module._load=originalLoad;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
before(async()=>{assert.match(await fs.readFile(path.join(root,'.gitignore'),'utf8'),/(^|\n)\.codex-\*\//);await fs.mkdir(path.join(root,'.codex-test'),{recursive:true});scratch=await fs.mkdtemp(path.join(root,'.codex-test','create-view-'));console.log('Create-view fixtures: '+scratch);});
beforeEach(async()=>{const caseRoot=path.join(scratch,'case-'+(++serial));current={workspace:path.join(caseRoot,'workspace'),outside:path.join(caseRoot,'outside'),panels:[],dialogs:[],picks:[],quickPicks:[],quickDialogs:[],createCalls:[]};await Promise.all([fs.mkdir(current.workspace,{recursive:true}),fs.mkdir(current.outside,{recursive:true})]);vscode.workspace.isTrusted=true;vscode.workspace.textDocuments=[];});
async function fixture(){const original=Uri.file(path.join(current.workspace,'원고 & original.tex')),proposed=Uri.file(path.join(current.outside,'modified.tex'));const before='PRIVATE ORIGINAL marker\r\nLet x > 0.\r\n',after='PRIVATE PROPOSED marker\r\nLet x >= 0.\r\n';await Promise.all([fs.writeFile(original.fsPath,before),fs.writeFile(proposed.fsPath,after)]);return {original,proposed,before,after,output:Uri.file(original.fsPath+'.rr')};}
async function unchanged(item){assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.before);assert.equal(await fs.readFile(item.proposed.fsPath,'utf8'),item.after);}
async function absent(item){await assert.rejects(fs.lstat(item.output.fsPath),{code:'ENOENT'});}
async function open(t,create=async(original,proposed,isCancelled,gitOriginal)=>createRequestFromSelection(original,proposed,action=>action(),isCancelled,gitOriginal)){
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

const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
async function git(...args){
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  for(const key of Object.keys(env))if(key.startsWith('GIT_')&&!['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'].includes(key))delete env[key];
  return (await execFile('git',args,{cwd:current.workspace,env,windowsHide:true})).stdout.trim();
}
async function gitFixture(){
  const item=await fixture();
  await git('init','--quiet');await git('config','core.autocrlf','false');
  await git('add','--',path.basename(item.original.fsPath));await git('commit','--quiet','-m','Original baseline');
  const commit=await git('rev-parse','HEAD');
  await fs.writeFile(item.original.fsPath,item.after);
  return {...item,commit};
}
async function chooseGit(panel,item){
  current.quickPicks.push('git',0);current.picks.push([item.original]);await send(panel,'selectOriginal');
}
test('Git original shows commit metadata and defaults the modified copy to the current saved target',async t=>{
  const item=await gitFixture(),{panel,result}=await open(t);
  const beforeGit=await git('status','--porcelain=v1'),head=await git('rev-parse','HEAD');
  await chooseGit(panel,item);
  assert.equal(state(panel).original,item.original.fsPath);
  assert.equal(state(panel).proposed,item.original.fsPath);
  assert.equal(state(panel).originalMode,'git');assert.ok(state(panel).originalRevision.includes(item.commit.slice(0,8)));
  assert.ok(state(panel).originalRevision.includes('Original baseline'));
  assert.equal(current.quickDialogs.length,2);
  assert.deepEqual(current.quickDialogs[0].items.map(item=>item.label),['Workspace file','Git commit']);
  assert.ok(current.quickDialogs[1].items[0].description.includes(item.commit.slice(0,8)));
  await send(panel,'create');
  assert.equal((await result).toString(),item.output.toString());
  assert.equal(current.createCalls[0][3].commit,item.commit);
  const request=JSON.parse(await fs.readFile(item.output.fsPath,'utf8'));
  const after=resolveRequest(request,item.before).file.after;
  assert.equal(after,item.after);
  assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.after);
  assert.equal(await git('rev-parse','HEAD'),head);
  assert.ok((await git('status','--porcelain=v1')).includes(beforeGit));
});

test('cancelling original mode, file or commit preserves the complete Git selection',async t=>{
  const item=await gitFixture(),{panel}=await open(t);await chooseGit(panel,item);
  current.picks.push([item.proposed]);await send(panel,'selectProposed');
  const selected=state(panel);
  const unchangedState=()=>{for(const key of ['original','proposed','output','originalMode','originalRevision'])assert.equal(state(panel)[key],selected[key]);};
  current.quickPicks.push(undefined);await send(panel,'selectOriginal');unchangedState();
  current.quickPicks.push('git');current.picks.push(undefined);await send(panel,'selectOriginal');unchangedState();
  current.quickPicks.push('git',undefined);current.picks.push([item.original]);await send(panel,'selectOriginal');unchangedState();
  assert.equal(current.createCalls.length,0);await absent(item);
});

test('switching from Git to workspace clears only its automatic same-file modified choice',async t=>{
  const item=await gitFixture(),{panel}=await open(t);await chooseGit(panel,item);
  current.picks.push([item.original]);await send(panel,'selectOriginal');
  assert.equal(state(panel).originalMode,'workspace');assert.equal(state(panel).originalRevision,undefined);
  assert.equal(state(panel).proposed,undefined);
  await chooseGit(panel,item);current.picks.push([item.proposed]);await send(panel,'selectProposed');
  current.picks.push([item.original]);await send(panel,'selectOriginal');
  assert.equal(state(panel).proposed,item.proposed.fsPath,'An explicit separate modified file survives');
});

test('closing during a commit picker never updates the form or creates output',async t=>{
  const item=await gitFixture(),{panel,result}=await open(t),commitPick=deferred();
  current.quickPicks.push('git',commitPick.promise);current.picks.push([item.original]);
  const selecting=send(panel,'selectOriginal');
  for(let i=0;i<100&&current.quickDialogs.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(current.quickDialogs.length,2);
  await send(panel,'create');assert.equal(current.createCalls.length,0);
  panel.dispose();assert.equal(await result,undefined);const messages=panel.webview.messages.length;
  commitPick.resolve(0);await selecting;assert.equal(panel.webview.messages.length,messages);await absent(item);
});

test('Git creation rejects dirty current input without changing source or creating output',async t=>{
  const item=await gitFixture(),{panel}=await open(t);await chooseGit(panel,item);
  vscode.workspace.textDocuments=[{uri:item.original,isDirty:true}];
  await send(panel,'create');
  assert.match(state(panel).error,/unsaved|save/i);assert.equal(panel.disposed,false);
  assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.after);await absent(item);
});

test('the command reports Git creation metadata and repeated invocation only reveals its active form',async t=>{
  const item=await gitFixture(),remembered=[];
  const result=createRequestFromFiles(Uri.file(root),action=>action(),async(uri,original)=>{remembered.push({uri,original});});await tick();
  const panel=current.panels.at(-1);t.after(()=>panel.dispose());await send(panel,'ready');
  assert.equal(await createRequestFromFiles(Uri.file(root)),undefined);
  assert.equal(panel.reveals,1);assert.equal(current.panels.length,1);
  await chooseGit(panel,item);await send(panel,'create');
  const created=await result;
  assert.equal(created.uri.toString(),item.output.toString());assert.equal(created.fromGit,true);
  assert.equal(remembered.length,1);assert.equal(remembered[0].uri.toString(),created.uri.toString());assert.equal(remembered[0].original.commit,item.commit);
});

test('trust loss while the original mode picker is open prevents subsequent file or Git selection',async t=>{
  const item=await fixture(),{panel}=await open(t),modePick=deferred();
  current.quickPicks.push(modePick.promise);
  const selecting=send(panel,'selectOriginal');await tick();
  vscode.workspace.isTrusted=false;modePick.resolve('git');await selecting;
  assert.match(state(panel).error,/trust/i);assert.equal(current.dialogs.length,0);
  assert.equal(state(panel).original,undefined);await absent(item);
});

test('a Git lookup error leaves the prior workspace original and modified copy unchanged',async t=>{
  const item=await fixture(),{panel}=await open(t);await choose(panel,item);
  current.quickPicks.push('git');current.picks.push([item.original]);await send(panel,'selectOriginal');
  assert.ok(state(panel).error);assert.equal(state(panel).originalMode,'workspace');
  assert.equal(state(panel).original,item.original.fsPath);assert.equal(state(panel).proposed,item.proposed.fsPath);
  await absent(item);
});

test('Git creation remembers its pinned baseline before releasing the exclusive creation task',async t=>{
  const item=await gitFixture();let inExclusive=false,released=false,remembered=0;
  const {panel,result}=await open(t,(original,proposed,isCancelled,gitOriginal)=>createRequestFromSelection(
    original,proposed,async action=>{inExclusive=true;try{return await action();}finally{inExclusive=false;released=true;}},
    isCancelled,gitOriginal,async(uri,pinned)=>{
      assert.equal(inExclusive,true);assert.equal(released,false);
      assert.equal(uri.toString(),item.output.toString());assert.equal(pinned,gitOriginal);
      assert.equal(pinned.commit,item.commit);assert.ok(await fs.readFile(uri.fsPath,'utf8'));remembered++;
    }));
  await chooseGit(panel,item);await send(panel,'create');
  assert.equal((await result).toString(),item.output.toString());
  assert.equal(remembered,1);assert.equal(released,true);assert.equal(inExclusive,false);
});

test('Git baseline recording failure removes only its unchanged newly-created request',async t=>{
  const item=await gitFixture();
  const {panel}=await open(t,(original,proposed,isCancelled,gitOriginal)=>createRequestFromSelection(
    original,proposed,action=>action(),isCancelled,gitOriginal,async()=>{throw new Error('Injected baseline storage failure');}));
  await chooseGit(panel,item);await send(panel,'create');
  assert.equal(panel.disposed,false);assert.match(state(panel).error,/new \.rr file was removed/);
  assert.match(state(panel).error,/Injected baseline storage failure/);await absent(item);
  assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.after);
});

test('Git baseline recording failure preserves a request edited after creation',async t=>{
  const item=await gitFixture();
  const {panel}=await open(t,(original,proposed,isCancelled,gitOriginal)=>createRequestFromSelection(
    original,proposed,action=>action(),isCancelled,gitOriginal,async(uri)=>{
      await fs.writeFile(uri.fsPath,'USER EDITED REQUEST\n');throw new Error('Injected baseline storage failure');
    }));
  await chooseGit(panel,item);await send(panel,'create');
  assert.equal(panel.disposed,false);assert.match(state(panel).error,/already exists and was preserved/);
  assert.equal(await fs.readFile(item.output.fsPath,'utf8'),'USER EDITED REQUEST\n');
  assert.equal(await fs.readFile(item.original.fsPath,'utf8'),item.after);
});
