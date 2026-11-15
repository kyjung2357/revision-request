import {parentPort,workerData} from 'node:worker_threads';
import {installPdfDecodeBudget} from './pdfReviewLimits';
import {createPortableReviewPdfCore,readPortableReviewPdfCore,readPortableReviewAnchorsCore} from './portableReviewPdfCore';

async function main(){
  if(!parentPort)throw new Error('PDF worker requires a parent.');
  try{
    installPdfDecodeBudget();
    const job=workerData;
    const value=job.operation==='read'?await readPortableReviewPdfCore(job.bytes):
      job.operation==='create'?await createPortableReviewPdfCore(job.bytes,job.manifest,job.anchors):
      job.operation==='anchors'?await readPortableReviewAnchorsCore(job.bytes,job.ids):undefined;
    if(value===undefined)throw new Error('Unknown PDF worker operation.');
    parentPort.postMessage({ok:true,value},value instanceof Uint8Array?[value.buffer as ArrayBuffer]:[]);
  }catch(error){parentPort.postMessage({ok:false,error:error instanceof Error?error.message:'PDF validation failed.'});}
}
void main();
