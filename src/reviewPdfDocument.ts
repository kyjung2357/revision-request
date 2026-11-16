import path from 'node:path';
import * as fs from 'node:fs/promises';
import {constants, type BigIntStats} from 'node:fs';
import {createHash} from 'node:crypto';
import {readPortableReviewPdf, updatePortableReviewPdfDecision} from './portableReviewPdf';
import type {ReviewPdfSnapshot} from './pdfReviewTypes';
import type {Decision} from './core';

const MAX_PDF = 50 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const normalized = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs].join(':');
const stamp = (stat: BigIntStats) => [identity(stat), stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
const movedStamp = (stat: BigIntStats) => [identity(stat), stat.size, stat.mtimeNs].join(':');
interface DirectoryIdentity {filename: string; identity: string}
interface FileSnapshot {bytes: Buffer; stat: BigIntStats; parents: DirectoryIdentity[]}
function filenameOf(value: string) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || !/\.rr\.pdf$/i.test(value)) {
    throw new Error('Choose an existing local .rr.pdf file.');
  }
  return path.resolve(value);
}
function checkFile(stat: BigIntStats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('The review PDF must be a regular file without symbolic or hard links.');
  if (stat.size < 8n || stat.size > BigInt(MAX_PDF)) throw new Error('Choose a PDF review file within the 50 MiB limit.');
}
async function directories(filename: string): Promise<DirectoryIdentity[]> {
  const parent = path.dirname(filename), parsed = path.parse(parent), result: DirectoryIdentity[] = [];
  let current = parsed.root;
  for (const segment of ['', ...parent.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const info = await fs.lstat(current, {bigint: true});
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(await fs.realpath(current)) !== normalized(current)) {
      throw new Error('Review PDF folders must not use symbolic links or redirected paths.');
    }
    result.push({filename: current, identity: identity(info)});
  }
  return result;
}
async function assertDirectories(expected: DirectoryIdentity[]) {
  const actual = await directories(path.join(expected.at(-1)!.filename, 'check.rr.pdf'));
  if (actual.length !== expected.length || actual.some((value, index) => value.identity !== expected[index]!.identity || normalized(value.filename) !== normalized(expected[index]!.filename))) {
    throw new Error('The review PDF folder changed. Reopen the PDF before saving.');
  }
}
async function readFileSnapshot(filename: string): Promise<FileSnapshot> {
  const parents = await directories(filename);
  const before = await fs.lstat(filename, {bigint: true}); checkFile(before);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({bigint: true}); checkFile(opened);
    if (stamp(opened) !== stamp(before)) throw new Error('The review PDF changed while opening.');
    const buffer = Buffer.alloc(Number(opened.size) + 1); let used = 0;
    while (used < buffer.length) {
      const {bytesRead} = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({bigint: true}), current = await fs.lstat(filename, {bigint: true});
    checkFile(after); checkFile(current);
    if (used !== Number(opened.size) || stamp(after) !== stamp(opened) || stamp(current) !== stamp(opened)) {
      throw new Error('The review PDF changed while reading.');
    }
    await assertDirectories(parents);
    return {bytes: buffer.subarray(0, used), stat: opened, parents};
  } finally {await handle.close();}
}
async function unchanged(filename: string, original: FileSnapshot) {
  await assertDirectories(original.parents);
  const current = await readFileSnapshot(filename);
  if (stamp(current.stat) !== stamp(original.stat) || sha256(current.bytes) !== sha256(original.bytes)) {
    throw new Error('The review PDF changed outside this viewer. Reopen it before saving.');
  }
}
async function install(filename: string, original: FileSnapshot, bytes: Uint8Array) {
  await unchanged(filename, original);
  const parent = path.dirname(filename), stage = await fs.mkdtemp(path.join(parent, '.codex-pdf-save-'));
  const temporary = path.join(stage, 'next.pdf'), backup = path.join(stage, 'previous.pdf');
  let displaced = false, installed = false, retain = false;
  try {
    await assertDirectories(original.parents);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
    await unchanged(filename, original);
    // Exclusive installation never overwrites a PDF that arrives during this save.
    await fs.rename(filename, backup); displaced = true;
    const moved = await readFileSnapshot(backup);
    if (movedStamp(moved.stat) !== movedStamp(original.stat) || sha256(moved.bytes) !== sha256(original.bytes)) {
      throw new Error('The review PDF was replaced during saving.');
    }
    await assertDirectories(original.parents);
    await fs.link(temporary, filename); installed = true;
    await fs.unlink(temporary);
  } catch (error) {
    if (displaced && !installed) {
      try {
        await assertDirectories(original.parents);
        const moved = await fs.lstat(backup, {bigint: true}); checkFile(moved);
        await fs.link(backup, filename); // fails if another file now occupies the path
        await fs.unlink(backup);
      } catch {
        retain = true;
        throw new Error((error instanceof Error ? error.message : 'PDF saving failed.') +
          ' The previous PDF was kept at "' + backup + '" because its original path could not be restored safely.');
      }
    }
    throw error;
  } finally {
    if (!retain) {
      try {
        await assertDirectories(original.parents);
        const info = await fs.lstat(stage);
        if (info.isDirectory() && !info.isSymbolicLink() && path.dirname(path.resolve(stage)) === parent) {
          await fs.rm(stage, {recursive: true, force: true});
        }
      } catch { /* Never follow a changed parent path while cleaning temporary files. */ }
    }
  }
}

/** Serializes semantic PDF decisions; a caller never supplies replacement PDF bytes. */
export class ReviewPdfDocumentStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, Error>();
  constructor(private readonly update = updatePortableReviewPdfDecision) {}
  private enqueue<T>(filename: string, action: () => Promise<T>): Promise<T> {
    const key = normalized(filename), previous = this.queues.get(key);
    const task = (previous ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, task);
    return task.then(value => {
      this.failures.delete(key);
      if (this.queues.get(key) === task) this.queues.delete(key);
      return value;
    }, error => {
      const failure = error instanceof Error ? error : new Error('PDF saving failed.');
      this.failures.set(key, failure);
      if (this.queues.get(key) === task) this.queues.delete(key);
      throw failure;
    });
  }
  async load(value: string): Promise<ReviewPdfSnapshot> {
    const filename = filenameOf(value);
    return this.enqueue(filename, async () => {
      const snapshot = await readFileSnapshot(filename), review = await readPortableReviewPdf(snapshot.bytes);
      await unchanged(filename, snapshot);
      return {bytes: snapshot.bytes, review};
    });
  }
  async saveDecision(value: string, expectedPdfHash: string, entryId: string, decision: Decision, through = false): Promise<ReviewPdfSnapshot> {
    const filename = filenameOf(value);
    if (typeof expectedPdfHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPdfHash) ||
        typeof entryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entryId) || entryId === '__proto__' ||
        !['pending', 'accepted', 'ignored'].includes(decision) || typeof through !== 'boolean' || (through && decision !== 'accepted')) {
      throw new Error('Invalid PDF review decision.');
    }
    return this.enqueue(filename, async () => {
      const before = await readFileSnapshot(filename);
      if (sha256(before.bytes) !== expectedPdfHash) throw new Error('The review PDF changed outside this viewer. Reopen it before saving.');
      const saved = await this.update(before.bytes, entryId, decision, through);
      if (!(saved.bytes instanceof Uint8Array) || saved.bytes.length > MAX_PDF || saved.review.pdfHash !== sha256(saved.bytes)) {
        throw new Error('Invalid PDF save result.');
      }
      if (saved.review.pdfHash === expectedPdfHash) await unchanged(filename, before);
      else await install(filename, before, saved.bytes);
      return saved;
    });
  }
  async flush(value: string): Promise<void> {
    const filename = filenameOf(value), key = normalized(filename);
    // Include a save enqueued while the previous one was completing.
    let pending: Promise<unknown> | undefined;
    while ((pending = this.queues.get(key))) {
      try {await pending;} catch { /* report the final queued outcome below */ }
      if (this.queues.get(key) === pending) await Promise.resolve();
    }
    const failure = this.failures.get(key);
    if (failure) throw failure;
  }
}
