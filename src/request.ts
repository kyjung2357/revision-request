import { createHash } from 'node:crypto';
import { renderAccepted, validateRequestPath, type Decision, type Hunk, type RequestFile } from './core';

export interface RequestEntry { line: number; before: string | null; after: string | null; reason?: string; status: Decision }
export interface RevisionRequest { path: string; time?: string; request: RequestEntry[] }
export interface ResolvedRequest {
  file: RequestFile; hunks: Hunk[]; decisions: Record<string, Decision>;
  entryIndexByHunkId: Record<string, number>; baseline: string; expectedTarget: string; identity: string;
}
const MAX_REQUEST = 20 * 1024 * 1024;
const MAX_TEXT = 5 * 1024 * 1024;
const validStatus = (value: unknown): value is Decision => value === 'pending' || value === 'accepted' || value === 'ignored';
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
  return value as Record<string, unknown>;
}
function textValue(value: unknown, label: string, limit = MAX_TEXT): string {
  if (typeof value !== 'string') throw new Error(label + ' must be a string.');
  if (value.includes('\0')) throw new Error(label + ' contains a NUL character.');
  if (Buffer.byteLength(value, 'utf8') > limit) throw new Error(label + ' exceeds the text size limit.');
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error(label + ' contains an unpaired Unicode surrogate.');
  return value;
}
function fragment(value: unknown, label: string): string | null {
  if (value === null) return null;
  const result = textValue(value, label);
  if (/[\r\n]/.test(result)) throw new Error(label + ' must contain text from a single line, without newline characters.');
  return result;
}
function timestamp(value: unknown): string {
  const result = textValue(value, 'Request.time', 100);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(result);
  if (!parts || !Number.isFinite(Date.parse(result))) throw new Error('Request.time must be an ISO 8601 timestamp with a timezone.');
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) {
    throw new Error('Request.time must contain a valid date and time.');
  }
  return result;
}
export function parseRequestDocument(text: string): RevisionRequest {
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST) throw new Error('The revision request exceeds the 20 MiB limit.');
  let input: unknown;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error('Invalid .rr JSON: ' + (error instanceof Error ? error.message : String(error))); }
  const source = record(input, 'Request'), path = validateRequestPath(source.path);
  if (!Array.isArray(source.request) || source.request.length > 10000) throw new Error('Request.request must be an array with at most 10000 entries.');
  const entries = source.request.map((value, index): RequestEntry => {
    const label = 'Request.request[' + index + ']', entry = record(value, label);
    if (!Number.isSafeInteger(entry.line) || (entry.line as number) < 1) throw new Error(label + '.line must be a positive original line number.');
    const before = fragment(entry.before, label + '.before'), after = fragment(entry.after, label + '.after');
    if (before === null && after === null) throw new Error(label + ' cannot have both before and after null.');
    if (!validStatus(entry.status)) throw new Error(label + '.status must be pending, ignored, or accepted.');
    return {line: entry.line as number, before, after, ...(entry.reason === undefined ? {} : {reason: textValue(entry.reason, label + '.reason', 50000)}), status: entry.status};
  });
  return {path, ...(source.time === undefined ? {} : {time: timestamp(source.time)}), request: entries};
}
export function proposalIdentity(request: RevisionRequest): string {
  return createHash('sha256').update(JSON.stringify([request.path,
    request.request.map(entry => [entry.line, entry.before, entry.after, entry.reason ?? ''])])).digest('hex');
}
export interface SourceLine { start: number; end: number; content: string; ending: string }
export function sourceLines(value: string): SourceLine[] {
  const offset = value.startsWith('\uFEFF') ? 1 : 0;
  let position = offset;
  return (value.slice(offset).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []).map(text => {
    const ending = text.match(/(?:\r\n|\r|\n)$/)?.[0] ?? '';
    const result = {start: position, end: position + text.length, content: text.slice(0, text.length - ending.length), ending};
    position = result.end; return result;
  });
}
const unique = (source: string, snippet: string) => snippet === '' ? source === '' : source.indexOf(snippet) >= 0 && source.indexOf(snippet, source.indexOf(snippet) + 1) < 0;
function uniqueOffset(source: string, snippet: string, label: string): number {
  if (!unique(source, snippet)) throw new Error(label + ' must match exactly once within its original line. Include enough unchanged text from that same line.');
  return snippet === '' ? 0 : source.indexOf(snippet);
}
/** Smallest changed span, expanded only within its line when anchors need context. */
export function minimalLineReplacement(before: string, after: string): {before: string; after: string} {
  const a = Array.from(before), b = Array.from(after);
  let left = 0, rightA = a.length, rightB = b.length;
  while (left < rightA && left < rightB && a[left] === b[left]) left++;
  while (rightA > left && rightB > left && a[rightA - 1] === b[rightB - 1]) { rightA--; rightB--; }
  const deadline = Date.now() + 1500;
  const rightContext = a.length - rightA;
  for (let padding = 0; padding <= left + rightContext; padding++) {
    for (let prefix = Math.max(0, padding - rightContext); prefix <= Math.min(left, padding); prefix++) {
      if (Date.now() > deadline) throw new Error('This line is too large to locate a unique change quickly.');
      const suffix = padding - prefix;
      const old = a.slice(left - prefix, rightA + suffix).join('');
      const next = b.slice(left - prefix, rightB + suffix).join('');
      if (unique(before, old) && unique(after, next)) return {before: old, after: next};
    }
  }
  throw new Error('The changed text cannot be located uniquely within its line.');
}
function insertionEnding(lines: SourceLine[], line: number): string {
  for (let distance = 0; distance <= lines.length; distance++) {
    const previous = lines[line - 2 - distance]?.ending;
    if (previous) return previous;
    const next = lines[line - 1 + distance]?.ending;
    if (next) return next;
  }
  return '\n';
}
function bootstrapBaseline(request: RevisionRequest, target: string): string {
  const accepted = request.request.filter(entry => entry.status === 'accepted');
  if (!accepted.length) return target;
  if (accepted.some(entry => entry.after === null)) throw new Error('Accepted line deletions need the saved baseline to preserve exact original line endings.');
  const inserted = accepted.filter(entry => entry.before === null);
  const insertions = new Map<number, RequestEntry[]>(), replacements = new Map<number, RequestEntry>();
  for (const entry of accepted) {
    if (entry.before === null) insertions.set(entry.line, [...(insertions.get(entry.line) ?? []), entry]);
    else replacements.set(entry.line, entry);
  }
  const targetLines = sourceLines(target), candidates = [targetLines];
  if (target === '' || target === '\uFEFF' || /[\r\n]$/.test(target)) candidates.push([...targetLines, {start: target.length, end: target.length, content: '', ending: ''}]);
  let lastError: unknown;
  for (const current of candidates) {
    try {
      const count = current.length - inserted.length;
      if (count < 0) throw new Error('Recorded insertions do not match the current original.');
      const baseline: {content: string; ending: string}[] = [];
      let index = 0;
      for (let line = 1; line <= count + 1; line++) {
        for (const entry of insertions.get(line) ?? []) {
          if (current[index]?.content !== entry.after) throw new Error('Accepted inserted line does not match the current original.');
          index++;
        }
        if (line > count) break;
        const original = current[index++];
        if (!original) throw new Error('The original line is missing.');
        let content = original.content;
        const replacement = replacements.get(line);
        if (replacement) {
          const start = uniqueOffset(content, replacement.after!, 'Accepted request.after');
          content = content.slice(0, start) + replacement.before! + content.slice(start + replacement.after!.length);
        }
        baseline.push({content, ending: original.ending});
      }
      if (index !== current.length) throw new Error('Accepted entries reference lines outside the original.');
      if (count && inserted.some(entry => entry.line === count + 1) && current[current.length - 1]?.ending === '') baseline[count - 1]!.ending = '';
      const value = (target.startsWith('\uFEFF') ? '\uFEFF' : '') + baseline.map(line => line.content + line.ending).join('');
      if (resolveRequest(request, target, value).expectedTarget !== target) throw new Error('The recorded decisions do not reproduce the current original exactly.');
      return value;
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('The recorded decisions cannot be reconstructed without a saved baseline.');
}
export function resolveRequest(request: RevisionRequest, target: string, cachedBaseline?: string): ResolvedRequest {
  textValue(target, 'Current original');
  const baseline = textValue(cachedBaseline ?? bootstrapBaseline(request, target), 'Request baseline');
  const original = sourceLines(baseline);
  const seen = new Set<number>();
  const planned = request.request.map((entry, index) => {
    const source = original[entry.line - 1];
    if (entry.before === null) {
      if (entry.line > original.length + 1) throw new Error('Inserted line must be before an original line or immediately after its last line.');
      const append = entry.line === original.length + 1;
      const unterminated = append && original.length > 0 && original[original.length - 1]!.ending === '';
      if (unterminated && request.request.some(item => item.line === original.length && item.after === null)) throw new Error('Replace the final line instead of combining its deletion with an append at an unterminated end of file.');
      const ending = insertionEnding(original, entry.line), content = entry.after!;
      const start = source?.start ?? baseline.length;
      return {entry, index, start, end: start, before: '', after: unterminated ? ending + content : content + ending,
        displayAfter: unterminated ? content : undefined, oldLines: 0, newLines: 1};
    }
    if (!source) throw new Error('Request.line does not identify an existing original line.');
    if (seen.has(entry.line)) throw new Error('Combine changes on the same original line into one request entry.');
    seen.add(entry.line);
    if (entry.after === null) {
      if (entry.before !== source.content) throw new Error('Deleting a line requires its complete original text in before.');
      return {entry, index, start: source.start, end: source.end, before: source.content + source.ending, after: '', displayAfter: undefined, oldLines: 1, newLines: 0};
    }
    const start = uniqueOffset(source.content, entry.before, 'Request ' + (index + 1) + '.before');
    const after = source.content.slice(0, start) + entry.after + source.content.slice(start + entry.before.length);
    return {entry, index, start: source.start, end: source.end, before: source.content + source.ending,
      after: after + source.ending, displayAfter: undefined, oldLines: 1, newLines: 1};
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  const decisions: Record<string, Decision> = {}, entryIndexByHunkId: Record<string, number> = {};
  const duplicates = new Map<string, number>(); let delta = 0;
  const hunks = planned.map((item, index): Hunk => {
    const identity = JSON.stringify([request.path, item.entry.line, item.start, item.end, item.before, item.after]);
    const ordinal = duplicates.get(identity) ?? 0; duplicates.set(identity, ordinal + 1);
    const id = createHash('sha256').update(identity + ':' + ordinal).digest('hex').slice(0, 24);
    const hunk: Hunk = {id, index, start: item.start, end: item.end, before: item.before, after: item.after,
      ...(item.displayAfter === undefined ? {} : {displayAfter: item.displayAfter}),
      oldStart: item.entry.line, oldLines: item.oldLines, newStart: item.entry.line + delta, newLines: item.newLines,
      contextBefore: original.slice(Math.max(0, item.entry.line - 4), item.entry.line - 1).map(line => line.content),
      contextAfter: original.slice(item.entry.line - 1 + item.oldLines, item.entry.line + 2).map(line => line.content)};
    delta += item.newLines - item.oldLines;
    decisions[id] = item.entry.status; entryIndexByHunkId[id] = item.index; return hunk;
  });
  const after = textValue(renderAccepted(baseline, hunks, Object.fromEntries(hunks.map(hunk => [hunk.id, 'accepted' as Decision]))), 'Proposed original');
  if (baseline.startsWith('\uFEFF') !== after.startsWith('\uFEFF')) throw new Error('Keep the original UTF-8 BOM unchanged.');
  const expectedTarget = renderAccepted(baseline, hunks, decisions);
  if (cachedBaseline === undefined && expectedTarget !== target) throw new Error('The stored request statuses do not match the current original. Create a fresh request.');
  const file: RequestFile = {path: request.path, before: baseline, after, reviewHunks: hunks,
    explanations: hunks.map(hunk => ({line: hunk.oldStart, text: request.request[entryIndexByHunkId[hunk.id]!]!.reason ?? ''}))};
  return {file, hunks, decisions, entryIndexByHunkId, baseline, expectedTarget, identity: proposalIdentity(request)};
}

interface Range { start: number; end: number; keyStart?: number }
function whitespace(text: string, start: number): number { while (start < text.length && /\s/.test(text[start]!)) start++; return start; }
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') return i + 1; }
  throw new Error('The request contains an unterminated JSON string.');
}
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let depth = 1, index = start + 1;
    while (index < text.length && depth) {
      const value = text[index]!;
      if (value === '"') { index = stringEnd(text, index); continue; }
      if (value === '{' || value === '[') depth++; else if (value === '}' || value === ']') depth--;
      index++;
    }
    return index;
  }
  let index = start; while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index++; return index;
}
function property(text: string, start: number, name: string): Range | undefined {
  let found: Range | undefined, index = whitespace(text, start + 1);
  while (text[index] !== '}') {
    const keyStart = index, keyEnd = stringEnd(text, index), key = JSON.parse(text.slice(index, keyEnd));
    const valueStart = whitespace(text, whitespace(text, keyEnd) + 1), end = valueEnd(text, valueStart);
    if (key === name) found = {start: valueStart, end, keyStart};
    index = whitespace(text, end); if (text[index] !== ',') break; index = whitespace(text, index + 1);
  }
  return found;
}
function requestEntries(text: string): Range[] {
  const root = whitespace(text, text.startsWith('\uFEFF') ? 1 : 0), array = property(text, root, 'request');
  if (!array) throw new Error('The request array is missing.');
  const result: Range[] = []; let index = whitespace(text, array.start + 1);
  while (text[index] !== ']') { const end = valueEnd(text, index); result.push({start: index, end}); index = whitespace(text, end); if (text[index] !== ',') break; index = whitespace(text, index + 1); }
  return result;
}
function replaceTokens(text: string, replacements: (Range & {value: string})[]): string {
  let result = text;
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) result = result.slice(0, item.start) + item.value + result.slice(item.end);
  parseRequestDocument(result); return result;
}
/** Only status tokens change; unrelated metadata, BOM, escaping and EOLs survive. */
export function patchRequestStatuses(text: string, updates: Record<number, Decision>): string {
  const doc = parseRequestDocument(text), entries = requestEntries(text), replacements: (Range & {value: string})[] = [];
  for (const [key, status] of Object.entries(updates)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length || String(index) !== key || !validStatus(status)) throw new Error('Invalid request status update.');
    if (doc.request[index]!.status === status) continue;
    const token = property(text, entries[index]!.start, 'status'); if (!token) throw new Error('The request status is missing.');
    replacements.push({...token, value: JSON.stringify(status)});
  }
  return replaceTokens(text, replacements);
}
/** Add the creation timestamp after the effective path without rewriting the JSON. */
export function ensureRequestTime(text: string, time: string): string {
  const doc = parseRequestDocument(text); if (doc.time !== undefined) return text;
  const checked = timestamp(time), root = whitespace(text, text.startsWith('\uFEFF') ? 1 : 0);
  const token = property(text, root, 'path'); if (!token) throw new Error('The request path is missing.');
  const keyStart = token.keyStart!;
  const lineStart = Math.max(text.lastIndexOf('\n', keyStart - 1), text.lastIndexOf('\r', keyStart - 1)) + 1;
  const prefix = text.slice(lineStart, keyStart);
  const newline = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const separator = /^[ \t]*$/.test(prefix) ? newline + prefix : ' ';
  const inserted = text.slice(0, token.end) + ',' + separator + '"time": ' + JSON.stringify(checked) + text.slice(token.end);
  parseRequestDocument(inserted); return inserted;
}
/** Edit the displayed single line, keeping other entries and the target unchanged. */
export function editPendingRequest(text: string, baseline: string, hunkId: string, draft: string): {text: string; request: RevisionRequest; review: ResolvedRequest; changed: boolean} {
  const request = parseRequestDocument(text), review = resolveRequest(request, baseline, baseline);
  const hunk = review.hunks.find(item => item.id === hunkId);
  if (!hunk) throw new Error('This change no longer exists. Review the refreshed request.');
  const index = review.entryIndexByHunkId[hunkId]!, entry = request.request[index]!;
  if (entry.status !== 'pending') throw new Error('Only pending changes can be edited.');
  const content = textValue(draft, 'Draft').replace(/(?:\r\n|\r|\n)$/, '');
  if (/[\r\n]/.test(content)) throw new Error('Edit one line at a time. Add separate request entries for additional lines.');
  const displayed = (hunk.displayAfter ?? hunk.after).replace(/(?:\r\n|\r|\n)$/, '');
  if (content === displayed) return {text, request, review, changed: false};
  const entries = requestEntries(text), source = sourceLines(baseline)[entry.line - 1];
  let updated: string;
  if (entry.before !== null && content === source!.content) {
    const start = index === entries.length - 1 && index > 0 ? entries[index - 1]!.end : entries[index]!.start;
    const end = index < entries.length - 1 ? entries[index + 1]!.start : entries[index]!.end;
    updated = text.slice(0, start) + text.slice(end);
  } else {
    const replacement = entry.before === null ? {before: null, after: content} : minimalLineReplacement(source!.content, content);
    const beforeToken = property(text, entries[index]!.start, 'before'), afterToken = property(text, entries[index]!.start, 'after');
    if (!beforeToken || !afterToken) throw new Error('The selected entry has no before/after text.');
    updated = replaceTokens(text, [{...beforeToken, value: JSON.stringify(replacement.before)}, {...afterToken, value: JSON.stringify(replacement.after)}]);
  }
  const nextRequest = parseRequestDocument(updated), nextReview = resolveRequest(nextRequest, review.expectedTarget, baseline);
  if (nextReview.expectedTarget !== review.expectedTarget) throw new Error('Editing a pending proposal must preserve the current original.');
  for (const previous of review.hunks) {
    if (review.decisions[previous.id] !== 'pending' && !nextReview.hunks.some(item => item.id === previous.id && nextReview.decisions[item.id] === review.decisions[previous.id])) {
      throw new Error('This edit changes an accepted or ignored block. Undo that decision before editing across it.');
    }
  }
  return {text: updated, request: nextRequest, review: nextReview, changed: updated !== text};
}
