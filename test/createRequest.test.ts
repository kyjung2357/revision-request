import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestFromSnapshots } from '../src/createRequest';
import { parseRequestDocument, resolveRequest } from '../src/request';
const options = {time: '2026-11-10T20:00:00.000Z'};
function verify(before: string, after: string) {
  const request = createRequestFromSnapshots('sample.tex', before, after, options);
  assert.deepEqual(Object.keys(request), ['path', 'time', 'request']);
  assert.ok(request.request.every(entry => entry.status === 'pending' && Number.isInteger(entry.line) && entry.line > 0));
  assert.ok(request.request.every(entry => [entry.before, entry.after].every(text => text === null || !/\r/.test(text))));
  const review = resolveRequest(request, before); assert.equal(review.file.after, after); assert.equal(review.expectedTarget, before);
  const accepted = {...request, request: request.request.map(entry => ({...entry, status: 'accepted' as const}))};
  assert.equal(resolveRequest(accepted, after, before).expectedTarget, after);
  if (!request.request.some(entry => entry.after === null || (entry.before !== null && (entry.before.includes('\n') || entry.after!.includes('\n'))))) {
    assert.equal(resolveRequest(accepted, after).baseline, before);
  }
  assert.deepEqual(parseRequestDocument(JSON.stringify(request)), request);
  return request;
}
test('generator emits line numbers and changed fragments instead of whole surrounding lines', () => {
  const result = verify('Let x > 0.\nkeep\ncoefficient = 2;\n', 'Let x >= 0.\nkeep\ncoefficient = 1;\n');
  assert.deepEqual(result.request.map(({line, before, after}) => ({line, before, after})), [{line: 1, before: '>', after: '>='}, {line: 3, before: '2', after: '1'}]);
  assert.deepEqual(Object.keys(result.request[0]!), ['line', 'before', 'after', 'status']);
});
test('same-line changes combine the minimal spanning fragment with enough unique context', () => {
  const result = verify('prefix a + b suffix\n', 'prefix A + B suffix\n');
  assert.equal(result.request.length, 1); assert.equal(result.request[0]!.before, 'a + b');
  const repeated = verify('x x x\n', 'x y x\n'); assert.equal(repeated.request[0]!.before, ' x ');
});
test('line additions and deletions use null and original coordinates including append', () => {
  const added = verify('start\nend\n', 'start\nnew one\nnew two\nend\n');
  assert.deepEqual(added.request.map(({line, before, after}) => ({line, before, after})), [{line: 2, before: null, after: 'new one\nnew two'}]);
  const deleted = verify('start\nobsolete\nend\n', 'start\nend\n');
  assert.deepEqual(deleted.request[0], {line: 2, before: 'obsolete', after: null, status: 'pending'});
  verify('first', 'first\nsecond\nthird');
});
test('BOM, mixed existing endings, blank lines and nonterminated EOF remain byte exact', () => {
  verify('\uFEFFold😀\r\nkeep\rlast', '\uFEFFnew😃\r\nkeep\rlast');
  verify('\uFEFFfirst\r\nsecond', '\uFEFFnew\r\nfirst\r\nsecond');
  verify('\uFEFFfirst\r\nsecond', '\uFEFFsecond');
  verify('line\r\nlast', 'line\r\nlast\r\nadded');
  verify('line\n\nlast\n', 'line\nfilled\nlast\n');
  verify('', 'first\nsecond\n'); verify('whole\nfile\n', ''); verify('', '');
});
test('unsupported EOF and line-ending changes fail instead of being normalized', () => {
  for (const [before, after] of [['text', 'text\n'], ['text\n', 'text'], ['a\r\n', 'A\n'], ['', 'no final newline']]) {
    assert.throws(() => createRequestFromSnapshots('sample.tex', before!, after!, options), /line endings|final-newline/);
  }
  assert.throws(() => createRequestFromSnapshots('sample.tex', '\uFEFFold', 'new', options), /BOM/);
  assert.throws(() => createRequestFromSnapshots('sample.tex', '\ud800', '\ud800', options), /Unicode/);
  assert.throws(() => createRequestFromSnapshots('../outside.tex', 'a', 'b', options), /path/i);
});
test('generator retains per-entry reasons and timestamps while unchanged files have no requests', () => {
  const result = createRequestFromSnapshots('sample.tex', 'alpha\nkeep\nbeta\n', 'ALPHA\nkeep\nBETA\n', {...options, reason: 'General', explanations: [{line: 3, text: 'Second'}]});
  assert.deepEqual(result.request.map(e => e.reason), ['General', 'Second']);
  assert.equal(result.time, options.time); assert.deepEqual(verify('same\n', 'same\n').request, []);
});
test('seeded generated changes preserve all and partial projections in both decision orders', () => {
  let seed = 1729;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 50; run++) {
    const original = Array.from({length: 8}, (_, i) => 'line-' + i + '-' + next() % 4);
    const proposed = [...original];
    proposed[1 + next() % 3] += '-edited';
    proposed.splice(5, 0, 'inserted-' + run);
    proposed.splice(7, 1);
    const before = original.join('\n') + '\n', after = proposed.join('\n') + '\n';
    const doc = verify(before, after);
    const statuses = doc.request.map(() => next() % 2 ? 'accepted' as const : 'ignored' as const);
    let forward = '', reverse = '';
    for (const order of [doc.request.map((_, i) => i), doc.request.map((_, i) => i).reverse()]) {
      const current = structuredClone(doc); let target = before;
      for (const index of order) { current.request[index]!.status = statuses[index]!; target = resolveRequest(current, target, before).expectedTarget; }
      if (!forward) forward = target; else reverse = target;
    }
    assert.equal(forward, reverse);
  }
});


test('contiguous paragraph and equation changes produce one atomic LF-delimited entry', () => {
  const before = 'heading\nold paragraph\nold equation\ntail\n';
  const after = 'heading\nnew paragraph\nnew equation\nextra detail\ntail\n';
  const doc = verify(before, after);
  assert.equal(doc.request.length, 1);
  assert.equal(doc.request[0]!.line, 2);
  assert.ok(doc.request[0]!.before!.includes('\n'));
  assert.ok(doc.request[0]!.after!.includes('\n'));
  const review = resolveRequest(doc, before);
  assert.equal(review.hunks.length, 1);
  assert.equal(review.hunks[0]!.oldLines, 2); assert.equal(review.hunks[0]!.newLines, 3);
  const deletion = verify('first\nremove one\nremove two\nlast\n', 'first\nlast\n');
  assert.deepEqual(deletion.request.map(({line, before, after}) => ({line, before, after})),
    [{line: 2, before: 'remove one\nremove two', after: null}]);
});

test('multiline generation preserves BOM, mixed original separators and unterminated EOF', () => {
  const sameCount = verify('\uFEFFkeep\r\nleft old\rmiddle old\nright old', '\uFEFFkeep\r\nleft new\rmiddle new\nright new');
  assert.equal(sameCount.request.length, 1);
  assert.equal(sameCount.request[0]!.line, 2);
  const grown = verify('keep\r\nold', 'keep\r\nnew\r\nsecond');
  assert.equal(grown.request.length, 1);
  assert.equal(grown.request[0]!.before, 'ol');
  assert.equal(grown.request[0]!.after, 'new\nsecon');
  const append = verify('keep\r\nlast', 'keep\r\nlast\r\nparagraph\r\n\r\nequation');
  assert.equal(append.request.length, 1);
  assert.equal(append.request[0]!.after, 'paragraph\n\nequation');
});


test('explicitly different reasons keep adjacent changes independently reviewable', () => {
  const doc = createRequestFromSnapshots('sample.tex', 'first\nsecond\nthird\n', 'FIRST\nSECOND\nTHIRD\n',
    {...options, explanations: [{line: 1, text: 'First reason'}, {line: 2, text: 'Other reason'}, {line: 3, text: 'Other reason'}]});
  assert.equal(doc.request.length, 2);
  assert.deepEqual(doc.request.map(item => [item.line, item.reason]), [[1, 'First reason'], [2, 'Other reason']]);
  assert.ok(doc.request[1]!.before!.includes('\n'));
  assert.equal(resolveRequest(doc, 'first\nsecond\nthird\n').file.after, 'FIRST\nSECOND\nTHIRD\n');
});


test('generator omits unsupplied reasons and preserves explicit empty reasons', () => {
  const before = 'old first\nold second\n', after = 'new first\nnew second\n';
  const omitted = createRequestFromSnapshots('sample.tex', before, after, options);
  assert.equal(omitted.request.length, 1); assert.equal(Object.hasOwn(omitted.request[0]!, 'reason'), false);
  const explicit = createRequestFromSnapshots('sample.tex', before, after, {...options, reason: ''});
  assert.equal(Object.hasOwn(explicit.request[0]!, 'reason'), true); assert.equal(explicit.request[0]!.reason, '');
  const local = createRequestFromSnapshots('sample.tex', before, after, {...options, explanations: [{line: 1, text: ''}]});
  assert.equal(Object.hasOwn(local.request[0]!, 'reason'), true); assert.equal(local.request[0]!.reason, '');
});
