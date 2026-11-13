import assert from 'node:assert/strict';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';
import {computeInlineChanges} from '../src/core';
import {compute, type ReviewHighlightInput} from '../src/reviewHighlight';

const input = (overrides: Partial<ReviewHighlightInput> = {}): ReviewHighlightInput => ({
  path: 'app.py', before: 'a[i+1]\n', draft: 'a[i+2]',
  beforePrefix: '', afterPrefix: '', hasProposed: true, ...overrides,
});
const changed = (parts: Array<{text: string; changed: boolean}>) => parts.filter(part => part.changed).map(part => part.text);
const text = (parts: Array<{text: string; changed: boolean}>) => parts.map(part => part.text).join('');

test('live drafts use the same language rules as host inline highlights', () => {
  for (const [target, before, draft] of [
    ['app.py', 'a[i+1]', 'a[i+2]'],
    ['app.ts', 'user?.name === 1', 'user?.title !== 1'],
    ['paper.tex', String.raw`\alpha_{x}`, String.raw`\alpha_{y}`],
    ['data.json', '{"old key": "old value"}', '{"new key": "new value"}'],
    ['README.md', '**old title**', '**new title**'],
    ['notes.unknown', 'one old-name', 'one new-name'],
  ]) {
    const value = input({path: target!, before: before! + '\n', draft: draft!});
    assert.deepEqual(compute(value, 1000), computeInlineChanges({before: value.before, after: value.draft + '\n'}, 1000, target));
  }
  assert.deepEqual(changed(compute(input(), 1000)[0]!.after), ['2']);
});

test('every edit rebuilds Python, JavaScript and Markdown context from the full prefix', () => {
  for (const [target, prefix, expected] of [
    ['app.py', 'text = """\nunchanged\n', 'a[i+2]'],
    ['app.js', '/*\nunchanged\n', 'a[i+2]'],
    ['README.md', '# Example\n~~~python\nunchanged\n', '2'],
  ]) {
    const value = input({path: target, beforePrefix: prefix, afterPrefix: prefix});
    assert.deepEqual(changed(compute(value, 1000)[0]!.after), [expected]);
    assert.deepEqual(changed(compute({...value, draft: 'a[i+3]'}, 1000)[0]!.after), [expected === '2' ? '3' : 'a[i+3]']);
    assert.deepEqual(compute({...value, draft: 'a[i+1]'}, 1000)[0], {
      before: [{text: 'a[i+1]', changed: false}], after: [{text: 'a[i+1]', changed: false}],
    });
  }
});

test('visible sides retain distinct grammar after earlier proposal decisions', () => {
  for (const [target, left, right] of [
    ['README.md', '~~~unknown\n', '~~~python\n'],
    ['app.py', 'text = """\n', 'text = 0\n'],
    ['app.js', '/*\n', 'value = 0;\n'],
  ]) {
    const row = compute(input({path: target, beforePrefix: left, afterPrefix: right}), 1000)[0]!;
    assert.deepEqual(changed(row.before), ['a[i+1]']);
    assert.deepEqual(changed(row.after), ['a[i+2]']);
  }
});

test('drafts retain logical trailing blanks and distinguish a blank proposal from deletion', () => {
  const rows = compute(input({before: 'value\n', draft: 'value\n\n'}), 1000);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => text(row.after)), ['value', '', '']);
  assert.deepEqual(rows[1]!.after, [{text: '', changed: true}]);
  assert.deepEqual(rows[2]!.after, [{text: '', changed: true}]);
  assert.deepEqual(compute(input({before: '', draft: '', hasProposed: true}), 1000), [
    {before: [], after: [{text: '', changed: true}]},
  ]);
  assert.deepEqual(compute(input({before: '', draft: '', hasProposed: false}), 1000), []);
  assert.deepEqual(compute(input({draft: '', hasProposed: false}), 1000)[0]!.after, []);
});

test('mixed endings, BOM and an unterminated EOF prefix preserve lexical state', () => {
  for (const prefix of ['\uFEFF~~~python\r\nunchanged\r', '~~~python\nunchanged']) {
    const row = compute(input({path: 'README.md', beforePrefix: prefix, afterPrefix: prefix}), 1000)[0]!;
    assert.deepEqual(changed(row.before), ['1']);
    assert.deepEqual(changed(row.after), ['2']);
  }
});

test('costly or expired context falls back to whole lines without guessing local grammar', () => {
  const long = 'x'.repeat(8193) + '\n~~~python\n';
  const row = compute(input({path: 'README.md', beforePrefix: long, afterPrefix: long}), 1000)[0]!;
  assert.deepEqual(changed(row.before), ['a[i+1]']);
  assert.deepEqual(changed(row.after), ['a[i+2]']);
  const expired = compute(input(), 0)[0]!;
  assert.deepEqual(changed(expired.after), ['a[i+2]']);
});

test('browser IIFE exposes the shared engine without Node globals or built-in imports', async () => {
  const bundle = await build({absWorkingDir: path.resolve(__dirname, '..'),
    entryPoints: ['src/reviewHighlight.ts'], bundle: true, platform: 'browser', format: 'iife',
    globalName: 'RRHighlight', write: false, metafile: true, logLevel: 'silent'});
  assert.ok(Object.keys(bundle.metafile!.inputs).every(name => !name.includes('src/core.ts')));
  const global: {RRHighlight?: {compute: typeof compute}} = {};
  runInNewContext(bundle.outputFiles[0]!.text, global);
  assert.equal(typeof global.RRHighlight?.compute, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(global.RRHighlight!.compute(input()))), compute(input(), 1000));
});
