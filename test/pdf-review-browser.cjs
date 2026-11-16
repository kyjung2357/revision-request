/* Real Chromium test of the dedicated RR PDF viewer and disk-backed autosave. */
'use strict';
require('tsx/cjs');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),Module=require('node:module');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{PDFDocument,StandardFonts}=require('pdf-lib');
const {proposalIdentity}=require('../src/request.ts'),{createPortableReviewPdf,readPortableReviewPdf}=require('../src/portableReviewPdf.ts');
const {ReviewPdfDocumentStore}=require('../src/reviewPdfDocument.ts');
const originalLoad=Module._load;
Module._load=function(name,...args){if(name==='vscode')return{Uri:{joinPath:(base,...parts)=>({toString:()=>base.toString()+'/'+parts.join('/')})}};return originalLoad.call(this,name,...args);};
const {createReviewPdfViewHtml}=require('../src/reviewPdfView.ts');Module._load=originalLoad;
const root=path.resolve(__dirname,'..'),runDir=path.join(root,'.codex-pdf-viewer',new Date().toISOString().replace(/[:.]/g,'-'));
const filename=path.join(runDir,'sample.tex.rr.pdf'),store=new ReviewPdfDocumentStore(),pause=ms=>new Promise(r=>setTimeout(r,ms));
let browser,server,cdp,origin,log='',saveMessages=[],results=[],failSave=false,readOnly=false;
class Devtools{
 constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});}
 static async connect(url){const socket=new WebSocket(url);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});return new Devtools(socket);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),20000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
async function fixture(){
 const request={path:'sample.tex',request:[{line:1,before:'old',after:'new',reason:'Use α ≤ β. <img src=x onerror=window.__xss=1>',status:'pending'},{line:2,before:'x',after:'y',status:'pending'},{line:3,before:null,after:'New paragraph.',reason:'Add the conclusion.',status:'pending'}]};
 const manifest={format:'revision-request-pdf',formatVersion:1,exportId:'viewer-test',createdAt:'2026-11-15T12:00:00Z',path:request.path,proposalIdentity:proposalIdentity(request),sourceHash:createHash('sha256').update('source').digest('hex'),request,entries:request.request.map((r,index)=>({id:'entry'+index,index,originalDecision:'pending',reason:r.reason}))};
 const pdf=await PDFDocument.create(),page=pdf.addPage([400,500]),font=await pdf.embedFont(StandardFonts.Helvetica);
 page.drawText('Revision Request PDF autosave',{x:30,y:465,size:16,font});
 for(let i=0;i<3;i++)page.drawText('Original and revised source line '+(i+1),{x:30,y:400-i*35,size:11,font});
 pdf.addPage([400,500]).drawText('Second page stays readable.',{x:30,y:440,size:12,font});
 return createPortableReviewPdf(await pdf.save(),manifest,manifest.entries.map((e,i)=>({entryId:e.id,page:0,x:30,y:400-i*35})));
}
async function snapshot(){const s=await store.load(filename);return{type:'pdfState',base64:Buffer.from(s.bytes).toString('base64'),...s.review,readOnly};}
async function message(m){
 if(m.type==='ready')return snapshot();
 if(m.type==='saveDecision'){
  saveMessages.push({...m,time:Date.now()});await pause(140);
  if(failSave)return{type:'pdfSaveError',sequence:m.sequence,error:'Test write failed. <img src=x onerror=window.__xss=2>'};
  const s=await store.saveDecision(filename,m.expectedPdfHash,m.entryId,m.decision,m.through===true);
  return{type:'pdfSaved',sequence:m.sequence,pdfHash:s.review.pdfHash,decisions:s.review.decisions};
 }
 return null;
}
async function startServer(){
 server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,origin||'http://127.0.0.1');let body,type='application/octet-stream';
  if(url.pathname==='/message'){
   let input='';for await(const chunk of req){input+=chunk;if(input.length>10000)throw Error('Too much input');}
   body=JSON.stringify(await message(JSON.parse(input)));type='application/json';
  }else if(url.pathname==='/'){
   const html=createReviewPdfViewHtml({cspSource:origin,asWebviewUri:uri=>uri},{toString:()=>origin,fsPath:root});
   const nonce=html.match(/nonce="([^"]+)"/)[1];
   const boot="window.__messages=[];window.__xss=0;window.acquireVsCodeApi=()=>({postMessage:m=>{window.__messages.push(m);fetch('/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)}).then(r=>r.json()).then(v=>{if(v)window.dispatchEvent(new MessageEvent('message',{data:v}));}).catch(e=>{window.__bridgeError=e.message;});}});";
   body=html.replace('<script nonce=', '<script nonce="'+nonce+'">'+boot+'</script><script nonce=');type='text/html';
  }else{
   const sub=decodeURIComponent(url.pathname).slice(1);if(sub.split('/').includes('..'))throw Error('Traversal');
   let file=path.join(root,sub);
   if(/^(?:dist|\.codex-build)\/pdfjs\//.test(sub)){const tail=sub.replace(/^(?:dist|\.codex-build)\/pdfjs\//,'');file=path.join(root,'node_modules/pdfjs-dist',tail==='pdf.mjs'||tail==='pdf.worker.mjs'?'legacy/build/'+tail:tail);}
   body=await fs.readFile(file);type=/\.m?js$/.test(sub)?'text/javascript':sub.endsWith('.css')?'text/css':sub.endsWith('.wasm')?'application/wasm':'application/octet-stream';
  }
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'pdfError',error:error.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
}
async function poll(expression,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await cdp.eval(expression))return;await pause(60);}throw Error('Timed out: '+expression+'\n'+await cdp.eval('document.body.innerText'));}
async function startBrowser(){
 let executable;for(const p of [process.env.RR_BROWSER_EXECUTABLE,path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),'/usr/bin/chromium'].filter(Boolean)){try{await fs.access(p);executable=p;break;}catch{}}
 if(!executable)throw Error('Installed Chromium browser required');
 const profile=path.join(runDir,'profile');await fs.mkdir(profile,{recursive:true});
 browser=spawn(executable,['--headless=new','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','--proxy-server='+origin,'--proxy-bypass-list=localhost;127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const s of[browser.stdout,browser.stderr])s.on('data',b=>log=(log+b).slice(-18000));
 let port;for(let i=0;i<200&&!port;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);}catch{}if(!port)await pause(100);}
 if(!port)throw Error('Browser startup failed');
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');cdp=await Devtools.connect(target.webSocketDebuggerUrl);
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url:origin});await poll('document.querySelectorAll(".pdf-control[data-decision]").length===6');
}
async function click(selector){const r=await cdp.eval('(() => {const n=document.querySelector('+JSON.stringify(selector)+');n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});}
const control=(id,value)=>'.pdf-control[data-entry-id="'+id+'"][data-decision="'+value+'"]';
async function capture(name){const result=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(runDir,name+'.png'),Buffer.from(result.data,'base64'));}
async function saved(){await poll('document.getElementById("save-status").textContent==="Saved"');return(await store.load(filename)).review.decisions;}
async function main(){
 await fs.mkdir(runDir,{recursive:true});await fs.writeFile(filename,await fixture());await startServer();await startBrowser();
 assert.equal(await cdp.eval('typeof window.RRReviewMenu'),'undefined');assert.equal(await cdp.eval('window.__xss'),0);
 await capture('initial');results.push('Production PDF.js renders PDF pages and bounded RR controls without executing embedded scripts.');
 await click(control('entry0','accepted'));assert.equal(await cdp.eval('document.getElementById("save-status").textContent'),'Saving…');
 assert.equal((await saved()).entry0,'accepted');results.push('Actual Accept pointer click automatically saves canonical PDF fields on disk.');
 await cdp.eval('document.querySelector('+JSON.stringify(control('entry0','ignored'))+').click();document.querySelector('+JSON.stringify(control('entry1','accepted'))+').click();document.querySelector('+JSON.stringify(control('entry2','ignored'))+').click();window.dispatchEvent(new MessageEvent("message",{data:{type:"flush",requestId:"import-waits"}}));');
 await saved();await poll('window.__messages.some(m=>m.type==="flushed"&&m.requestId==="import-waits"&&m.ok)');
 assert.deepEqual((await store.load(filename)).review.decisions,{entry0:'ignored',entry1:'accepted',entry2:'ignored'});
 assert.equal(new Set(saveMessages.map(m=>m.expectedPdfHash)).size,saveMessages.length);results.push('Rapid choices serialize with fresh acknowledged hashes; Import flush waits for every disk write.');
 await capture('saved');await cdp.send('Page.reload',{ignoreCache:true});await poll('document.querySelectorAll(".pdf-control[data-decision]").length===6');
 assert.equal(await cdp.eval('document.querySelector('+JSON.stringify(control('entry0','ignored'))+').getAttribute("aria-pressed")'),'true');results.push('Reopened PDF restores the persisted review decisions.');
 await click('.more-control[data-entry-id="entry0"]');await click('.review-menu button:first-child');assert.match(await cdp.eval('document.getElementById("explanation-text").textContent'),/α ≤ β/);assert.equal(await cdp.eval('document.querySelector("#explanation img")'),null);await capture('why');
 await cdp.eval('document.getElementById("close-explanation").click()');
 await click(control('entry0','ignored'));assert.equal((await saved()).entry0,'pending');
 await click('.more-control[data-entry-id="entry1"]');await click('.review-menu button:last-child');assert.deepEqual(await saved(),{entry0:'accepted',entry1:'accepted',entry2:'ignored'});results.push('Selected choice can reset to pending; Why and Accept up to here work without PDF JavaScript.');
 failSave=true;await click(control('entry0','ignored'));await poll('document.getElementById("save-status").textContent==="Not saved"');
 assert.equal((await store.load(filename)).review.decisions.entry0,'accepted');assert.equal(await cdp.eval('document.querySelector("#error-bar img")'),null);
 await cdp.eval('window.dispatchEvent(new MessageEvent("message",{data:{type:"flush",requestId:"failed-import"}}))');
 await poll('window.__messages.some(m=>m.type==="flushed"&&m.requestId==="failed-import"&&!m.ok)');await capture('failed');
 failSave=false;await click('#retry-save');assert.equal((await saved()).entry0,'ignored');results.push('Failed save keeps the unsaved choice visibly marked, blocks Import flush, and supports retry.');
 const externalState=await snapshot(),beforeConflict=saveMessages.length;
 await cdp.eval('document.querySelector('+JSON.stringify(control('entry0','accepted'))+').click();document.querySelector('+JSON.stringify(control('entry1','ignored'))+').click();window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(externalState)+'}));');
 await pause(500);await poll('document.getElementById("save-status").textContent==="Not saved"');
 assert.equal(saveMessages.length,beforeConflict+1);assert.equal(await cdp.eval('document.querySelector('+JSON.stringify(control('entry1','ignored'))+').getAttribute("aria-pressed")'),'true');
 await cdp.eval('window.dispatchEvent(new MessageEvent("message",{data:{type:"flush",requestId:"external-import"}}))');
 await poll('window.__messages.some(m=>m.type==="flushed"&&m.requestId==="external-import"&&!m.ok)');
 assert.equal(await cdp.eval('document.getElementById("retry-save").hidden'),true);
 assert.equal((await store.load(filename)).review.decisions.entry1,'accepted');await capture('external-change');
 await click('#reload-pdf');await saved();await poll('document.querySelectorAll(".pdf-control[data-decision]").length===6');
 assert.equal(await cdp.eval('document.querySelector('+JSON.stringify(control('entry1','accepted'))+').getAttribute("aria-pressed")'),'true');
 results.push('External reload during queued saves preserves unsaved choices on screen, blocks further saves and Import, and requires explicit reload.');
 await click('#next-page');await poll('document.getElementById("page-number").value==="2"');await click('#zoom-in');await pause(180);await capture('second-page');results.push('Page navigation and zoom render additional pages.');
 readOnly=true;await cdp.send('Page.reload',{ignoreCache:true});await poll('document.querySelectorAll(".pdf-control[data-decision]").length===6');assert.equal(await cdp.eval('[...document.querySelectorAll(".pdf-control[data-decision]")].every(n=>n.disabled)'),true);results.push('Untrusted-workspace view disables PDF decision mutation.');
 console.log(JSON.stringify({passed:true,runDir,results},null,2));
}
(async()=>{try{await main();}catch(error){console.error(error.stack);try{console.error(await cdp?.eval('({body:document.body.innerText,bridge:window.__bridgeError})'));if(cdp)await capture('failure');}catch{}process.exitCode=1;}finally{if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.socket.close();}if(browser&&browser.exitCode===null)browser.kill();if(server)server.close();await fs.writeFile(path.join(runDir,'results.json'),JSON.stringify({results,log},null,2)).catch(()=>{});}})();
