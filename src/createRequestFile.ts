import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequestFromSnapshots } from './createRequest';
import { readGitOriginal, validateGitOriginalTarget, type GitOriginal } from './gitOriginal';

export interface CreateRequestFileOptions {
  workspace: string;
  original: string;
  proposed: string;
  output?: string;
  reason?: string;
  gitOriginal?: GitOriginal;
  assertReady?: () => void | Promise<void>;
}

const MAX_BYTES = 5 * 1024 * 1024;

function checkWorkspacePath(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error(`${label} must remain inside the workspace.`);
  }
  if (relative.split(path.sep).some(segment => segment.toLowerCase() === '.git')) {
    throw new Error(`${label} cannot be inside .git metadata.`);
  }
}

async function readSnapshot(file: string, label: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${label} must identify an existing regular file.`);
  if (info.size > MAX_BYTES) throw new Error(`${label} exceeds the 5 MiB text limit.`);
  const bytes = await readFile(file);
  if (bytes.length > MAX_BYTES) throw new Error(`${label} exceeds the 5 MiB text limit.`);
  let text: string;
  try {
    // A BOM is part of the original snapshot and must be preserved.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text.`);
  }
  if (text.includes('\0')) throw new Error(`${label} contains NUL bytes; only UTF-8 text files are supported.`);
  return { bytes, text, info };
}

/** Create a review request from two saved files without changing either input. */
export async function createRequestFile(options: CreateRequestFileOptions): Promise<string> {
  const originalArg = options.original;
  if (!originalArg.trim() || path.isAbsolute(originalArg) || /^[A-Za-z]:/.test(originalArg) ||
      originalArg.includes('\\') || originalArg.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Original must be a workspace-relative path using /, without . or .. segments.');
  }
  if (!options.proposed.trim()) throw new Error('Choose a separate saved proposed file.');
  const root = await realpath(options.workspace);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace must identify an existing directory.');
  const originalPath = path.resolve(root, originalArg);
  checkWorkspacePath(root, originalPath, 'Original file');
  const original = await realpath(originalPath);
  checkWorkspacePath(root, original, 'Original file');
  const proposedPath = path.resolve(root, options.proposed);
  const proposed = await realpath(proposedPath);

  const expectedName = path.posix.basename(originalArg) + '.rr';
  const requestedOutput = path.resolve(root, options.output ?? originalArg + '.rr');
  if (path.basename(requestedOutput) !== expectedName) {
    throw new Error(`Output must be named ${expectedName}, including the original extension.`);
  }
  checkWorkspacePath(root, requestedOutput, 'Output file');
  const outputParent = await realpath(path.dirname(requestedOutput));
  const output = path.join(outputParent, expectedName);
  checkWorkspacePath(root, output, 'Output file');

  await options.assertReady?.();
  const [before, after] = await Promise.all([
    readSnapshot(original, 'Original file'), readSnapshot(proposed, 'Proposed file'),
  ]);
  if (!options.gitOriginal && (original === proposed || (before.info.dev === after.info.dev && before.info.ino === after.info.ino))) {
    throw new Error('Proposed must be a separate modified copy, not the original file or a hard link to it.');
  }
  const gitOriginal = options.gitOriginal ? await validateGitOriginalTarget(root, original, options.gitOriginal) : undefined;
  // Git stores LF blobs even when a working tree uses CRLF. The request contains
  // logical line fragments and preserves the recipient's existing line endings.
  const beforeText = gitOriginal ? (await readGitOriginal(gitOriginal)).replace(/\r\n|\r/g, '\n') : before.text;
  const afterText = gitOriginal ? after.text.replace(/\r\n|\r/g, '\n') : after.text;
  if (beforeText === afterText) {
    throw new Error(gitOriginal ? 'The proposed file is identical to the Git original; there are no content changes to review.'
      : 'The proposed file is identical to the original; there are no changes to review.');
  }
  const request = createRequestFromSnapshots(originalArg, beforeText, afterText, { reason: options.reason });
  const serialized = JSON.stringify(request, null, 2) + '\n';

  // Recheck editor state and the saved inputs before committing the request.
  await options.assertReady?.();
  const [currentOriginal, currentProposed, currentParent] = await Promise.all([
    realpath(originalPath), realpath(proposedPath), realpath(path.dirname(requestedOutput)),
  ]);
  if (currentOriginal !== original || currentProposed !== proposed || currentParent !== outputParent) {
    throw new Error('An input or output path changed while preparing the request. Try again.');
  }
  const [currentBefore, currentAfter] = await Promise.all([
    readSnapshot(original, 'Original file'), readSnapshot(proposed, 'Proposed file'),
  ]);
  for (const [initial, current] of [[before, currentBefore], [after, currentAfter]] as const) {
    if (!initial.bytes.equals(current.bytes) || initial.info.dev !== current.info.dev ||
        initial.info.ino !== current.info.ino || initial.info.mtimeMs !== current.info.mtimeMs) {
      throw new Error('An input file changed while preparing the request. Save both files and try again.');
    }
  }
  if (gitOriginal) await validateGitOriginalTarget(root, original, gitOriginal);
  // Recheck cancellation, workspace trust, and editor state after the final reads.
  await options.assertReady?.();
  try {
    // Exclusive creation also rejects existing files and symbolic links.
    await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A request already exists at ${output}. Existing files are never overwritten; choose another folder or move the existing request.`);
    }
    throw error;
  }
  return output;
}
