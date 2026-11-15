import {isMainThread} from 'node:worker_threads';
import {PDFContext,decodePDFRawStream} from 'pdf-lib';

const STREAM_LIMIT=32*1024*1024;
const ALLOCATION_LIMIT=256*1024*1024;
/** pdf-lib 1.17.1 decoders all grow through DecodeStream.ensureBuffer.
 * Install before load: object/xref streams are decoded during parsing, before
 * any attachment validation. Worker heap limits alone do not bound ArrayBuffers.
 * Resolve the actual decoder prototype so this also works in an esbuild bundle.
 */
export function installPdfDecodeBudget() {
  if(isMainThread)throw new Error('PDF parsing requires an isolated worker.');
  const probe=decodePDFRawStream(PDFContext.create().flateStream('budget probe'));
  let prototype:object|null=Object.getPrototypeOf(probe);
  for(let depth=0;prototype&&!Object.hasOwn(prototype,'ensureBuffer')&&depth<8;depth++)prototype=Object.getPrototypeOf(prototype);
  if(!prototype||!Object.hasOwn(prototype,'ensureBuffer'))throw new Error('Unsupported PDF decoder; refusing unbounded parsing.');
  type Decoder={buffer:Uint8Array;minBufferLength:number};
  const decoder=prototype as {ensureBuffer:(this:Decoder,requested:number)=>Uint8Array};
  if(typeof decoder.ensureBuffer!=='function')throw new Error('Unsupported PDF decoder.');
  const original=decoder.ensureBuffer;
  let allocated=0;
  decoder.ensureBuffer=function(requested:number){
    if(!Number.isSafeInteger(requested)||requested<0||requested>STREAM_LIMIT||!Number.isSafeInteger(this.minBufferLength)||this.minBufferLength<1||this.minBufferLength>STREAM_LIMIT)throw new Error('PDF decoded stream exceeds the resource limit.');
    if(requested<=this.buffer.byteLength)return this.buffer;
    let size=this.minBufferLength;while(size<requested)size*=2;
    if(size>STREAM_LIMIT||allocated+size>ALLOCATION_LIMIT)throw new Error('PDF decompression exceeds the resource limit.');
    allocated+=size;
    return original.call(this,requested);
  };
  // Fail closed if a future pdf-lib decoder no longer calls the bounded method.
  const before=allocated;probe.decode();
  if(allocated===before)throw new Error('Unsupported PDF decoder allocation path.');
}
