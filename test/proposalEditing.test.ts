import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeHunks, renderAccepted, type Decision, type RequestFile } from '../src/core';
import { editPendingHunk, replaceRequestAfter } from '../src/proposalEditing';

const file = (before: string, after: string): RequestFile => ({ path: 'src/example.tex', before, after });
const target = (proposal: RequestFile, decisions: Record<string, Decision>) =>
  renderAccepted(proposal.before, computeHunks(proposal), decisions);
const firstId = (proposal: RequestFile) => computeHunks(proposal)[0]!.id;

test('editing a middle pending block preserves earlier insertion offsets, all resolved decisions, metadata, and target bytes', () => {
  const proposal: RequestFile = {
    ...file('head\nold A\nkeep A\nold B\nkeep B\nold C\ntail\n',
      'intro 😀\nhead\nnew A\nkeep A\nnew B\nkeep B\nnew C\ntail\n'),
    reason: 'Default explanation.',
    explanations: [{ line: 4, text: 'Edit only B.' }, { line: 6, text: 'Keep C accepted.' }],
  };
  const hunks = computeHunks(proposal);
  assert.equal(hunks.length, 4);
  const decisions: Record<string, Decision> = {
    [hunks[0]!.id]: 'accepted', [hunks[1]!.id]: 'ignored', [hunks[2]!.id]: 'pending', [hunks[3]!.id]: 'accepted',
  };
  const originalProposal = structuredClone(proposal);
  const originalDecisions = { ...decisions };
  const expected = target(proposal, decisions);
  const result = editPendingHunk(proposal, decisions, hunks[2]!.id, 'revised B 😀\nadded B\n');
  assert.equal(result.changed, true);
  assert.equal(result.file.after, 'intro 😀\nhead\nnew A\nkeep A\nrevised B 😀\nadded B\nkeep B\nnew C\ntail\n');
  assert.equal(result.file.before, proposal.before);
  assert.deepEqual(result.file.explanations, proposal.explanations);
  assert.equal(result.file.reason, proposal.reason);
  for (const hunk of [hunks[0]!, hunks[1]!, hunks[3]!]) assert.equal(result.decisions[hunk.id], decisions[hunk.id]);
  assert(!Object.hasOwn(result.decisions, hunks[2]!.id));
  assert.equal(target(result.file, result.decisions), expected);
  assert.deepEqual(proposal, originalProposal);
  assert.deepEqual(decisions, originalDecisions);
});

test('LF-normalized no-op preserves mixed line ending bytes, no final newline, and prunes stale pending keys', () => {
  const proposal = file('old 1\r\nold 2\nold 3\rold 4', 'first\r\nsecond\nthird\rlast');
  const result = editPendingHunk(proposal, { obsolete: 'pending' }, firstId(proposal), 'first\nsecond\nthird\nlast');
  assert.equal(result.changed, false);
  assert.strictEqual(result.file, proposal);
  assert.equal(result.file.after, 'first\r\nsecond\nthird\rlast');
  assert.deepEqual(result.decisions, { [firstId(proposal)]: 'pending' });
});

test('unchanged proposal lines retain mixed endings while a changed line uses the existing block ending', () => {
  const proposal = file('old 1\r\nold 2\nold 3\rold 4', 'first\r\nsecond\nthird\rlast');
  const result = editPendingHunk(proposal, {}, firstId(proposal), 'first\nedited\nthird\nlast');
  assert.equal(result.file.after, 'first\r\nedited\r\nthird\rlast');
  assert.equal(target(result.file, result.decisions), proposal.before);
});

test('CRLF replacement preserves exact text outside the edited block and uses CRLF for added lines', () => {
  const proposal = file('prefix\r\nold A\r\nold B\r\nsuffix\n', 'prefix\r\nnew A\r\nnew B\r\nsuffix\n');
  const result = editPendingHunk(proposal, {}, firstId(proposal), 'new A\nchanged B\nadded C\n');
  assert.equal(result.file.after, 'prefix\r\nnew A\r\nchanged B\r\nadded C\r\nsuffix\n');
  assert.equal(result.file.before, proposal.before);
});

test('final newline presence follows the draft in both directions', () => {
  const proposal = file('context\r\nold', 'context\r\nnew');
  const added = editPendingHunk(proposal, {}, firstId(proposal), 'new\n');
  assert.equal(added.file.after, 'context\r\nnew\r\n');
  const removed = editPendingHunk(added.file, added.decisions, firstId(added.file), 'newer');
  assert.equal(removed.file.after, 'context\r\nnewer');
  assert.equal(target(removed.file, removed.decisions), proposal.before);
});

test('pure insertion can grow or disappear without editing its original', () => {
  const proposal = file('start\nend\n', 'start\nnew\nend\n');
  const grown = editPendingHunk(proposal, {}, firstId(proposal), 'first\nsecond\n');
  assert.equal(grown.file.after, 'start\nfirst\nsecond\nend\n');
  assert.equal(target(grown.file, grown.decisions), proposal.before);
  const removed = editPendingHunk(proposal, {}, firstId(proposal), '');
  assert.equal(removed.changed, true);
  assert.equal(removed.file.after, proposal.before);
  assert.deepEqual(removed.decisions, {});
});

test('pure deletion has an exact empty no-op and can become a replacement using removed source EOL', () => {
  const proposal = file('start\r\nold\r\nend\r\n', 'start\r\nend\r\n');
  const id = firstId(proposal);
  assert.equal(editPendingHunk(proposal, {}, id, '').changed, false);
  const restored = editPendingHunk(proposal, {}, id, 'replacement\nmore\n');
  assert.equal(restored.file.after, 'start\r\nreplacement\r\nmore\r\nend\r\n');
  assert.equal(target(restored.file, restored.decisions), proposal.before);
});

test('restoring internal baseline lines splits a pending block into independent pending blocks', () => {
  const proposal: RequestFile = { ...file('a\nb\nc\n', 'A\nB\nC\n'), explanations: [{ line: 1, text: 'First.' }, { line: 3, text: 'Last.' }] };
  const result = editPendingHunk(proposal, {}, firstId(proposal), 'A\nb\nC\n');
  const hunks = computeHunks(result.file);
  assert.deepEqual(hunks.map(hunk => hunk.oldStart), [1, 3]);
  assert.deepEqual(Object.values(result.decisions), ['pending', 'pending']);
  assert.deepEqual(result.file.explanations, proposal.explanations);
  assert.equal(target(result.file, result.decisions), proposal.before);
});

test('restoring a pending replacement leaves another accepted block intact', () => {
  const proposal = file('old\ncontext\nlast\n', 'new\ncontext\nLAST\n');
  const hunks = computeHunks(proposal);
  const decisions: Record<string, Decision> = { [hunks[1]!.id]: 'accepted' };
  const result = editPendingHunk(proposal, decisions, hunks[0]!.id, 'old\n');
  assert.equal(result.file.after, 'old\ncontext\nLAST\n');
  assert.deepEqual(result.decisions, decisions);
  assert.equal(target(result.file, result.decisions), target(proposal, decisions));
});

test('accepted and ignored blocks cannot be edited, including identical drafts', () => {
  const proposal = file('old\n', 'new\n');
  for (const decision of ['accepted', 'ignored'] as const) {
    for (const draft of ['new\n', 'edited\n']) {
      assert.throws(() => editPendingHunk(proposal, { [firstId(proposal)]: decision }, firstId(proposal), draft), /Only pending/);
    }
  }
});

test('an edit that merges a resolved neighboring block is rejected without mutating inputs', () => {
  const proposal = file('a\nseparator\nc\n', 'A\nseparator\nC\n');
  const hunks = computeHunks(proposal);
  for (const decision of ['accepted', 'ignored'] as const) {
    const decisions = { [hunks[1]!.id]: decision };
    assert.throws(() => editPendingHunk(proposal, decisions, hunks[0]!.id, 'A'), /merge or change/);
    assert.equal(proposal.after, 'A\nseparator\nC\n');
    assert.deepEqual(decisions, { [hunks[1]!.id]: decision });
  }
});

test('unknown hunks, stale resolved decisions, and invalid decision values are rejected', () => {
  const proposal = file('old\n', 'new\n');
  assert.throws(() => editPendingHunk(proposal, {}, 'missing', 'edited\n'), /no longer exists/);
  assert.throws(() => editPendingHunk(proposal, { missing: 'accepted' }, firstId(proposal), 'edited\n'), /stale or missing/);
  assert.throws(() => editPendingHunk(proposal, { missing: 'ignored' }, firstId(proposal), 'edited\n'), /stale or missing/);
  assert.throws(() => editPendingHunk(proposal, { [firstId(proposal)]: 'invalid' as Decision }, firstId(proposal), 'edited\n'), /invalid review decision/);
});

test('invalid NUL, unpaired Unicode, and oversized UTF-8 drafts are rejected', () => {
  const proposal = file('old\n', 'new\n');
  for (const draft of ['bad\0text', '\uD800', '\uDC00', '한'.repeat(Math.floor(5 * 1024 * 1024 / 3) + 1)]) {
    assert.throws(() => editPendingHunk(proposal, {}, firstId(proposal), draft), /NUL|surrogate|5 MiB/);
  }
  assert.throws(() => editPendingHunk(file('old\n', 'bad\uD800'), {}, 'unused', 'new'), /surrogate/);
});

test('UTF-8 BOM is preserved, cannot be added or removed, and valid Unicode remains literal', () => {
  const proposal = file('\uFEFFold\r\n', '\uFEFFnew\r\n');
  const result = editPendingHunk(proposal, {}, firstId(proposal), '\uFEFF수정 😀\n');
  assert.equal(result.file.after, '\uFEFF수정 😀\r\n');
  assert.throws(() => editPendingHunk(proposal, {}, firstId(proposal), 'without BOM\n'), /BOM/);
  const noBom = file('old\n', 'new\n');
  assert.throws(() => editPendingHunk(noBom, {}, firstId(noBom), '\uFEFFadded BOM\n'), /BOM/);
});

test('restored line endings cannot expand the full proposed snapshot beyond its byte limit', () => {
  const proposal = file('old\r\n', 'new\r\n');
  const draft = 'x'.repeat(5 * 1024 * 1024 - 1) + '\n';
  assert.throws(() => editPendingHunk(proposal, {}, firstId(proposal), draft), /5 MiB/);
});

test('raw request replacement preserves BOM, formatting, large numeric metadata, and every other token', () => {
  const raw = '\uFEFF{\r\n  "version": 1,\r\n  "title": "Review",\r\n  "huge": 9007199254740993123456789,\r\n' +
    '  "nested": {"after":"untouched", "syntax":"} [ \\" \\\\"},\r\n  "files": [{\r\n' +
    '    "path": "example.py", "before": "old\\r\\n", "custom": [null,true,{"n":12345678901234567890}],\r\n' +
    '    "after" : "new\\r\\n", "reason":"Keep me"\r\n  }]\r\n}\r\n';
  const updated = replaceRequestAfter(raw, '새 제안 😀\r\n');
  assert.equal(updated, raw.replace('"after" : "new\\r\\n"', '"after" : "새 제안 😀\\r\\n"'));
  assert.equal(JSON.parse(updated.slice(1)).files[0].after, '새 제안 😀\r\n');
});

test('raw request replacement follows last duplicate files/after keys including escaped property names', () => {
  const raw = '{"version":1,"title":"Review","files":[{"after":"old unused"}],' +
    '"fi\\u006ces":[{"path":"x.py","before":"old\\n","after":"first unused",' +
    '"af\\u0074er":"N\\u0045W\\n","metadata":{"after":"nested unused"}}]}';
  const updated = replaceRequestAfter(raw, 'edited\n');
  assert.equal(updated, raw.replace('"af\\u0074er":"N\\u0045W\\n"', '"af\\u0074er":"edited\\n"'));
  assert.equal(JSON.parse(updated).files[0].after, 'edited\n');
});

test('raw no-op retains existing Unicode escapes and request whitespace exactly', () => {
  const raw = ' \r\n{"version":1,"title":"Review","files":[{"path":"x.py","before":"old","after":"n\\u0065w"}]}\t';
  assert.equal(replaceRequestAfter(raw, 'new'), raw);
});

test('raw replacement rejects invalid requests and invalid new snapshots', () => {
  const raw = JSON.stringify({version: 1, title: 'Review', files: [file('old\n', 'new\n')]});
  assert.throws(() => replaceRequestAfter('{invalid', 'new'), /Invalid .rr JSON/);
  assert.throws(() => replaceRequestAfter(raw, 'bad\0text'), /NUL/);
  assert.throws(() => replaceRequestAfter(raw, '\uD800'), /surrogate/);
  assert.throws(() => replaceRequestAfter(raw, '\uFEFFnew\n'), /BOM/);
});
