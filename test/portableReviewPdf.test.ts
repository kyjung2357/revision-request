import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFRawStream, PDFRef, PDFBool, PDFNumber, PDFWriter, StandardFonts, decodePDFRawStream} from 'pdf-lib';
import {createPortableReviewPdf, readPortableReviewPdf, readPortableReviewAnchors, pdfReviewMenuScript} from '../src/portableReviewPdf';
import {proposalIdentity, type RevisionRequest} from '../src/request';
import type {PdfReviewManifest, PdfReviewAnchor} from '../src/pdfReviewTypes';

const name=PDFName.of;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const field=(id:string)=>'RRDecision_export-test-1_'+id;
export function fixtureManifest():PdfReviewManifest {
  const request:RevisionRequest={path:'examples/manuscript.tex',request:[
    {line:5,before:'old',after:'new',status:'pending',reason:'A short explanation.'},
    {line:3,before:'a',after:'b',status:'accepted'},
    {line:1,before:'before',after:'after',status:'pending',reason:'설명과 수식: α ≤ β'},
    {line:7,before:null,after:'A new paragraph.',status:'pending'},
  ]};
  return {format:'revision-request-pdf',formatVersion:1,exportId:'export-test-1',createdAt:'2026-11-15T12:00:00Z',
    path:request.path,proposalIdentity:proposalIdentity(request),sourceHash:hash('original source'),request,
    entries:[{id:'first',index:2,originalDecision:'pending',reason:request.request[2]!.reason},
      {id:'second',index:0,originalDecision:'pending',reason:request.request[0]!.reason},
      {id:'third',index:3,originalDecision:'pending'}]};
}
export const fixtureAnchors:PdfReviewAnchor[]=[{entryId:'first',page:0,x:50,y:400},{entryId:'second',page:0,x:50,y:392},{entryId:'third',page:0,x:50,y:100}];
export async function sourceFixture():Promise<Uint8Array> {
  const pdf=await PDFDocument.create(),page=pdf.addPage([400,500]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Manuscript review',{x:40,y:455,size:18,font});
  page.drawText('The unchanged paragraph remains readable.',{x:40,y:400,size:12,font});
  page.drawText('Old wording / proposed new wording.',{x:40,y:380,size:12,font});
  page.drawText('A new paragraph belongs here.',{x:40,y:100,size:12,font});
  return pdf.save();
}
let generated:Promise<Uint8Array>|undefined;
const fixture=()=>generated??=(async()=>createPortableReviewPdf(await sourceFixture(),fixtureManifest(),fixtureAnchors))();
async function modified(edit:(pdf:PDFDocument)=>void|Promise<void>) {
  const pdf=await PDFDocument.load(await fixture());await edit(pdf);return pdf.save({updateFieldAppearances:false});
}
function embedded(pdf:PDFDocument) {
  const tree=pdf.catalog.lookup(name('Names'),PDFDict).lookup(name('EmbeddedFiles'),PDFDict);
  const pairs=tree.lookup(name('Names'),PDFArray),spec=pdf.context.lookup(pairs.get(1),PDFDict);
  const ef=spec.lookup(name('EF'),PDFDict),ref=ef.get(name('F')) as PDFRef;
  return {tree,pairs,spec,ef,ref,stream:pdf.context.lookup(ref) as PDFRawStream};
}

test('standard PDF retains the manuscript and adds non-overlapping right-margin form controls',async()=>{
  const bytes=await fixture(),pdf=await PDFDocument.load(bytes),result=await readPortableReviewPdf(bytes);
  assert.deepEqual(result.manifest,fixtureManifest());
  assert.deepEqual(result.decisions,{first:'pending',second:'pending',third:'pending'});
  assert.equal(result.pdfHash,hash(bytes));assert.equal(pdf.getPage(0).getWidth(),526);
  assert.equal(pdf.getForm().getFields().length,6);
  const rects=fixtureManifest().entries.map(entry=>pdf.getForm().getRadioGroup(field(entry.id)).acroField.getWidgets()[0]!.getRectangle());
  assert.ok(rects.every(rect=>rect.x>=400 && rect.width===30 && rect.height===12));
  for(const entry of fixtureManifest().entries) {
    const more=pdf.getForm().getButton('RRMore_export-test-1_'+entry.id).acroField.getWidgets()[0]!.getRectangle();
    assert.equal(more.width,16); assert.equal(more.height,12);
  }
  assert.ok(rects[0]!.y-rects[1]!.y>=14);assert.ok(rects[1]!.y-rects[2]!.y>=14);
  const annotations=pdf.getPage(0).node.Annots()!;
  let reasons=0;for(let i=0;i<annotations.size();i++){
    const annotation=pdf.context.lookup(annotations.get(i),PDFDict);
    if(annotation.lookup(name('Subtype'))===name('Text'))reasons++;
  }
  assert.equal(reasons,2,'standard text annotations expose explanations without scripts');
  const group=pdf.getForm().getRadioGroup(field('first'));
  assert.deepEqual(group.getOptions(),['accepted','ignored']);assert.equal(group.acroField.dict.lookup(name('V')),name('Off'));
  assert.ok(group.acroField.dict.lookup(name('TU')) instanceof PDFHexString);
});
test('explanation notes retain compact appearances and original request numbers',async()=>{
  const pdf=await PDFDocument.load(await fixture()),annotations=pdf.getPage(0).node.Annots()!;
  const notes:Array<PDFDict>=[];
  for(let i=0;i<annotations.size();i++){const annotation=pdf.context.lookup(annotations.get(i),PDFDict);if(annotation.lookup(name('Subtype'))===name('Text'))notes.push(annotation);}
  assert.deepEqual(notes.map(note=>(note.lookup(name('T')) as PDFHexString).decodeText()),['Why - change 3','Why - change 1']);
  assert.equal((notes[0]!.lookup(name('Contents')) as PDFHexString).decodeText(),'설명과 수식: α ≤ β');
  for(const note of notes){
    const rect=note.lookup(name('Rect'),PDFArray).asArray().map(value=>(value as PDFNumber).asNumber());
    assert.equal(rect[2]!-rect[0]!,11);assert.equal(rect[3]!-rect[1]!,11);
    const ap=note.lookup(name('AP'),PDFDict).lookup(name('N'));assert.ok(ap instanceof PDFRawStream);
    assert.deepEqual(ap.dict.lookup(name('BBox'),PDFArray).asArray().map(value=>(value as PDFNumber).asNumber()),[0,0,11,11]);
    assert.ok(decodePDFRawStream(ap).decode().length>0);
  }
});

test('number gutters include reviewed entries omitted from PDF controls',async()=>{
  const manifest=fixtureManifest();
  manifest.request.request=Array.from({length:1000},(_,index)=>({line:index+1,before:'a',after:'b',status:index===999?'pending':'accepted',reason:'Reason'}));
  manifest.entries=[{id:'last',index:999,originalDecision:'pending',reason:'Reason'}];manifest.proposalIdentity=proposalIdentity(manifest.request);
  const pdf=await PDFDocument.load(await createPortableReviewPdf(await sourceFixture(),manifest,[{entryId:'last',page:0,x:50,y:400}]));
  const rect=pdf.getForm().getRadioGroup(field('last')).acroField.getWidgets()[0]!.getRectangle(),font=await pdf.embedFont(StandardFonts.Helvetica);
  assert.ok(rect.x>408+font.widthOfTextAtSize('1000',6),'number and control must not overlap');
  assert.equal(rect.x,424);
});

test('radio appearances retain zero rotation without native circles or extra borders',async()=>{
  const pdf=await PDFDocument.load(await fixture());
  assert.equal(pdf.getForm().acroForm.dict.lookup(name('NeedAppearances')),PDFBool.False);
  for(const entry of fixtureManifest().entries){
    const group=pdf.getForm().getRadioGroup(field(entry.id));
    assert.equal(group.acroField.dict.has(name('DA')),false);
    for(const widget of group.acroField.getWidgets()){
      const mk=widget.dict.lookup(name('MK'),PDFDict);
      assert.deepEqual(mk.keys().map(key=>key.toString()),['/R']);
      assert.equal(mk.lookup(name('R'),PDFNumber).asNumber(),0);
      assert.equal(widget.dict.has(name('BS')),false);
      assert.equal(widget.dict.has(name('DA')),false);
      assert.equal(widget.dict.get(name('H')),name('P'));
      assert.deepEqual(widget.dict.lookup(name('Border'),PDFArray).asArray().map(x=>(x as PDFNumber).asNumber()),[0,0,0]);
      const rect=widget.getRectangle(),ap=widget.dict.lookup(name('AP'),PDFDict);
      for(const kind of ['N','R','D'])for(const state of ['Off',widget.getOnValue()!.decodeText()]){
        const stream=ap.lookup(name(kind),PDFDict).lookup(name(state));
        assert.ok(stream instanceof PDFRawStream);
        assert.deepEqual(stream.dict.lookup(name('BBox'),PDFArray).asArray().map(x=>(x as PDFNumber).asNumber()),[0,0,rect.width,rect.height]);
      }
    }
  }
});
test('saved Accept and Ignore choices round-trip without executing scripts',async()=>{
  const bytes=await modified(pdf=>{pdf.getForm().getRadioGroup(field('first')).select('accepted');pdf.getForm().getRadioGroup(field('second')).select('ignored');});
  assert.deepEqual((await readPortableReviewPdf(bytes)).decisions,{first:'accepted',second:'ignored',third:'pending'});
  const pdf=await PDFDocument.load(bytes);pdf.getForm().getRadioGroup(field('first')).clear();
  assert.equal((await readPortableReviewPdf(await pdf.save({updateFieldAppearances:false}))).decisions.first,'pending');
});
test('incrementally saved AcroForm updates use the latest canonical values',async()=>{
  const original=await PDFDocument.load(await fixture());
  const base=Buffer.from(await original.save({useObjectStreams:false,updateFieldAppearances:false}));
  const pdf=await PDFDocument.load(base),group=pdf.getForm().getRadioGroup(field('third'));group.select('accepted');
  const objects=[{ref:group.ref,dict:group.acroField.dict},...group.acroField.getWidgets().map(widget=>({ref:pdf.context.getObjectRef(widget.dict)!,dict:widget.dict}))];
  const chunks:Buffer[]=[base,Buffer.from('\n')],offsets:{number:number,offset:number}[]=[];
  let length=base.length+1;
  for(const {ref,dict} of objects){const content=Buffer.from(ref.objectNumber+' '+ref.generationNumber+' obj\n'+dict.toString()+'\nendobj\n');offsets.push({number:ref.objectNumber,offset:length});chunks.push(content);length+=content.length;}
  const previous=Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))![1]);
  const xref='xref\n'+offsets.map(item=>item.number+' 1\n'+String(item.offset).padStart(10,'0')+' 00000 n \n').join('');
  chunks.push(Buffer.from(xref+'trailer\n<< /Size '+(pdf.context.largestObjectNumber+1)+' /Root '+pdf.context.trailerInfo.Root!.toString()+' /Prev '+previous+' >>\nstartxref\n'+length+'\n%%EOF\n'));
  assert.equal((await readPortableReviewPdf(Buffer.concat(chunks))).decisions.third,'accepted');
});
test('prefix menu follows display order, changes only pending choices, and preserves later entries',()=>{
  const manifest=fixtureManifest(),values=new Map(manifest.entries.map(entry=>[field(entry.id),{value:'Off'}]));
  values.get(field('second'))!.value='ignored';
  const context=vm.createContext({app:{popUpMenuEx:()=> 'accept',alert:()=>{}},getField:(id:string)=>values.get(id)});
  vm.runInContext(pdfReviewMenuScript(manifest)+'; RRReviewMenu.call(this,1);',context);
  assert.equal(values.get(field('first'))!.value,'accepted');assert.equal(values.get(field('second'))!.value,'ignored');assert.equal(values.get(field('third'))!.value,'Off');
});
test('explanations are safely encoded and the menu has a no-JavaScript-feature fallback',()=>{
  const manifest=fixtureManifest();manifest.entries[0]!.reason='"; injected=true; //\u2028한국어';
  let message='';const context=vm.createContext({app:{popUpMenuEx:()=> 'why',alert:(text:string)=>{message=text;}},injected:false});
  vm.runInContext(pdfReviewMenuScript(manifest)+'; RRReviewMenu.call(this,0);',context);
  assert.equal(message,manifest.entries[0]!.reason);assert.equal(context.injected,false);
  const fallback=vm.createContext({app:{alert:(text:string)=>{message=text;}}});
  vm.runInContext(pdfReviewMenuScript(manifest)+'; RRReviewMenu.call(this,0);',fallback);assert.match(message,/Accept\/Ignore still work/);
});
test('missing or flattened decision fields are rejected',async()=>{
  const missing=await modified(pdf=>pdf.getForm().removeField(pdf.getForm().getRadioGroup(field('first'))));
  await assert.rejects(readPortableReviewPdf(missing),/missing|orphan|detached/i);
  const flattened=await modified(pdf=>pdf.getForm().flatten({updateFieldAppearances:false}));
  await assert.rejects(readPortableReviewPdf(flattened),/missing|flatten/i);
});
test('duplicate field references and unrelated duplicate field names are rejected',async()=>{
  const duplicate=await modified(pdf=>pdf.catalog.lookup(name('AcroForm'),PDFDict).lookup(name('Fields'),PDFArray).push(pdf.getForm().getRadioGroup(field('first')).ref));
  await assert.rejects(readPortableReviewPdf(duplicate),/duplicate/i);
  const names=await modified(pdf=>{const extra=pdf.getForm().createTextField('other');extra.acroField.dict.set(name('T'),PDFHexString.fromText(field('first')));});
  await assert.rejects(readPortableReviewPdf(names),/duplicate/i);
});
test('orphaned, duplicate, and page-detached review widgets are rejected',async()=>{
  const detached=await modified(pdf=>{const widget=pdf.getForm().getRadioGroup(field('first')).acroField.getWidgets()[0]!;pdf.getPage(0).node.removeAnnot(pdf.context.getObjectRef(widget.dict)!);});
  await assert.rejects(readPortableReviewPdf(detached),/missing|detached/i);
  const duplicate=await modified(pdf=>{const widget=pdf.getForm().getRadioGroup(field('first')).acroField.getWidgets()[0]!;pdf.getPage(0).node.addAnnot(pdf.context.getObjectRef(widget.dict)!);});
  await assert.rejects(readPortableReviewPdf(duplicate),/missing|detached/i);
  const orphan=await modified(pdf=>{const widget=pdf.getForm().getRadioGroup(field('first')).acroField.getWidgets()[0]!;const copy=widget.dict.clone(pdf.context);pdf.getPage(0).node.addAnnot(pdf.context.register(copy));});
  await assert.rejects(readPortableReviewPdf(orphan),/unregistered/i);
});
test('invalid canonical values and inconsistent appearances are rejected',async()=>{
  for(const value of ['bogus','accepted']) {
    const bytes=await modified(pdf=>{const dict=pdf.getForm().getRadioGroup(field('first')).acroField.dict;if(value)dict.set(name('V'),name(value));else dict.delete(name('V'));});
    await assert.rejects(readPortableReviewPdf(bytes),/decision|appearance|canonical/i);
  }
});
test('invalid choices, missing appearances, and extra decision fields are rejected',async()=>{
  const missing=await modified(pdf=>{const widget=pdf.getForm().getRadioGroup(field('first')).acroField.getWidgets()[0]!;widget.dict.lookup(name('AP'),PDFDict).lookup(name('N'),PDFDict).delete(name('Off'));});
  await assert.rejects(readPortableReviewPdf(missing),/appearance/i);
  const extra=await modified(pdf=>pdf.getForm().createRadioGroup('RRDecision_extra').addOptionToPage('accepted',pdf.getPage(0)));
  await assert.rejects(readPortableReviewPdf(extra),/unexpected/i);
});
test('changed and duplicate manifest attachments are rejected',async()=>{
  const altered=await modified(pdf=>{const attachment=embedded(pdf),envelope=JSON.parse(Buffer.from(decodePDFRawStream(attachment.stream).decode()).toString());envelope.manifest.sourceHash='0'.repeat(64);pdf.context.assign(attachment.ref,pdf.context.flateStream(Buffer.from(JSON.stringify(envelope))));});
  await assert.rejects(readPortableReviewPdf(altered),/changed|damaged/i);
  const duplicate=await modified(pdf=>{const {pairs}=embedded(pdf);pairs.push(PDFHexString.fromText('revision-request.json'));pairs.push(pairs.get(1));});
  await assert.rejects(readPortableReviewPdf(duplicate),/exactly one/i);
});
test('manifest validates pending coverage, hashes, identities, indexes, and safe IDs',async()=>{
  const source=await sourceFixture();
  const changes:Array<(value:PdfReviewManifest)=>void>=[m=>{m.entries.pop();},m=>{m.entries[0]!.index=1;},m=>{m.entries[1]!.id=m.entries[0]!.id;},m=>{m.sourceHash='invalid';},m=>{m.proposalIdentity='0'.repeat(64);},m=>{m.entries[0]!.id='unsafe.field';},m=>{m.entries[0]!.id='__proto__';},m=>{m.createdAt='2026-02-30T12:00:00Z';},m=>{m.entries[0]!.reason='changed';}];
  for(const change of changes){const manifest=fixtureManifest();change(manifest);await assert.rejects(createPortableReviewPdf(source,manifest,fixtureAnchors));}
});
test('each pending entry requires one valid anchor and no reviewed entry gets controls',async()=>{
  const source=await sourceFixture(),manifest=fixtureManifest();
  for(const anchors of [fixtureAnchors.slice(1),[fixtureAnchors[0]!,fixtureAnchors[0]!,fixtureAnchors[2]!],fixtureAnchors.map(a=>({...a,y:-3})),fixtureAnchors.map(a=>({...a,page:1}))])await assert.rejects(createPortableReviewPdf(source,manifest,anchors),/anchor/i);
  const result=await readPortableReviewPdf(await fixture());assert.equal(Object.keys(result.decisions).length,3);assert.equal(result.manifest.request.request[1]!.status,'accepted');
});
test('crowded pages add lanes instead of overlapping controls or covering source content',async()=>{
  const source=await sourceFixture(),manifest=fixtureManifest();manifest.request.request=Array.from({length:32},(_,i)=>({line:i+1,before:'a',after:'b',status:'pending'}));manifest.proposalIdentity=proposalIdentity(manifest.request);
  manifest.entries=manifest.request.request.map((_,index)=>({id:'entry-'+index,index,originalDecision:'pending'}));
  const anchors=manifest.entries.map(entry=>({entryId:entry.id,page:0,x:50,y:250}));
  const pdf=await PDFDocument.load(await createPortableReviewPdf(source,manifest,anchors));assert.equal(pdf.getPage(0).getWidth(),652);
  const rectangles=manifest.entries.map(entry=>pdf.getForm().getRadioGroup(field(entry.id)).acroField.getWidgets()[0]!.getRectangle());
  for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++){const a=rectangles[i]!,b=rectangles[j]!;assert.ok(a.x!==b.x||Math.abs(a.y-b.y)>=13.999);}
});
test('PDF import enforces the size limit and requires embedded review data',async()=>{
  await assert.rejects(readPortableReviewPdf(new Uint8Array(50*1024*1024+1)),/50 MiB/);
  await assert.rejects(readPortableReviewPdf(await sourceFixture()),/exactly one/);
  await assert.rejects(readPortableReviewPdf(Buffer.from('not a PDF')),/PDF/);
});



test('a widget cannot override the canonical decision value',async()=>{
  const conflicting=await modified(pdf=>{pdf.getForm().getRadioGroup(field('first')).acroField.getWidgets()[0]!.dict.set(name('V'),name('accepted'));});
  await assert.rejects(readPortableReviewPdf(conflicting),/canonical decision/i);
});
test('ordinary PDF saving preserves static button labels without any annotation layer',async()=>{
  const bytes=await modified(pdf=>{for(const page of pdf.getPages())page.node.delete(name('Annots'));});
  const pdf=await PDFDocument.load(bytes);let content='';
  const contents=pdf.getPage(0).node.Contents();const streams=contents instanceof PDFArray?Array.from({length:contents.size()},(_,i)=>pdf.context.lookup(contents.get(i))):[contents];
  for(const stream of streams)if(stream instanceof PDFRawStream)content+=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  assert.ok(content.includes(Buffer.from('Accept').toString('hex').toUpperCase()));
  assert.ok(content.includes(Buffer.from('Ignore').toString('hex').toUpperCase()));
  assert.ok(content.includes(Buffer.from('REVISION REQUEST').toString('hex').toUpperCase()));
  for(const removed of ['Use a form-enabled PDF app to review.','Read-only viewers may hide selections.','Choose, save, and return this PDF.','Choices do not edit the source.','The ... menu needs PDF JavaScript.']) {
    assert.ok(!content.includes(Buffer.from(removed).toString('hex').toUpperCase()));
  }
  // Brackets stay inside the sidebar and end at the original anchor height.
  const leaders=[...content.matchAll(/0\.45 w[\s\S]*?([-\d.]+) ([-\d.]+) m\n([-\d.]+) ([-\d.]+) l/g)]
    .map(match=>match.slice(1).map(Number));
  assert.equal(leaders.length,9);
  for(const [x1,y1,x2,y2] of leaders){assert.ok(x1===x2||y1===y2,'leader is orthogonal');assert.ok(x1!>=400&&x2!>=400&&x1!<=406&&x2!<=406,'leader stays left of the number within its lane');}
  for(let i=0;i<fixtureAnchors.length;i++) {
    assert.deepEqual(leaders[i*3]!.filter((_,index)=>index%2===0),[406,402]);
    assert.deepEqual(leaders[i*3+2],[402,fixtureAnchors[i]!.y,400,fixtureAnchors[i]!.y]);
  }
  const numbers=[...content.matchAll(/1 0 0 1 408 [-\d.]+ Tm\n<([\dA-F]+)> Tj/g)].map(match=>Buffer.from(match[1]!,'hex').toString());
  assert.deepEqual(numbers,['3','1','4'],'visible numbers retain original request indexes');
  await assert.rejects(readPortableReviewPdf(bytes),/missing|detached/i);
});

test('an absent radio value is pending only when both widget appearances are Off',async()=>{
  const cleared=await modified(pdf=>{
    const group=pdf.getForm().getRadioGroup(field('first'));
    group.select('accepted');group.clear();group.acroField.dict.delete(name('V'));
  });
  assert.equal((await readPortableReviewPdf(cleared)).decisions.first,'pending');
  for(const state of ['accepted','ignored']) {
    const conflicting=await modified(pdf=>{
      const group=pdf.getForm().getRadioGroup(field('first'));
      group.select(state);group.acroField.dict.delete(name('V'));
    });
    await assert.rejects(readPortableReviewPdf(conflicting),/appearance disagrees/i);
  }
  const missingAppearance=await modified(pdf=>{
    const group=pdf.getForm().getRadioGroup(field('first'));group.acroField.dict.delete(name('V'));
    group.acroField.getWidgets()[0]!.dict.delete(name('AS'));
  });
  await assert.rejects(readPortableReviewPdf(missingAppearance),/appearance disagrees/i);
});
test('non-name radio values never become implicit pending decisions',async()=>{
  for(const value of ['Off',null,0]) {
    const invalid=await modified(pdf=>pdf.getForm().getRadioGroup(field('first')).acroField.dict.set(name('V'),
      typeof value==='string'?PDFHexString.fromText(value):value===null?pdf.context.obj(null):pdf.context.obj(value)));
    await assert.rejects(readPortableReviewPdf(invalid),/Invalid canonical PDF decision value/);
  }
});


test('cyclic and mismatched page or form parents are rejected before recursive traversal',async()=>{
  const formCycle=await modified(pdf=>{const group=pdf.getForm().getRadioGroup(field('first'));group.acroField.dict.set(name('Parent'),group.ref);});
  await assert.rejects(()=>readPortableReviewPdf(formCycle),/form parent/);
  const mismatched=await modified(pdf=>{const group=pdf.getForm().getRadioGroup(field('first'));group.acroField.getWidgets()[0]!.dict.set(name('Parent'),pdf.getForm().getRadioGroup(field('second')).ref);});
  await assert.rejects(()=>readPortableReviewPdf(mismatched),/form parent/);
  // Save before corrupting: avoid invoking pdf-lib's own recursive page API here.
  const pdf=await PDFDocument.load(await fixture()),root=pdf.catalog.lookup(name('Pages'),PDFDict);
  root.lookup(name('Kids'),PDFArray).push(pdf.catalog.get(name('Pages'))!);
  const cyclic=await PDFWriter.forContext(pdf.context,50).serializeToBuffer();
  await assert.rejects(()=>readPortableReviewPdf(cyclic),/page tree/);
  const wrong=await PDFDocument.load(await fixture()),page=wrong.getPage(0);
  page.node.set(name('Parent'),page.ref);
  await assert.rejects(async()=>readPortableReviewPdf(await PDFWriter.forContext(wrong.context,50).serializeToBuffer()),/page tree/);
});

test('compiled PDFs lose inherited scripts, external actions, widgets and embedded files',async()=>{
  const pdf=await PDFDocument.load(await sourceFixture()),page=pdf.getPage(0);
  pdf.addJavaScript('UntrustedScript','app.launchURL("https://attacker.invalid",true);');
  const attack=pdf.context.obj({S:'JavaScript',JS:PDFHexString.fromText('app.alert("untrusted")')});
  pdf.catalog.set(name('OpenAction'),attack);page.node.set(name('AA'),pdf.context.obj({O:attack}));
  pdf.catalog.set(name('AF'),pdf.context.obj([attack]));
  await pdf.attach(Buffer.from('secret attachment payload'),'private.txt');
  const old=pdf.getForm().createTextField('OldForm');old.addToPage(page,{x:10,y:10,width:30,height:15});
  old.acroField.dict.set(name('AA'),pdf.context.obj({K:attack}));
  const add=(action:PDFDict)=>{const annotation=pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[10,20,30,40],A:action});page.node.addAnnot(pdf.context.register(annotation));return annotation;};
  add(pdf.context.obj({S:'Launch',F:'dangerous.exe'}));add(pdf.context.obj({S:'URI',URI:PDFHexString.fromText('https://attacker.invalid')}));
  add(pdf.context.obj({S:'GoTo',D:[page.ref,'Fit'],Next:attack}));
  const output=await createPortableReviewPdf(await pdf.save(),fixtureManifest(),fixtureAnchors),clean=await PDFDocument.load(output);
  assert.equal(clean.catalog.has(name('OpenAction')),false);assert.equal(clean.catalog.lookup(name('AF'),PDFArray).size(),1);assert.equal(clean.getPage(0).node.has(name('AA')),false);
  assert.equal(clean.getForm().getFields().some(item=>item.getName()==='OldForm'),false);
  const names=clean.catalog.lookup(name('Names'),PDFDict),scripts=names.lookup(name('JavaScript'),PDFDict).lookup(name('Names'),PDFArray);
  assert.equal(scripts.size(),2);assert.equal((scripts.lookup(0) as PDFHexString).decodeText(),'RevisionRequestMenu');
  const attachments=names.lookup(name('EmbeddedFiles'),PDFDict).lookup(name('Names'),PDFArray);assert.equal(attachments.size(),2);
  let localLinks=0;
  for(const [,obj] of clean.context.enumerateIndirectObjects()){
    if(obj instanceof PDFDict){assert.equal(obj.has(name('AA')),false);assert.equal(obj.has(name('OpenAction')),false);const action=obj.lookup(name('A'));if(action instanceof PDFDict&&action.lookup(name('S'))===name('GoTo')){assert.equal(action.has(name('Next')),false);localLinks++;}}
    if(obj instanceof PDFRawStream){assert.equal(Buffer.from(obj.getContents()).includes(Buffer.from('secret attachment payload')),false);if(obj.dict.lookup(name('Type'))===name('EmbeddedFile'))assert.equal(Buffer.from(decodePDFRawStream(obj).decode()).includes(Buffer.from('secret attachment payload')),false);}
  }
  assert.equal(localLinks,1);assert.equal((await readPortableReviewPdf(output)).decisions.first,'pending');
});

test('object-stream and attachment decompression bombs are bounded off the main thread',async()=>{
  const bomb=Buffer.alloc(33*1024*1024,32);
  const source=await PDFDocument.load(await sourceFixture());source.context.register(source.context.flateStream(bomb,{Type:'ObjStm',N:0,First:0}));
  const compressed=await source.save({useObjectStreams:false});assert.ok(compressed.length<100000);
  let responsive=false;const timer=setTimeout(()=>{responsive=true;},50);
  try{await assert.rejects(()=>readPortableReviewPdf(compressed),/resource limit|invalid object/i);assert.equal(responsive,true,'the host event loop continues while an untrusted decoder runs');}finally{clearTimeout(timer);}
  const attachment=await PDFDocument.load(await fixture()),info=embedded(attachment);
  attachment.context.assign(info.ref,attachment.context.flateStream(bomb));
  await assert.rejects(async()=>readPortableReviewPdf(await attachment.save({updateFieldAppearances:false})),/resource limit|size limit/);
  // A rejected parse cannot poison the next worker or its budget.
  assert.equal((await readPortableReviewPdf(await fixture())).decisions.third,'pending');
});

test('destination traversal is isolated and bounded, with exact review anchor coverage',async()=>{
  const pdf=await PDFDocument.load(await sourceFixture()),page=pdf.getPage(0);
  const tree=pdf.context.obj({Names:[PDFHexString.fromText('rrreview.first'),[page.ref,'XYZ',50,400,null]]});
  pdf.catalog.set(name('Names'),pdf.context.obj({Dests:tree}));
  assert.deepEqual(await readPortableReviewAnchors(await pdf.save(),['first']),[{entryId:'first',page:0,x:50,y:400}]);
  const treeRef=pdf.context.register(tree);tree.set(name('Kids'),pdf.context.obj([treeRef]));
  await assert.rejects(async()=>readPortableReviewAnchors(await pdf.save(),['first']),/destination tree/);
});


test('many individually bounded object streams cannot exhaust aggregate decoder memory',async()=>{
  const pdf=await PDFDocument.load(await sourceFixture()),chunk=Buffer.alloc(8*1024*1024,32);
  for(let i=0;i<18;i++)pdf.context.register(pdf.context.flateStream(chunk,{Type:'ObjStm',N:0,First:0}));
  const bytes=await pdf.save({useObjectStreams:false});assert.ok(bytes.length<200000);
  await assert.rejects(()=>readPortableReviewPdf(bytes),/resource limit|invalid object/i);
});
