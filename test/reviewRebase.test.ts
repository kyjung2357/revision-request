import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAccepted, computeHunks, type Decision } from '../src/core';
import { resolveRequest, type RequestEntry, type RevisionRequest } from '../src/request';
import { createTrackedReview, rebaseTrackedReview, transitionTrackedReview, reconfigureTrackedReview,
  projectTrackedReview, validateTrackedReview, type TrackedReview } from '../src/reviewRebase';
const entry = (line: number, before: string | null, after: string | null, status: Decision = 'pending'): RequestEntry => ({line, before, after, status});
function fixture(text: string, entries: RequestEntry[]) {
  const request: RevisionRequest = {path: 'sample.tex', request: entries};
  const resolved = resolveRequest(request, '', text);
  const tracked = createTrackedReview(resolved.file, resolved.decisions);
  return {request, resolved, tracked, ids: tracked.entries.map(item => item.hunk.id)};
}
const accept = (review: TrackedReview, id: string) => transitionTrackedReview(review, {[id]: 'accepted'});
const undo = (review: TrackedReview, id: string) => transitionTrackedReview(review, {[id]: 'pending'});
function consistent(review: TrackedReview) {
  const projection = projectTrackedReview(review);
  assert.equal(renderAccepted(projection.file.before, projection.hunks, projection.decisions), review.text);
  assert.deepEqual(computeHunks(projection.file), projection.hunks);
  return projection;
}

test('unrelated saved edits update positions and survive a later Accept without changing original hunk identity', () => {
  const {tracked, ids} = fixture('intro\nold\ntail\n', [entry(2, 'old', 'new')]);
  const rebased = rebaseTrackedReview(tracked, 'new intro\nextra\nold\nnew tail\n');
  assert.equal(rebased.entries[0]!.start, 'new intro\nextra\n'.length);
  assert.equal(rebased.entries[0]!.conflict, undefined);
  assert.deepEqual(rebased.entries[0]!.hunk, tracked.entries[0]!.hunk);
  assert.equal(consistent(rebased).hunks[0]!.oldStart, 3);
  assert.equal(accept(rebased, ids[0]!).text, 'new intro\nextra\nnew\nnew tail\n');
  assert.equal(tracked.text, 'intro\nold\ntail\n');
});

test('gray line insertion at a pending block boundary and deletion before it remain safe', () => {
  const {tracked, ids} = fixture('one\ntwo\nold\ntail\n', [entry(3, 'old', 'new')]);
  for (const text of ['one\ntwo\nadded\nold\ntail\n', 'one\nold\ntail\n', 'old\ntail\n']) {
    const result = rebaseTrackedReview(tracked, text);
    assert.equal(result.entries[0]!.conflict, undefined);
    assert.equal(accept(result, ids[0]!).text, text.replace('old\n', 'new\n'));
  }
});

test('a manual edit inside pending affects only that block and is never implicitly accepted', () => {
  const {tracked, ids} = fixture('old\ncontext\nother\n', [entry(1, 'old', 'new'), entry(3, 'other', 'OTHER')]);
  const result = rebaseTrackedReview(tracked, 'new\ncontext\nother\n');
  assert.equal(result.entries[0]!.decision, 'pending');
  assert.ok(result.entries[0]!.conflict);
  assert.equal(result.entries[1]!.conflict, undefined);
  assert.throws(() => accept(result, ids[0]!), /original changed|ambiguous/);
  const second = accept(result, ids[1]!);
  assert.equal(second.text, 'new\ncontext\nOTHER\n');
  const ignored = transitionTrackedReview(second, {[ids[0]!]: 'ignored'});
  assert.equal(ignored.text, second.text); assert.equal(ignored.entries[0]!.conflict, undefined);
  assert.ok(ignored.entries[0]!.undoBlocked); assert.throws(() => undo(ignored, ids[0]!), /Undo/);
  consistent(ignored);
});

test('unhighlighted characters inside a pending original line remain protected', () => {
  const {tracked} = fixture('let x = 1;\n', [entry(1, '1', '2')]);
  const result = rebaseTrackedReview(tracked, 'let y = 1;\n');
  assert.ok(result.entries[0]!.conflict);
});

test('direct edits to resolved content retain decisions and block only that Undo', () => {
  for (const status of ['accepted', 'ignored'] as const) {
    const {tracked, ids} = fixture('old\ncontext\nother\n', [entry(1, 'old', 'new', status), entry(3, 'other', 'OTHER')]);
    const result = rebaseTrackedReview(tracked, 'manual\ncontext\nother\n');
    assert.equal(result.entries[0]!.decision, status); assert.ok(result.entries[0]!.undoBlocked);
    assert.throws(() => undo(result, ids[0]!), /Undo/);
    assert.equal(accept(result, ids[1]!).text, 'manual\ncontext\nOTHER\n');
    const projected = consistent(result).hunks[0]!;
    assert.equal(projected.before, 'manual\n'); assert.equal(projected.after, 'manual\n');
  }
});

test('unrelated manual edits survive Undo of an untouched accepted change', () => {
  const {tracked, ids} = fixture('intro\nold\ntail\n', [entry(2, 'old', 'new', 'accepted')]);
  const result = rebaseTrackedReview(tracked, 'manual intro\nnew\nmanual tail\n');
  assert.equal(result.entries[0]!.undoBlocked, undefined);
  assert.equal(undo(result, ids[0]!).text, 'manual intro\nold\nmanual tail\n');
});

test('pending insertion anchors reject simultaneous manual insertion at the same position', () => {
  const {tracked, ids} = fixture('head\ntail\n', [entry(2, null, 'proposed')]);
  const result = rebaseTrackedReview(tracked, 'head\nmanual\ntail\n');
  assert.ok(result.entries[0]!.conflict); assert.throws(() => accept(result, ids[0]!), /original changed|ambiguous/);
  const shifted = rebaseTrackedReview(tracked, 'new head\ntail\n');
  assert.equal(shifted.entries[0]!.conflict, undefined);
  assert.equal(accept(shifted, ids[0]!).text, 'new head\nproposed\ntail\n');
});

test('a manual deletion across multiple pending blocks produces disjoint conflict ranges', () => {
  const {tracked, ids} = fixture('a\nfirst\nbetween\nsecond\nz\n', [entry(2, 'first', 'FIRST'), entry(4, 'second', 'SECOND')]);
  const result = rebaseTrackedReview(tracked, 'a\nreplacement\nz\n');
  assert.ok(result.entries.every(item => item.conflict));
  assert.ok(result.entries[0]!.end <= result.entries[1]!.start);
  consistent(result);
  const ignored = transitionTrackedReview(result, Object.fromEntries(ids.map(id => [id, 'ignored'])));
  assert.equal(ignored.text, result.text);
});

test('repeated lines with ambiguous surviving identity do not acquire approval authority', () => {
  const {tracked, ids} = fixture('same\nsame\ntail\n', [entry(2, 'same', 'changed')]);
  const result = rebaseTrackedReview(tracked, 'same\ntail\n');
  assert.ok(result.entries[0]!.conflict);
  assert.throws(() => accept(result, ids[0]!), /ambiguous|original changed/);
});

test('CRLF, UTF-8 BOM, Unicode and a nonterminated ending are preserved exactly', () => {
  const {tracked, ids} = fixture('\uFEFF머리\r\nold😀\r\n끝', [entry(2, 'old', 'new')]);
  const result = rebaseTrackedReview(tracked, '\uFEFF수정된 머리\r\n추가\r\nold😀\r\n끝');
  assert.equal(result.entries[0]!.conflict, undefined);
  assert.equal(accept(result, ids[0]!).text, '\uFEFF수정된 머리\r\n추가\r\nnew😀\r\n끝');
  assert.throws(() => rebaseTrackedReview(result, result.text.slice(1)), /BOM/);
  consistent(result);
});

test('accepted nonterminated EOF additions own their separator for Undo and display once', () => {
  const {tracked, ids} = fixture('old', [entry(2, null, 'added', 'accepted')]);
  assert.equal(tracked.text, 'old\nadded');
  const projection = consistent(tracked);
  assert.equal(projection.hunks[0]!.before, 'added'); assert.equal(projection.hunks[0]!.oldStart, 2);
  assert.equal(undo(tracked, ids[0]!).text, 'old');
});

test('empty-source insertion conflicts if the user fills the source first', () => {
  const {tracked, ids} = fixture('', [entry(1, null, '')]);
  const result = rebaseTrackedReview(tracked, 'manual');
  assert.ok(result.entries[0]!.conflict); assert.throws(() => accept(result, ids[0]!), /original changed|ambiguous/);
});

test('edited pending proposals retain external context and can be accepted in one transition', () => {
  const {tracked, request, resolved, ids} = fixture('intro\nold\ntail\n', [entry(2, 'old', 'new')]);
  const rebased = rebaseTrackedReview(tracked, 'manual intro\nold\ntail\n');
  const next = resolveRequest({...request, request: [entry(2, 'old', 'edited', 'accepted')]}, '', resolved.baseline);
  const updated = reconfigureTrackedReview(rebased, next.file, next.decisions, {[next.hunks[0]!.id]: ids[0]!});
  assert.equal(updated.text, 'manual intro\nedited\ntail\n');
  assert.equal(updated.entries[0]!.decision, 'accepted');
  assert.equal(undo(updated, next.hunks[0]!.id).text, 'manual intro\nold\ntail\n');
});

test('removing a noop pending proposal leaves the current original and other decisions intact', () => {
  const {tracked, request, resolved} = fixture('intro\nold\nother\ntail\n', [entry(2, 'old', 'new'), entry(3, 'other', 'OTHER', 'accepted')]);
  const rebased = rebaseTrackedReview(tracked, 'manual\nold\nOTHER\ntail\n');
  const next = resolveRequest({...request, request: [request.request[1]!]}, '', resolved.baseline);
  const updated = reconfigureTrackedReview(rebased, next.file, next.decisions);
  assert.equal(updated.text, rebased.text); assert.equal(updated.entries.length, 1);
  assert.equal(updated.entries[0]!.decision, 'accepted'); consistent(updated);
});

test('proposal edits cannot erase conflicts or mutate resolved history', () => {
  const {tracked, request, resolved, ids} = fixture('old\n', [entry(1, 'old', 'new')]);
  const next = resolveRequest({...request, request: [entry(1, 'old', 'edited')]}, '', resolved.baseline);
  const mapping = {[next.hunks[0]!.id]: ids[0]!};
  assert.throws(() => reconfigureTrackedReview(rebaseTrackedReview(tracked, 'manual\n'), next.file, next.decisions, mapping), /pending original/);
  assert.throws(() => reconfigureTrackedReview(accept(tracked, ids[0]!), next.file, next.decisions, mapping), /pending original/);
  const empty = resolveRequest({...request, request: []}, '', resolved.baseline);
  assert.throws(() => reconfigureTrackedReview(rebaseTrackedReview(tracked, 'manual\n'), empty.file, empty.decisions), /conflicting/);
});

test('multiple same-anchor insertions preserve array order through independent decisions', () => {
  const {tracked, ids} = fixture('head\ntail\n', [entry(2, null, 'first'), entry(2, null, 'second'), entry(2, 'tail', 'TAIL')]);
  const rebased = rebaseTrackedReview(tracked, 'manual head\ntail\n');
  let result = accept(rebased, ids[1]!); assert.equal(result.text, 'manual head\nsecond\ntail\n');
  result = accept(result, ids[0]!); assert.equal(result.text, 'manual head\nfirst\nsecond\ntail\n');
  result = accept(result, ids[2]!); assert.equal(result.text, 'manual head\nfirst\nsecond\nTAIL\n');
  result = undo(result, ids[0]!); assert.equal(result.text, 'manual head\nsecond\nTAIL\n'); consistent(result);
});

test('repeated rebases compose and closed reviews still show the saved current source', () => {
  const {tracked, ids} = fixture('head\nold\ntail\n', [entry(2, 'old', 'new')]);
  const first = rebaseTrackedReview(tracked, 'one\nhead\nold\ntail\n');
  const second = rebaseTrackedReview(first, 'one\nhead\nold\ntail\ntwo\n');
  const accepted = accept(second, ids[0]!);
  const closed = rebaseTrackedReview(accepted, 'one\nhead\nmanual\ntail\ntwo\n');
  assert.equal(closed.entries[0]!.decision, 'accepted'); assert.ok(closed.entries[0]!.undoBlocked);
  consistent(closed);
});

test('tracking validates persisted ranges, text limits, stale decisions and bounded diff work', () => {
  const {tracked} = fixture('old\n', [entry(1, 'old', 'new')]);
  for (const text of ['\0', '\ud800', 'x'.repeat(5 * 1024 * 1024 + 1)]) assert.throws(() => rebaseTrackedReview(tracked, text), /UTF-8|limit/);
  assert.throws(() => rebaseTrackedReview(tracked, 'different\n', 0), /timed out/);
  assert.throws(() => validateTrackedReview({...tracked, text: 'different\n'}), /matches|match/);
  assert.throws(() => validateTrackedReview({...tracked, entries: [{...tracked.entries[0], start: -1}]}), /ranges/);
  assert.throws(() => transitionTrackedReview(tracked, {unknown: 'accepted'}), /Unknown/);
  const accepted = accept(tracked, tracked.entries[0]!.hunk.id);
  assert.throws(() => transitionTrackedReview(accepted, {[accepted.entries[0]!.hunk.id]: 'ignored'}), /Undo/);
});

test('bounded gray-edit scenarios never overwrite manual context when one pending block is accepted', () => {
  for (let scenario = 0; scenario < 80; scenario++) {
    const rows = Array.from({length: 24}, (_,index) => 'row-' + index + '-original');
    const lines = [4, 9, 15, 21];
    const {tracked, ids} = fixture(rows.join('\n') + '\n', lines.map((line, index) => entry(line, rows[line - 1]!, 'proposal-' + index,
      index === 0 && scenario % 2 ? 'accepted' : index === 1 && scenario % 3 ? 'ignored' : 'pending')));
    let current = tracked.text.split('\n'); current.pop();
    current[0] = 'manual-header-' + scenario;
    current.splice(1, 0, 'manual-added-' + scenario);
    current[current.indexOf('row-11-original')] = 'manual-middle-' + scenario;
    current.splice(current.indexOf('row-22-original'), 1);
    const text = current.join('\n') + '\n';
    const rebased = rebaseTrackedReview(tracked, text);
    assert.ok(rebased.entries.every(item => !item.conflict && !item.undoBlocked));
    const accepted = accept(rebased, ids[2]!);
    assert.equal(accepted.text, text.replace('row-14-original\n', 'proposal-2\n'));
    assert.equal(undo(accepted, ids[2]!).text, text);
    consistent(accepted);
  }
});

test('all decision subsets agree with immutable rendering before external edits', () => {
  const baseline = 'first\nsecond\nthird';
  const proposals = [entry(1, null, 'head'), entry(1, 'first', 'FIRST'), entry(2, 'second', null), entry(4, null, 'tail')];
  const initial = fixture(baseline, proposals);
  for (let mask = 0; mask < 16; mask++) {
    const changes = Object.fromEntries(initial.ids.map((id, index) => [id, mask & (1 << index) ? 'accepted' as const : 'ignored' as const]));
    const result = transitionTrackedReview(initial.tracked, changes);
    assert.equal(result.text, renderAccepted(baseline, initial.resolved.hunks, changes));
    consistent(result);
    const restored = transitionTrackedReview(result, Object.fromEntries(initial.ids.map(id => [id, 'pending' as const])));
    assert.equal(restored.text, baseline);
  }
});

test('a large review maps many gray edits without scanning the whole source for every block', () => {
  const rows = Array.from({length: 3000}, (_, index) => 'Unique source row ' + index + '.');
  const requests = Array.from({length: 1000}, (_, index) => entry(index * 3 + 2, rows[index * 3 + 1]!, 'Proposed row ' + index + '.'));
  const {tracked, ids} = fixture(rows.join('\n') + '\n', requests);
  const current = rows.map((line, index) => index % 6 === 0 ? 'Manual context ' + index + '.' : line);
  current.unshift('Manual introduction.');
  const saved = current.join('\n') + '\n', rebased = rebaseTrackedReview(tracked, saved, 2000);
  const projection = consistent(rebased);
  assert.equal(projection.hunks.length, 1000);
  projection.hunks.forEach((hunk, index) => {
    assert.equal(hunk.oldStart, index * 3 + 3);
    assert.equal(hunk.conflict, undefined);
    assert.equal(hunk.before, rows[index * 3 + 1] + '\n');
  });
  assert.equal(accept(rebased, ids[499]!).text, saved.replace(rows[1498]! + '\n', 'Proposed row 499.\n'));
});
