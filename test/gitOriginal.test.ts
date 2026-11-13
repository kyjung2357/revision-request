import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {listGitFileHistory, readGitOriginal, validateGitOriginalTarget, type GitOriginal} from '../src/gitOriginal';
import {createRequestFile} from '../src/createRequestFile';
import {parseRequestDocument, resolveRequest} from '../src/request';

const run = promisify(execFile);
const project = path.resolve(__dirname, '..'), scratch = path.join(project, '.codex-test');
function cleanEnv() {
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
  return {...env,GIT_TERMINAL_PROMPT:'0'};
}
async function git(cwd:string,...args:string[]) {
  return (await run('git',['-c','core.autocrlf=false','-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:10000,env:cleanEnv()})).stdout;
}
async function fixture(t:TestContext,name='sample.py') {
  assert.match(await readFile(path.join(project,'.gitignore'),'utf8'),/^\.codex-\*\/$/m);
  await mkdir(scratch,{recursive:true});
  const directory=await mkdtemp(path.join(scratch,'git-original-'));
  t.after(async()=>{const relative=path.relative(scratch,directory);assert.ok(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..'));await rm(directory,{recursive:true,force:true});});
  const repository=path.join(directory,'repository');
  await mkdir(repository);await git(repository,'init','-q');await git(repository,'config','user.name','Revision Test');await git(repository,'config','user.email','test@example.invalid');
  const target=path.join(repository,name);await mkdir(path.dirname(target),{recursive:true});
  return {directory,repository,target,name};
}
async function commit(repository:string,target:string,text:string,message:string) {
  await writeFile(target,text);await git(repository,'add','--',path.relative(repository,target).split(path.sep).join('/'));
  await git(repository,'commit','-q','-m',message);
  return (await git(repository,'rev-parse','HEAD')).trim();
}
function options(f:Awaited<ReturnType<typeof fixture>>,gitOriginal:GitOriginal,proposed=f.target) {
  return {workspace:f.repository,original:f.name,proposed,gitOriginal};
}

test('Git history contains pinned commits and exact immutable UTF-8 text without changing working state',async t=>{
  const f=await fixture(t,'docs/한글 space [x].py');
  const first=await commit(f.repository,f.target,'first = 1\n','First <version> & explanation');
  const second=await commit(f.repository,f.target,'first = 2\n','Second revision');
  await writeFile(f.target,'first = 3\n');
  const beforeStatus=await git(f.repository,'status','--porcelain=v1','-z');
  const beforeIndex=await git(f.repository,'ls-files','--stage','-z');
  const history=await listGitFileHistory(f.repository,f.target);
  assert.deepEqual(history.map(item=>item.commit),[second,first]);
  assert.equal(history[1]!.subject,'First <version> & explanation');
  assert.ok(Number.isFinite(Date.parse(history[0]!.date)));
  assert.equal(await readGitOriginal(history[1]!),'first = 1\n');
  assert.equal(await readFile(f.target,'utf8'),'first = 3\n');
  assert.equal(await git(f.repository,'rev-parse','HEAD'),second+'\n');
  assert.equal(await git(f.repository,'status','--porcelain=v1','-z'),beforeStatus);
  assert.equal(await git(f.repository,'ls-files','--stage','-z'),beforeIndex);
});

test('unborn and untracked files have no history and non-repository files report a clear error',async t=>{
  const f=await fixture(t);await writeFile(f.target,'content\n');
  assert.deepEqual(await listGitFileHistory(f.repository,f.target),[]);
  await commit(f.repository,path.join(f.repository,'tracked.txt'),'tracked\n','Track another file');
  assert.deepEqual(await listGitFileHistory(f.repository,f.target),[]);
  const outsideFolder=path.join(f.directory,'not-repository');await mkdir(outsideFolder);
  const outside=path.join(outsideFolder,'outside.txt');await writeFile(outside,'outside');
  // Stop Git discovery before it reaches the enclosing development repository.
  await writeFile(path.join(outsideFolder,'.git'),'gitdir: missing-git-directory\n');
  await assert.rejects(listGitFileHistory(outsideFolder,outside),/Git could not read/);
});

test('Git request uses selected commit as before and current target as modified copy',async t=>{
  const f=await fixture(t),before='def square(x):\n    return x + x\n',after='def square(x):\n    return x * x\n';
  await commit(f.repository,f.target,before,'Baseline');
  await writeFile(f.target,after);
  const [original]=await listGitFileHistory(f.repository,f.target);
  const indexBefore=await git(f.repository,'ls-files','--stage','-z'),headBefore=await git(f.repository,'rev-parse','HEAD');
  const output=await createRequestFile(options(f,original!));
  const request=parseRequestDocument(await readFile(output,'utf8'));
  assert.ok(request.request.every(entry=>entry.status==='pending'));
  assert.equal(resolveRequest(request,before).file.after,after);
  assert.equal(await readFile(f.target,'utf8'),after);
  assert.equal(await git(f.repository,'ls-files','--stage','-z'),indexBefore);
  assert.equal(await git(f.repository,'rev-parse','HEAD'),headBefore);
  await assert.rejects(createRequestFile(options(f,original!)),/already exists.*never overwritten/);
  assert.equal(await readFile(output,'utf8'),JSON.stringify(request,null,2)+'\n');
});

test('Git CRLF checkout conversion is ignored while content, BOM, and final newline rules are preserved',async t=>{
  const f=await fixture(t);
  await commit(f.repository,f.target,'\uFEFFvalue = 1\nkeep\n','Baseline');
  const [original]=await listGitFileHistory(f.repository,f.target);
  await writeFile(f.target,'\uFEFFvalue = 2\r\nkeep\r\n');
  const output=await createRequestFile(options(f,original!));
  const request=parseRequestDocument(await readFile(output,'utf8'));
  assert.equal(resolveRequest(request,'\uFEFFvalue = 1\r\nkeep\r\n').file.after,'\uFEFFvalue = 2\r\nkeep\r\n');
  assert.equal(await readFile(f.target,'utf8'),'\uFEFFvalue = 2\r\nkeep\r\n');

  const another=await fixture(t);
  await commit(another.repository,another.target,'same\n','Baseline');
  const [selected]=await listGitFileHistory(another.repository,another.target);
  await writeFile(another.target,'same\r\n');
  await assert.rejects(createRequestFile(options(another,selected!)),/no content changes/);
  await writeFile(another.target,'same');
  await assert.rejects(createRequestFile(options(another,selected!)),/final-newline|line endings/);
});

test('the selected Git version is bound to the chosen existing target and a full commit ID',async t=>{
  const f=await fixture(t);
  await commit(f.repository,f.target,'before\n','Baseline');
  const [original]=await listGitFileHistory(f.repository,f.target);
  const other=path.join(f.repository,'other.py');await writeFile(other,'after\n');
  await assert.rejects(validateGitOriginalTarget(f.repository,other,original!),/does not belong/);
  await assert.rejects(createRequestFile({...options(f,original!),original:'other.py'}),/does not belong/);
  for(const change of [{commit:'HEAD'},{commit:'-o'},{path:'../sample.py'},{path:'.git/config'},{path:'/sample.py'},{path:'sample.py:other'}]) {
    await assert.rejects(readGitOriginal({...original!,...change}),/valid Git/);
  }
  await assert.rejects(readGitOriginal({...original!,commit:'f'.repeat(40)}),/Git could not read/);
  await assert.rejects(readGitOriginal({...original!,path:'missing.py'}),/does not exist/);
  const tree=(await git(f.repository,'rev-parse','HEAD^{tree}')).trim();
  await assert.rejects(readGitOriginal({...original!,commit:tree}),/not a commit/);
  await assert.rejects(listGitFileHistory(f.repository,path.join(f.repository,'.git','config')),/outside .git/);
});

test('Git snapshots reject binary invalid UTF-8 oversized data and symlink blobs',async t=>{
  const f=await fixture(t);
  for(const [bytes,message] of [
    [Buffer.from('binary\0content'),/NUL/],
    [Buffer.from([0xc3,0x28]),/valid UTF-8/],
    [Buffer.alloc(5*1024*1024+1,65),/5 MiB/]
  ] as const) {
    await writeFile(f.target,bytes);await git(f.repository,'add','--',f.name);await git(f.repository,'commit','-q','-m','Blob');
    const [original]=await listGitFileHistory(f.repository,f.target);
    await assert.rejects(readGitOriginal(original!),message);
  }
  const blob=(await git(f.repository,'rev-parse','HEAD:'+f.name)).trim();
  await git(f.repository,'update-index','--cacheinfo','120000,'+blob+','+f.name);
  await git(f.repository,'commit','-q','-m','Symlink mode');
  const [symlink]=await listGitFileHistory(f.repository,f.target);
  await assert.rejects(readGitOriginal(symlink!),/regular file/);
});

test('subdirectory workspaces and linked worktrees use their actual repository and HEAD',async t=>{
  const f=await fixture(t,'nested/file.py');
  await commit(f.repository,f.target,'old\n','Initial');
  const [nested]=await listGitFileHistory(path.join(f.repository,'nested'),f.target);
  assert.equal(nested!.path,'nested/file.py');
  assert.equal(await readGitOriginal(nested!),'old\n');
  const worktree=path.join(f.directory,'linked');
  await git(f.repository,'worktree','add','--detach',worktree,'HEAD');
  const [linked]=await listGitFileHistory(worktree,path.join(worktree,'nested','file.py'));
  assert.equal(path.relative(linked!.repository,worktree),'');
  assert.equal(await readGitOriginal(linked!),'old\n');
});

test('inherited Git context cannot redirect history or snapshot reads to another repository',async t=>{
  const f=await fixture(t);
  await commit(f.repository,f.target,'expected\n','Expected');
  const previous=new Map<string,string|undefined>();
  for(const [key,value] of Object.entries({GIT_DIR:path.join(f.directory,'wrong'),GIT_WORK_TREE:f.directory,GIT_INDEX_FILE:path.join(f.directory,'wrong-index'),GIT_OBJECT_DIRECTORY:path.join(f.directory,'wrong-objects'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.bare',GIT_CONFIG_VALUE_0:'true'})) {
    previous.set(key,process.env[key]);process.env[key]=value;
  }
  try {
    const [original]=await listGitFileHistory(f.repository,f.target);
    assert.equal(await readGitOriginal(original!),'expected\n');
  } finally {
    for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

test('changed working input or cancelled preparation cannot create a stale Git request',async t=>{
  for(const mode of ['changed','cancelled']) {
    const f=await fixture(t);await commit(f.repository,f.target,'old\n','Baseline');await writeFile(f.target,'new\n');
    const [original]=await listGitFileHistory(f.repository,f.target);
    let calls=0;
    await assert.rejects(createRequestFile({...options(f,original!),assertReady:async()=>{
      if(++calls===2) {if(mode==='cancelled')throw Error('Cancelled');await writeFile(f.target,'changed\n');}
    }}),mode==='cancelled'?/Cancelled/:/input file changed/);
    assert.equal((await readdir(f.repository)).some(name=>name.endsWith('.rr')),false);
  }
});

test('missing Git reports an actionable installation error',async t=>{
  const f=await fixture(t);await writeFile(f.target,'content\n');
  const previous=process.env.PATH;process.env.PATH='';
  try {await assert.rejects(listGitFileHistory(f.repository,f.target),/Git is not installed|PATH/);}
  finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});
