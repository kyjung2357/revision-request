import {isMainThread} from 'node:worker_threads';
import {pdfReviewMenuScript} from './pdfReviewMenu';
import {createHash} from 'node:crypto';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream,
  PDFRadioGroup, PDFRef, PDFNumber, PDFBool, StandardFonts, rgb, drawButton, decodePDFRawStream,
  type PDFPage, type PDFFont} from 'pdf-lib';
import {parseRequestDocument, proposalIdentity} from './request';
import type {Decision} from './core';
import type {PdfReviewManifest, PdfReviewAnchor, ImportedPdfReview} from './pdfReviewTypes';

const ATTACHMENT = 'revision-request.json';
const MAX_PDF = 50 * 1024 * 1024;
const MAX_MANIFEST = 22 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const name = PDFName.of;
const string = PDFHexString.fromText;
const fieldName = (manifest: PdfReviewManifest, id: string) => 'RRDecision_' + manifest.exportId + '_' + id;
const moreName = (manifest: PdfReviewManifest, id: string) => 'RRMore_' + manifest.exportId + '_' + id;
const decision = (value: unknown): value is Decision => value === 'pending' || value === 'accepted' || value === 'ignored';
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
  return value as Record<string, unknown>;
}
function knownKeys(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(label + ' contains unknown properties.');
}
function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= limit && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function validateManifest(value: unknown): PdfReviewManifest {
  const data = object(value, 'PDF review manifest');
  knownKeys(data, ['format', 'formatVersion', 'exportId', 'createdAt', 'path', 'proposalIdentity', 'sourceHash', 'request', 'entries'], 'PDF review manifest');
  if (data.format !== 'revision-request-pdf' || data.formatVersion !== 1) throw new Error('Unsupported PDF review format.');
  if (typeof data.exportId !== 'string' || !idPattern.test(data.exportId)) throw new Error('Invalid PDF review export ID.');
  if (typeof data.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(data.createdAt) || !Number.isFinite(Date.parse(data.createdAt))) throw new Error('Invalid PDF review creation time.');
  if (typeof data.sourceHash !== 'string' || !hashPattern.test(data.sourceHash) || typeof data.proposalIdentity !== 'string' || !hashPattern.test(data.proposalIdentity)) throw new Error('Invalid PDF review fingerprint.');
  const requestData = object(data.request, 'Embedded request');
  knownKeys(requestData, ['path', 'time', 'request'], 'Embedded request');
  if (Array.isArray(requestData.request)) for (const item of requestData.request) knownKeys(object(item, 'Embedded request entry'), ['line', 'before', 'after', 'reason', 'status'], 'Embedded request entry');
  const request = parseRequestDocument(JSON.stringify(data.request));
  parseRequestDocument(JSON.stringify({path: request.path, time: data.createdAt, request: []}));
  if (data.path !== request.path || data.proposalIdentity !== proposalIdentity(request)) throw new Error('The embedded PDF request does not match its identity.');
  if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > MAX_ENTRIES) throw new Error('A PDF review requires 1 to 10000 pending entries.');
  const ids = new Set<string>(), indexes = new Set<number>();
  for (const raw of data.entries) {
    const entry = object(raw, 'PDF review entry');
    knownKeys(entry, ['id', 'index', 'originalDecision', 'reason'], 'PDF review entry');
    if (typeof entry.id !== 'string' || !idPattern.test(entry.id) || entry.id === '__proto__' || ids.has(entry.id)) throw new Error('Invalid or duplicate PDF review entry ID.');
    if (!Number.isSafeInteger(entry.index) || (entry.index as number) < 0 || (entry.index as number) >= request.request.length || indexes.has(entry.index as number)) throw new Error('Invalid or duplicate PDF review entry index.');
    const original = request.request[entry.index as number]!;
    if (entry.originalDecision !== 'pending' || original.status !== 'pending') throw new Error('PDF controls must refer only to originally pending entries.');
    if (entry.reason !== undefined && (!validString(entry.reason, 50000) || entry.reason !== (original.reason ?? ''))) throw new Error('Invalid PDF review explanation.');
    ids.add(entry.id); indexes.add(entry.index as number);
  }
  if (request.request.some((entry, index) => entry.status === 'pending' && !indexes.has(index))) throw new Error('The PDF review is missing pending entries.');
  return data as unknown as PdfReviewManifest;
}
function checkPdf(bytes: Uint8Array) {
  if(isMainThread)throw new Error('PDF parsing requires an isolated worker.');
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PDF || bytes.length < 8 || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('Choose a PDF review file within the 50 MiB limit.');
}
function decodeString(value: unknown): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}
function embeddedManifests(pdf: PDFDocument): PDFRawStream[] {
  const names = pdf.catalog.lookupMaybe(name('Names'), PDFDict);
  const tree = names?.lookupMaybe(name('EmbeddedFiles'), PDFDict);
  if (!tree) return [];
  const found: PDFRawStream[] = [], seen = new Set<PDFDict>();
  let count = 0;
  const walk = (node: PDFDict, depth: number) => {
    if (depth > 32 || seen.has(node) || ++count > 20000) throw new Error('Invalid PDF attachment tree.');
    seen.add(node);
    const pairs = node.lookupMaybe(name('Names'), PDFArray);
    if (pairs) {
      if (pairs.size() % 2) throw new Error('Invalid PDF attachment names.');
      for (let index = 0; index < pairs.size(); index += 2) {
        const filename = decodeString(pdf.context.lookup(pairs.get(index)));
        if (filename !== ATTACHMENT) continue;
        const spec = pdf.context.lookup(pairs.get(index + 1), PDFDict);
        const actualName = decodeString(spec.lookup(name('UF'))) ?? decodeString(spec.lookup(name('F')));
        if (actualName !== ATTACHMENT) throw new Error('Ambiguous PDF review attachment.');
        const ef = spec.lookup(name('EF'), PDFDict);
        const stream = ef.lookup(name('UF')) ?? ef.lookup(name('F'));
        if (!(stream instanceof PDFRawStream)) throw new Error('Invalid PDF review attachment stream.');
        found.push(stream);
      }
    }
    const children = node.lookupMaybe(name('Kids'), PDFArray);
    if (children) for (let index = 0; index < children.size(); index++) walk(pdf.context.lookup(children.get(index), PDFDict), depth + 1);
  };
  walk(tree, 0);
  return found;
}
function inspectFieldTree(pdf: PDFDocument) {
  const acroform = pdf.catalog.lookupMaybe(name('AcroForm'), PDFDict);
  const fields = acroform?.lookupMaybe(name('Fields'), PDFArray);
  if (!fields || fields.size() === 0) throw new Error('PDF review fields are missing. Save the filled form; do not print or flatten it.');
  const seen = new Set<PDFDict>();
  let count = 0;
  const walk = (field: PDFDict, depth: number, parent?: PDFDict) => {
    if (field.lookup(name('Parent')) !== parent) throw new Error('Invalid PDF form parent link.');
    if (depth > 32 || seen.has(field) || ++count > MAX_ENTRIES * 5 + 1000) throw new Error('Invalid or duplicate PDF form tree.');
    seen.add(field);
    const children = field.lookupMaybe(name('Kids'), PDFArray);
    if (children) for (let index = 0; index < children.size(); index++) walk(pdf.context.lookup(children.get(index), PDFDict), depth + 1, field);
  };
  for (let index = 0; index < fields.size(); index++) walk(pdf.context.lookup(fields.get(index), PDFDict), 0);
}
// Keep page artwork and interactive widgets on the same compact geometry.
const CONTROL_HEIGHT = 12, CHOICE_WIDTH = 30, CONTROL_GAP = 3, MENU_WIDTH = 16, LEADER_GUTTER = 6;
const controlFontSize = (text: string) => text === '...' ? 8.5 : 7;
function appearance(pdf: PDFDocument, font: PDFFont, text: string, width: number, height: number, selected: boolean, accept: boolean) {
  const size = controlFontSize(text);
  const color = selected ? (accept ? rgb(.12,.42,.72) : rgb(.38,.4,.43)) : rgb(.96,.97,.98);
  const textColor = selected ? rgb(1,1,1) : rgb(.17,.22,.28);
  const operators = drawButton({x: 0, y: 0, width, height, borderWidth: .6,
    color, borderColor: selected ? color : rgb(.65,.69,.73), textColor, font: name('RRFont'), fontSize: size,
    textLines: [{encoded: font.encodeText(text), x: (width - font.widthOfTextAtSize(text,size))/2, y: (height-size)/2+(text==='...'?5:1.5)}]});
  return pdf.context.register(pdf.context.formXObject(operators, {BBox: [0,0,width,height], Resources: {Font: {RRFont: font.ref}}}));
}
// Some embedded viewers render page content but intentionally omit all form widgets.
// A static off-state underneath each widget keeps that read-only view understandable.
function drawStaticControl(page: PDFPage, font: PDFFont, label: string, x: number, y: number, width: number) {
  const size=controlFontSize(label);
  page.drawRectangle({x,y,width,height:CONTROL_HEIGHT,borderWidth:.6,borderColor:rgb(.65,.69,.73),color:rgb(.96,.97,.98)});
  page.drawText(label,{x:x+(width-font.widthOfTextAtSize(label,size))/2,y:y+(CONTROL_HEIGHT-size)/2+(label==='...'?5:1.5),size,font,color:rgb(.17,.22,.28)});
}
function addChoice(pdf: PDFDocument, page: PDFPage, font: PDFFont, manifest: PdfReviewManifest, entryId: string, x: number, y: number, reason: string) {
  drawStaticControl(page,font,'Accept',x,y,CHOICE_WIDTH);
  drawStaticControl(page,font,'Ignore',x+CHOICE_WIDTH+CONTROL_GAP,y,CHOICE_WIDTH);
  const group = pdf.getForm().createRadioGroup(fieldName(manifest, entryId));
  group.enableOffToggling();
  group.addOptionToPage('accepted', page, {x,y,width:CHOICE_WIDTH,height:CONTROL_HEIGHT,borderWidth:0});
  group.addOptionToPage('ignored', page, {x:x+CHOICE_WIDTH+CONTROL_GAP,y,width:CHOICE_WIDTH,height:CONTROL_HEIGHT,borderWidth:0});
  group.acroField.dict.delete(name('Opt'));
  group.acroField.dict.delete(name('DA'));
  const widgets = group.acroField.getWidgets();
  for (let index = 0; index < widgets.length; index++) {
    const widget = widgets[index]!, value = index === 0 ? 'accepted' : 'ignored', label = index === 0 ? 'Accept' : 'Ignore';
    const off = appearance(pdf,font,label,CHOICE_WIDTH,CONTROL_HEIGHT,false,index===0), on = appearance(pdf,font,label,CHOICE_WIDTH,CONTROL_HEIGHT,true,index===0);
    // Native BG/BC settings make Acrobat draw a circular radio over our artwork.
    // Keep explicit zero rotation: omitting MK entirely shifts Acrobat's live appearance.
    widget.dict.set(name('MK'),pdf.context.obj({R:0}));
    widget.dict.delete(name('DA')); widget.dict.delete(name('BS'));
    widget.dict.set(name('Border'),pdf.context.obj([0,0,0]));
    widget.dict.set(name('H'),name('P'));
    widget.dict.set(name('AP'),pdf.context.obj({N:{Off:off,[value]:on},R:{Off:off,[value]:on},D:{Off:on,[value]:on}}));
    widget.dict.set(name('AS'),name('Off'));
  }
  group.acroField.dict.set(name('V'),name('Off'));
  group.acroField.dict.set(name('DV'),name('Off'));
  group.acroField.dict.set(name('TU'),string('Choose Accept or Ignore, then save this PDF. '+(reason ? 'Why: '+reason : 'No explanation provided.')));
  pdf.getForm().markFieldAsClean(group.ref);
}
function addMenu(pdf: PDFDocument, page: PDFPage, font: PDFFont, manifest: PdfReviewManifest, index: number, x: number, y: number, reason: string) {
  const entry = manifest.entries[index]!;
  drawStaticControl(page,font,'...',x,y,MENU_WIDTH);
  const button = pdf.getForm().createButton(moreName(manifest,entry.id));
  button.addToPage('...',page,{x,y,width:MENU_WIDTH,height:CONTROL_HEIGHT,font,borderWidth:0,backgroundColor:rgb(.96,.97,.98),textColor:rgb(.17,.22,.28)});
  const widget = button.acroField.getWidgets()[0]!;
  widget.dict.set(name('A'),pdf.context.obj({S:'JavaScript',JS:string('RRReviewMenu.call(this,'+index+');')}));
  const ap = appearance(pdf,font,'...',MENU_WIDTH,CONTROL_HEIGHT,false,false);
  widget.dict.set(name('AP'),pdf.context.obj({N:ap,D:ap}));
  button.acroField.dict.set(name('TU'),string('Why / Accept all up to here. Menu requires a PDF viewer with JavaScript support. '+(reason?'Why: '+reason:'')));
  pdf.getForm().markFieldAsClean(button.ref);
  // A standard text annotation keeps explanations accessible in viewers without PDF JavaScript.
  if (reason) {
    // Without an explicit appearance PDF.js expands note icons to 22 points,
    // overlapping adjacent compact rows. Keep the standard Unicode popup.
    const note = pdf.context.register(pdf.context.flateStream(
      'q .25 .45 .7 RG .7 w 1 1 m 10 1 l 10 8 l 8 10 l 1 10 l h S ' +
      '8 10 m 8 8 l 10 8 l S 3 6 m 8 6 l S 3 4 m 8 4 l S Q',
      {Type:'XObject',Subtype:'Form',FormType:1,BBox:[0,0,11,11],Resources:{}}));
    page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',
      Rect:[x+MENU_WIDTH+2,y+.5,x+MENU_WIDTH+13,y+11.5],AP:{N:note},
      Contents:string(reason),T:string('Why - change '+(entry.index+1)),Name:'Comment',F:4,C:[.25,.45,.7],Open:false})));
  }
}
/** Create a standard PDF with form decisions; the source document is never modified. */
export async function createPortableReviewPdfCore(compiledPdf: Uint8Array, input: PdfReviewManifest, anchors: PdfReviewAnchor[]): Promise<Uint8Array> {
  checkPdf(compiledPdf);
  const manifest = validateManifest(JSON.parse(JSON.stringify(input)));
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized,'utf8') > MAX_MANIFEST) throw new Error('The PDF review manifest exceeds the size limit.');
  const pdf = await PDFDocument.load(compiledPdf,{updateMetadata:false,throwOnInvalidObject:true});
  inspectPageTree(pdf);
  if (pdf.getPageCount() > 2000 || pdf.isEncrypted) throw new Error('Unsupported PDF page count or encryption.');
  if (embeddedManifests(pdf).length) throw new Error('The source PDF already contains review data.');
  sanitizeCompiledPdf(pdf);
  const pageAnchors = new Map<number, (PdfReviewAnchor & {order:number})[]>(), ids = new Set<string>();
  const entryOrders = new Map(manifest.entries.map((entry, index) => [entry.id, index]));
  if (anchors.length !== manifest.entries.length) throw new Error('Every pending change must have exactly one PDF anchor.');
  for (const anchor of anchors) {
    const order = entryOrders.get(anchor.entryId) ?? -1;
    if (order<0 || ids.has(anchor.entryId) || !Number.isInteger(anchor.page) || anchor.page<0 || anchor.page>=pdf.getPageCount() || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw new Error('Invalid or duplicate PDF review anchor.');
    ids.add(anchor.entryId);
    const page = pdf.getPage(anchor.page), box=page.getMediaBox();
    if (anchor.x < box.x-2 || anchor.x > box.x+box.width+2 || anchor.y < box.y-2 || anchor.y > box.y+box.height+2) throw new Error('A review anchor is outside its PDF page.');
    const group=pageAnchors.get(anchor.page)??[];group.push({...anchor,order});pageAnchors.set(anchor.page,group);
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const numberGutter=LEADER_GUTTER+Math.max(12,Math.ceil(font.widthOfTextAtSize(String(manifest.request.request.length),6))+4);
  const laneWidth=108+numberGutter,rowHeight=14;
  for (const [pageIndex,list] of pageAnchors) {
    const page=pdf.getPage(pageIndex),box=page.getMediaBox();
    if (page.getRotation().angle % 360 !== 0 || box.height<140) throw new Error('Review controls require unrotated PDF pages at least 140 points high.');
    list.sort((a,b)=>b.y-a.y || a.order-b.order);
    const capacity=Math.floor((box.height-104)/rowHeight),lanes=Math.ceil(list.length/capacity);
    const newWidth=box.width+lanes*laneWidth;
    if(newWidth>14400)throw new Error('Too many review controls on one PDF page. Group related changes and generate again.');
    page.setMediaBox(box.x,box.y,newWidth,box.height);page.setCropBox(box.x,box.y,newWidth,box.height);
    for(let lane=0;lane<lanes;lane++) {
      const startX=box.x+box.width+lane*laneWidth,top=box.y+box.height-76,bottom=box.y+28;
      page.drawRectangle({x:startX,y:box.y,width:laneWidth,height:box.height,color:rgb(.985,.988,.992)});
      page.drawLine({start:{x:startX,y:box.y},end:{x:startX,y:box.y+box.height},color:rgb(.78,.82,.86),thickness:.5});
      page.drawText('REVISION REQUEST',{x:startX+12,y:box.y+box.height-22,size:8,font,color:rgb(.18,.27,.38)});

      const chunk=list.slice(lane*capacity,(lane+1)*capacity),ys:number[]=[];
      for(let i=0;i<chunk.length;i++)ys[i]=Math.min(top,chunk[i]!.y-CONTROL_HEIGHT/2,i?ys[i-1]!-rowHeight:top);
      for(let i=ys.length-1;i>=0;i--)ys[i]=Math.max(ys[i]!,i===ys.length-1?bottom:ys[i+1]!+rowHeight);
      for(let i=0;i<chunk.length;i++) {
        const anchor=chunk[i]!,entry=manifest.entries[anchor.order]!,y=ys[i]!,x=startX+numberGutter;
        const reason=entry.reason??manifest.request.request[entry.index]!.reason??'';
        const numberX=startX+LEADER_GUTTER+2,centerY=y+CONTROL_HEIGHT/2,elbowX=startX+2;
        page.drawText(String(entry.index+1),{x:numberX,y:centerY-3,size:6,font,color:rgb(.32,.4,.47)});
        // Route the bracket within its own sidebar gutter, never through a
        // number, manuscript text, or controls in a previous overflow lane.
        const leader=[{x:numberX-2,y:centerY},{x:elbowX,y:centerY},{x:elbowX,y:anchor.y},{x:startX,y:anchor.y}];
        for(let segment=1;segment<leader.length;segment++)page.drawLine({start:leader[segment-1]!,end:leader[segment]!,color:rgb(.62,.7,.77),thickness:.45});
        addChoice(pdf,page,font,manifest,entry.id,x,y,reason);addMenu(pdf,page,font,manifest,anchor.order,x+2*(CHOICE_WIDTH+CONTROL_GAP),y,reason);
      }
    }
  }
  pdf.getForm().acroForm.dict.set(name('NeedAppearances'),PDFBool.False);
  await pdf.attach(Buffer.from(JSON.stringify({manifest,sha256:sha256(serialized)}),'utf8'),ATTACHMENT,
    {mimeType:'application/json',description:'Revision Request proposal and export identity. Decisions are stored in the PDF form fields.',creationDate:new Date(manifest.createdAt)});
  pdf.addJavaScript('RevisionRequestMenu',pdfReviewMenuScript(manifest));
  pdf.setTitle('Revision Request - '+manifest.path);pdf.setProducer('Revision Request');
  const result=await pdf.save({updateFieldAppearances:false});
  if(result.length>MAX_PDF)throw new Error('The generated PDF exceeds the 50 MiB limit.');
  // Validate the real saved field tree and appearances, not only the authoring objects.
  await readPortableReviewPdfCore(result);
  return result;
}
/** Read saved form decisions without executing PDF actions or embedded JavaScript. */
export async function readPortableReviewPdfCore(bytes: Uint8Array): Promise<ImportedPdfReview> {
  checkPdf(bytes);
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  inspectPageTree(pdf);
  if(pdf.isEncrypted||pdf.getPageCount()>2000)throw new Error('Unsupported encrypted PDF or page count.');
  const attachments=embeddedManifests(pdf);
  if(attachments.length!==1)throw new Error('The PDF must contain exactly one Revision Request attachment.');
  const contents=decodePDFRawStream(attachments[0]!).getBytes(MAX_MANIFEST+1);
  if(contents.length>MAX_MANIFEST)throw new Error('The PDF review attachment exceeds the size limit.');
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contents));}catch{throw new Error('Invalid PDF review attachment JSON.');}
  const envelope=object(raw,'PDF review attachment');knownKeys(envelope,['manifest','sha256'],'PDF review attachment');
  const manifest=validateManifest(envelope.manifest);
  if(envelope.sha256!==sha256(JSON.stringify(manifest)))throw new Error('The embedded PDF review data was changed or damaged.');
  inspectFieldTree(pdf);
  const fields=pdf.getForm().getFields(),names=new Set<string>(),byName=new Map<string,typeof fields[number]>();
  for(const field of fields){const key=field.getName();if(names.has(key))throw new Error('Duplicate PDF form field names.');names.add(key);byName.set(key,field);}
  const expected=new Set(manifest.entries.map(entry=>fieldName(manifest,entry.id)));
  for(const key of names)if(key.startsWith('RRDecision_')&&!expected.has(key))throw new Error('Unexpected PDF decision fields.');
  const widgetPages=new Map<PDFDict,number>();
  for(const page of pdf.getPages()){
    const annotations=page.node.Annots();if(!annotations)continue;
    for(let index=0;index<annotations.size();index++){
      const annotation=pdf.context.lookup(annotations.get(index));
      if (!(annotation instanceof PDFDict)) throw new Error('A PDF annotation is missing or detached.');
      if(annotation.lookupMaybe(name('Subtype'),PDFName)!==name('Widget'))continue;
      widgetPages.set(annotation,(widgetPages.get(annotation)??0)+1);
      const direct=decodeString(annotation.lookup(name('T'))),parent=annotation.lookupMaybe(name('Parent'),PDFDict);
      const parentName=parent&&decodeString(parent.lookup(name('T')));
      if(direct?.startsWith('RRDecision_')&&!parent)throw new Error('Orphaned PDF review widget.');
      if(parentName?.startsWith('RRDecision_')){
        const field=byName.get(parentName);
        if(!(field instanceof PDFRadioGroup)||field.acroField.dict!==parent)throw new Error('Orphaned or duplicate PDF review widget.');
        if(!field.acroField.getWidgets().some(widget=>widget.dict===annotation))throw new Error('Unregistered PDF review widget.');
      }
    }
  }
  const decisions:Record<string,Decision>={};
  for(const entry of manifest.entries){
    const field=byName.get(fieldName(manifest,entry.id));
    if(!(field instanceof PDFRadioGroup))throw new Error('A PDF review decision field is missing or has the wrong type.');
    const options=field.getOptions();if(options.length!==2||new Set(options).size!==2||!options.includes('accepted')||!options.includes('ignored'))throw new Error('Invalid PDF decision choices.');
    const valueObject=field.acroField.dict.get(name('V'),true);
    const storedValue=pdf.context.lookup(valueObject);
    if(valueObject!==undefined&&!(storedValue instanceof PDFName)) throw new Error('Invalid canonical PDF decision value.');
    // Radio /V is optional when no choice is selected. Some readers omit it
    // after clearing a choice; the widget checks below still require BOTH /AS
    // values to be Off. Never infer approval from an appearance alone.
    const value=storedValue instanceof PDFName?storedValue:name('Off');
    const selected=field.getSelected(),chosen:unknown=value===name('Off')?'pending':selected;
    if(!decision(chosen))throw new Error('Invalid saved PDF review decision.');
    const widgets=field.acroField.getWidgets();if(widgets.length!==2)throw new Error('Missing or duplicated PDF review buttons.');
    for(const widget of widgets){
      if(widget.dict.get(name('Parent'))?.toString()!==field.ref.toString()||widgetPages.get(widget.dict)!==1)throw new Error('PDF decision buttons are missing or detached from their field.');
      const ownValue=widget.dict.lookup(name('V'));
      if (ownValue && ownValue!==value) throw new Error('The PDF widget value disagrees with its canonical decision.');
      const on=widget.getOnValue();
      if(!on)throw new Error('Missing PDF decision appearance.');
      const appearance=widget.getAppearanceState(),expectedAppearance=value===on?on:name('Off');
      if(appearance!==expectedAppearance)throw new Error('The PDF decision appearance disagrees with its saved value. Save the form again.');
      const normal=widget.dict.lookup(name('AP'),PDFDict).lookup(name('N'),PDFDict);
      for(const state of [name('Off'),on]){
        const stream=normal.lookup(state);if(!(stream instanceof PDFRawStream)||!stream.getContents().length)throw new Error('Empty PDF decision appearance.');
      }
    }
    decisions[entry.id]=chosen;
  }
  return{manifest,decisions,pdfHash:sha256(bytes)};
}

/** Validate graph topology before pdf-lib recursively traverses page parents/Kids. */
function inspectPageTree(pdf: PDFDocument) {
  const root=pdf.catalog.lookup(name('Pages'),PDFDict),seen=new Set<PDFDict>();
  let count=0,pages=0;
  const walk=(node:PDFDict,parent:PDFDict|undefined,depth:number)=>{
    if(depth>32||seen.has(node)||++count>10000||node.lookup(name('Parent'))!==parent) throw new Error('Invalid PDF page tree.');
    seen.add(node);
    const type=node.lookup(name('Type'));
    if(type===name('Page')) {if(++pages>2000)throw new Error('Unsupported PDF page count.');return;}
    if(type!==name('Pages'))throw new Error('Invalid PDF page tree type.');
    const kids=node.lookup(name('Kids'),PDFArray);
    if(kids.size()>10000)throw new Error('Invalid PDF page tree size.');
    for(let i=0;i<kids.size();i++)walk(pdf.context.lookup(kids.get(i),PDFDict),node,depth+1);
  };
  walk(root,undefined,0);
  if(!pages)throw new Error('The PDF contains no pages.');
}

/** A TeX-produced PDF is still untrusted. Keep local links, never inherited active content. */
function sanitizeCompiledPdf(pdf:PDFDocument) {
  const embedded=new Set<PDFRawStream>(),seen=new Set<unknown>();
  let visited=0;
  const scan=(value:unknown,depth:number)=>{
    if(!(value instanceof PDFDict||value instanceof PDFArray||value instanceof PDFRawStream)||seen.has(value))return;
    if(depth>64||++visited>200000)throw new Error('The source PDF object graph is too complex.');
    seen.add(value);
    if(value instanceof PDFArray){for(let i=0;i<value.size();i++)scan(pdf.context.lookup(value.get(i)),depth+1);return;}
    const dict=value instanceof PDFRawStream?value.dict:value;
    const ef=dict.lookupMaybe(name('EF'),PDFDict);
    if(ef)for(const item of ef.values()){const stream=pdf.context.lookup(item);if(stream instanceof PDFRawStream)embedded.add(stream);}
    for(const item of dict.values())scan(pdf.context.lookup(item),depth+1);
  };
  for(const [,object] of pdf.context.enumerateIndirectObjects())scan(object,0);
  // Scrub all dictionaries, including objects reachable through outlines and resources.
  // Deleting a catalog name alone would leave its active dictionaries in the saved PDF.
  for(const object of seen){
    if(!(object instanceof PDFDict||object instanceof PDFRawStream))continue;
    const dict=object instanceof PDFRawStream?object.dict:object;
    for(const key of ['AA','OpenAction','JS','JavaScript','Launch','EmbeddedFiles','AF','EF','XFA','RichMediaContent','RichMediaSettings','Movie','Sound','3DD','3DA'])dict.delete(name(key));
    const action=dict.lookup(name('A'));
    if(action instanceof PDFDict&&action.lookup(name('S'))===name('GoTo')){
      const destination=action.get(name('D'));
      dict.set(name('A'),pdf.context.obj(destination?{S:'GoTo',D:destination}:{S:'GoTo'}));
    } else dict.delete(name('A'));
    const type=dict.lookup(name('S'));
    if(type instanceof PDFName&&['JavaScript','Launch','URI','GoToR','GoToE','SubmitForm','ImportData','Rendition','Movie','Sound','Named','SetOCGState','Trans','Hide','ResetForm','Thread'].some(key=>type===name(key))){
      for(const key of dict.keys())dict.delete(key);
    } else if(type===name('GoTo'))dict.delete(name('Next'));
  }
  // Attachments are removed from the file itself, not merely from its visible tree.
  for(const [ref,object] of pdf.context.enumerateIndirectObjects())if(object instanceof PDFRawStream&&(embedded.has(object)||object.dict.lookup(name('Type'))===name('EmbeddedFile')))pdf.context.assign(ref,pdf.context.stream(''));
  pdf.catalog.delete(name('AcroForm'));
  const names=pdf.catalog.lookupMaybe(name('Names'),PDFDict);
  if(names)for(const key of names.keys())if(key!==name('Dests'))names.delete(key);
  for(const page of pdf.getPages()){
    const annots=page.node.Annots();if(!annots)continue;
    for(let i=annots.size()-1;i>=0;i--){
      const annotation=pdf.context.lookup(annots.get(i));
      if(!(annotation instanceof PDFDict)||![name('Link'),name('Text')].includes(annotation.lookup(name('Subtype')) as PDFName))annots.remove(i);
    }
  }
}

export async function readPortableReviewAnchorsCore(bytes:Uint8Array,ids:string[]):Promise<PdfReviewAnchor[]> {
  checkPdf(bytes);
  if(!Array.isArray(ids)||ids.length>MAX_ENTRIES||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!idPattern.test(id)))throw new Error('Invalid PDF review anchor identifiers.');
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});inspectPageTree(pdf);
  const pages=new Map(pdf.getPages().map((page,index)=>[page.ref.toString(),index])),found=new Map<string,PdfReviewAnchor[]>(),wanted=new Set(ids),seen=new Set<PDFDict>();
  let count=0;
  const visit=(node:PDFDict,depth:number)=>{
    if(depth>32||seen.has(node)||++count>20000)throw new Error('Invalid PDF destination tree.');seen.add(node);
    const pairs=node.lookupMaybe(name('Names'),PDFArray);
    if(pairs){
      if(pairs.size()%2||pairs.size()>MAX_ENTRIES*4)throw new Error('Invalid PDF destination names.');
      for(let i=0;i<pairs.size();i+=2){
        const label=decodeString(pairs.lookup(i));if(!label?.startsWith('rrreview.'))continue;
        const entryId=label.slice(9);if(!wanted.has(entryId))continue;
        const value=pairs.lookup(i+1),array=value instanceof PDFArray?value:value instanceof PDFDict?value.lookupMaybe(name('D'),PDFArray):undefined;
        if(!array||array.size()<4)throw new Error('Invalid PDF review destination.');
        const page=array.get(0),mode=array.lookup(1),x=array.lookup(2),y=array.lookup(3),pageIndex=page instanceof PDFRef?pages.get(page.toString()):undefined;
        if(pageIndex===undefined||mode!==name('XYZ')||!(y instanceof PDFNumber))throw new Error('Invalid PDF review position.');
        const anchor={entryId,page:pageIndex,x:x instanceof PDFNumber?x.asNumber():0,y:y.asNumber()};
        if(!Number.isFinite(anchor.x)||!Number.isFinite(anchor.y))throw new Error('Invalid PDF review position.');
        const matches=found.get(entryId)??[];matches.push(anchor);found.set(entryId,matches);
      }
    }
    const kids=node.lookupMaybe(name('Kids'),PDFArray);
    if(kids)for(let i=0;i<kids.size();i++)visit(kids.lookup(i,PDFDict),depth+1);
  };
  const names=pdf.catalog.lookupMaybe(name('Names'),PDFDict),dests=names?.lookupMaybe(name('Dests'),PDFDict);if(dests)visit(dests,0);
  return ids.map(id=>{const matches=found.get(id);if(matches?.length!==1)throw new Error('The rendered PDF could not uniquely locate change '+id+'. Review this change in the source preview.');return matches[0]!;});
}
