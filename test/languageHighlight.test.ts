import assert from 'node:assert/strict';
import test from 'node:test';
import {computeInlineChanges, computeFileInlineChanges, type Decision} from '../src/core';
import {resolveRequest, type RequestEntry} from '../src/request';
import {createInlineDiffContext} from '../src/inlineDiffContext';

const changed = (segments: Array<{text: string; changed: boolean}>) => segments.filter(part => part.changed).map(part => part.text);
function check(path: string | undefined, before: string, after: string, oldChanged: string[], newChanged: string[]) {
  const rows = computeInlineChanges({before, after}, 1000, path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.before.map(part => part.text).join(''), before);
  assert.equal(rows[0]!.after.map(part => part.text).join(''), after);
  assert.deepEqual(changed(rows[0]!.before), oldChanged, path + ': ' + before);
  assert.deepEqual(changed(rows[0]!.after), newChanged, path + ': ' + after);
}
const entry = (line: number, before: string | null, after: string | null): RequestEntry => ({line, before, after, status: 'pending'});
function review(path: string, source: string, entries: RequestEntry[], statuses: Decision[] = []) {
  const resolved = resolveRequest({path, request: entries}, source);
  const decisions = Object.fromEntries(resolved.hunks.map((hunk, i) => [hunk.id, statuses[i] ?? 'pending']));
  const original = JSON.stringify(resolved);
  const highlights = computeFileInlineChanges(resolved.file, resolved.hunks, decisions, 1000);
  assert.equal(JSON.stringify(resolved), original, 'Display computation cannot mutate proposals, text, identities, or decisions');
  return {resolved, highlights, at: (index: number, row = 0) => {
    const result = highlights.get(resolved.hunks[index]!.id)?.[row]; assert.ok(result); return result;
  }};
}

test('Python highlights complete names, literals and operators without unchanged brackets', () => {
  const examples: [string, string, string[], string[]][] = [
    ['first_name', 'last_name', ['first_name'], ['last_name']],
    ['user.name', 'user.title', ['name'], ['title']],
    ['calculate(x)', 'calculate(y)', ['x'], ['y']],
    ['a[i+1]', 'a[i+2]', ['1'], ['2']],
    ['x-y', 'x+y', ['-'], ['+']],
    ['x <= limit', 'x < limit', ['<='], ['<']],
    ['rate = 0.95', 'rate = 0.99', ['0.95'], ['0.99']],
    ['value = 1_000', 'value = 2_000', ['1_000'], ['2_000']],
    ['"load old data"', '"load new data"', ['old'], ['new']],
    ['# remove old data', '# remove new data', ['old'], ['new']],
    ['"x-y"', '"x+y"', ['x-y'], ['x+y']],
    ['"\\n"', '"\\t"', ['\\n'], ['\\t']],
    ['f"Hello {name}"', 'f"Hello {user}"', ['name'], ['user']],
    ['f"{items[i+1]:.2f}"', 'f"{items[i+2]:.3f}"', ['1', '.2f'], ['2', '.3f']],
    ['    return x', '\treturn x', ['    '], ['\t']],
    ['한글_이름 = 1', '새로운_이름 = 1', ['한글_이름'], ['새로운_이름']],
  ];
  for (const [before, after, oldChanged, newChanged] of examples) check('src/app.py', before, after, oldChanged, newChanged);
  for (const path of ['APP.PY', 'app.pyw', 'stub.pyi']) check(path, 'f(x)', 'f(y)', ['x'], ['y']);
});

test('JavaScript and TypeScript compare operators, templates and string escapes as units', () => {
  for (const path of ['app.js', 'app.ts', 'app.mjs', 'app.cjs', 'app.mts', 'app.cts', 'app.jsx', 'app.tsx']) {
    check(path, 'user?.name === 1', 'user?.title !== 1', ['name ==='], ['title !==']);
    check(path, 'const n = 12n;', 'const n = 14n;', ['12n'], ['14n']);
    check(path, '"\\n"', '"\\t"', ['\\n'], ['\\t']);
    check(path, '`Hello ${user.name}`', '`Hello ${user.title}`', ['name'], ['title']);
  }
  check('app.ts', 'type Value = string | null;', 'type Value = number | null;', ['string'], ['number']);
});

test('JSON property names stay whole while values use words and literals', () => {
  for (const path of ['data.json', 'settings.jsonc']) {
    check(path, '{"old key": "old value"}', '{"new key": "new value"}', ['old key', 'old'], ['new key', 'new']);
    check(path, '{"fontSize": 14}', '{"fontSize": 16}', ['14'], ['16']);
    check(path, '{"offset": -1.5e-2}', '{"offset": -2.5e-2}', ['-1.5e-2'], ['-2.5e-2']);
  }
  const item = review('config.json', '{\n"old key"\n: "old value"\n}\n', [entry(2, 'old', 'new'), entry(3, 'old', 'new')]);
  assert.deepEqual(changed(item.at(0).before), ['old key']);
  assert.deepEqual(changed(item.at(1).before), ['old']);
});

test('Markdown prose keeps whole words and unchanged markup', () => {
  check('README.md', '**old title**', '**new title**', ['old'], ['new']);
  check('notes.markdown', '[old title](https://example.com)', '[new title](https://example.com)', ['old'], ['new']);
  check('README.md', 'Use `first_name` here.', 'Use `last_name` here.', ['first_name'], ['last_name']);
  check('README.md', '# Team notebook', '# Team handbook', ['notebook'], ['handbook']);
});

test('unchanged hunk lines advance lexical state on each side independently', () => {
  for (const path of ['app.py', 'app.ts', 'README.md']) {
    const opening = path.endsWith('.py') ? 'text = """' : path.endsWith('.ts') ? '/*' : '~~~python';
    const before = opening + '\na[i+1]\n', after = opening + '\na[i+2]\n';
    const rows = computeInlineChanges({before, after}, 1000, path);
    assert.deepEqual(changed(rows[1]!.before), [path.endsWith('.md') ? '1' : 'a[i+1]']);
    assert.deepEqual(changed(rows[1]!.after), [path.endsWith('.md') ? '2' : 'a[i+2]']);
  }
});

test('full source context handles Markdown fences outside separated pending blocks', () => {
  const source = '# Examples\n~~~python\na[i+1]\nunchanged = 0\nb[j+3]\n~~~\n**old title**\n~~~unknown\na[i+1]\n~~~\n';
  const item = review('README.md', source, [entry(3, '1', '2'), entry(5, '3', '4'), entry(7, 'old', 'new'), entry(9, '1', '2')]);
  assert.deepEqual(changed(item.at(0).before), ['1']);
  assert.deepEqual(changed(item.at(1).before), ['3']);
  assert.deepEqual(changed(item.at(2).before), ['old']);
  assert.deepEqual(changed(item.at(3).before), ['a[i+1]']);
});

test('full source context carries triple strings and block comments across separate changes', () => {
  for (const [path, opening, closing] of [['app.py', 'text = """', '"""'], ['app.js', '/*', '*/']]) {
    const source = opening + '\na[i+1]\n' + closing + '\na[i+1]\n';
    const item = review(path!, source, [entry(2, '1', '2'), entry(4, '1', '2')]);
    assert.deepEqual(changed(item.at(0).before), ['a[i+1]']);
    assert.deepEqual(changed(item.at(1).before), ['1']);
  }
});

test('displayed grammar respects earlier pending, accepted and ignored fence decisions', () => {
  const source = '# Examples\n~~~unknown\na[i+1]\n~~~\n';
  for (const status of ['pending', 'accepted', 'ignored'] as const) {
    const item = review('README.md', source, [entry(2, 'unknown', 'python'), entry(3, '1', '2')], [status, 'pending']);
    assert.deepEqual(changed(item.at(1).before), [status === 'accepted' ? '1' : 'a[i+1]']);
    assert.deepEqual(changed(item.at(1).after), [status === 'accepted' ? '2' : 'a[i+2]']);
    assert.equal(item.highlights.has(item.resolved.hunks[0]!.id), status === 'pending');
  }
});

test('same-anchor insertions and deletions map displayed pending rows without reparsing', () => {
  const source = 'prefix\n~~~python\na[i+1]\n~~~\n';
  const entries = [entry(1, null, 'one'), entry(1, null, 'two'), entry(1, 'prefix', null), entry(3, '1', '2')];
  for (const statuses of [
    ['accepted', 'pending', 'ignored', 'pending'],
    ['ignored', 'accepted', 'accepted', 'pending'],
    ['pending', 'pending', 'pending', 'pending'],
  ] as Decision[][]) {
    const item = review('README.md', source, entries, statuses);
    assert.deepEqual(changed(item.at(3).before), ['1']);
    assert.deepEqual(changed(item.at(3).after), ['2']);
  }
});

test('BOM and mixed line endings preserve offsets in document context', () => {
  const item = review('README.md', '\uFEFF~~~python\r\na[i+1]\r\n~~~\r', [entry(2, '1', '2')]);
  assert.deepEqual(changed(item.at(0).before), ['1']);
  assert.deepEqual(changed(item.at(0).after), ['2']);
  assert.equal(item.at(0).before.map(part => part.text).join(''), 'a[i+1]');
});

test('context exhaustion and oversized prefixes conservatively retain the whole changed line', () => {
  const item = review('README.md', 'x'.repeat(8193) + '\n~~~python\na[i+1]\n~~~\n', [entry(3, '1', '2')]);
  assert.deepEqual(changed(item.at(0).before), ['a[i+1]']);
  assert.deepEqual(changed(item.at(0).after), ['a[i+2]']);
  const context = createInlineDiffContext('app.py', 'a[i+1]', 'a[i+2]', Date.now() - 1);
  assert.equal(context.before(1, 'a[i+1]'), undefined);
  assert.equal(context.after(1, 'a[i+2]'), undefined);
  assert.deepEqual(changed(computeInlineChanges({before: 'f(x)', after: 'f(y)'}, 0, 'app.py')[0]!.before), ['f(x)']);
});

test('unknown extensions and .rr source names keep existing whitespace fallback', () => {
  for (const path of [undefined, 'app.unknown', 'app.py.rr']) check(path, 'a[i+1]', 'a[i+2]', ['a[i+1]'], ['a[i+2]']);
});
