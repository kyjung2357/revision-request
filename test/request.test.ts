import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHunks, renderAccepted, type Decision } from '../src/core';
import { parseRequestDocument, proposalIdentity, resolveRequest, patchRequestStatuses,
  editPendingRequest, ensureRequestTime, minimalLineReplacement, type RevisionRequest, type RequestEntry } from '../src/request';
const entry = (line: number, before: string | null, after: string | null, status: Decision = 'pending', reason?: string): RequestEntry => ({line, before, after, status, ...(reason === undefined ? {} : {reason})});
const request = (...entries: RequestEntry[]): RevisionRequest => ({path: 'src/sample.tex', request: entries});
const raw = (doc: RevisionRequest) => JSON.stringify(doc, null, 2) + '\n';

test('one unversioned format requires original line and newline-free fragments or null', () => {
  const doc = request(entry(2, '\\n', '\\geq', 'pending', 'Reason'));
  assert.deepEqual(parseRequestDocument(raw(doc)), doc);
  assert.deepEqual(parseRequestDocument('\uFEFF' + raw(doc)), doc);
  for (const line of [undefined, null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseRequestDocument(JSON.stringify({path: 'x.tex', request: [{...doc.request[0], line}]})), /line/);
  }
  for (const invalid of ['before\nafter', 'before\rafter', '\r\n']) {
    assert.throws(() => parseRequestDocument(raw(request(entry(1, invalid, 'new')))), /single line/);
    assert.throws(() => parseRequestDocument(raw(request(entry(1, 'old', invalid)))), /single line/);
  }
  assert.throws(() => parseRequestDocument(raw(request(entry(1, null, null)))), /both/);
  assert.throws(() => parseRequestDocument('{'), /Invalid .rr JSON/);
  assert.throws(() => parseRequestDocument('null'), /object/);
});
test('parser preserves status rules, limits, valid timestamps and Unicode', () => {
  for (const status of [undefined, null, '', 'accept', 'Ignored', 0]) assert.throws(() => parseRequestDocument(JSON.stringify({path: 'x.tex', request: [{line: 1, before: 'a', after: 'b', status}]})), /status/);
  assert.throws(() => parseRequestDocument(raw({...request(entry(1, 'a', 'b')), path: '../escape'})), /path/);
  assert.throws(() => parseRequestDocument(raw(request(entry(1, '\ud800', 'b')))), /surrogate/);
  assert.throws(() => parseRequestDocument(raw(request(entry(1, 'a', '\0')))), /NUL/);
  assert.throws(() => parseRequestDocument(' '.repeat(20 * 1024 * 1024 + 1)), /20 MiB/);
  assert.throws(() => parseRequestDocument(raw(request(entry(1, 'a'.repeat(5 * 1024 * 1024 + 1), 'b')))), /size/);
  assert.throws(() => parseRequestDocument(raw(request(...Array.from({length: 10001}, () => entry(1, 'a', 'b'))))), /10000/);
  for (const time of ['2026-11-10', '2026-11-10T12:00:00', '2026-02-30T00:00:00Z']) assert.throws(() => parseRequestDocument(raw({...request(), time})), /time|date/);
});
test('line is original-baseline-relative and matching never searches another line', () => {
  const review = resolveRequest(request(entry(2, 'old', 'new')), 'old\nlet old = 1;\nold\n');
  assert.equal(review.file.after, 'old\nlet new = 1;\nold\n');
  assert.equal(review.hunks[0]!.before, 'let old = 1;\n');
  assert.throws(() => resolveRequest(request(entry(1, 'missing', 'new')), 'old\nmissing\n'), /exactly once/);
  assert.throws(() => resolveRequest(request(entry(1, 'x', 'y')), 'x x\n'), /exactly once/);
  assert.throws(() => resolveRequest(request(entry(3, 'old', 'new')), 'old\n'), /existing original line/);
});
test('minimal fragments use only enough same-line context and preserve Unicode boundaries', () => {
  assert.deepEqual(minimalLineReplacement('Let x > 0.', 'Let x >= 0.'), {before: '>', after: '>='});
  assert.deepEqual(minimalLineReplacement('x x x', 'x y x'), {before: ' x ', after: ' y '});
  assert.deepEqual(minimalLineReplacement('abcXabcY', 'abcZXabcY'), {before: 'X', after: 'ZX'});
  assert.deepEqual(minimalLineReplacement('😀 one', '😃 one'), {before: '😀', after: '😃'});
  assert.deepEqual(minimalLineReplacement('', 'new'), {before: '', after: 'new'});
});
test('one existing-line entry is atomic and duplicate same-line requests require combining', () => {
  const review = resolveRequest(request(entry(1, 'a + b', 'A + B')), 'prefix a + b suffix\n');
  assert.equal(review.hunks.length, 1); assert.equal(computeHunks(review.file).length, 1);
  assert.throws(() => resolveRequest(request(entry(1, 'a', 'A'), entry(1, 'b', 'B')), 'a + b\n'), /Combine/);
});
test('insertions at a shared anchor precede replacement and remain independent in array order', () => {
  const baseline = 'first\nold\nlast\n';
  const doc = request(entry(2, 'old', 'new'), entry(2, null, 'insert one'), entry(2, null, 'insert two'));
  const review = resolveRequest(doc, baseline);
  assert.equal(review.file.after, 'first\ninsert one\ninsert two\nnew\nlast\n');
  assert.deepEqual(review.hunks.map(h => h.oldStart), [2, 2, 2]);
  assert.deepEqual(review.hunks.map(h => review.entryIndexByHunkId[h.id]), [1, 2, 0]);
  for (let mask = 0; mask < 8; mask++) {
    const updated = {...doc, request: doc.request.map((e, i) => ({...e, status: mask & (1 << i) ? 'accepted' as const : 'ignored' as const}))};
    const expected = 'first\n' + (mask & 2 ? 'insert one\n' : '') + (mask & 4 ? 'insert two\n' : '') + (mask & 1 ? 'new\n' : 'old\n') + 'last\n';
    assert.equal(resolveRequest(updated, expected, baseline).expectedTarget, expected);
    assert.equal(resolveRequest(updated, expected).baseline, baseline);
  }
});
test('line deletion requires full text, blank line is distinct from deleted line', () => {
  const baseline = 'delete this\n\nlast';
  assert.throws(() => resolveRequest(request(entry(1, 'delete', null)), baseline), /complete original text/);
  assert.equal(resolveRequest(request(entry(1, 'delete this', null)), baseline).file.after, '\nlast');
  assert.equal(resolveRequest(request(entry(2, '', 'filled')), baseline).file.after, 'delete this\nfilled\nlast');
  assert.equal(resolveRequest(request(entry(2, '', null)), baseline).file.after, 'delete this\nlast');
  assert.equal(resolveRequest(request(entry(1, null, '')), baseline).file.after, '\ndelete this\n\nlast');
});
test('deletion before later edits does not change original line coordinates', () => {
  const baseline = 'remove\r\nkeep\r\nold';
  const doc = request(entry(1, 'remove', null), entry(3, 'old', 'new'));
  assert.equal(resolveRequest(doc, baseline).file.after, 'keep\r\nnew');
  assert.equal(resolveRequest({...doc, request: [doc.request[0]!, {...doc.request[1]!, status: 'accepted'}]}, 'remove\r\nkeep\r\nnew', baseline).expectedTarget, 'remove\r\nkeep\r\nnew');
  assert.throws(() => resolveRequest({...doc, request: doc.request.map(e => ({...e, status: 'accepted'}))}, 'keep\r\nnew'), /saved baseline/);
});
test('nonterminated EOF additions preserve exact physical separators and display one row', () => {
  const baseline = 'old';
  const doc = request(entry(1, 'old', 'new'), entry(2, null, 'B'), entry(2, null, 'C'));
  const review = resolveRequest(doc, baseline);
  assert.equal(review.file.after, 'new\nB\nC');
  assert.equal(review.hunks[1]!.after, '\nB'); assert.equal(review.hunks[1]!.displayAfter, 'B');
  assert.equal(review.hunks[1]!.newLines, 1);
  for (let mask = 0; mask < 8; mask++) {
    const decided = {...doc, request: doc.request.map((e, i) => ({...e, status: mask & (1 << i) ? 'accepted' as const : 'ignored' as const}))};
    const target = (mask & 1 ? 'new' : 'old') + (mask & 2 ? '\nB' : '') + (mask & 4 ? '\nC' : '');
    assert.equal(resolveRequest(decided, target, baseline).expectedTarget, target);
    assert.equal(resolveRequest(decided, target).baseline, baseline);
  }
  assert.throws(() => resolveRequest(request(entry(1, 'old', null), entry(2, null, 'B')), baseline), /Replace the final line/);
});
test('blank append and emptied final line reconstruct only after exact forward verification', () => {
  const append = request(entry(2, null, '', 'accepted'));
  assert.equal(resolveRequest(append, 'A\n').baseline, 'A');
  const empty = request(entry(2, 'B', '', 'accepted'));
  assert.equal(resolveRequest(empty, 'A\n').baseline, 'A\nB');
});
test('empty-file additions infer LF, fixed BOM stays outside every editable line', () => {
  assert.equal(resolveRequest(request(entry(1, null, 'A'), entry(1, null, 'B')), '').file.after, 'A\nB\n');
  const baseline = '\uFEFFfirst\r\nsecond';
  assert.equal(resolveRequest(request(entry(1, null, 'new')), baseline).file.after, '\uFEFFnew\r\nfirst\r\nsecond');
  assert.equal(resolveRequest(request(entry(1, 'first', null)), baseline).file.after, '\uFEFFsecond');
  assert.equal(resolveRequest(request(entry(2, 'second', 'SECOND')), baseline).file.after, '\uFEFFfirst\r\nSECOND');
  assert.throws(() => resolveRequest(request(entry(1, 'first', '\uFEFFfirst')), 'first\n'), /BOM/);
});
test('cached baseline remains authoritative for manually edited statuses', () => {
  const baseline = 'old\n';
  const doc = request(entry(1, 'old', 'new', 'accepted'));
  assert.equal(resolveRequest(doc, baseline, baseline).expectedTarget, 'new\n');
  assert.throws(() => resolveRequest(doc, baseline), /exactly once/);
});
test('status and time preserve identity; line coordinates and fragments change it', () => {
  const doc = request(entry(1, 'a', 'b'));
  assert.equal(proposalIdentity(doc), proposalIdentity({...doc, time: '2026-11-10T00:00:00Z', request: [entry(1, 'a', 'b', 'ignored')]}));
  assert.notEqual(proposalIdentity(doc), proposalIdentity(request(entry(2, 'a', 'b'))));
  assert.notEqual(proposalIdentity(doc), proposalIdentity(request(entry(1, 'a', 'c'))));
});
test('surgical status and timestamp writes preserve raw JSON metadata and formatting', () => {
  const text = '\uFEFF{\r\n "path":"sample.tex", "huge":900719925474099312345,\n "request":[{"line":1,"before":"a","after":"b","status":"accepted","sta\\u0074us":"pending"}]\r\n}\n';
  assert.equal(patchRequestStatuses(text, {0: 'ignored'}), text.replace('"sta\\u0074us":"pending"', '"sta\\u0074us":"ignored"'));
  const stamped = ensureRequestTime(text, '2026-11-10T00:00:00Z');
  assert.equal(parseRequestDocument(stamped).time, '2026-11-10T00:00:00Z');
  assert.equal(ensureRequestTime(stamped, 'unused'), stamped);
  assert.equal(proposalIdentity(parseRequestDocument(stamped)), proposalIdentity(parseRequestDocument(text)));
});
test('inline editing stores minimal fragments, preserves decisions and rejects multiline drafts', () => {
  const baseline = 'old one\r\nold two\r\nold three';
  const doc = request(entry(1, 'old', 'new', 'accepted'), entry(2, 'old', 'new'), entry(3, 'old', 'new', 'ignored'));
  const review = resolveRequest(doc, baseline, baseline), selected = review.hunks[1]!;
  const result = editPendingRequest(raw(doc), baseline, selected.id, 'edited two\n');
  assert.deepEqual(result.request.request[1], entry(2, 'ol', 'edite'));
  assert.equal(result.review.expectedTarget, review.expectedTarget);
  assert.equal(result.review.file.after, 'new one\r\nedited two\r\nnew three');
  assert.throws(() => editPendingRequest(raw(doc), baseline, selected.id, 'one\ntwo\n'), /one line/);
  assert.throws(() => editPendingRequest(raw(doc), baseline, review.hunks[0]!.id, 'no\n'), /Only pending/);
  assert.equal(editPendingRequest(raw(doc), baseline, selected.id, 'new two\n').text, raw(doc));
});
test('restoring a pending line removes only that entry; append editing keeps separator physical', () => {
  const baseline = 'one\nlast';
  const doc = request(entry(1, 'one', 'ONE', 'ignored'), entry(2, 'last', 'LAST'), entry(3, null, 'added'));
  const review = resolveRequest(doc, baseline), removed = editPendingRequest(raw(doc), baseline, review.hunks[1]!.id, 'last');
  assert.equal(removed.request.request.length, 2); assert.equal(removed.request.request[0]!.status, 'ignored');
  const edited = editPendingRequest(raw(doc), baseline, review.hunks[2]!.id, 'revised');
  assert.equal(edited.request.request[2]!.after, 'revised');
  assert.equal(edited.review.hunks[2]!.after, '\nrevised');
  assert.equal(edited.review.expectedTarget, baseline);
});
test('partial approvals commute for independent entries including repeated insertions', () => {
  const baseline = 'a\nb\nc\n';
  const doc = request(entry(1, 'a', 'A'), entry(2, null, 'same'), entry(2, null, 'same'), entry(3, 'c', null));
  const original = resolveRequest(doc, baseline);
  assert.equal(new Set(original.hunks.map(h => h.id)).size, 4);
  for (let mask = 0; mask < 16; mask++) {
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
      const decided = structuredClone(doc); let current = baseline;
      for (const index of order) {
        decided.request[index]!.status = mask & (1 << index) ? 'accepted' : 'ignored';
        const step = resolveRequest(decided, current, baseline); current = step.expectedTarget;
        assert.equal(current, renderAccepted(baseline, step.hunks, step.decisions));
      }
      const expected = (mask & 1 ? 'A\n' : 'a\n') + (mask & 2 ? 'same\n' : '') + (mask & 4 ? 'same\n' : '') + 'b\n' + (mask & 8 ? '' : 'c\n');
      assert.equal(current, expected);
    }
  }
});
