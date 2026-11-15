/* Real PDF.js viewer interaction smoke test; no downloads or visible browser.
 * RR_PDFJS_EXTENSION must point to an installed LaTeX Workshop directory.
 * Run: node test/portableReviewPdf.browser.cjs
 */
'use strict';
require('tsx/cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {PDFDocument,StandardFonts} = require('pdf-lib');
const {proposalIdentity} = require('../src/request.ts');
const {createPortableReviewPdf,readPortableReviewPdf} = require('../src/portableReviewPdf.ts');
const root=path.resolve(__dirname,'..');
const runDir=path.join(root,'.codex-pdf-browser',new Date().toISOString().replace(/[:.]/g,'-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,server,cdp,pdfBytes,extension,log='',results=[];
class Devtools {
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.method==='Page.javascriptDialogOpening'){void this.send('Page.handleJavaScriptDialog',{accept:true});return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});return new Devtools(socket);}
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>reject(new Error('CDP timeout: '+method)),20000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
async function find(paths){for(const p of paths.filter(Boolean)){try{await fs.access(p);return p;}catch{}}throw new Error('Required installed runtime not found: '+paths.join(', '));}
async function fixture(){
 const request={path:'sample.tex',request:[
  {line:1,before:'old',after:'new',reason:'First explanation: α ≤ β',status:'pending'},
  {line:2,before:'x',after:'y',reason:'Second explanation.',status:'pending'},
  {line:3,before:null,after:'New paragraph.',status:'pending'}]};
 const manifest={format:'revision-request-pdf',formatVersion:1,exportId:'headless-test',createdAt:'2026-11-15T12:00:00Z',path:request.path,proposalIdentity:proposalIdentity(request),sourceHash:createHash('sha256').update('source').digest('hex'),request,entries:request.request.map((r,index)=>({id:'entry'+index,index,originalDecision:'pending',reason:r.reason}))};
 const pdf=await PDFDocument.create(),page=pdf.addPage([400,500]),font=await pdf.embedFont(StandardFonts.Helvetica);
 page.drawText('Portable review interaction test',{x:40,y:455,size:16,font});
 for(let i=0;i<3;i++)page.drawText('Sample source line '+(i+1),{x:40,y:400-i*12,size:12,font});
 return createPortableReviewPdf(await pdf.save(),manifest,manifest.entries.map((e,i)=>({entryId:e.id,page:0,x:40,y:400-i*12})));
}
const bootstrap=`document.addEventListener('webviewerloaded',()=>window.PDFViewerApplicationOptions.setAll({disablePreferences:true,enableScripting:false,annotationEditorMode:-1,defaultUrl:'/fixture.pdf',workerSrc:'/build/pdf.worker.mjs',cMapUrl:'/cmaps/',standardFontDataUrl:'/standard_fonts/',wasmUrl:'/wasm/'}));await import('/viewer.mjs');await window.PDFViewerApplication.initializedPromise;window.__ready=true;`;
async function startServer(){
 const original=await fs.readFile(path.join(extension,'viewer/viewer.html'),'utf8');
 const html=original.replace('out/viewer/latexworkshop.js','bootstrap.mjs');
 server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');let contents,type;
  if(url.pathname==='/'){contents=html;type='text/html';}
  else if(url.pathname==='/bootstrap.mjs'){contents=bootstrap;type='text/javascript';}
  else if(url.pathname==='/fixture.pdf'){contents=pdfBytes;type='application/pdf';}
  else{const sub=decodeURIComponent(url.pathname).slice(1),parts=sub.split('/');if(parts.includes('..'))throw Error('Traversal');
   let base=path.join(extension,'viewer'),relative=sub;
   if(parts[0]==='build'){base=path.join(extension,'node_modules/pdfjs-dist/legacy');}
   else if(['cmaps','standard_fonts','wasm','iccs'].includes(parts[0]))base=path.join(extension,'node_modules/pdfjs-dist');
   contents=await fs.readFile(path.join(base,relative));type=sub.endsWith('.mjs')?'text/javascript':sub.endsWith('.css')?'text/css':sub.endsWith('.json')?'application/json':sub.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
  }res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(contents);
 }catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
}
async function poll(expression,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await cdp.eval(expression))return;await wait(80);}throw Error('Timed out: '+expression);}
async function startBrowser(url){
 const executable=await find([process.env.RR_BROWSER_EXECUTABLE,path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),'/usr/bin/chromium']);
 const profile=path.join(runDir,'profile');await fs.mkdir(profile,{recursive:true});
 browser=spawn(executable,['--headless=new','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','--proxy-server='+url,'--proxy-bypass-list=localhost;127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const s of [browser.stdout,browser.stderr])s.on('data',b=>{log=(log+b).slice(-16000);});
 let port;for(let i=0;i<200&&!port;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);}catch{}if(!port)await wait(100);}
 if(!port)throw Error('Browser launch failed: '+log);
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');cdp=await Devtools.connect(target.webSocketDebuggerUrl);
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url:url+'/?file=/fixture.pdf'});await poll('window.__ready && window.PDFViewerApplication.pdfDocument && document.querySelectorAll(".annotationLayer input[type=radio]").length===6');
 await cdp.eval('PDFViewerApplication.pdfViewer.currentScale=1.5');await poll('document.querySelectorAll(".radioButton canvas").length===12');
}
async function state(){return cdp.eval(`(()=>{const rows=Array.from(document.querySelectorAll('.annotationLayer input[type=radio]')).map(el=>{const r=el.getBoundingClientRect(),section=el.parentElement;return {name:el.name,id:el.dataset.elementId,checked:el.checked,appearance:getComputedStyle(el).appearance,x:r.x,y:r.y,width:r.width,height:r.height,canvases:Array.from(section.querySelectorAll('canvas')).map(c=>{const pixel=Array.from(c.getContext('2d').getImageData(Math.min(4,c.width-1),Math.min(4,c.height-1),1,1).data);return {name:c.dataset.canvasName,display:getComputedStyle(c).display,pixel};})};});return {rows,scripting:PDFViewerApplicationOptions.get('enableScripting')};})()`);}
async function click(index){const s=await state(),r=s.rows[index];await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+r.width/2,y:r.y+r.height/2});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:r.x+r.width/2,y:r.y+r.height/2});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x+r.width/2,y:r.y+r.height/2});await wait(80);return state();}
async function capture(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(runDir,name+'.png'),Buffer.from(r.data,'base64'));}
async function save(name){const data=await cdp.eval(`(async()=>{const bytes=await PDFViewerApplication.pdfDocument.saveDocument();let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);})()`);const bytes=Buffer.from(data,'base64');await fs.writeFile(path.join(runDir,name+'.pdf'),bytes);return {bytes,imported:await readPortableReviewPdf(bytes)};}
async function main(){
 const extensions=path.join(process.env.USERPROFILE||'','/.vscode/extensions');
 extension=process.env.RR_PDFJS_EXTENSION||(await fs.readdir(extensions)).filter(n=>n.startsWith('james-yu.latex-workshop-')).sort().map(n=>path.join(extensions,n)).at(-1);
 if(!extension)throw Error('Install LaTeX Workshop or set RR_PDFJS_EXTENSION.');
 await fs.mkdir(runDir,{recursive:true});pdfBytes=await fixture();await fs.writeFile(path.join(runDir,'pending.pdf'),pdfBytes);const url=await startServer();await startBrowser(url);
 let s=await state();assert.equal(s.scripting,false);assert.equal(s.rows.length,6);assert.ok(s.rows.every(r=>r.appearance==='none'&&!r.checked&&r.canvases.length===2));
 results.push('PDF.js uses transparent native inputs and separate checked/unchecked canvases, with scripting disabled.');
 const notes=await cdp.eval('(async()=>{const p=await PDFViewerApplication.pdfDocument.getPage(1);return (await p.getAnnotations()).filter(a=>a.subtype==="Text").map(a=>({rect:a.rect,hasAppearance:a.hasAppearance,contents:a.contentsObj?.str}));})()');
 assert.equal(notes.length,2);for(const n of notes){assert.equal(n.rect[2]-n.rect[0],11);assert.equal(n.rect[3]-n.rect[1],11);assert.equal(n.hasAppearance,true);}assert.match(notes[0].contents,/α ≤ β/);results.push('Reason notes keep 11×11 points and Unicode explanations.');
 await wait(250);const note=await cdp.eval("(()=>{const r=document.querySelector('.textAnnotation').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...note});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...note});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...note});await poll("Array.from(document.querySelectorAll('.popupAnnotation')).some(p=>!p.hidden && p.innerText.includes('α ≤ β'))");await capture('explanation');results.push('Click opens the real Unicode reason popup without PDF JavaScript.');
 s=await click(0);assert.equal(s.rows[0].checked,true);assert.equal(s.rows[1].checked,false);assert.equal(s.rows[0].canvases.find(c=>c.name==='checked').display,'block');
 assert.deepEqual(s.rows[0].canvases.find(c=>c.name==='checked').pixel,[31,107,184,255]);const accepted=await save('accepted');assert.equal(accepted.imported.decisions.entry0,'accepted');await capture('accepted');
 s=await click(1);assert.equal(s.rows[0].checked,false);assert.equal(s.rows[1].checked,true);assert.equal(s.rows[1].canvases.find(c=>c.name==='checked').display,'block');
 assert.deepEqual(s.rows[1].canvases.find(c=>c.name==='checked').pixel,[97,102,110,255]);const ignored=await save('ignored');assert.equal(ignored.imported.decisions.entry0,'ignored');await capture('ignored');
 results.push('Actual pointer clicks Accepted → Ignored update appearances and canonical saved decisions.');
 // PDF.js does not support native radio off-toggling, unlike Acrobat. Record
 // the real click behavior; exercise its reset-form route separately.
 s=await click(1);assert.equal(s.rows[1].checked,true);results.push('PDF.js limitation: clicking the selected radio again keeps the choice; it does not clear.');
 await cdp.eval(`(()=>{for(const el of document.querySelectorAll('.annotationLayer input[type=radio]')){el.dispatchEvent(new Event('resetform'));PDFViewerApplication.pdfDocument.annotationStorage.setValue(el.dataset.elementId,{value:el.checked});}})()`);
 const cleared=await save('cleared');assert.deepEqual(cleared.imported.decisions,{entry0:'pending',entry1:'pending',entry2:'pending'});results.push('PDF.js reset-form path saves canonical pending values.');
 await cdp.eval('PDFViewerApplication.pdfDocument.annotationStorage.resetModified()');pdfBytes=ignored.bytes;await cdp.eval('window.__ready=false');await cdp.send('Page.reload',{ignoreCache:true});await poll('window.__ready && document.querySelectorAll(".annotationLayer input[type=radio]").length===6 && document.querySelectorAll(".radioButton canvas").length===12');
 s=await state();assert.equal(s.rows[0].checked,false);assert.equal(s.rows[1].checked,true);const reopened=await save('reopened');assert.equal(reopened.imported.decisions.entry0,'ignored');results.push('Saved ignored PDF reopens with matching state and can be imported again.');await capture('reopened');
 console.log(JSON.stringify({passed:true,extension,runDir,results},null,2));
}
(async()=>{try{await main();}catch(e){console.error(e.stack);try{if(cdp){console.error(await cdp.eval("({body:document.body?.innerText,inputs:document.querySelectorAll('input').length,layer:document.querySelector('.annotationLayer')?.outerHTML,ready:window.__ready,mode:PDFViewerApplicationOptions.get('annotationMode'),errors:window.__errors})"));await capture('failure');}}catch{}process.exitCode=1;}finally{if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.socket.close();}if(browser&&browser.exitCode===null)browser.kill();if(server)server.close();await fs.writeFile(path.join(runDir,'results.json'),JSON.stringify({results,log},null,2)).catch(()=>{});}})();



