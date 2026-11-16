/* global acquireVsCodeApi */
const vscode=acquireVsCodeApi();
const pagesNode=document.getElementById('pages'),statusNode=document.getElementById('save-status'),errorBar=document.getElementById('error-bar');
const menu=document.getElementById('review-menu'),explanation=document.getElementById('explanation');
const assets=document.body.dataset.pdfAssets;
let pdfjs,loadingTask,pdfDocument,manifest,confirmed={},pdfHash='',queue=[],inflight=null,sequence=0,lastError='',loadGeneration=0;
let pages=[],scale=1,fit=true,rendering=0,frame=0,flushes=[],pdfReady=false,readOnly=false,reloadRequired=false;
const allowed=new Set(['pending','accepted','ignored']);
const post=message=>vscode.postMessage(message);
const entryById=()=>new Map((manifest?.entries||[]).map(entry=>[entry.id,entry]));
const decisionsValid=value=>value && typeof value==='object' && !Array.isArray(value) && manifest.entries.every(entry=>allowed.has(value[entry.id])) && Object.keys(value).length===manifest.entries.length;
function projected(){
 const next={...confirmed};
 for(const change of queue){
  if(change.through){for(const entry of manifest.entries){if(next[entry.id]==='pending')next[entry.id]='accepted';if(entry.id===change.entryId)break;}}
  else next[change.entryId]=change.decision;
 }
 return next;
}
function updateStatus(){
 const saving=queue.length>0 || Boolean(inflight);
 statusNode.classList.toggle('saving',saving&&!lastError);
 statusNode.textContent=lastError?'Not saved':saving?'Saving…':pdfReady?(readOnly?'Read only · trust this workspace to save':'Saved'):'Loading PDF…';
 errorBar.hidden=!lastError;
 document.getElementById('error-message').textContent=lastError;
 document.getElementById('retry-save').hidden=!lastError || !queue.length || reloadRequired;
 const next=manifest?projected():{};
 for(const button of pagesNode.querySelectorAll('[data-entry-id][data-decision]')){
  button.classList.toggle('is-selected',next[button.dataset.entryId]===button.dataset.decision);
  button.setAttribute('aria-pressed',String(next[button.dataset.entryId]===button.dataset.decision));
  button.classList.toggle('is-unsaved',next[button.dataset.entryId]!==confirmed[button.dataset.entryId]);
  button.disabled=Boolean(lastError)||readOnly;
 }
 for(const button of pagesNode.querySelectorAll('.more-control'))button.disabled=Boolean(lastError);
 settleFlushes();
}
function settleFlushes(){
 if(inflight||(!lastError&&queue.length))return;
 for(const requestId of flushes.splice(0))post({type:'flushed',requestId,ok:!lastError,error:lastError||undefined});
}
function sendNext(){
 if(inflight||lastError||!queue.length)return;
 const next=queue[0];inflight={...next,sequence:++sequence};
 post({type:'saveDecision',sequence:inflight.sequence,expectedPdfHash:pdfHash,entryId:next.entryId,decision:next.decision,...(next.through?{through:true}:{})});
 updateStatus();
}
function choose(entryId,decision,through=false){
 if(!pdfReady||lastError||readOnly||!entryById().has(entryId))return;
 queue.push({entryId,decision,through});closeMenu();updateStatus();sendNext();
}
function closeMenu(){menu.hidden=true;menu.replaceChildren();}
function showAt(node,anchor){
 node.hidden=false;const rect=anchor.getBoundingClientRect(),box=node.getBoundingClientRect();
 node.style.left=Math.max(8,Math.min(rect.left,innerWidth-box.width-8))+'px';
 node.style.top=Math.max(8,Math.min(rect.bottom+4,innerHeight-box.height-8))+'px';
}
function openMenu(entryId,anchor){
 closeMenu();const entry=entryById().get(entryId);if(!entry)return;
 for(const [label,callback,disabled]of [
  ['Show change explanation',()=>{document.getElementById('explanation-text').textContent=entry.reason??manifest.request.request[entry.index]?.reason??'';closeMenu();showAt(explanation,anchor);document.getElementById('close-explanation').focus();},!(entry.reason??manifest.request.request[entry.index]?.reason??'').trim()],
  ['Accept all up to here',()=>choose(entryId,'accepted',true),readOnly]
 ]){
  const item=document.createElement('button');item.type='button';item.textContent=label;item.disabled=disabled;item.setAttribute('role','menuitem');item.addEventListener('click',callback);menu.append(item);
 }
 showAt(menu,anchor);menu.querySelector('button:not(:disabled)')?.focus();
}
function controlsFor(annotations,viewport,node){
 const fields=new Map(),more=new Map();
 for(const entry of manifest.entries){fields.set('RRDecision_'+manifest.exportId+'_'+entry.id,entry.id);more.set('RRMore_'+manifest.exportId+'_'+entry.id,entry.id);}
 const layer=document.createElement('div');layer.className='pdf-controls';
 for(const item of annotations){
  const id=fields.get(item.fieldName)||more.get(item.fieldName);if(!id || !Array.isArray(item.rect)||item.rect.length!==4||!item.rect.every(Number.isFinite))continue;
  const isMore=more.has(item.fieldName),value=item.buttonValue;
  if(!isMore&&!['accepted','ignored'].includes(value))continue;
  const box=[...viewport.convertToViewportPoint(item.rect[0],item.rect[1]),...viewport.convertToViewportPoint(item.rect[2],item.rect[3])],x=Math.min(box[0],box[2]),y=Math.min(box[1],box[3]),width=Math.abs(box[2]-box[0]),height=Math.abs(box[3]-box[1]);
  if(width<=0||height<=0||x<-.5||y<-.5||x+width>viewport.width+.5||y+height>viewport.height+.5)continue;
  const button=document.createElement('button');button.type='button';button.className='pdf-control '+(isMore?'more-control':value);button.dataset.entryId=id;
  button.style.left=x+'px';button.style.top=y+'px';button.style.width=width+'px';button.style.height=height+'px';button.style.fontSize=(height*(isMore?.72:.58))+'px';
  button.textContent=isMore?'⋯':value==='accepted'?'Accept':'Ignore';
  button.setAttribute('aria-label',(isMore?'More actions for change ':button.textContent+' change ')+(entryById().get(id).index+1));
  if(isMore)button.addEventListener('click',()=>openMenu(id,button));
  else {button.dataset.decision=value;button.addEventListener('click',()=>choose(id,projected()[id]===value?'pending':value));}
  layer.append(button);
 }
 node.append(layer);updateStatus();
}
function showFailure(error){lastError=typeof error==='string'?error:error?.message||'The PDF could not be displayed.';updateStatus();}
function clearRender(page){
 page.task?.cancel();page.task=null;page.ready=false;page.failed=false;page.renderVersion=(page.renderVersion||0)+1;
 if(page.canvas){page.canvas.width=0;page.canvas.height=0;page.canvas=null;}
 page.node.replaceChildren();
 const label=document.createElement('div');label.className='page-placeholder';label.textContent='Page '+page.number;page.node.append(label);
}
function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;renderVisible();});}
function updatePageNavigation(){
 const view=pagesNode.getBoundingClientRect();let current=pages.find(p=>p.node.getBoundingClientRect().bottom>view.top+20)?.number||1;
 document.getElementById('page-number').value=String(current);
 document.getElementById('previous-page').disabled=current<=1;document.getElementById('next-page').disabled=current>=pages.length;
}
function renderVisible(){
 if(!pdfDocument)return;
 const bounds=pagesNode.getBoundingClientRect(),near=[];
 updatePageNavigation();
 for(const page of pages){
  const box=page.node.getBoundingClientRect(),distance=box.bottom<bounds.top?bounds.top-box.bottom:box.top>bounds.bottom?box.top-bounds.bottom:0;
  if(distance<900)near.push(page);
  else if(distance>1800&&page.ready)clearRender(page);
 }
 for(const page of near){if(rendering>=2)break;if(!page.ready&&!page.failed&&!page.task&&!page.busy)void renderPage(page);}
}
async function renderPage(page){
 const generation=loadGeneration,version=page.renderVersion;page.busy=true;rendering++;
 try{
  const proxy=await pdfDocument.getPage(page.number);
  if(generation!==loadGeneration||version!==page.renderVersion)return;
  const viewport=proxy.getViewport({scale}),ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(12000000/(viewport.width*viewport.height)));
  if(!Number.isFinite(ratio)||ratio<=0)throw Error('The PDF page dimensions are invalid.');
  page.width=viewport.width;page.height=viewport.height;page.node.style.width=viewport.width+'px';page.node.style.height=viewport.height+'px';
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(viewport.width*ratio));canvas.height=Math.max(1,Math.floor(viewport.height*ratio));canvas.setAttribute('aria-label','PDF page '+page.number);
  page.node.replaceChildren(canvas);page.canvas=canvas;
  page.task=proxy.render({canvas,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0],annotationMode:pdfjs.AnnotationMode.ENABLE_FORMS});
  await page.task.promise;
  if(generation!==loadGeneration||version!==page.renderVersion)return;
  const annotations=await proxy.getAnnotations({intent:'display'});
  if(generation!==loadGeneration||version!==page.renderVersion)return;
  controlsFor(annotations,viewport,page.node);page.ready=true;
 }catch(error){if(error?.name!=='RenderingCancelledException'&&generation===loadGeneration){page.failed=true;showFailure(error);}}
 finally{page.task=null;page.busy=false;if(generation===loadGeneration){rendering=Math.max(0,rendering-1);schedule();}}
}
function changeScale(next,keepFit=false){
 if(!pdfDocument)return;
 const old=scale,scroll=pagesNode.scrollTop;scale=Math.max(.25,Math.min(4,next));fit=keepFit;
 for(const page of pages){clearRender(page);page.node.style.width=(page.width/old*scale)+'px';page.node.style.height=(page.height/old*scale)+'px';page.width=page.width/old*scale;page.height=page.height/old*scale;}
 pagesNode.scrollTop=scroll/old*scale;closeMenu();explanation.hidden=true;
 document.getElementById('zoom-fit').textContent=fit?'Fit width':Math.round(scale*100)+'%';schedule();
}
async function load(message){
 if(queue.length||inflight){reloadRequired=true;showFailure('The PDF changed while choices were being saved. Your unsaved choices are still shown. Reload saved PDF discards them and opens the saved version.');return;}
 if(typeof message.base64!=='string'||message.base64.length>71000000||typeof message.pdfHash!=='string'||!/^[a-f0-9]{64}$/.test(message.pdfHash)
  ||!Array.isArray(message.manifest?.entries)||!message.manifest.entries.length||message.manifest.entries.length>10000)return showFailure('Invalid PDF review data.');
 const generation=++loadGeneration;pdfReady=false;lastError='';reloadRequired=false;closeMenu();explanation.hidden=true;
 for(const page of pages)page.task?.cancel();pages=[];rendering=0;pagesNode.replaceChildren();updateStatus();
 try{
  await loadingTask?.destroy();if(generation!==loadGeneration)return;pdfDocument=null;
  manifest=message.manifest;if(!decisionsValid(message.decisions))throw Error('Invalid PDF review decisions.');
  confirmed={...message.decisions};pdfHash=message.pdfHash;readOnly=message.readOnly===true;
  document.getElementById('filename').textContent=manifest.path+'.rr.pdf';document.getElementById('filename').title=manifest.path+'.rr.pdf';
  pdfjs ||= await import(document.body.dataset.pdfModule);if(generation!==loadGeneration)return;pdfjs.GlobalWorkerOptions.workerSrc=document.body.dataset.pdfWorker;
  const raw=atob(message.base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  loadingTask=pdfjs.getDocument({data:bytes,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',disableAutoFetch:true,disableStream:true,enableXfa:false,isEvalSupported:false,disableWorkerRendering:true});
  const loaded=await loadingTask.promise;if(generation!==loadGeneration){await loaded.destroy();return;}pdfDocument=loaded;
  if(loaded.numPages>2000)throw Error('This PDF has too many pages to open in the review viewer.');
  const first=await loaded.getPage(1),base=first.getViewport({scale:1});
  if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0||base.width>30000||base.height>30000)throw Error('Invalid PDF page dimensions.');
  scale=fit?Math.max(.25,Math.min(2,(pagesNode.clientWidth-32)/base.width)):scale;
  for(let number=1;number<=loaded.numPages;number++){
   const node=document.createElement('section');node.className='pdf-page';node.dataset.pageNumber=String(number);node.style.width=base.width*scale+'px';node.style.height=base.height*scale+'px';node.setAttribute('aria-label','Page '+number);
   const page={number,node,width:base.width*scale,height:base.height*scale,ready:false,task:null,busy:false,canvas:null};pages.push(page);clearRender(page);pagesNode.append(node);
  }
  document.getElementById('page-number').max=String(loaded.numPages);document.getElementById('page-count').textContent='/ '+loaded.numPages;
  pdfReady=true;updateStatus();schedule();
 }catch(error){if(generation===loadGeneration)showFailure(error);}
}
window.addEventListener('message',event=>{
 const message=event.data;if(!message||typeof message!=='object')return;
 if(message.type==='pdfState'){void load(message);return;}
 if(message.type==='pdfSaved'){
  if(!inflight||message.sequence!==inflight.sequence)return;
  if(typeof message.pdfHash!=='string'||!/^[a-f0-9]{64}$/.test(message.pdfHash)||!decisionsValid(message.decisions)){inflight=null;showFailure('The save confirmation was invalid. Reload the saved PDF.');return;}
  confirmed={...message.decisions};pdfHash=message.pdfHash;queue.shift();inflight=null;if(!reloadRequired)lastError='';updateStatus();sendNext();return;
 }
 if(message.type==='pdfSaveError'){
  if(message.sequence!==inflight?.sequence)return;
  inflight=null;showFailure(typeof message.error==='string'?message.error:'The PDF choices could not be saved.');return;
 }
 if(message.type==='pdfError'){showFailure(typeof message.error==='string'?message.error:'The PDF could not be opened.');return;}
 if(message.type==='flush'&&typeof message.requestId==='string'){flushes.push(message.requestId);settleFlushes();}
});
document.getElementById('retry-save').addEventListener('click',()=>{if(reloadRequired)return;lastError='';updateStatus();sendNext();});
document.getElementById('reload-pdf').addEventListener('click',()=>{if(inflight)return;queue=[];lastError='';pdfReady=false;updateStatus();post({type:'ready'});});
document.getElementById('close-explanation').addEventListener('click',()=>{explanation.hidden=true;});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.review-menu,.more-control'))closeMenu();if(!event.target.closest('.explanation,.review-menu'))explanation.hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenu();explanation.hidden=true;}});
function goPage(value){const number=Math.min(pages.length,Math.max(1,Number(value)||1));pages[number-1]?.node.scrollIntoView({block:'start'});schedule();}
document.getElementById('previous-page').addEventListener('click',()=>goPage(Number(document.getElementById('page-number').value)-1));
document.getElementById('next-page').addEventListener('click',()=>goPage(Number(document.getElementById('page-number').value)+1));
document.getElementById('page-number').addEventListener('change',event=>goPage(event.target.value));
document.getElementById('zoom-in').addEventListener('click',()=>changeScale(scale*1.2));
document.getElementById('zoom-out').addEventListener('click',()=>changeScale(scale/1.2));
document.getElementById('zoom-fit').addEventListener('click',()=>{if(pages[0])changeScale((pagesNode.clientWidth-32)/(pages[0].width/scale),true);});
pagesNode.addEventListener('scroll',()=>{closeMenu();explanation.hidden=true;schedule();},{passive:true});
window.addEventListener('resize',()=>{if(fit&&pages[0])changeScale((pagesNode.clientWidth-32)/(pages[0].width/scale),true);else schedule();});
post({type:'ready'});
