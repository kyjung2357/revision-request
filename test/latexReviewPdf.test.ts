import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {generateLatexReviewPdf,prepareReviewSources,readReviewAnchors} from '../src/latexReviewPdf';
import type {PdfReviewSourceEntry} from '../src/pdfReviewTypes';
import {parseRequestDocument,resolveRequest} from '../src/request';
import {createTrackedReview} from '../src/reviewRebase';

function entry(source:string,before:string,after:string,id='change_one'):PdfReviewSourceEntry {
  const start=source.indexOf(before);assert.ok(start>=0);return{id,index:0,start,end:start+before.length,before,after};
}
const article=String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Old paragraph has an old phrase.
\begin{align}
a&=b+c\\
x&=y+z
\end{align}
\end{document}
`;

test('review snapshots preserve source and entry boundaries for replacements, insertions and deletions',()=>{
  const replace=entry(article,'Old paragraph has an old phrase.\n','New paragraph has a new phrase.\n');
  const addAt=article.indexOf('\\begin{align}');const add={id:'insert',index:1,start:addAt,end:addAt,before:'',after:'Inserted paragraph.\n'};
  const remove=entry(article,'x&=y+z\n','','remove');remove.index=2;
  const result=prepareReviewSources(article,[replace,add,remove]);
  const strip=(text:string)=>text.replace(/\\RRpdf(?:anchor|end)\{[^}]+\}/g,'');
  assert.equal(strip(result.before),article);assert.equal(strip(result.after),article.replace(replace.before,replace.after).replace('\\begin{align}','Inserted paragraph.\n\\begin{align}').replace(remove.before,''));
  for(const id of ['change_one','insert','remove'])for(const text of Object.values(result))assert.equal(text.split('\\RRpdfanchor{'+id+'}').length-1,1);
});

test('review snapshot rejects stale spans, duplicate IDs, overlaps, preamble and invisible-only changes',()=>{
  const valid=entry(article,'Old paragraph','New paragraph');
  for(const entries of [[{...valid,before:'different'}],[valid,valid],[{...valid,start:-1}],[entry(article,'\\documentclass{article}','\\documentclass{book}')]])assert.throws(()=>prepareReviewSources(article,entries));
  const comments=article.replace('Old paragraph has an old phrase.','% old comment');assert.throws(()=>prepareReviewSources(comments,[entry(comments,'% old comment','% new comment')]));
});

test('PDF anchors use named destinations and reject missing change positions',async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage();
  doc.catalog.set(PDFName.of('Names'),doc.context.obj({Dests:{Names:[PDFString.of('rrreview.one'),[page.ref,PDFName.of('XYZ'),22,530,null]]}}));
  const bytes=await doc.save();assert.deepEqual(await readReviewAnchors(bytes,['one']),[{entryId:'one',page:0,x:22,y:530}]);
  await assert.rejects(readReviewAnchors(bytes,['absent']),/could not uniquely locate/);
});

test('real LaTeX review keeps aligned cells valid and marks every pending block',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const root=path.resolve('.codex-test-latex-review');await fs.mkdir(root,{recursive:true});
  const workspace=await fs.mkdtemp(path.join(root,'workspace-')),target=path.join(workspace,'paper.tex');await fs.writeFile(target,article);
  const before=await fs.readFile(target);const entries=[entry(article,'Old paragraph has an old phrase.\n','New paragraph has a new phrase.\n'),entry(article,'a&=b+c\\\\\n','a&=b+d\\\\\n','math')];entries[1]!.index=1;
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source:article,entries,outputDirectory:path.join(workspace,'.codex-review-output')});
  assert.deepEqual(result.anchors.map(a=>a.entryId),entries.map(e=>e.id));assert.ok(result.pdf.length>1000);assert.deepEqual(await fs.readFile(target),before);
  await fs.writeFile(path.join(root,'last-pdf-path.txt'),path.join(workspace,'.codex-review-output','review.pdf'));
});

test('real PDF generation keeps already accepted source text and ignored originals in both snapshots',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const baseline=String.raw`\documentclass{article}
\begin{document}
Accepted old sentence.
Ignored original sentence.
Pending statement: PENDINGOLD.
\end{document}
`;
  const accepted='Accepted current first sentence.\nAccepted current second sentence.';
  const source=baseline.replace('Accepted old sentence.',accepted);
  const request=parseRequestDocument(JSON.stringify({path:'paper.tex',request:[
    {line:3,before:'Accepted old sentence.',after:accepted,status:'accepted'},
    {line:4,before:'Ignored original sentence.',after:'Ignored proposal must not appear.',status:'ignored'},
    {line:5,before:'PENDINGOLD',after:'PENDINGNEW',status:'pending'},
  ]}));
  const review=resolveRequest(request,source,baseline),tracking=createTrackedReview(review.file,review.decisions);
  assert.equal(tracking.text,source);
  const entries=tracking.entries.filter(item=>item.decision==='pending').map(item=>({
    id:item.hunk.id,index:review.entryIndexByHunkId[item.hunk.id]!,start:item.start,end:item.end,
    before:source.slice(item.start,item.end),after:item.hunk.after,
  }));
  assert.equal(entries.length,1);assert.equal(entries[0]!.index,2);
  const snapshots=prepareReviewSources(source,entries);
  const strip=(text:string)=>text.replace(/\\RRpdf(?:anchor|end)\{[^}]+\}/g,'');
  assert.equal(strip(snapshots.before),source);
  assert.equal(strip(snapshots.after),source.replace('PENDINGOLD','PENDINGNEW'));
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});
  const workspace=await fs.mkdtemp(path.join(base,'reviewed-source-')),target=path.join(workspace,'paper.tex');
  const requestPath=target+'.rr',savedRequest=JSON.stringify(request);await fs.writeFile(target,source);await fs.writeFile(requestPath,savedRequest);
  const outputDirectory=path.join(workspace,'.codex-review-output');
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source:await fs.readFile(target,'utf8'),entries,outputDirectory});
  assert.deepEqual(result.anchors.map(anchor=>anchor.entryId),entries.map(item=>item.id));
  for(const side of ['before','after']){
    const snapshot=await fs.readFile(path.join(outputDirectory,side,'paper.tex'),'utf8');
    assert.ok(snapshot.includes(accepted));assert.ok(snapshot.includes('Ignored original sentence.'));
    assert.ok(!snapshot.includes('Accepted old sentence.'));assert.ok(!snapshot.includes('Ignored proposal must not appear.'));
  }
  const compiled=await fs.readFile(path.join(outputDirectory,'review.tex'),'utf8');
  const body=compiled.slice(compiled.indexOf('\\begin{document}'));
  assert.match(body,/^Accepted current first sentence\.\r?\nAccepted current second sentence\.\r?$/m);
  assert.match(body,/^Ignored original sentence\.\r?$/m);
  assert.ok(!body.includes('Accepted old sentence.'));assert.ok(!body.includes('Ignored proposal must not appear.'));
  assert.match(body,/\\DIFdel\{[^}]*PENDINGOLD/);assert.match(body,/\\DIFadd\{[^}]*PENDINGNEW/);
  assert.equal((body.match(/\\RRpdfanchor\{/g)??[]).length,1,'only the pending change has a review control destination');
  assert.equal(await fs.readFile(target,'utf8'),source);assert.equal(await fs.readFile(requestPath,'utf8'),savedRequest);
  assert.ok(!result.warnings.some(w=>/undefined|multiply/i.test(w)),JSON.stringify(result.warnings));
});

test('real subfile root resolves copied dependencies and leaves originals unchanged',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const workspace=await fs.mkdtemp(path.join(base,'subfile-'));await fs.mkdir(path.join(workspace,'sections'));
  const source='% !TEX root = ../main.tex\nThe old statement.\n',target=path.join(workspace,'sections','body.tex');
  const root=String.raw`\documentclass{article}
\begin{document}
\input{sections/body}
\end{document}
`;
  await fs.writeFile(path.join(workspace,'main.tex'),root);await fs.writeFile(target,source);
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'The old statement.\n','The new statement.\n')],outputDirectory:path.join(workspace,'.codex-build-review')});
  assert.equal(result.anchors.length,1);assert.equal(await fs.readFile(target,'utf8'),source);assert.equal(await fs.readFile(path.join(workspace,'main.tex'),'utf8'),root);
});

test('real PDF renders display fractions, inserted/deleted environments, labels and local assets',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});
  const workspace=await fs.mkdtemp(path.join(base,'paths $() ; spaced-')),target=path.join(workspace,'paper name.tex');
  const source=String.raw`\documentclass{article}
\usepackage{amsmath,graphicx}
\begin{document}
Unchanged introduction.
\begin{equation}\label{eq:one}
F=\frac{a+b}{c+d}
\end{equation}
\begin{align}
u&=v+w\\
x&=y+z
\end{align}
This paragraph will be deleted.
Unchanged conclusion, referring to \eqref{eq:one}.
\includegraphics[width=1cm]{figure}
\end{document}
`;
  const asset=await PDFDocument.create();asset.addPage([40,40]);await fs.writeFile(path.join(workspace,'figure.pdf'),await asset.save());await fs.writeFile(target,source);
  const fraction=entry(source,'F=\\frac{a+b}{c+d}\n','F=\\frac{a+b}{c+e}\n','fraction');
  const align=entry(source,'u&=v+w\\\\\nx&=y+z\n','u&=v+q\\\\\nx&=y+r\n','aligned');align.index=1;
  const deletion=entry(source,'This paragraph will be deleted.\n','','deleted');deletion.index=2;
  const insertion={id:'inserted',index:3,start:source.indexOf('Unchanged conclusion'),end:source.indexOf('Unchanged conclusion'),before:'',after:'\\begin{equation}\\label{eq:new}\ng=h+i\n\\end{equation}\n'};
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[fraction,align,deletion,insertion],outputDirectory:path.join(workspace,'.codex-build-review')});
  assert.equal(result.anchors.length,4);assert.ok(result.anchors.every(a=>a.page===0&&a.y>0));assert.equal(await fs.readFile(target,'utf8'),source);
  assert.ok(!result.warnings.some(w=>/undefined|multiply/i.test(w)),JSON.stringify(result.warnings));
  await fs.writeFile(path.join(base,'last-rich-pdf-path.txt'),path.join(workspace,'.codex-build-review','review.pdf'));
});

test('missing LaTeX tools give an actionable error without changing the original',async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const workspace=await fs.mkdtemp(path.join(base,'missing-')),target=path.join(workspace,'paper.tex');await fs.writeFile(target,article);
  const previous=process.env.PATH;
  try{process.env.PATH='';await assert.rejects(generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source:article,entries:[entry(article,'Old paragraph','New paragraph')],outputDirectory:path.join(workspace,'.codex-review-output')}),/requires latexdiff on PATH/);}
  finally{process.env.PATH=previous;}
  assert.equal(await fs.readFile(target,'utf8'),article);
});

test('compact fragments inside control sequences keep PDF anchors outside the command',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const workspace=await fs.mkdtemp(path.join(base,'compact-')),target=path.join(workspace,'paper.tex');
  const source=String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\[
A=\frac{a}{b}
\]
\end{document}
`;
  const change=entry(source,'frac','dfrac');const snapshots=prepareReviewSources(source,[change]);
  assert.match(snapshots.before,/\\RRpdfanchor\{change_one\}A=\\frac/);assert.match(snapshots.after,/\\RRpdfanchor\{change_one\}A=\\dfrac/);
  await fs.writeFile(target,source);const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[change],outputDirectory:path.join(workspace,'.codex-review-output')});assert.equal(result.anchors.length,1);
});

test('repository multiline example compiles with one destination for every grouped proposal',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const source=await fs.readFile('examples/multiline-demo.tex','utf8'),request=parseRequestDocument(await fs.readFile('examples/multiline-demo.tex.rr','utf8')),review=resolveRequest(request,source);
  const entries=review.hunks.map((h,index)=>({id:h.id,index,start:h.start,end:h.end,before:h.before,after:h.after}));
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const workspace=await fs.mkdtemp(path.join(base,'grouped-')),target=path.join(workspace,'multiline-demo.tex');await fs.writeFile(target,source);
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries,outputDirectory:path.join(workspace,'.codex-review-output')});
  assert.equal(result.anchors.length,entries.length);assert.equal(await fs.readFile(target,'utf8'),source);
  await fs.writeFile(path.join(base,'last-grouped-pdf-path.txt'),path.join(workspace,'.codex-review-output','review.pdf'));
});

test('external shared macros are copied and verbatim paths remain literal',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const container=await fs.mkdtemp(path.join(base,'external-')),workspace=path.join(container,'project');await fs.mkdir(workspace);
  const macros='\\newcommand{\\LocalName}{Shared macro}\n',macroFile=path.join(container,'shared.tex');await fs.writeFile(macroFile,macros);
  const source=String.raw`\documentclass{article}
\input{../shared.tex}
\begin{document}
\LocalName: old text.
\begin{verbatim}
\input{../shared.tex}
\end{verbatim}
\end{document}
`;
  const target=path.join(workspace,'paper.tex');await fs.writeFile(target,source);const outputDirectory=path.join(workspace,'.codex-review-output');
  const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'old text','new text')],outputDirectory});
  assert.equal(result.anchors.length,1);assert.equal(await fs.readFile(macroFile,'utf8'),macros);assert.equal(await fs.readFile(target,'utf8'),source);
  assert.match(await fs.readFile(path.join(outputDirectory,'after','paper.tex'),'utf8'),/\\begin\{verbatim\}\n\\input\{\.\.\/shared\.tex\}/);
});

test('shared inputs stay frozen when edited between snapshot reads',{skip:process.env.RR_TEST_LATEX!=='1'},async()=>{
  const io=require('node:fs/promises') as typeof fs;
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const workspace=await fs.mkdtemp(path.join(base,'frozen-'));
  const target=path.join(workspace,'body.tex'),root=path.join(workspace,'main.tex'),macro=path.join(workspace,'shared.tex'),assetPath=path.join(workspace,'figure.pdf');
  const source='% !TEX root = main.tex\nA frozen old statement.\n';
  const rootSource=String.raw`% !TEX program = pdflatex
\documentclass{article}
\usepackage{graphicx}
\input{shared}
\begin{document}
\FrozenValue
\input{body}
\includegraphics[width=1cm]{figure}
\end{document}
`;
  const macroSource='\\newcommand{\\FrozenValue}{Unchanged shared macro}\n';
  const asset=await PDFDocument.create();asset.addPage([40,40]);const assetBytes=await asset.save();
  await fs.writeFile(target,source);await fs.writeFile(root,rootSource);await fs.writeFile(macro,macroSource);await fs.writeFile(assetPath,assetBytes);
  const changedFiles=new Map([[root,rootSource.replace('pdflatex','unsupported-engine')],[macro,'\\newcommand{\\FrozenValue}{Unrelated new text}\n'],[assetPath,'Not a PDF anymore']]);
  const readCounts=new Map<string,number>(),originalOpen=io.open;
  const intercepted=(async(file:Parameters<typeof fs.open>[0],flags:Parameters<typeof fs.open>[1],mode?:Parameters<typeof fs.open>[2])=>{
    const handle=await originalOpen(file,flags,mode);
    if(typeof file==='string'&&changedFiles.has(file)){
      const count=(readCounts.get(file)??0)+1;readCounts.set(file,count);
      const originalClose=handle.close.bind(handle);
      handle.close=async()=>{await originalClose();if(count===1)await fs.writeFile(file,changedFiles.get(file)!);};
    }
    return handle;
  }) as typeof fs.open;
  const mock=test.mock.method(io,'open',intercepted);
  const outputDirectory=path.join(workspace,'.codex-review-output');
  try{
    const result=await generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'old','new')],outputDirectory});
    assert.equal(result.anchors.length,1);
    for(const file of changedFiles.keys())assert.equal(readCounts.get(file),1,'dependency was read more than once: '+file);
  }finally{mock.mock.restore();}
  for(const side of ['before','after']){
    assert.match(await fs.readFile(path.join(outputDirectory,side,'main.tex'),'utf8'),/program = pdflatex/);
    assert.equal(await fs.readFile(path.join(outputDirectory,side,'shared.tex'),'utf8'),macroSource);
  }
  const assets=await fs.readdir(path.join(outputDirectory,'assets'));assert.equal(assets.length,1);
  assert.deepEqual(await fs.readFile(path.join(outputDirectory,'assets',assets[0]!,'figure.pdf')),Buffer.from(assetBytes));
  assert.equal(await fs.readFile(target,'utf8'),source);
});


test('proposed resource access, engine primitives and encoded commands are rejected before tools run',async()=>{
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const container=await fs.mkdtemp(path.join(base,'security-')),workspace=path.join(container,'project');await fs.mkdir(workspace);
  const target=path.join(workspace,'paper.tex'),secret=path.join(container,'sentinel.txt');await fs.writeFile(target,article);await fs.writeFile(secret,'Harmless external sentinel');
  const output=path.join(container,'sentinel-output.txt');await fs.writeFile(output,'Do not replace this sentinel');
  const payloads=[
    '\\input{../sentinel.txt}',
    '\\input{'+secret.replace(/\\/g,'/')+'}',
    '\\openin1=../sentinel.txt \\read1 to\\result',
    '\\openout1='+output.replace(/\\/g,'/')+' \\write1{overwritten}',
    '\\pdfobj stream file{../sentinel.txt}',
    '\\directlua{io.open("../sentinel-output.txt","w"):write("changed")}',
    '\\immediate\\write18{echo changed}',
    '\\csname input\\endcsname{../sentinel.txt}',
    '\\catcode92=12',
    '^^5cinput{../sentinel.txt}',
  ];
  for(let i=0;i<payloads.length;i++)await assert.rejects(generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source:article,entries:[entry(article,'Old paragraph has an old phrase.',payloads[i]!)],outputDirectory:path.join(workspace,'.codex-output-'+i)}),/cannot introduce file access/);
  assert.equal(await fs.readFile(secret,'utf8'),'Harmless external sentinel');assert.equal(await fs.readFile(output,'utf8'),'Do not replace this sentinel');assert.equal(await fs.readFile(target,'utf8'),article);
  for(let i=0;i<payloads.length;i++)assert.deepEqual(await fs.readdir(path.join(workspace,'.codex-output-'+i)),[],'rejected proposal was copied or executed');
  const compact=article.replace('Old paragraph has an old phrase.','\\text{safe}');assert.throws(()=>prepareReviewSources(compact,[entry(compact,'text','input')]),/cannot introduce file access/);
});

test('proposed aggregate text is bounded before snapshots or subprocesses are created',()=>{
  assert.throws(()=>prepareReviewSources(article,[entry(article,'Old paragraph','x'.repeat(5*1024*1024))]),/size limit/);
});

test('a changed symlink target cannot widen the frozen dependency graph',async()=>{
  const io=require('node:fs/promises') as typeof fs;const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const container=await fs.mkdtemp(path.join(base,'dependency-race-')),workspace=path.join(container,'project');await fs.mkdir(workspace);
  const target=path.join(workspace,'paper.tex'),macro=path.join(workspace,'shared.tex'),outside=path.join(container,'sentinel.tex');
  const source=article.replace('\\begin{document}','\\input{shared}\n\\begin{document}');await fs.writeFile(target,source);await fs.writeFile(macro,'\\newcommand{\\Shared}{Safe macro}\n');await fs.writeFile(outside,'Harmless external sentinel');
  const original=io.realpath;let lookups=0;
  const mock=test.mock.method(io,'realpath',(async(file:Parameters<typeof fs.realpath>[0],options:Parameters<typeof fs.realpath>[1])=>{if(file===macro&&++lookups>1)return outside;return original(file,options);}) as typeof fs.realpath);
  try{await assert.rejects(generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'Old paragraph','New paragraph')],outputDirectory:path.join(workspace,'.codex-output')}),/outside the original project snapshot/);}finally{mock.mock.restore();}
  assert.equal(await fs.readFile(outside,'utf8'),'Harmless external sentinel');assert.equal(await fs.readFile(target,'utf8'),source);
});

test('a symlinked root directive must resolve inside the workspace',async()=>{
  const io=require('node:fs/promises') as typeof fs;const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const container=await fs.mkdtemp(path.join(base,'root-race-')),workspace=path.join(container,'project');await fs.mkdir(workspace);
  const target=path.join(workspace,'body.tex'),root=path.join(workspace,'main.tex'),outside=path.join(container,'outside.tex'),source='% !TEX root = main.tex\nOld text.\n';await fs.writeFile(target,source);await fs.writeFile(root,article);await fs.writeFile(outside,article);
  const original=io.realpath;const mock=test.mock.method(io,'realpath',(async(file:Parameters<typeof fs.realpath>[0],options:Parameters<typeof fs.realpath>[1])=>file===root?outside:original(file,options)) as typeof fs.realpath);
  try{await assert.rejects(generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'Old','New')],outputDirectory:path.join(workspace,'.codex-output')}),/symbolic link/);}finally{mock.mock.restore();}
});

test('real MiKTeX policy denies primitive writes outside the snapshot',{skip:process.env.RR_TEST_LATEX!=='1'},async(t)=>{
  const {execFileSync}=await import('node:child_process');if(!/MiKTeX/i.test(execFileSync('pdflatex',['--version'],{windowsHide:true,encoding:'utf8'}))){t.skip('MiKTeX-specific native output-policy regression.');return;}
  const base=path.resolve('.codex-test-latex-review');await fs.mkdir(base,{recursive:true});const container=await fs.mkdtemp(path.join(base,'engine-policy-')),workspace=path.join(container,'project');await fs.mkdir(workspace);
  const sentinel=path.join(container,'sentinel.txt');await fs.writeFile(sentinel,'Harmless external sentinel');
  for(const [index,primitive] of ['\\immediate\\openout1='+sentinel.replace(/\\/g,'/')+' \\immediate\\write1{overwritten}'].entries()){
    // Put the attack in the trusted baseline to bypass the proposal guard and
    // exercise the actual engine policy, not just a regular-expression test.
    const source=article.replace('\\end{document}',primitive+'\n\\end{document}'),target=path.join(workspace,'paper-'+index+'.tex');await fs.writeFile(target,source);
    await assert.rejects(generateLatexReviewPdf({workspaceRoot:workspace,targetPath:target,source,entries:[entry(source,'Old paragraph','New paragraph')],outputDirectory:path.join(workspace,'.codex-output-'+index)}),/could not build/);
    assert.equal(await fs.readFile(sentinel,'utf8'),'Harmless external sentinel');assert.equal(await fs.readFile(target,'utf8'),source);
  }
});
