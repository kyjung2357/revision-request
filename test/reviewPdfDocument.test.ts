import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {PDFDocument, StandardFonts, PDFName, PDFDict, PDFRawStream} from 'pdf-lib';
import {ReviewPdfDocumentStore} from '../src/reviewPdfDocument';
import {createPortableReviewPdf, readPortableReviewPdf, updatePortableReviewPdfDecision} from '../src/portableReviewPdf';
import {proposalIdentity, type RevisionRequest} from '../src/request';
import type {PdfReviewManifest, ReviewPdfSnapshot} from '../src/pdfReviewTypes';

const root = path.resolve(__dirname, '..'), scratch = path.join(root, '.codex-test-pdf-store');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let fixtureBytes: Promise<Uint8Array> | undefined;
function fixture() {
  return fixtureBytes ??= (async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 500]), font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('PDF autosave fixture', {x: 30, y: 440, size: 12, font});
    const request: RevisionRequest = {path: 'sample.tex', request: [1,2,3].map(line => ({line, before: 'old', after: 'new', status: 'pending'}))};
    const manifest: PdfReviewManifest = {format: 'revision-request-pdf', formatVersion: 1, exportId: 'autosave-test',
      createdAt: '2026-11-15T15:00:00Z', path: request.path, sourceHash: hash(Buffer.from('original')),
      proposalIdentity: proposalIdentity(request), request, entries: request.request.map((_, index) => ({id: 'change-' + index, index, originalDecision: 'pending'}))};
    return createPortableReviewPdf(await pdf.save(), manifest, manifest.entries.map((entry, index) => ({entryId: entry.id, page: 0, x: 30, y: 400 - index * 30})));
  })();
}
async function workspace(t: TestContext) {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /^\.codex-\*\/$/m);
  await fs.mkdir(scratch, {recursive: true});
  const folder = path.join(scratch, randomUUID()); await fs.mkdir(folder);
  const filename = path.join(folder, 'sample.tex.rr.pdf'); await fs.writeFile(filename, await fixture());
  t.after(async () => {
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved), scratch);
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return {folder, filename, store: new ReviewPdfDocumentStore()};
}
function deferred<T>() {let resolve!: (value: T) => void;const promise = new Promise<T>(done => {resolve = done;});return {promise, resolve};}

test('PDF decisions persist immediately, retain exact appearances and are readable after reopening', async t => {
  const {folder, filename, store} = await workspace(t), first = await store.load(filename);
  const saved = await store.saveDecision(filename, first.review.pdfHash, 'change-0', 'accepted');
  assert.equal(saved.review.decisions['change-0'], 'accepted');
  assert.equal((await readPortableReviewPdf(await fs.readFile(filename))).decisions['change-0'], 'accepted');
  assert.notEqual(saved.review.pdfHash, first.review.pdfHash);
  assert.deepEqual(saved.review.manifest, first.review.manifest);
  const ignored = await store.saveDecision(filename, saved.review.pdfHash, 'change-1', 'ignored');
  const pending = await store.saveDecision(filename, ignored.review.pdfHash, 'change-0', 'pending');
  await store.flush(filename);
  assert.deepEqual((await new ReviewPdfDocumentStore().load(filename)).review.decisions, {'change-0': 'pending', 'change-1': 'ignored', 'change-2': 'pending'});
  assert.equal(pending.review.pdfHash, hash(await fs.readFile(filename)));
  assert.deepEqual(await fs.readdir(folder), ['sample.tex.rr.pdf']);
  const initialPdf = await PDFDocument.load(first.bytes), savedPdf = await PDFDocument.load(pending.bytes);
  const getAppearance = (pdf: PDFDocument, index: number, appearance: string) => {
    const field = pdf.getForm().getRadioGroup('RRDecision_autosave-test_change-' + index);
    const widget = field.acroField.getWidgets()[0]!, normal = widget.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFDict);
    const stream = normal.lookup(PDFName.of(appearance)); assert.ok(stream instanceof PDFRawStream); return Buffer.from(stream.getContents());
  };
  assert.deepEqual(getAppearance(initialPdf, 0, 'accepted'), getAppearance(savedPdf, 0, 'accepted'));
  assert.deepEqual(getAppearance(initialPdf, 0, 'Off'), getAppearance(savedPdf, 0, 'Off'));
});

test('Accept up to here changes only pending entries in PDF display order', async t => {
  const {filename, store} = await workspace(t), first = await store.load(filename);
  const ignored = await store.saveDecision(filename, first.review.pdfHash, 'change-0', 'ignored');
  const accepted = await store.saveDecision(filename, ignored.review.pdfHash, 'change-1', 'accepted', true);
  assert.deepEqual(accepted.review.decisions, {'change-0': 'ignored', 'change-1': 'accepted', 'change-2': 'pending'});
  assert.deepEqual((await readPortableReviewPdf(await fs.readFile(filename))).decisions, accepted.review.decisions);
});

test('saving an unchanged choice does not rewrite the file', async t => {
  const {filename, store} = await workspace(t), first = await store.load(filename), before = await fs.stat(filename, {bigint: true});
  const result = await store.saveDecision(filename, first.review.pdfHash, 'change-0', 'pending');
  const after = await fs.stat(filename, {bigint: true});
  assert.equal(result.review.pdfHash, first.review.pdfHash);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
});

test('queued writes require the latest acknowledged hash and flush waits for the final outcome', async t => {
  const {filename} = await workspace(t), entered = deferred<void>(), release = deferred<void>();
  let active = 0, maximum = 0;
  const store = new ReviewPdfDocumentStore(async (...args) => {
    active++; maximum = Math.max(maximum, active);
    entered.resolve(); await release.promise;
    try {return await updatePortableReviewPdfDecision(...args);} finally {active--;}
  });
  const original = await store.load(filename);
  const first = store.saveDecision(filename, original.review.pdfHash, 'change-0', 'accepted');
  await entered.promise;
  const stale = store.saveDecision(filename, original.review.pdfHash, 'change-1', 'ignored');
  const staleCheck = assert.rejects(stale, /changed outside/);
  let flushed = false;
  const flushing = assert.rejects(store.flush(filename), /changed outside/).then(() => {flushed = true;});
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(flushed, false);
  release.resolve(); const saved = await first; await staleCheck; await flushing;
  assert.equal(maximum, 1);
  assert.deepEqual((await readPortableReviewPdf(await fs.readFile(filename))).decisions, {'change-0': 'accepted', 'change-1': 'pending', 'change-2': 'pending'});
  const next = await store.saveDecision(filename, saved.review.pdfHash, 'change-1', 'ignored');
  await store.flush(filename);
  assert.equal(next.review.decisions['change-1'], 'ignored');
});

test('an external replacement cannot be overwritten by a stale viewer', async t => {
  const {filename, store} = await workspace(t), first = await store.load(filename);
  const changed = await updatePortableReviewPdfDecision(first.bytes, 'change-2', 'accepted');
  await fs.writeFile(filename, changed.bytes);
  await assert.rejects(store.saveDecision(filename, first.review.pdfHash, 'change-0', 'ignored'), /changed outside/);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(changed.bytes));
  await assert.rejects(store.flush(filename), /changed outside/);
  assert.equal((await store.load(filename)).review.pdfHash, changed.review.pdfHash);
  await store.flush(filename);
});

test('replacement during PDF parsing is detected before committing any bytes', async t => {
  const {filename, folder} = await workspace(t), entered = deferred<void>(), release = deferred<void>();
  const store = new ReviewPdfDocumentStore(async (...args) => {
    const result = await updatePortableReviewPdfDecision(...args);
    entered.resolve(); await release.promise; return result;
  });
  const original = await store.load(filename);
  const pending = store.saveDecision(filename, original.review.pdfHash, 'change-0', 'accepted');
  const rejected = assert.rejects(pending, /changed outside/);
  await entered.promise;
  await fs.rename(filename, path.join(folder, 'previous.rr.pdf'));
  await fs.writeFile(filename, original.bytes); // identical bytes still belong to a different file identity
  release.resolve(); await rejected;
  assert.equal(hash(await fs.readFile(filename)), original.review.pdfHash);
  assert.deepEqual((await readPortableReviewPdf(await fs.readFile(filename))).decisions, original.review.decisions);
});

test('a PDF arriving at the commit gap is retained and the displaced original is recoverable', async t => {
  const {filename, folder, store} = await workspace(t), original = await store.load(filename);
  const arriving = await updatePortableReviewPdfDecision(original.bytes, 'change-2', 'ignored');
  const mutable = require('node:fs/promises') as typeof fs, originalLink = mutable.link;
  let inserted = false;
  mutable.link = async (existingPath, newPath) => {
    if (!inserted && String(existingPath).endsWith('next.pdf') && String(newPath) === filename) {
      inserted = true; await fs.writeFile(filename, arriving.bytes, {flag: 'wx'});
    }
    return originalLink(existingPath, newPath);
  };
  try {
    await assert.rejects(store.saveDecision(filename, original.review.pdfHash, 'change-0', 'accepted'), /previous PDF was kept/);
  } finally {mutable.link = originalLink;}
  assert.equal(inserted, true);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(arriving.bytes));
  const stages = (await fs.readdir(folder)).filter(name => name.startsWith('.codex-pdf-save-'));
  assert.equal(stages.length, 1);
  assert.deepEqual(await fs.readFile(path.join(folder, stages[0]!, 'previous.pdf')), Buffer.from(original.bytes));
});

test('malformed decision messages and unknown IDs never change file contents', async t => {
  const {filename, store} = await workspace(t), original = await store.load(filename);
  for (const id of ['__proto__', 'bad.field', 'bad\nfield', 'unknown']) {
    await assert.rejects(store.saveDecision(filename, original.review.pdfHash, id, 'accepted'), /Invalid|does not exist/);
  }
  await assert.rejects(store.saveDecision(filename, 'bad-hash', 'change-0', 'accepted'), /Invalid/);
  await assert.rejects(store.saveDecision(filename, original.review.pdfHash, 'change-0', 'ignored', true), /Invalid/);
  await assert.rejects(store.saveDecision(filename, original.review.pdfHash, 'change-0', 'bogus' as 'pending'), /Invalid/);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(original.bytes));
});

test('oversized files and hard-linked documents are rejected before parsing or writing', async t => {
  const {filename, folder, store} = await workspace(t), original = await store.load(filename);
  const linked = path.join(folder, 'linked.rr.pdf'); await fs.link(filename, linked);
  await assert.rejects(store.load(filename), /regular file/);
  await assert.rejects(store.saveDecision(filename, original.review.pdfHash, 'change-0', 'accepted'), /regular file/);
  await fs.unlink(linked);
  const oversized = path.join(folder, 'oversized.rr.pdf'), handle = await fs.open(oversized, 'wx');
  await handle.truncate(50 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(store.load(oversized), /50 MiB/);
  await assert.rejects(store.load(path.join(folder, 'plain.pdf')), /\.rr\.pdf/);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(original.bytes));
});

test('symbolic-link PDF files and junction parents are rejected', async t => {
  const {filename, folder, store} = await workspace(t), original = await store.load(filename);
  const link = path.join(folder, 'linked.rr.pdf');
  try {await fs.symlink(filename, link, 'file');}
  catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    t.diagnostic('File symlink creation unavailable; junction path is still checked below.');
  }
  try {await fs.lstat(link);await assert.rejects(store.load(link), /symbolic|redirected|regular/);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const real = path.join(folder, 'real'), redirected = path.join(folder, 'redirected');
  await fs.mkdir(real);await fs.writeFile(path.join(real, 'nested.rr.pdf'), original.bytes);
  try {await fs.symlink(real, redirected, process.platform === 'win32' ? 'junction' : 'dir');}
  catch (error) {if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {t.skip('Directory links unavailable on this device.');return;}throw error;}
  await assert.rejects(store.load(path.join(redirected, 'nested.rr.pdf')), /symbolic|redirected/);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(original.bytes));
});

test('an update worker failure leaves the PDF unchanged and prevents silent import', async t => {
  const {filename} = await workspace(t), store = new ReviewPdfDocumentStore(async (): Promise<ReviewPdfSnapshot> => {throw new Error('Simulated worker failure');});
  const original = await store.load(filename);
  await assert.rejects(store.saveDecision(filename, original.review.pdfHash, 'change-0', 'accepted'), /worker failure/);
  await assert.rejects(store.flush(filename), /worker failure/);
  assert.deepEqual(await fs.readFile(filename), Buffer.from(original.bytes));
});
