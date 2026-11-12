import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createRequestFile } from '../src/createRequestFile';
import { parseRequestDocument, resolveRequest } from '../src/request';

const project = path.resolve(__dirname, '..');
const scratch = path.join(project, '.codex-test');
async function fixture(t: TestContext, before = 'Let x > 0.\nkeep\n', after = 'Let x >= 0.\nkeep\n') {
  const ignore = await readFile(path.join(project, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.codex-\*\/$/m, 'Test scratch must be gitignored before creating it.');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'create-request-file-'));
  t.after(async () => {
    const relative = path.relative(scratch, directory);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const original = path.join(workspace, 'sample.tex');
  const proposed = path.join(directory, 'proposed.tex');
  await Promise.all([writeFile(original, before), writeFile(proposed, after)]);
  return { directory, workspace, original, proposed, before, after, options: { workspace, original: 'sample.tex', proposed } };
}

test('saved files produce a compact request with pending entries and leave both inputs unchanged', async t => {
  const f = await fixture(t);
  let readyCalls = 0;
  const output = await createRequestFile({ ...f.options, reason: 'Include zero.', assertReady: () => { readyCalls++; } });
  assert.equal(output, path.join(await realpath(f.workspace), 'sample.tex.rr'));
  const request = parseRequestDocument(await readFile(output, 'utf8'));
  assert.equal(request.path, 'sample.tex');
  assert.ok(Number.isFinite(Date.parse(request.time!)));
  assert.deepEqual(request.request, [{ line: 1, before: '>', after: '>=', reason: 'Include zero.', status: 'pending' }]);
  assert.equal(resolveRequest(request, f.before).file.after, f.after);
  assert.equal(await readFile(f.original, 'utf8'), f.before);
  assert.equal(await readFile(f.proposed, 'utf8'), f.after);
  assert.ok(readyCalls >= 3, 'Editor readiness is checked again after the final snapshot reads.');
});

test('line insertion and deletion produce explicit null fragments', async t => {
  for (const [before, after, entry] of [
    ['start\nend\n', 'start\nnew\nend\n', { line: 2, before: null, after: 'new' }],
    ['start\nobsolete\nend\n', 'start\nend\n', { line: 2, before: 'obsolete', after: null }],
  ] as const) {
    const f = await fixture(t, before, after);
    const request = parseRequestDocument(await readFile(await createRequestFile(f.options), 'utf8'));
    assert.deepEqual(request.request.map(({ line, before, after }) => ({ line, before, after })), [entry]);
    assert.equal(resolveRequest(request, before).file.after, after);
  }
});

test('a workspace-relative proposed path and a different output folder are supported', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, 'requests'));
  await writeFile(path.join(f.workspace, 'edited.tex'), f.after);
  const output = await createRequestFile({ ...f.options, proposed: 'edited.tex', output: 'requests/sample.tex.rr' });
  assert.equal(output, path.join(await realpath(f.workspace), 'requests', 'sample.tex.rr'));
});

test('existing output is preserved and reports that files are never overwritten', async t => {
  const f = await fixture(t);
  const output = path.join(f.workspace, 'sample.tex.rr');
  await writeFile(output, 'existing request');
  await assert.rejects(createRequestFile(f.options), /already exists.*never overwritten/);
  assert.equal(await readFile(output, 'utf8'), 'existing request');
  assert.equal(await readFile(f.original, 'utf8'), f.before);
});

test('the same input and a hard link to it are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(createRequestFile({ ...f.options, proposed: f.original }), /separate modified copy/);
  const alias = path.join(f.directory, 'alias.tex');
  await link(f.original, alias);
  await assert.rejects(createRequestFile({ ...f.options, proposed: alias }), /hard link/);
  assert.deepEqual(await readdir(f.workspace), ['sample.tex']);
});

test('original/output escapes, .git metadata and incorrect output names are rejected', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, '.git'));
  await writeFile(path.join(f.workspace, '.git', 'sample.tex'), f.before);
  for (const original of ['../proposed.tex', f.original, 'folder\\sample.tex']) {
    await assert.rejects(createRequestFile({ ...f.options, original }), /workspace-relative/);
  }
  await assert.rejects(createRequestFile({ ...f.options, original: '.git/sample.tex' }), /\.git/);
  await assert.rejects(createRequestFile({ ...f.options, output: '../sample.tex.rr' }), /inside the workspace/);
  await assert.rejects(createRequestFile({ ...f.options, output: '.git/sample.tex.rr' }), /\.git/);
  await assert.rejects(createRequestFile({ ...f.options, output: 'wrong.rr' }), /named sample.tex.rr/);
});

test('directory links cannot move the original or output outside the workspace', async t => {
  const f = await fixture(t);
  const external = path.join(f.directory, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'sample.tex'), f.before);
  await symlink(external, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createRequestFile({ ...f.options, original: 'escape/sample.tex' }), /inside the workspace/);
  await assert.rejects(createRequestFile({ ...f.options, output: 'escape/sample.tex.rr' }), /inside the workspace/);
  assert.deepEqual(await readdir(external), ['sample.tex']);
});

test('invalid UTF-8, binary and oversized inputs are rejected without output', async t => {
  const f = await fixture(t);
  for (const [bytes, error] of [
    [Buffer.from([0xc3, 0x28]), /valid UTF-8/],
    [Buffer.from('binary\0content'), /NUL/],
    [Buffer.alloc(5 * 1024 * 1024 + 1, 65), /5 MiB/],
  ] as const) {
    await writeFile(f.proposed, bytes);
    await assert.rejects(createRequestFile(f.options), error);
  }
  await assert.rejects(createRequestFile({ ...f.options, proposed: f.directory }), /regular file/);
  assert.deepEqual(await readdir(f.workspace), ['sample.tex']);
});

test('identical saved copies report no changes without creating a request', async t => {
  const f = await fixture(t, 'same\n', 'same\n');
  await assert.rejects(createRequestFile(f.options), /no changes to review/);
  assert.deepEqual(await readdir(f.workspace), ['sample.tex']);
});

test('readiness rejection before reading or before writing creates no output', async t => {
  for (const rejectOn of [1, 2, 3]) {
    const f = await fixture(t);
    let calls = 0;
    await assert.rejects(createRequestFile({ ...f.options, assertReady: async () => {
      if (++calls === rejectOn) throw new Error('Save your dirty document first.');
    } }), /dirty document/);
    assert.equal(calls, rejectOn);
    assert.deepEqual(await readdir(f.workspace), ['sample.tex']);
    assert.equal(await readFile(f.original, 'utf8'), f.before);
  }
});

test('changes to either saved input during preparation prevent stale output', async t => {
  for (const input of ['original', 'proposed'] as const) {
    const f = await fixture(t);
    let calls = 0;
    await assert.rejects(createRequestFile({ ...f.options, assertReady: async () => {
      if (++calls === 2) await writeFile(f[input], 'changed while preparing\n');
    } }), /input file changed/);
    assert.deepEqual(await readdir(f.workspace), ['sample.tex']);
  }
});
