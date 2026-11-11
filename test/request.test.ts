import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHunks, renderAccepted, type Decision } from '../src/core';
import { parseRequestDocument, proposalIdentity, resolveRequest, patchRequestStatuses,
  editPendingRequest, ensureRequestTime, minimalLineReplacement, type RevisionRequest, type RequestEntry } from '../src/request';
const entry = (line: number, before: string | null, after: string | null, status: Decision = 'pending', reason?: string): RequestEntry => ({line, before, after, status, ...(reason === undefined ? {} : {reason})});
const request = (...entries: RequestEntry[]): RevisionRequest => ({path: 'src/sample.tex', request: entries});
const raw = (doc: RevisionRequest) => JSON.stringify(doc, null, 2) + '\n';

test('one unversioned format accepts LF-delimited blocks or null and rejects CR', () => {
  const doc = request(entry(2, '\\n', '\\geq', 'pending', 'Reason'));
  assert.deepEqual(parseRequestDocument(raw(doc)), doc);
  assert.deepEqual(parseRequestDocument('\uFEFF' + raw(doc)), doc);
  for (const line of [undefined, null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseRequestDocument(JSON.stringify({path: 'x.tex', request: [{...doc.request[0], line}]})), /line/);
  }
  for (const invalid of ['before\rafter', '\r\n']) {
    assert.throws(() => parseRequestDocument(raw(request(entry(1, invalid, 'new')))), /LF.*CR/);
    assert.throws(() => parseRequestDocument(raw(request(entry(1, 'old', invalid)))), /LF.*CR/);
  }
  const multiline = request(entry(1, 'before\nsecond', 'after\nthird'));
  assert.deepEqual(parseRequestDocument(raw(multiline)), multiline);
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
test('blank append bootstraps while an emptied final line requires the exact saved baseline', () => {
  const append = request(entry(2, null, '', 'accepted'));
  assert.equal(resolveRequest(append, 'A\n').baseline, 'A');
  const empty = request(entry(2, 'B', '', 'accepted'));
  assert.throws(() => resolveRequest(empty, 'A\n'), /saved baseline/);
  assert.equal(resolveRequest(empty, 'A\n', 'A\nB').expectedTarget, 'A\n');
  assert.equal(resolveRequest(request(entry(2, 'B', '')), 'A\n', 'A\nB').expectedTarget, 'A\nB');
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
test('inline editing stores minimal fragments and supports exact multiline drafts', () => {
  const baseline = 'old one\r\nold two\r\nold three';
  const doc = request(entry(1, 'old', 'new', 'accepted'), entry(2, 'old', 'new'), entry(3, 'old', 'new', 'ignored'));
  const review = resolveRequest(doc, baseline, baseline), selected = review.hunks[1]!;
  const result = editPendingRequest(raw(doc), baseline, selected.id, 'edited two');
  assert.deepEqual(result.request.request[1], entry(2, 'ol', 'edite'));
  assert.equal(result.review.expectedTarget, review.expectedTarget);
  assert.equal(result.review.file.after, 'new one\r\nedited two\r\nnew three');
  const multiline = editPendingRequest(raw(doc), baseline, selected.id, 'one\ntwo');
  assert.equal(multiline.review.file.after, 'new one\r\none\r\ntwo\r\nnew three');
  assert.equal(multiline.review.expectedTarget, review.expectedTarget);
  assert.throws(() => editPendingRequest(raw(doc), baseline, review.hunks[0]!.id, 'no\n'), /Only pending/);
  assert.equal(editPendingRequest(raw(doc), baseline, selected.id, 'new two').text, raw(doc));
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


test('multiline replacement anchors its boundary fragments on the specified consecutive original lines', () => {
  const baseline = '\uFEFFprefix old\r\nmiddle\rlast suffix\nuntouched\r\n';
  const doc = request(entry(1, 'old\nmiddle\nlast', 'NEW\nCENTER\nEND'));
  const review = resolveRequest(doc, baseline);
  assert.equal(review.file.after, '\uFEFFprefix NEW\r\nCENTER\rEND suffix\nuntouched\r\n');
  assert.equal(review.hunks.length, 1); assert.equal(review.hunks[0]!.oldLines, 3);
  assert.equal(review.hunks[0]!.draftAfter, 'prefix NEW\nCENTER\nEND suffix');
  assert.equal(review.hunks[0]!.before, 'prefix old\r\nmiddle\rlast suffix\n');
  assert.equal(review.hunks[0]!.start, 1);
  assert.throws(() => resolveRequest(request(entry(2, 'old\nmiddle\nlast', 'new')), baseline), /exactly once/);
  assert.throws(() => resolveRequest(request(entry(3, 'last\nuntouched\nmissing', 'new')), baseline), /existing original/);
  const decided = {...doc, request: doc.request.map(item => ({...item, status: 'accepted' as const}))};
  assert.throws(() => resolveRequest(decided, review.file.after), /saved baseline/);
  assert.equal(resolveRequest(decided, review.file.after, baseline).baseline, baseline);
});

test('multiline deletion requires complete lines and consumes their exact physical endings', () => {
  const baseline = 'keep\r\nremove one\rremove two\nlast';
  const doc = request(entry(2, 'remove one\nremove two', null));
  const review = resolveRequest(doc, baseline);
  assert.equal(review.file.after, 'keep\r\nlast');
  assert.equal(review.hunks[0]!.oldLines, 2); assert.equal(review.hunks[0]!.newLines, 0);
  assert.throws(() => resolveRequest(request(entry(2, 'one\nremove two', null)), baseline), /complete original/);
  assert.throws(() => resolveRequest(request(entry(2, 'remove one\ntwo', null)), baseline), /complete original/);
});

test('overlapping consumed blocks and interior insertions are rejected, outer boundaries are independent', () => {
  const baseline = 'a\nb\nc\nd\n';
  for (const doc of [
    request(entry(2, 'b\nc', 'B\nC'), entry(3, 'c', 'C')),
    request(entry(2, 'b\nc', null), entry(1, 'a\nb', 'A\nB')),
    request(entry(2, 'b\nc', 'B\nC'), entry(3, null, 'inside')),
  ]) assert.throws(() => resolveRequest(doc, baseline), /overlap/);
  const doc = request(entry(2, 'b\nc', 'B\nC'), entry(2, null, 'before\nblock'), entry(4, null, 'after\nblock'));
  for (let mask = 0; mask < 8; mask++) {
    const decided = {...doc, request: doc.request.map((item, index) => ({...item, status: mask & (1 << index) ? 'accepted' as const : 'ignored' as const}))};
    const expected = 'a\n' + (mask & 2 ? 'before\nblock\n' : '') + (mask & 1 ? 'B\nC\n' : 'b\nc\n') + (mask & 4 ? 'after\nblock\n' : '') + 'd\n';
    const review = resolveRequest(decided, expected, baseline);
    assert.equal(review.expectedTarget, expected);
    if (mask & 1) assert.throws(() => resolveRequest(decided, expected), /saved baseline/);
    else assert.equal(resolveRequest(decided, expected).baseline, baseline);
  }
});

test('multiline insertion keeps duplicate blocks independent and bootstraps nonterminated EOF exactly', () => {
  const baseline = '\uFEFFkeep\r\nlast';
  const doc = request(entry(3, null, 'paragraph\n\nequation'), entry(3, null, 'paragraph\n\nequation'));
  const review = resolveRequest(doc, baseline);
  assert.equal(new Set(review.hunks.map(item => item.id)).size, 2);
  assert.equal(review.hunks[0]!.displayAfter, 'paragraph\r\n\r\nequation');
  assert.equal(review.hunks[0]!.draftAfter, 'paragraph\n\nequation');
  for (let mask = 0; mask < 4; mask++) {
    const decided = {...doc, request: doc.request.map((item, index) => ({...item, status: mask & (1 << index) ? 'accepted' as const : 'ignored' as const}))};
    const expected = baseline + (mask & 1 ? '\r\nparagraph\r\n\r\nequation' : '') + (mask & 2 ? '\r\nparagraph\r\n\r\nequation' : '');
    assert.equal(resolveRequest(decided, expected, baseline).expectedTarget, expected);
    assert.equal(resolveRequest(decided, expected).baseline, baseline);
  }
});

test('multiline decisions and Undo preserve exact bytes across independent decision orders and cached reopen', () => {
  const baseline = '\uFEFFfirst\r\nsecond\rkeep\nlast';
  const doc = request(entry(1, 'first\nsecond', 'FIRST\nSECOND\nADDED'), entry(4, 'last', 'LAST'), entry(5, null, 'tail\nend'));
  for (const order of [[0, 1, 2], [2, 1, 0]]) {
    const decided = structuredClone(doc);
    let current = baseline;
    for (const index of order) {
      decided.request[index]!.status = 'accepted';
      const review = resolveRequest(decided, current, baseline);
      current = review.expectedTarget;
      assert.equal(resolveRequest(parseRequestDocument(raw(decided)), current, baseline).expectedTarget, current);
    }
    assert.equal(current, '\uFEFFFIRST\r\nSECOND\rADDED\rkeep\nLAST\ntail\nend');
    assert.throws(() => resolveRequest(decided, current), /saved baseline/);
    for (const index of order.reverse()) {
      decided.request[index]!.status = 'pending';
      current = resolveRequest(decided, current, baseline).expectedTarget;
    }
    assert.equal(current, baseline);
  }
});

test('exact block drafts preserve intentional trailing blank lines and only rewrite the selected entry', () => {
  const baseline = 'old first\r\nold second\r\nkeep';
  const doc = request(entry(1, 'old first\nold second', 'new first\nnew second'), entry(3, 'keep', 'KEEP', 'accepted'));
  const review = resolveRequest(doc, baseline, baseline);
  const changed = editPendingRequest(raw(doc), baseline, review.hunks[0]!.id, 'revised\nblock\n');
  assert.equal(changed.review.hunks[0]!.draftAfter, 'revised\nblock\n');
  assert.equal(changed.review.file.after, 'revised\r\nblock\r\n\r\nKEEP');
  assert.equal(changed.review.expectedTarget, review.expectedTarget);
  assert.deepEqual(changed.request.request[1], doc.request[1]);
  assert.equal(editPendingRequest(changed.text, baseline, changed.review.hunks[0]!.id, 'revised\nblock\n').changed, false);
  const removed = editPendingRequest(raw(doc), baseline, review.hunks[0]!.id, 'old first\nold second');
  assert.deepEqual(removed.request.request, [doc.request[1]]);
  const eof = resolveRequest(request(entry(1, 'old', 'new\n')), 'old');
  assert.equal(eof.file.after, 'new\n'); assert.equal(eof.hunks[0]!.draftAfter, 'new\n');
});

test('multiline reasons may be omitted or empty without affecting application', () => {
  for (const reason of [undefined, '']) {
    const doc = parseRequestDocument(raw(request(entry(1, 'one\ntwo', 'ONE\nTWO', 'pending', reason))));
    assert.equal(resolveRequest(doc, 'one\ntwo\n').file.after, 'ONE\nTWO\n');
    assert.equal(doc.request[0]!.reason, reason);
  }
});


test('ambiguous accepted multiline imports require the saved baseline instead of inventing Undo text', () => {
  const baseline = 'middle\rlast\ntail';
  const unsafe = request(entry(1, 'middle\nlast', '\n'));
  const acceptedUnsafe = {...unsafe, request: unsafe.request.map(item => ({...item, status: 'accepted' as const}))};
  assert.throws(() => resolveRequest(acceptedUnsafe, '\r\ntail'), /saved baseline/);
  assert.throws(() => resolveRequest(unsafe, baseline), /merge separate CR and LF/);
  assert.throws(() => resolveRequest(acceptedUnsafe, '\r\ntail', baseline), /merge separate CR and LF/);
  const valid = request(entry(1, 'middle\nlast', 'MIDDLE\nLAST'));
  const target = resolveRequest(valid, baseline).file.after;
  assert.equal(target, 'MIDDLE\rLAST\ntail');
  const accepted = {...valid, request: valid.request.map(item => ({...item, status: 'accepted' as const}))};
  assert.throws(() => resolveRequest(accepted, target), /saved baseline/);
  assert.equal(resolveRequest(accepted, target, baseline).expectedTarget, target);
  assert.equal(resolveRequest(valid, target, baseline).expectedTarget, baseline, 'Cached Undo restores exact original bytes');
});

test('logical separators cannot collapse across context, deletions, or independent decision subsets', () => {
  for (const [baseline, entries] of [
    ['a\rb\nc', [entry(2, 'b', '')]],
    ['a\rb\n\nc', [entry(2, 'b', null)]],
    ['a\rb\nc\n\nd', [entry(2, 'b', null), entry(3, 'c', null)]],
    ['a\rb\nc', [entry(1, 'a', null), entry(2, 'b', '')]],
  ] as [string, ReturnType<typeof entry>[]][]) {
    assert.throws(() => resolveRequest(request(...entries), baseline), /merge separate CR and LF/);
  }
  const baseline = 'a\rb';
  const doc = request(entry(2, null, 'first\n'), entry(2, null, '\nsecond'));
  for (let mask = 0; mask < 4; mask++) {
    const decided = {...doc, request: doc.request.map((item, index) => ({...item, status: mask & (1 << index) ? 'accepted' as const : 'ignored' as const}))};
    const expected = 'a\r' + (mask & 1 ? 'first\r\r' : '') + (mask & 2 ? '\rsecond\r' : '') + 'b';
    assert.equal(resolveRequest(decided, expected, baseline).expectedTarget, expected);
    assert.equal(resolveRequest(decided, expected).baseline, baseline);
  }
});


test('ambiguous accepted empty replacements require the saved baseline without changing blank insertions', () => {
  const accepted = request(entry(2, 'word', '', 'accepted'));
  const target = 'left\r\n';
  assert.throws(() => resolveRequest(accepted, target), /saved baseline/);
  assert.throws(() => resolveRequest(accepted, target, 'left\rword\n'), /merge separate CR and LF/);
  const baseline = 'left\r\nword';
  const resolved = resolveRequest(accepted, target, baseline);
  assert.equal(resolved.baseline, baseline);
  assert.equal(resolved.expectedTarget, target);
  assert.equal(resolveRequest(request(entry(2, 'word', '')), target, baseline).expectedTarget, baseline);
  assert.equal(resolveRequest(request(entry(2, null, '', 'accepted')), 'left\n').baseline, 'left');
});
