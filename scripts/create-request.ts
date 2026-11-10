import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseRequest } from '../src/core';

const help = `Create a .rr revision request without modifying the original file.

Usage:
  npm run request -- --workspace <folder> --original <relative-file>
    --proposed <modified-copy> --title <title>
    [--output <original.ext.rr>]
    [--reason <reason>]

Paths are resolved from --workspace (defaults to the current directory).
--original must be a workspace-relative path using forward slashes.
--proposed may also be an absolute path to a separate modified copy.
--output defaults to <original path>.rr beside the original.
An explicit output must keep the name <complete-original-filename>.rr,
remain inside the workspace, and not already exist.
The output directory must already exist. Existing files are never overwritten.
`;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' &&
      !relative.startsWith('..' + path.sep));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    // Keep a UTF-8 BOM in the content snapshot, if present.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text.`);
  }
  if (text.includes('\0')) {
    throw new Error(`${label} contains NUL bytes; only UTF-8 text files are supported.`);
  }
  return text;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string', default: process.cwd() },
      original: { type: 'string' },
      proposed: { type: 'string' },
      output: { type: 'string' },
      title: { type: 'string' },
      reason: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  for (const key of ['original', 'proposed', 'title'] as const) {
    if (!values[key]?.trim()) {
      throw new Error(`Missing --${key}. Run with --help for usage.`);
    }
  }
  const originalArg = values.original!;
  if (path.isAbsolute(originalArg) || /^[A-Za-z]:/.test(originalArg) ||
      originalArg.includes('\\') || originalArg.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('--original must be a relative path using /, without . or .. segments.');
  }

  const root = await realpath(values.workspace!);
  if (!(await stat(root)).isDirectory()) {
    throw new Error('--workspace must identify an existing directory.');
  }
  const original = await realpath(path.resolve(root, originalArg));
  if (!contained(root, original)) {
    throw new Error('The original file resolves outside the workspace.');
  }
  const proposed = await realpath(path.resolve(root, values.proposed!));
  if (!(await stat(original)).isFile() || !(await stat(proposed)).isFile()) {
    throw new Error('Both --original and --proposed must identify regular files.');
  }
  if (original === proposed) {
    throw new Error('--proposed must be a separate modified copy, not the original file.');
  }

  const expectedName = path.posix.basename(originalArg) + '.rr';
  const requestedOutput = path.resolve(root, values.output ?? originalArg + '.rr');
  if (path.basename(requestedOutput) !== expectedName) {
    throw new Error(`--output must be named ${expectedName}, including the original extension.`);
  }
  if (path.extname(requestedOutput) !== '.rr') {
    throw new Error('--output must have the .rr extension.');
  }
  const outputParent = await realpath(path.dirname(requestedOutput));
  const output = path.join(outputParent, path.basename(requestedOutput));
  if (!contained(root, output)) {
    throw new Error('The output file must remain inside the workspace.');
  }

  const [beforeBytes, afterBytes] = await Promise.all([
    readFile(original),
    readFile(proposed),
  ]);
  const before = decodeUtf8(beforeBytes, 'Original file');
  const after = decodeUtf8(afterBytes, 'Proposed file');
  if (before === after) {
    throw new Error('The proposed file is identical to the original; there are no changes to review.');
  }
  const file = {
    path: originalArg,
    before,
    after,
    ...(values.reason ? { reason: values.reason } : {}),
  };
  const request = { version: 1, title: values.title!, files: [file] };
  const serialized = JSON.stringify(request, null, 2) + '\n';
  parseRequest(serialized);
  // wx is an exclusive create: do not silently replace an existing proposal.
  await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`Created ${output}\nOriginal file unchanged: ${original}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Revision Request: ${message}\n`);
  process.exitCode = 1;
});
