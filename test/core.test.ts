import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeHunks,
  computeInlineChanges,
  validateRequestFile,
  renderAccepted,
  requestFingerprint,
  type Decision,
  type RequestFile,
} from '../src/core';

const make = (before: string, after: string, path = 'examples/manuscript.tex'): RequestFile => ({
  path, before, after,
});
test('snapshot validation preserves exact text and ignores untrusted internal groups', () => {
  const file = make('첫 줄\r\n😀 second', '첫 줄\r\n😀 revised\n');
  file.reason = 'Correct the coefficient.';
  assert.deepEqual(validateRequestFile({...file, reviewHunks: [{malicious: true}]}), file);
});

test('explanation metadata preserves exact text without changing hunk identities or application', () => {
  const base = make('old\ncontext\ntail\n', 'NEW\ncontext\nTAIL\n');
  const file = {
    ...base,
    reason: 'File-level fallback.',
    explanations: [
      { line: 1, text: '  Explain 한글 😀 exactly.\r\n' },
      { line: 3, text: '' },
      { line: Number.MAX_SAFE_INTEGER, text: 'Unused location is harmless metadata.' },
    ],
  };
  const parsed = validateRequestFile(file);
  assert.deepEqual(parsed, file);
  assert.deepEqual(computeHunks(parsed), computeHunks(base));
  const hunks = computeHunks(parsed);
  assert.equal(renderAccepted(base.before, hunks,
    Object.fromEntries(hunks.map(hunk => [hunk.id, 'accepted']))), base.after);
  assert.equal(Object.hasOwn(validateRequestFile(make('old\n', 'new\n')), 'explanations'), false);
  assert.deepEqual(validateRequestFile({...base, explanations: []}).explanations, []);
});

test('explanations reject malformed locations, duplicates, NUL and excessive UTF-8 text', () => {
  const file = make('old\n', 'new\n');
  const malformed: unknown[] = [
    null, {}, 'text', [null], [[]],
    [{line: 0, text: ''}], [{line: -1, text: ''}], [{line: 1.5, text: ''}],
    [{line: '1', text: ''}], [{line: Number.MAX_SAFE_INTEGER + 1, text: ''}],
    [{line: 1}], [{line: 1, text: null}], [{line: 1, text: 'x\0y'}],
    [{line: 1, text: '한'.repeat(16_667)}],
    [{line: 1, text: 'one'}, {line: 1, text: 'duplicate'}],
    Array.from({length: 10_001}, (_, index) => ({line: index + 1, text: ''})),
  ];
  for (const value of malformed) {
    assert.throws(() => validateRequestFile({...file, explanations: value}),
      /explanations/);
  }
  assert.equal(validateRequestFile({...file, explanations: [{line: 1, text: 'x'.repeat(50_000)}]}).explanations![0]!.text.length, 50_000);
});

test('opening and ignoring proposals leave the original text unchanged', () => {
  const file = make('alpha\nbeta\ngamma\ndelta\nepsilon\n', 'ALPHA\nbeta\ngamma\ndelta\nEPSILON\n');
  const hunks = computeHunks(file);
  assert.equal(hunks.length, 2);
  assert.equal(renderAccepted(file.before, hunks, {}), file.before);
  const decisions = Object.fromEntries(hunks.map(hunk => [hunk.id, 'ignored'])) as Record<string, Decision>;
  assert.equal(renderAccepted(file.before, hunks, decisions), file.before);
  assert.equal(file.before, 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
});

test('accepting groups out of order changes only the selected original locations', () => {
  const file = make('alpha\nbeta\ngamma\ndelta\nepsilon\n', 'ALPHA\nbeta\ngamma\ndelta\nEPSILON\nextra\n');
  const hunks = computeHunks(file);
  assert.equal(hunks.length, 2);
  const decisions: Record<string, Decision> = { [hunks[1]!.id]: 'accepted' };
  assert.equal(renderAccepted(file.before, hunks, decisions), 'alpha\nbeta\ngamma\ndelta\nEPSILON\nextra\n');
  decisions[hunks[0]!.id] = 'ignored';
  assert.equal(renderAccepted(file.before, hunks, decisions), 'alpha\nbeta\ngamma\ndelta\nEPSILON\nextra\n');
  decisions[hunks[0]!.id] = 'accepted';
  assert.equal(renderAccepted(file.before, hunks, decisions), file.after);
});

test('insertions and deletions remain independent even when earlier edits shift line numbers', () => {
  const file = make('one\ntwo\nthree\nfour\nfive\n', 'inserted\none\ntwo\nthree\nfive\n');
  const hunks = computeHunks(file);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.oldLines, 0);
  assert.equal(hunks[1]!.newLines, 0);
  assert.equal(renderAccepted(file.before, hunks, { [hunks[1]!.id]: 'accepted' }), 'one\ntwo\nthree\nfive\n');
  assert.equal(renderAccepted(file.before, hunks, { [hunks[0]!.id]: 'accepted' }), 'inserted\none\ntwo\nthree\nfour\nfive\n');
});

test('hunk offsets are UTF-16 and display context excludes line endings', () => {
  const file = make('😀 한글\r\nold\r\ntail\r\n', '😀 한글\r\nnew\r\ntail\r\n');
  const [hunk] = computeHunks(file);
  assert.equal(hunk!.start, '😀 한글\r\n'.length);
  assert.equal(hunk!.end, '😀 한글\r\nold\r\n'.length);
  assert.equal(hunk!.oldStart, 2);
  assert.equal(hunk!.newStart, 2);
  assert.deepEqual(hunk!.contextBefore, ['😀 한글']);
  assert.deepEqual(hunk!.contextAfter, ['tail']);
});

test('roundtrips empty documents, replacements, CRLF, CR and final-newline differences', () => {
  const pairs = [
    ['', ''],
    ['', 'new'],
    ['', '\n'],
    ['old', ''],
    ['old\n', ''],
    ['same', 'same'],
    ['text', 'text\n'],
    ['text\n', 'text'],
    ['a\r\nb\r\n', 'a\r\nB\r\n'],
    ['a\rb\r', 'A\rb\r'],
    ['a\r\nb\nlast', 'a\nB\r\nlast\n'],
    ['x\nx\nx\n', 'x\ny\nx\n'],
    ['\\alpha = 1.\n', '\\alpha = 2.\n'],
  ];
  for (const [before, after] of pairs) {
    const file = make(before!, after!);
    const hunks = computeHunks(file);
    const decisions = Object.fromEntries(hunks.map(hunk => [hunk.id, 'accepted'])) as Record<string, Decision>;
    assert.equal(renderAccepted(file.before, hunks, decisions), file.after, JSON.stringify([before, after]));
    assert.equal(renderAccepted(file.before, hunks, {}), file.before);
  }
});

test('seeded mixed-line-ending documents always reproduce exactly the proposed text', () => {
  let seed = 173;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const words = ['alpha', 'β', '한글', '😀', '', 'repeat'];
  const eols = ['\n', '\r\n', '\r'];
  const document = () => Array.from({ length: Math.floor(random() * 20) }, () =>
    words[Math.floor(random() * words.length)]! + eols[Math.floor(random() * eols.length)]!,
  ).join('') + (random() > 0.5 ? 'no-final-newline' : '');
  for (let iteration = 0; iteration < 150; iteration++) {
    const file = make(document(), document());
    const hunks = computeHunks(file);
    const accepted = Object.fromEntries(hunks.map(hunk => [hunk.id, 'accepted'])) as Record<string, Decision>;
    const ignored = Object.fromEntries(hunks.map(hunk => [hunk.id, 'ignored'])) as Record<string, Decision>;
    assert.equal(renderAccepted(file.before, hunks, accepted), file.after);
    assert.equal(renderAccepted(file.before, hunks, ignored), file.before);
  }
});

test('hunk identifiers are deterministic and content- and path-bound', () => {
  const file = make('old\n', 'new\n');
  assert.deepEqual(computeHunks(file), computeHunks({ ...file }));
  assert.notEqual(computeHunks(file)[0]!.id, computeHunks({ ...file, after: 'other\n' })[0]!.id);
  assert.notEqual(computeHunks(file)[0]!.id, computeHunks({ ...file, path: 'other.tex' })[0]!.id);
  assert.equal(requestFingerprint('same'), requestFingerprint('same'));
  assert.notEqual(requestFingerprint('same'), requestFingerprint('same '));
});

test('malformed snapshots fail with useful messages', () => {
  for (const value of [null, [], 'text']) assert.throws(() => validateRequestFile(value), /must be an object/);
  assert.throws(() => validateRequestFile({path: 'x.tex', before: 1, after: 'text'}), /before must be a string/);
  assert.throws(() => validateRequestFile(make('a\0b', 'text')), /NUL/);
});

test('paths cannot escape the workspace or alias Windows devices and streams', () => {
  for (const path of [
    '../proof.tex', 'folder/../proof.tex', './proof.tex', '/tmp/proof.tex',
    'C:/proof.tex', 'C:proof.tex', 'file:///proof.tex', 'folder\\proof.tex',
    '//server/share', 'folder//proof.tex', 'folder/', 'folder/file.tex:stream',
    'NUL.tex', 'folder/CON', 'proof.tex.', 'proof.tex ', 'folder/*',
  ]) {
    assert.throws(() => validateRequestFile(make('a', 'b', path)), { name: 'Error' }, path);
  }
  assert.equal(validateRequestFile(make('a', 'b', '2027c/Proof with spaces.tex')).path,
    '2027c/Proof with spaces.tex');
});

test('snapshot size limits prevent unbounded review input', () => {
  assert.throws(() => validateRequestFile(make('x'.repeat(5 * 1024 * 1024 + 1), 'small')), /byte limit/);
});

test('render rejects stale or overlapping change groups instead of producing a corrupt target', () => {
  const file = make('old\n', 'new\n');
  const [hunk] = computeHunks(file);
  assert.throws(() => renderAccepted('unrelated\n', [hunk!], { [hunk!.id]: 'accepted' }), /invalid, overlapping, or stale/);
  assert.throws(() => renderAccepted(file.before, [hunk!, hunk!], {}), /invalid, overlapping, or stale/);
  assert.throws(() => renderAccepted(file.before, [{ ...hunk!, start: -1 }], {}), /invalid, overlapping, or stale/);
  assert.throws(() => renderAccepted(file.before, [hunk!], { [hunk!.id]: 'typo' as Decision }), /invalid review decision/);
});

test('intraline comparison preserves separate common LaTeX stretches between multiple edits', () => {
  const before = '\\alpha = 2x + 3y.\\label{eq:estimate}\r\n';
  const after = '\\alpha = 1x + 4y.\\label{eq:estimate}\r\n';
  const hunk = computeHunks(make(before, after))[0]!;
  const snapshot = structuredClone(hunk);
  const [row] = computeInlineChanges(hunk);
  assert.deepEqual(row, {
    before: [
      {text: '\\alpha = ', changed: false}, {text: '2', changed: true},
      {text: 'x + ', changed: false}, {text: '3', changed: true},
      {text: 'y.\\label{eq:estimate}', changed: false},
    ],
    after: [
      {text: '\\alpha = ', changed: false}, {text: '1', changed: true},
      {text: 'x + ', changed: false}, {text: '4', changed: true},
      {text: 'y.\\label{eq:estimate}', changed: false},
    ],
  });
  assert.deepEqual(hunk, snapshot, 'Presentation metadata must not mutate a hunk or its identity.');
});

test('intraline Unicode edits keep whole code points and exact surrounding text', () => {
  const [row] = computeInlineChanges({before: '😀 한글 α = 2 🐱', after: '😁 한글 α = 3 🐱'});
  assert.deepEqual(row!.before.filter(segment => segment.changed).map(segment => segment.text), ['😀', '2']);
  assert.deepEqual(row!.after.filter(segment => segment.changed).map(segment => segment.text), ['😁', '3']);
  assert.equal(row!.before.map(segment => segment.text).join(''), '😀 한글 α = 2 🐱');
  assert.equal(row!.after.map(segment => segment.text).join(''), '😁 한글 α = 3 🐱');
  assert.ok(row!.before.some(segment => !segment.changed && segment.text === ' 한글 α = '));
});

test('intraline rows zip displayed source lines and preserve insertions, deletion and blank lines', () => {
  const rows = computeInlineChanges({before: '\r\nold\r\n', after: '\nNEW\rnew-tail'});
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {before: [{text: '', changed: false}], after: [{text: '', changed: false}]});
  assert.deepEqual(rows[1], {before: [{text: 'old', changed: true}], after: [{text: 'NEW', changed: true}]});
  assert.deepEqual(rows[2], {before: [], after: [{text: 'new-tail', changed: true}]});
  assert.deepEqual(computeInlineChanges({before: 'removed\n', after: ''}), [
    {before: [{text: 'removed', changed: true}], after: []},
  ]);
  assert.deepEqual(computeInlineChanges({before: 'same\r\nlast', after: 'same\nlast\n'}), [
    {before: [{text: 'same', changed: false}], after: [{text: 'same', changed: false}]},
    {before: [{text: 'last', changed: false}], after: [{text: 'last', changed: false}]},
  ]);
  assert.deepEqual(computeInlineChanges({before: '', after: ''}), []);
});

test('intraline work limits fall back to whole changed text without losing content', () => {
  const pairs = [
    {before: 'a'.repeat(8193) + 'x', after: 'a'.repeat(8193) + 'y'},
    {before: 'a'.repeat(1024), after: 'b'.repeat(1024)},
  ];
  for (const input of pairs) {
    assert.deepEqual(computeInlineChanges(input), [
      {before: [{text: input.before, changed: true}], after: [{text: input.after, changed: true}]},
    ]);
  }
  assert.deepEqual(computeInlineChanges({before: 'old tail', after: 'new tail'}, 0), [
    {before: [{text: 'old tail', changed: true}], after: [{text: 'new tail', changed: true}]},
  ]);
  assert.deepEqual(computeInlineChanges({before: 'same', after: 'same'}, 0), [
    {before: [{text: 'same', changed: false}], after: [{text: 'same', changed: false}]},
  ]);
});
