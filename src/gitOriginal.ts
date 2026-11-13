import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface GitOriginal {
  repository: string;
  path: string;
  /** A pinned full commit object ID, never a movable branch or revision expression. */
  commit: string;
  subject: string;
  date: string;
}
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HISTORY = 100;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function safePath(value: string): boolean {
  return Boolean(value) && !path.posix.isAbsolute(value) && !value.includes('\\') &&
    !/[:\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = {...process.env};
  // An MCP/client process can inherit another repository's Git context.
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_.*)?)$/i.test(key)) delete env[key];
  }
  return {...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1'};
}
function git(repository: string, args: string[], limit = 512 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--no-replace-objects', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-C', repository, ...args], {
      encoding: 'buffer', maxBuffer: limit, timeout: 10_000, windowsHide: true, env: gitEnvironment(),
    }, (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('Git is not installed or is not available on PATH.'));
        else if (error.killed || (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error('Git history or file content exceeds the time or size limit.'));
        } else reject(new Error('Git could not read this repository, commit, or file. Choose an available committed version.'));
      } else resolve(stdout);
    });
  });
}
function decode(bytes: Buffer, label: string): string {
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
  catch {throw new Error(label + ' is not valid UTF-8 text.');}
  if (text.includes('\0')) throw new Error(label + ' contains NUL bytes; only UTF-8 text files are supported.');
  return text;
}
async function repositoryRoot(directory: string): Promise<string> {
  const reported = decode(await git(directory, ['rev-parse', '--show-toplevel'], 32 * 1024), 'Git repository path').replace(/\r?\n$/, '');
  if (!path.isAbsolute(reported)) throw new Error('Choose a file inside a local Git working tree.');
  return realpath(reported);
}
async function gitTarget(workspace: string, target: string) {
  const root = await realpath(workspace);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace must identify an existing directory.');
  const candidate = path.resolve(target);
  if (!inside(root, candidate) || !safePath(path.relative(root, candidate).split(path.sep).join('/'))) {
    throw new Error('Select an existing target file inside the workspace, outside .git metadata.');
  }
  if (!(await lstat(candidate)).isFile()) throw new Error('The Git target must be an existing regular file, not a symbolic link.');
  const actual = await realpath(candidate);
  if (!inside(root, actual)) throw new Error('The Git target resolves outside the workspace.');
  const repository = await repositoryRoot(path.dirname(actual));
  const relative = path.relative(repository, actual).split(path.sep).join('/');
  if (!inside(repository, actual) || !safePath(relative)) throw new Error('The target must be a regular file inside the selected Git working tree.');
  return {repository, path: relative};
}
function validateSelection(selection: GitOriginal): void {
  if (!selection || typeof selection.repository !== 'string' || !path.isAbsolute(selection.repository) ||
      typeof selection.path !== 'string' || !safePath(selection.path) ||
      typeof selection.commit !== 'string' || !HASH.test(selection.commit)) {
    throw new Error('Choose a valid Git file and a full commit ID from its history.');
  }
}

/** The source picker uses current-branch history at the current path, without rename following. */
export async function listGitFileHistory(workspace: string, target: string): Promise<GitOriginal[]> {
  const location = await gitTarget(workspace, target);
  // An unborn repository has no refs. This also avoids an ambiguous HEAD error in a new repository.
  const heads = await git(location.repository, ['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/heads'], 1024);
  if (!heads.toString('ascii').trim()) {
    // Detached HEAD is valid even when no local branch remains.
    try {await git(location.repository, ['rev-parse', '--verify', 'HEAD^{commit}'], 1024);}
    catch {return [];}
  }
  const output = await git(location.repository, ['log', '-z', '--no-show-signature', '--no-notes', '--no-color', '--encoding=UTF-8', '--format=%H%x00%cI%x00%s',
    '--max-count=' + MAX_HISTORY, '--diff-filter=AMRT', 'HEAD', '--', location.path]);
  const parts = decodeHistory(output).split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 3) throw new Error('Git returned an invalid history response.');
  const result: GitOriginal[] = [];
  for (let index = 0; index < parts.length; index += 3) {
    const commit = parts[index]!, date = parts[index + 1]!, subject = parts[index + 2]!;
    if (!HASH.test(commit) || !Number.isFinite(Date.parse(date))) throw new Error('Git returned an invalid history entry.');
    result.push({...location, commit, date, subject});
  }
  return result;
}
function decodeHistory(bytes: Buffer): string {
  // NULs delimit fields in the machine-readable history protocol.
  try {return new TextDecoder('utf-8', {fatal: true}).decode(bytes);}
  catch {throw new Error('Git commit metadata is not valid UTF-8 text.');}
}

/** Rebind the pinned revision to the existing target instead of accepting an arbitrary Git blob. */
export async function validateGitOriginalTarget(workspace: string, target: string, selection: GitOriginal): Promise<GitOriginal> {
  validateSelection(selection);
  const location = await gitTarget(workspace, target);
  const selectedRoot = await realpath(selection.repository);
  if (path.relative(location.repository, selectedRoot) !== '' || location.path !== selection.path) {
    throw new Error('The selected Git version does not belong to the original target file. Select it again.');
  }
  return {...selection, repository: location.repository, path: location.path};
}

/** Read an immutable regular-file blob without checking out files, running filters, or fetching. */
export async function readGitOriginal(selection: GitOriginal): Promise<string> {
  validateSelection(selection);
  const repository = await realpath(selection.repository);
  if (path.relative(repository, await repositoryRoot(repository)) !== '') throw new Error('The selected Git working tree changed. Select the original again.');
  const kind = decode(await git(repository, ['cat-file', '-t', selection.commit], 1024), 'Git object type').trim();
  if (kind !== 'commit') throw new Error('The selected Git object is not a commit.');
  const tree = decodeHistory(await git(repository, ['ls-tree', '-z', selection.commit, '--', selection.path], 32 * 1024));
  const entries = tree.split('\0').filter(Boolean);
  if (entries.length !== 1) throw new Error('The selected file does not exist in this commit.');
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]*)$/.exec(entries[0]!);
  if (!match || !['100644', '100755'].includes(match[1]!) || match[2] !== 'blob' ||
      !HASH.test(match[3]!) || match[4] !== selection.path) {
    throw new Error('The selected Git file must be a regular file, not a symbolic link or submodule.');
  }
  const object = match[3]!;
  const sizeText = decode(await git(repository, ['cat-file', '-s', object], 1024), 'Git file size').trim();
  if (!/^\d+$/.test(sizeText) || Number(sizeText) > MAX_BYTES) throw new Error('The Git original exceeds the 5 MiB text limit.');
  const bytes = await git(repository, ['cat-file', 'blob', object], MAX_BYTES + 1);
  if (bytes.length > MAX_BYTES) throw new Error('The Git original exceeds the 5 MiB text limit.');
  return decode(bytes, 'Git original');
}
