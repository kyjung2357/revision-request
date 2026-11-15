import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {readPortableReviewAnchors} from './portableReviewPdf';
import type {CompiledReviewPdf, LatexReviewPdfInput, PdfReviewAnchor, PdfReviewSourceEntry, PdfCompilationProgressReporter} from './pdfReviewTypes';

const MAX_TEXT = 5 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_PROJECT = 250 * 1024 * 1024;
const MAX_OUTPUT = 25 * 1024 * 1024;
const MAX_PDF = 50 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const inside = (base: string, value: string) => {const relative=path.relative(base,value);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const texPath = (value: string) => value.split(path.sep).join('/');
const withoutComments = (value: string) => value.replace(/(?<!\\)%[^\r\n]*/g,'');
const maskedText = (value: string) => value.replace(/[^\r\n]/g,' ');
function maskNonCode(value:string):string {
  return value.replace(/\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\s*\{\1\}/g,maskedText)
    .replace(/\\(?:verb\*?|lstinline)(?:\[[^\]]*\])?([^\w\s])[^\r\n]*?\1/g,maskedText)
    .replace(/(?<!\\)%[^\r\n]*/g,maskedText);
}
const hasDocument = (value: string) => /\\documentclass(?:\[[^\]]*\])?\s*\{/.test(maskNonCode(value));


// Defense in depth, not a TeX sandbox. Existing project macros are executable
// code, and can expose capabilities under arbitrary names. The host must ask
// for explicit trust in the proposed LaTeX before every local PDF build.
const restrictedProposalCommand = /\\(?:input|include|includeonly|subfile|import|subimport|includefrom|subincludefrom|inputfrom|subinputfrom|usepackage|RequirePackage|documentclass|LoadClass|bibliography|bibliographystyle|addbibresource|addglobalbib|addsectionbib|includegraphics|graphicspath|DeclareGraphicsExtensions|DeclareGraphicsRule|verbatiminput|VerbatimInput|lstinputlisting|inputminted|includepdf|externaldocument|openin|openout|closein|closeout|read|readline|write|immediate|directlua|latelua|luaexec|luadirect|luafunction|pdfextension|pdfvariable|pdffeedback|pdfobj|pdfrefobj|pdfannot|pdfstartlink|pdfoutline|pdfcatalog|pdfnames|pdfinfo|pdftrailer|pdfmdfivesum|pdffiledump|pdffilesize|pdffilemoddate|special|catcode|lccode|uccode|csname|endcsname|scantokens|expandafter|expanded|lowercase|uppercase|let|futurelet|def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewDocumentEnvironment|RenewDocumentEnvironment|ExplSyntaxOn|makeatletter|everyjob|everyeof|everypar|everymath|everydisplay|output|shipout|loop|repeat|endlinechar|escapechar|newlinechar|chardef|mathchardef|countdef|dimendef|skipdef|toksdef)(?![A-Za-z])/;
function checkProposalCode(value:string):void {
  // Check the whole edited physical line, including unchanged command prefixes:
  // a compact fragment replacing "frac" with "input" must not bypass this.
  const code=withoutComments(value);
  if(code.includes('^^')||restrictedProposalCommand.test(code))throw new Error('PDF review cannot introduce file access, executable TeX primitives, or macro definitions. Review this change in the source preview.');
}

/** Read a regular file through one handle with a hard allocation bound. */
async function readBounded(file:string,maximum:number,description:string):Promise<Buffer> {
  const handle=await fs.open(file,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
  try {
    const stat=await handle.stat();if(!stat.isFile()||stat.size>maximum)throw new Error(description+' exceeds the PDF review size limit or is not a regular file.');
    const chunks:Buffer[]=[];let total=0;
    while(true){const chunk=Buffer.allocUnsafe(Math.min(64*1024,maximum-total+1));const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maximum)throw new Error(description+' exceeds the PDF review size limit.');chunks.push(chunk.subarray(0,bytesRead));}
    return Buffer.concat(chunks,total);
  } finally {await handle.close();}
}

/** Restrict native tools without changing the user's TeX installation/config. */
function toolEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env};
  for(const key of Object.keys(env))if(/^(?:PERL|LUA_INIT|LUA_PATH|LUA_CPATH|TEXINPUTS|BIBINPUTS|BSTINPUTS|TEXMFCNF|TEXMFOUTPUT|TEXFORMATS|TEXMFSCRIPTS)/i.test(key)||/^MIKTEX_.*(?:ALLOWUNSAFE|SHELLCOMMANDMODE|ENABLEINSTALLER)/i.test(key))delete env[key];
  Object.assign(env,{LC_ALL:'C',LANG:'C',openout_any:'p',openin_any:'p',shell_escape:'f',MIKTEX_ENABLE_INSTALLER:'0'});
  // MiKTeX resolves application-specific environment values before registry/INI
  // settings. Supply each supported engine tag as well as the general setting.
  // TeX Live 2026 no longer enforces openin_any: these are not OS confinement.
  for(const tag of ['','PDFLATEX_','PDFTEX_','LATEX_','TEX_','XELATEX_','XETEX_','LUALATEX_','LUATEX_','MIKTEX_','BIBTEX_']) {
    env['MIKTEX_'+tag+'CORE_ALLOWUNSAFEINPUTFILES']='false';
    env['MIKTEX_'+tag+'CORE_ALLOWUNSAFEOUTPUTFILES']='false';
    env['MIKTEX_'+tag+'CORE_SHELLCOMMANDMODE']='Forbidden';
  }
  return env;
}

/** Both snapshots contain the same stable boundaries, so a PDF control always refers to one .rr entry. */
export function prepareReviewSources(source: string, entries: PdfReviewSourceEntry[]): {before: string; after: string} {
  if (Buffer.byteLength(source,'utf8')>MAX_TEXT || source.includes('\0')) throw new Error('The LaTeX source exceeds the review size limit or contains NUL.');
  if (!entries.length || entries.length>10000) throw new Error('Choose at least one pending change for PDF review (maximum 10000).');
  const ids=new Set<string>();let position=0,before='',after='',proposedBytes=Buffer.byteLength(source,'utf8');
  const body=source.search(/\\begin\s*\{document\}/);
  for(const entry of entries) {
    if(!idPattern.test(entry.id)||ids.has(entry.id))throw new Error('PDF review needs unique stable change IDs.');ids.add(entry.id);
    if(!Number.isSafeInteger(entry.start)||!Number.isSafeInteger(entry.end)||entry.start<position||entry.end<entry.start||entry.end>source.length)throw new Error('PDF review changes overlap or share a physical source line.');
    if(source.slice(entry.start,entry.end)!==entry.before)throw new Error('The source no longer matches a PDF review change.');
    if(body>=0&&entry.start<body+'\\begin{document}'.length)throw new Error('Changes in the LaTeX preamble must be reviewed in the source preview.');
    if(!withoutComments(entry.before+entry.after).trim())throw new Error('Comment-only or whitespace-only changes must be reviewed in the source preview.');
    // Mark the physical line boundary, never the middle of a TeX command token.
    // The replacement itself remains the exact compact fragment from the .rr.
    const lineStart=entry.start===0?0:source.lastIndexOf('\n',entry.start-1)+1;
    const endsAtBoundary=entry.end===0||source[entry.end-1]==='\n';
    const newline=source.indexOf('\n',entry.end);
    const lineEnd=endsAtBoundary?entry.end:newline<0?source.length:newline+1;
    if(lineStart<position)throw new Error('PDF review entries on the same physical line must first be merged in the source preview.');
    if(/(?<!\\)%/.test(source.slice(lineStart,entry.start)))throw new Error('Comment-only changes must be reviewed in the source preview.');
    proposedBytes+=Buffer.byteLength(entry.after,'utf8')-Buffer.byteLength(entry.before,'utf8');if(proposedBytes>MAX_TEXT)throw new Error('The proposed LaTeX exceeds the PDF review size limit.');
    const fullBefore=source.slice(lineStart,lineEnd),fullAfter=source.slice(lineStart,entry.start)+entry.after+source.slice(entry.end,lineEnd);
    checkProposalCode(fullAfter);
    const visible=withoutComments(fullBefore+'\n'+fullAfter);
    if(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|newenvironment|renewenvironment)\b/.test(visible))throw new Error('Macro definition changes must be reviewed in the source preview.');
    if(/\\label\b/.test(visible)&&!visible.replace(/\\label\s*\{[^}]*\}/g,'').trim())throw new Error('Label-only changes must be reviewed in the source preview.');
    const head='\\RRpdfanchor{'+entry.id+'}',tail='\\RRpdfend{'+entry.id+'}';
    before+=source.slice(position,lineStart)+head+fullBefore+tail;
    after+=source.slice(position,lineStart)+head+fullAfter+tail;
    position=lineEnd;
  }
  return {before:before+source.slice(position),after:after+source.slice(position)};
}

async function run(command: string,args: string[],cwd: string,timeout=120000):Promise<{stdout:string;stderr:string}> {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,windowsHide:true,shell:false,detached:process.platform!=='win32',env:toolEnvironment(),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',size=0,settled=false,stopping:Error|undefined;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve({stdout,stderr});};
    const stop=(error:Error)=>{
      if(stopping||settled)return;stopping=error;
      if(!child.pid){finish(error);return;}
      try {
        if(process.platform==='win32'){
          // Use Windows' own utility, never a similarly named workspace file.
          const killer=spawn(path.join(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
          killer.on('error',()=>{child.kill();});
          killer.on('close',code=>{if(code!==0)child.kill();});
        } else process.kill(-child.pid,'SIGKILL');
      }catch{child.kill();}
      // Resolve only on child close, after handles/pipes are closed, so the
      // caller cannot remove the snapshot while its compiler is still alive.
    };
    const timer=setTimeout(()=>stop(new Error(command+' timed out while building the review PDF.')),timeout);
    for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']] as const)stream?.on('data',(chunk:Buffer)=>{if(stopping)return;size+=chunk.length;if(size>MAX_OUTPUT){stop(new Error(command+' produced too much output.'));return;}if(name==='stdout')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');});
    child.on('error',error=>finish(new Error((error as NodeJS.ErrnoException).code==='ENOENT'?'PDF review requires '+command+' on PATH. Install a LaTeX distribution with latexdiff.':command+': '+error.message)));
    child.on('close',code=>{if(stopping)finish(stopping);else if(code===0)finish();else{const lines=(stdout+'\n'+stderr).split(/\r?\n/);const useful=lines.filter(line=>/^!|Error|error|Undefined|Missing|Fatal|not found|\.tex:\d+/.test(line));finish(new Error(command+' could not build the review PDF. '+(useful.length?useful.slice(-8):lines.slice(-10)).join('\n')));}});
  });
}
async function exists(file:string){try{return (await fs.stat(file)).isFile();}catch{return false;}}
async function resolveLiteral(raw:string,from:string,rootDir:string,extensions:string[],graphicDirs:string[]=[]):Promise<string|undefined>{
  if(!raw||/[\\#{}\0]/.test(raw.replace(/\\/g,process.platform==='win32'?'/':'\\'))||raw.startsWith('|'))return undefined;
  const roots=path.isAbsolute(raw)?['']:[rootDir,path.dirname(from),...graphicDirs];
  for(const base of roots){const stem=path.resolve(base,raw);for(const extension of ['',...extensions]){const item=stem+extension;if(await exists(item))return fs.realpath(item);}}
  return undefined;
}
interface Reference {start:number;end:number;target:string;kind:'text'|'asset'}
async function references(source:string,from:string,rootDir:string,graphicDirs:string[]):Promise<Reference[]> {
  const result:Reference[]=[];
  const clean=maskNonCode(source);
  for(const match of clean.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g))for(const item of match[1]!.matchAll(/\{([^}]*)\}/g))graphicDirs.push(path.resolve(rootDir,item[1]!));
  const pattern=/\\(input|include|subfile|includegraphics|bibliography|addbibresource|bibliographystyle|usepackage|RequirePackage|documentclass)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
  for(const match of clean.matchAll(pattern)) {
    const command=match[1]!,raw=match[2]!,start=match.index!+match[0].lastIndexOf('{')+1;
    const extensions=command==='includegraphics'?['.pdf','.png','.jpg','.jpeg','.eps']:command==='bibliography'||command==='addbibresource'?['.bib']:command==='bibliographystyle'?['.bst']:command==='documentclass'?['.cls']:command==='usepackage'||command==='RequirePackage'?['.sty']:['.tex'];
    const items=(command==='bibliography'||command==='usepackage'||command==='RequirePackage')?raw.split(','):[raw];let cursor=0;
    for(const value of items){const trimmed=value.trim(),offset=value.indexOf(trimmed);const target=await resolveLiteral(trimmed,from,rootDir,extensions,graphicDirs);if(target)result.push({start:start+cursor+offset,end:start+cursor+offset+trimmed.length,target,kind:/\.(tex|txt)$/i.test(target)?'text':'asset'});cursor+=value.length+1;}
  }
  // \input filename (without braces), used by older manuscripts.
  for(const match of clean.matchAll(/\\input[ \t]+([^\s{}%]+)/g)){const raw=match[1]!,target=await resolveLiteral(raw,from,rootDir,['.tex']);if(target)result.push({start:match.index!+match[0].lastIndexOf(raw),end:match.index!+match[0].length,target,kind:'text'});}
  return result;
}

async function findRoot(input:LatexReviewPdfInput):Promise<string>{
  if(hasDocument(input.source))return input.targetPath;
  const directive=input.source.split(/\r?\n/).slice(0,30).map(line=>/^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/i.exec(line)).find(Boolean);
  if(directive){const candidate=path.resolve(path.dirname(input.targetPath),directive[1]!);if(!inside(input.workspaceRoot,candidate)||!(await exists(candidate)))throw new Error('The LaTeX root directive must point to an existing file inside this workspace.');const resolved=await fs.realpath(candidate);if(!inside(input.workspaceRoot,resolved))throw new Error('The LaTeX root directive must not escape the workspace through a symbolic link.');return resolved;}
  const candidates:string[]=[];let dir=path.dirname(input.targetPath);
  while(inside(input.workspaceRoot,dir)){
    for(const item of await fs.readdir(dir,{withFileTypes:true})){if(!item.isFile()||!/\.(tex|ltx|latex)$/i.test(item.name))continue;const candidate=path.join(dir,item.name);if(candidate===input.targetPath)continue;const value=(await readBounded(candidate,MAX_TEXT,'LaTeX root')).toString('utf8');if(hasDocument(value))candidates.push(candidate);if(candidates.length>MAX_FILES)throw new Error('The LaTeX project exceeds the PDF review dependency limit.');}
    if(dir===input.workspaceRoot)break;dir=path.dirname(dir);
  }
  const matches:string[]=[];
  for(const candidate of candidates){const queue=[candidate],seen=new Set<string>();while(queue.length&&seen.size<MAX_FILES){const file=queue.shift()!;if(seen.has(file))continue;seen.add(file);if(file===input.targetPath){matches.push(candidate);break;}const value=(await readBounded(file,MAX_TEXT,'LaTeX dependency')).toString('utf8');for(const ref of await references(value,file,path.dirname(candidate),[]))if(ref.kind==='text')queue.push(ref.target);}}
  if(matches.length!==1)throw new Error('Choose one LaTeX root with a % !TEX root = ... directive before generating this subfile review.');
  return matches[0]!;
}

async function makeSnapshot(root:string,input:LatexReviewPdfInput,source:string,snapshot:string,assets:string,frozenInputs:Map<string,Buffer>,allowedInputs?:ReadonlySet<string>):Promise<string>{
  const queue=[root],done=new Map<string,string>(),graphicDirs:string[]=[];let total=0;
  const localPath=(file:string)=>path.join(snapshot,inside(input.workspaceRoot,file)?path.relative(input.workspaceRoot,file):path.join('_external',createHash('sha256').update(file).digest('hex').slice(0,16),path.basename(file)));
  while(queue.length){const file=queue.shift()!;if(done.has(file))continue;if(allowedInputs&&!allowedInputs.has(file))throw new Error('The proposed LaTeX introduces a dependency outside the original project snapshot. Review this change in the source preview.');if(done.size>=MAX_FILES)throw new Error('The LaTeX project exceeds the PDF review dependency limit.');
    // Share exact dependency bytes across both sides, even if the user edits a
    // root, macro, or asset while the disposable snapshots are being prepared.
    let raw:Buffer;
    if(file===input.targetPath)raw=Buffer.from(source,'utf8');
    else {
      const frozen=frozenInputs.get(file);
      if(frozen)raw=frozen;
      else {
        raw=await readBounded(file,Math.min(/\.(tex|ltx|latex|sty|cls|txt)$/i.test(file)?MAX_TEXT:MAX_PROJECT,MAX_PROJECT-total),'LaTeX dependency');frozenInputs.set(file,raw);
      }
    }
    total+=raw.length;if(total>MAX_PROJECT)throw new Error('The LaTeX project exceeds the PDF review size limit.');
    const textFile=/\.(tex|ltx|latex|sty|cls|txt)$/i.test(file);let content=raw;
    const destination=textFile?localPath(file):path.join(assets,createHash('sha256').update(file).digest('hex').slice(0,16),path.basename(file));done.set(file,destination);
    if(textFile){let text=raw.toString('utf8');const refs=await references(text,file,path.dirname(root),graphicDirs);for(const ref of refs.sort((a,b)=>b.start-a.start)){if(allowedInputs&&!allowedInputs.has(ref.target))throw new Error('The proposed LaTeX introduces a dependency outside the original project snapshot. Review this change in the source preview.');queue.push(ref.target);const target=/\.(tex|ltx|latex|sty|cls|txt)$/i.test(ref.target)?localPath(ref.target):path.join(assets,createHash('sha256').update(ref.target).digest('hex').slice(0,16),path.basename(ref.target));let replacement=texPath(path.relative(/\.(tex|ltx|latex|txt)$/i.test(ref.target)&&!/\.(sty|cls)$/i.test(file)?path.dirname(localPath(root)):path.dirname(assets),target));if(/\.(sty|cls|bst)$/i.test(ref.target))replacement=replacement.replace(/\.(sty|cls|bst)$/i,'');text=text.slice(0,ref.start)+replacement+text.slice(ref.end);}content=Buffer.from(text,'utf8');}
    await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,content);
  }
  if(!done.has(input.targetPath))throw new Error('The selected LaTeX root does not include the request target.');
  return done.get(root)!;
}

/** Read stable destinations, not text matching or approximate line heights. */
export async function readReviewAnchors(bytes:Uint8Array,ids:string[]):Promise<PdfReviewAnchor[]> {
  return readPortableReviewAnchors(bytes,ids);
}

/** Build a disposable project. Never write to the target, request, or their dependencies. */
export async function generateLatexReviewPdf(input:LatexReviewPdfInput,onProgress?:PdfCompilationProgressReporter):Promise<CompiledReviewPdf>{
  onProgress?.({stage: 'preparing', message: 'Copying LaTeX sources and dependencies…'});
  const rootDir=await fs.realpath(input.workspaceRoot),target=await fs.realpath(input.targetPath);
  if(!inside(rootDir,target)||!/\.(tex|ltx|latex)$/i.test(target))throw new Error('PDF review requires a LaTeX target inside the workspace.');
  const output=path.resolve(input.outputDirectory);if(/[{}%#\r\n]/.test(output+target))throw new Error('This project path contains characters that cannot be represented safely in a review TeX file.');if(inside(output,target)||output===rootDir||!output.split(path.sep).some(part=>part.startsWith('.codex-')))throw new Error('PDF review output must use a separate .codex- temporary directory.');
  await fs.mkdir(output,{recursive:true});if((await fs.readdir(output)).length)throw new Error('PDF review needs a fresh temporary output directory.');
  const normalized={...input,workspaceRoot:rootDir,targetPath:target};
  const marked=prepareReviewSources(input.source,input.entries),root=await findRoot(normalized);
  const rootBytes=root===target?Buffer.from(input.source,'utf8'):await readBounded(root,MAX_TEXT,'LaTeX root');
  const frozenInputs=new Map<string,Buffer>([[root,rootBytes]]);
  const rootText=rootBytes.toString('utf8');
  if(/\\(?:newcommand|renewcommand|providecommand)\s*\{?\\DIF(?:add|del)/.test(rootText))throw new Error('An existing latexdiff document cannot be used as a fresh review source.');
  const before=await makeSnapshot(root,normalized,marked.before,path.join(output,'before'),path.join(output,'assets'),frozenInputs);
  const after=await makeSnapshot(root,normalized,marked.after,path.join(output,'after'),path.join(output,'assets'),frozenInputs,new Set([target,...frozenInputs.keys()]));
  const preamble=await fs.readFile(path.join(__dirname,'..','media','review-preamble.tex'),'utf8');
  onProgress?.({stage: 'diffing', message: 'Generating the marked-up LaTeX comparison…'});
  const result=await run('latexdiff',['--encoding=utf8','--no-label','--flatten','--math-markup=fine','--graphics-markup=both','--exclude-safecmd=RRpdfanchor,RRpdfend','--append-context2cmd=RRpdfanchor,RRpdfend','--config=MINWORDSBLOCK=0',before,after],output);
  const bodyStart=result.stdout.replace(/(?<!\\)%[^\r\n]*/g,text=>' '.repeat(text.length)).search(/\\begin\s*\{document\}/);
  if(bodyStart<0)throw new Error('latexdiff did not produce a complete LaTeX document.');
  result.stdout=result.stdout.slice(0,bodyStart)+preamble+'\n'+result.stdout.slice(bodyStart);
  const document=path.join(output,'review.tex');await fs.writeFile(document,result.stdout,'utf8');
  for(const entry of input.entries)if(withoutComments(result.stdout).split('\\RRpdfanchor{'+entry.id+'}').length!==2)throw new Error('latexdiff could not uniquely preserve the review marker for change '+entry.id+'.');
  const program=/^\s*%\s*!TEX\s+(?:program|TS-program)\s*=\s*([\w-]+)/im.exec(rootText)?.[1]?.toLowerCase()??'pdflatex';
  const engine=program==='xelatex'||program==='lualatex'?program:program==='pdflatex'||program==='latexmk'?'pdflatex':undefined;
  if(!engine)throw new Error('PDF review supports pdflatex, xelatex, or lualatex root directives.');
  // Reuse a project's resolved bibliography, if present, without changing it.
  const bbl=root.replace(/\.[^.]+$/,'.bbl');if(await exists(bbl))await fs.writeFile(path.join(output,'review.bbl'),await readBounded(bbl,MAX_TEXT,'Bibliography')); 
  onProgress?.({stage: 'compiling', message: 'Checking the LaTeX compiler…'});
  const version=await run(engine,['--version'],output,15000);
  const options=[...(/MiKTeX/i.test(version.stdout+version.stderr)?['-disable-installer']:[]),'-no-shell-escape','-recorder','-interaction=nonstopmode','-halt-on-error','-file-line-error','-synctex=1','review.tex'];
  let log='';for(let pass=0;pass<3;pass++){
    onProgress?.({stage: 'compiling', message: 'Compiling PDF — pass '+(pass+1)+' of 3…'});
    const built=await run(engine,options,output);log=built.stdout+'\n'+built.stderr;
    if(pass===0&&!(await exists(path.join(output,'review.bbl')))){
      const bibliography=await exists(path.join(output,'review.bcf'))?'biber':/\\bibliography\s*\{/.test(result.stdout)?'bibtex':undefined;
      if(bibliography){
        onProgress?.({stage: 'compiling', message: 'Building the bibliography…'});
        await run(bibliography,['review'],output);
      }
    }
  }
  if(/(?:Label.*multiply defined|There were multiply-defined labels)/.test(log))throw new Error('The review PDF contains duplicate labels. Review these changes in the source preview.');
  const pdf=new Uint8Array(await readBounded(path.join(output,'review.pdf'),MAX_PDF,'Generated PDF'));
  onProgress?.({stage: 'annotating', message: 'Locating changes in the compiled PDF…'});
  const anchors=await readReviewAnchors(pdf,input.entries.map(entry=>entry.id));
  const warnings=[...new Set(log.split(/\r?\n/).filter(line=>/(?:LaTeX|Package).*Warning:|Overfull \\hbox/.test(line)))].slice(0,30);
  if(/There were undefined references|Citation .* undefined/.test(log))warnings.push('Some references or citations are unresolved in the review PDF.');
  return {pdf,anchors,warnings};
}
