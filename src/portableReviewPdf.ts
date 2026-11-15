import path from 'node:path';
import {existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import type {PdfReviewManifest,PdfReviewAnchor,ImportedPdfReview} from './pdfReviewTypes';
export {pdfReviewMenuScript} from './pdfReviewMenu';

const MAX_PDF=50*1024*1024;
type Job={operation:'read'|'create'|'anchors';bytes:Uint8Array;manifest?:PdfReviewManifest;anchors?:PdfReviewAnchor[];ids?:string[]};
let active=false;
const waiting:(()=>void)[]=[];
function run<T>(job:Job):Promise<T>{
  if(!(job.bytes instanceof Uint8Array)||job.bytes.length>MAX_PDF||job.bytes.length<8||!Buffer.from(job.bytes.subarray(0,1024)).includes(Buffer.from('%PDF-')))return Promise.reject(new Error('Choose a PDF review file within the 50 MiB limit.'));
  if(waiting.length>=4)return Promise.reject(new Error('Too many PDF operations are waiting. Try again after the current review finishes.'));
  return new Promise((resolve,reject)=>{
    const start=()=>{
      active=true;
      const compiled=path.join(__dirname,'pdf-review-worker.cjs');
      let worker:Worker;
      const release=()=>{active=false;waiting.shift()?.();};
      try{
        // Only trusted module paths enter this development loader, never PDF data.
        // Published builds always have the adjacent bundled worker.
        const source=path.join(__dirname,'pdfReviewWorker.ts'),development=!existsSync(compiled)&&existsSync(source);
        if(!existsSync(compiled)&&!development)throw new Error('The PDF review worker is missing. Rebuild or reinstall the extension.');
        const entry=development?'require('+JSON.stringify(require.resolve('tsx/cjs'))+');require('+JSON.stringify(source)+');':compiled;
        const bytes=new Uint8Array(job.bytes);
        worker=new Worker(entry,{eval:development,workerData:{...job,bytes},transferList:[bytes.buffer],execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
      }catch(error){release();reject(error);return;}
      let settled=false;
      const finish=(error?:Error,value?:T)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        // Terminate before starting another parser, including after success.
        void worker.terminate().finally(release);
        if(error)reject(error);else resolve(value!);
      };
      const timer=setTimeout(()=>finish(new Error('PDF processing exceeded its time limit.')),job.operation==='create'?30000:15000);
      worker.once('message',(result:{ok:boolean;error?:string;value?:T})=>finish(result?.ok?undefined:new Error(result?.error??'PDF validation failed.'),result?.value));
      worker.once('error',error=>finish(new Error('PDF worker rejected the document: '+error.message)));
      worker.once('exit',code=>{if(!settled)finish(new Error('PDF worker stopped before completing validation ('+code+').'));});
    };
    if(active)waiting.push(start);else start();
  });
}
/** Create a standard review PDF in an isolated, resource-bounded parser. */
export async function createPortableReviewPdf(bytes:Uint8Array,manifest:PdfReviewManifest,anchors:PdfReviewAnchor[]):Promise<Uint8Array>{
  if(!Array.isArray(anchors)||anchors.length>10000||Buffer.byteLength(JSON.stringify(manifest),'utf8')>22*1024*1024)return Promise.reject(new Error('The PDF review manifest exceeds the size limit.'));
  return run({operation:'create',bytes,manifest,anchors});
}
/** Reads data only: no PDF actions or scripts are executed. */
export async function readPortableReviewPdf(bytes:Uint8Array):Promise<ImportedPdfReview>{return run({operation:'read',bytes});}
export async function readPortableReviewAnchors(bytes:Uint8Array,ids:string[]):Promise<PdfReviewAnchor[]>{
  if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||id.length>128))return Promise.reject(new Error('Invalid PDF review anchor identifiers.'));
  return run({operation:'anchors',bytes,ids});
}
