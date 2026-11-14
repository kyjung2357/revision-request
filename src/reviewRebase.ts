import { diffArrays } from 'diff';
import { computeHunks, renderAccepted, type Decision, type Hunk, type RequestFile } from './core';

const MAX_BYTES = 5 * 1024 * 1024;
const CONFLICT = 'The original changed inside this pending block. Review a fresh proposal or ignore this change.';
const AMBIGUOUS = 'The current position of this change is ambiguous after an original edit.';
const UNDO_BLOCKED = 'This part of the original was edited directly after the decision. Undo is unavailable.';

export interface TrackedEntry {
  hunk: Hunk;
  start: number;
  end: number;
  decision: Decision;
  conflict?: string;
  undoBlocked?: string;
}
export interface TrackedReview {
  version: 1;
  path: string;
  text: string;
  entries: TrackedEntry[];
}
export interface TrackedHunk extends Hunk {
  decision: Decision;
  conflict?: string;
  undoBlocked?: string;
}
export interface TrackedProjection {
  file: RequestFile;
  hunks: TrackedHunk[];
  decisions: Record<string, Decision>;
}
interface Edit { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
const decision = (value: unknown): value is Decision => value === 'pending' || value === 'accepted' || value === 'ignored';
const physicalLines = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
const countLines = (text: string) => physicalLines(text).length;
function checkText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_BYTES || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new Error('Review tracking requires valid UTF-8 text within the 5 MiB limit.');
  }
}
function copy(review: TrackedReview): TrackedReview {
  return {...review, entries: review.entries.map(entry => ({...entry, hunk: {...entry.hunk,
    contextBefore: [...entry.hunk.contextBefore], contextAfter: [...entry.hunk.contextAfter]}}))};
}
/** Reject corrupt persisted tracking rather than deriving fresh approval authority from it. */
export function validateTrackedReview(value: unknown): TrackedReview {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved review tracking.');
  const review = value as TrackedReview;
  checkText(review.text);
  if (review.version !== 1 || typeof review.path !== 'string' || !review.path || !Array.isArray(review.entries) || review.entries.length > 10_000) {
    throw new Error('Invalid saved review tracking.');
  }
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const entry of review.entries) {
    const hunk = entry?.hunk;
    if (!hunk || typeof hunk.id !== 'string' || !hunk.id || ids.has(hunk.id) || !decision(entry.decision) ||
      !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < previousEnd || entry.end < entry.start || entry.end > review.text.length ||
      !Number.isSafeInteger(hunk.index) || hunk.index < 0 || !Number.isSafeInteger(hunk.start) || !Number.isSafeInteger(hunk.end) || hunk.start < 0 || hunk.end < hunk.start ||
      !Number.isSafeInteger(hunk.oldStart) || hunk.oldStart < 1 || !Number.isSafeInteger(hunk.newStart) || hunk.newStart < 1 ||
      !Number.isSafeInteger(hunk.oldLines) || hunk.oldLines < 0 || !Number.isSafeInteger(hunk.newLines) || hunk.newLines < 0 ||
      !Array.isArray(hunk.contextBefore) || !Array.isArray(hunk.contextAfter) ||
      [...hunk.contextBefore, ...hunk.contextAfter].some(item => typeof item !== 'string') ||
      (entry.conflict !== undefined && typeof entry.conflict !== 'string') || (entry.undoBlocked !== undefined && typeof entry.undoBlocked !== 'string')) {
      throw new Error('Invalid saved review ranges.');
    }
    checkText(hunk.before); checkText(hunk.after);
    if (hunk.displayAfter !== undefined) checkText(hunk.displayAfter);
    if (hunk.draftAfter !== undefined) checkText(hunk.draftAfter);
    if (!entry.conflict && !entry.undoBlocked && review.text.slice(entry.start, entry.end) !== (entry.decision === 'accepted' ? hunk.after : hunk.before)) {
      throw new Error('The saved review range no longer matches its recorded decision.');
    }
    ids.add(hunk.id); previousEnd = entry.end;
  }
  return copy(review);
}

export function createTrackedReview(file: RequestFile, decisions: Record<string, Decision>): TrackedReview {
  checkText(file.before); checkText(file.after);
  const hunks = computeHunks(file), text = renderAccepted(file.before, hunks, decisions);
  checkText(text);
  let delta = 0;
  const entries = hunks.map(hunk => {
    const current = decisions[hunk.id] ?? 'pending';
    if (!decision(current)) throw new Error('Invalid review decision.');
    const start = hunk.start + delta, contents = current === 'accepted' ? hunk.after : hunk.before;
    const entry: TrackedEntry = {hunk: {...hunk}, start, end: start + contents.length, decision: current};
    delta += contents.length - hunk.before.length;
    return entry;
  });
  return validateTrackedReview({version: 1, path: file.path, text, entries});
}
function editsFromDiff(before: string[], after: string[], timeout: number): Edit[] {
  if (timeout <= 0) throw new Error('The original comparison timed out. Review the source before continuing.');
  const parts = diffArrays(before, after, {timeout});
  if (!parts) throw new Error('The original comparison timed out. Review the source before continuing.');
  const edits: Edit[] = [];
  let oldOffset = 0, newOffset = 0;
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      const length = part.value.reduce((sum, line) => sum + line.length, 0);
      oldOffset += length; newOffset += length; index++; continue;
    }
    const edit = {oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset};
    while (index < parts.length && (parts[index]!.added || parts[index]!.removed)) {
      const item = parts[index++]!, length = item.value.reduce((sum, line) => sum + line.length, 0);
      if (item.removed) oldOffset += length;
      else newOffset += length;
    }
    edit.oldEnd = oldOffset; edit.newEnd = newOffset; edits.push(edit);
  }
  return edits;
}
function upperBound<T>(items: T[], value: number, coordinate: (item: T) => number): number {
  let low = 0, high = items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (coordinate(items[middle]!) <= value) low = middle + 1; else high = middle; }
  return low;
}
function point(position: number, edits: Edit[], right: boolean): number {
  const edit = edits[upperBound(edits, position, item => item.oldStart) - 1];
  if (!edit) return position;
  if (edit.oldStart === edit.oldEnd && position === edit.oldStart) return right ? edit.newEnd : edit.newStart;
  if (position < edit.oldEnd) return edit.newStart;
  return position + edit.newEnd - edit.oldEnd;
}
function touched(entry: TrackedEntry, edits: Edit[]): boolean {
  if (entry.start === entry.end) {
    const edit = edits[upperBound(edits, entry.start, item => item.oldStart) - 1];
    return Boolean(edit && (edit.oldStart === edit.oldEnd ? edit.oldStart === entry.start : entry.start < edit.oldEnd));
  }
  const edit = edits[upperBound(edits, entry.start, item => item.oldEnd)];
  return Boolean(edit && edit.oldStart < entry.end);
}
function mappedRange(entry: TrackedEntry, edits: Edit[]): [number, number] {
  const start = point(entry.start, edits, true);
  return [start, Math.max(start, point(entry.end, edits, entry.start === entry.end))];
}
/** Adopt saved external edits while keeping the original proposal and decisions immutable. */
export function rebaseTrackedReview(value: TrackedReview, currentText: string, timeBudgetMs = 200): TrackedReview {
  const review = validateTrackedReview(value); checkText(currentText);
  if (review.text === currentText) return review;
  if (review.text.startsWith('\uFEFF') !== currentText.startsWith('\uFEFF')) throw new Error('The original UTF-8 BOM changed. Create a fresh request.');
  const offset = review.text.startsWith('\uFEFF') ? 1 : 0;
  const before = physicalLines(review.text.slice(offset)), after = physicalLines(currentText.slice(offset));
  const deadline = Date.now() + Math.max(0, timeBudgetMs);
  const addBom = (edit: Edit): Edit => ({oldStart: edit.oldStart + offset, oldEnd: edit.oldEnd + offset, newStart: edit.newStart + offset, newEnd: edit.newEnd + offset});
  const edits = editsFromDiff(before, after, deadline - Date.now()).map(addBom);
  // A reversed comparison chooses the opposite alignment of repeated equal lines.
  // Disagreeing coordinates are not sufficient evidence for an automatic rebase.
  const oldLength = review.text.length - offset, newLength = currentText.length - offset;
  const reverse = editsFromDiff([...before].reverse(), [...after].reverse(), deadline - Date.now()).map(edit => addBom({
    oldStart: oldLength - edit.oldEnd, oldEnd: oldLength - edit.oldStart,
    newStart: newLength - edit.newEnd, newEnd: newLength - edit.newStart
  })).reverse();
  let previousEnd = offset;
  review.entries = review.entries.map(entry => {
    let [start, end] = mappedRange(entry, edits);
    const alternate = mappedRange(entry, reverse);
    const ambiguous = start !== alternate[0] || end !== alternate[1];
    const changed = touched(entry, edits) || touched(entry, reverse);
    // A replacement crossing several blocks can collapse earlier spans. Retain
    // each decision row, but show current source text at most once.
    start = Math.max(previousEnd, start); end = Math.max(start, end); previousEnd = end;
    const result = {...entry, start, end};
    if (changed || ambiguous) {
      if (entry.decision === 'pending') result.conflict = ambiguous ? AMBIGUOUS : CONFLICT;
      else result.undoBlocked = UNDO_BLOCKED;
    }
    return result;
  });
  review.text = currentText;
  return validateTrackedReview(review);
}
/** Apply only explicitly selected decisions to the latest current source. */
export function transitionTrackedReview(value: TrackedReview, changes: Record<string, Decision>): TrackedReview {
  const review = validateTrackedReview(value), known = new Set(review.entries.map(entry => entry.hunk.id));
  for (const [id, next] of Object.entries(changes)) if (!known.has(id) || !decision(next)) throw new Error('Unknown change or invalid review decision.');
  const parts: string[] = [];
  let cursor = 0, delta = 0;
  review.entries = review.entries.map(entry => {
    const next = changes[entry.hunk.id] ?? entry.decision;
    let text = review.text.slice(entry.start, entry.end);
    const result = {...entry};
    if (next !== entry.decision) {
      if (entry.decision !== 'pending' && next !== 'pending') throw new Error('Undo the previous decision before choosing another one.');
      if (next === 'pending') {
        if (entry.undoBlocked) throw new Error(entry.undoBlocked);
        if (entry.decision === 'accepted') text = entry.hunk.before;
        delete result.conflict;
      } else if (next === 'accepted') {
        if (entry.conflict) throw new Error(entry.conflict);
        text = entry.hunk.after;
      } else if (entry.conflict) {
        // Ignoring a conflict discards only the proposal; its manual source stays.
        result.undoBlocked = UNDO_BLOCKED; delete result.conflict;
      }
    }
    const start = entry.start + delta;
    parts.push(review.text.slice(cursor, entry.start), text); cursor = entry.end;
    delta += text.length - (entry.end - entry.start);
    return {...result, start, end: start + text.length, decision: next};
  });
  parts.push(review.text.slice(cursor)); review.text = parts.join('');
  return validateTrackedReview(review);
}
/** Carry current ranges into an explicitly edited proposal generation. */
export function reconfigureTrackedReview(value: TrackedReview, file: RequestFile,
  decisions: Record<string, Decision>, newToOldIds: Record<string, string> = {}): TrackedReview {
  const review = validateTrackedReview(value);
  if (file.path !== review.path) throw new Error('A review cannot change its target path.');
  const old = new Map(review.entries.map(entry => [entry.hunk.id, entry])), used = new Set<string>();
  const entries = computeHunks(file).map(hunk => {
    const oldId = newToOldIds[hunk.id] ?? hunk.id, previous = old.get(oldId);
    if (!previous || used.has(oldId)) throw new Error('The edited proposal does not match the tracked review.');
    used.add(oldId);
    const changed = hunk.before !== previous.hunk.before || hunk.after !== previous.hunk.after || hunk.start !== previous.hunk.start || hunk.end !== previous.hunk.end;
    if (changed && (previous.decision !== 'pending' || previous.conflict || hunk.before !== previous.hunk.before || hunk.start !== previous.hunk.start || hunk.end !== previous.hunk.end)) {
      throw new Error('Only an unchanged pending original block can receive an edited proposal.');
    }
    return {...previous, hunk: {...hunk}};
  });
  for (const entry of review.entries) if (!used.has(entry.hunk.id) && (entry.decision !== 'pending' || entry.conflict)) {
    throw new Error('A reviewed or conflicting entry cannot be removed by proposal editing.');
  }
  return transitionTrackedReview({...review, entries}, decisions);
}
function lineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}
/** A display projection never uses historic accepted text over newer manual edits. */
export function projectTrackedReview(value: TrackedReview): TrackedProjection {
  const review = validateTrackedReview(value);
  const starts = lineStarts(review.text);
  const hunks: TrackedHunk[] = review.entries.map(entry => {
    const pending = entry.decision === 'pending';
    let start = entry.start, before = review.text.slice(start, entry.end);
    // Accepted EOF additions own their preceding separator for Undo. In the
    // visual projection that separator belongs to surrounding current context.
    if (!pending && entry.hunk.displayAfter !== undefined && entry.decision === 'accepted') {
      const prefix = before.match(/^(?:\r\n|\r|\n)/)?.[0] ?? '';
      start += prefix.length; before = before.slice(prefix.length);
    }
    const oldStart = upperBound(starts, start, value => value) + (pending && start === review.text.length && !before && start > 0 && !/[\r\n]$/.test(review.text) ? 1 : 0);
    const hunk: TrackedHunk = {...entry.hunk, start, end: entry.end, before,
      after: pending ? entry.hunk.after : before, oldStart, newStart: oldStart,
      oldLines: countLines(before), newLines: pending ? entry.hunk.newLines : countLines(before), decision: entry.decision,
      ...(entry.conflict ? {conflict: entry.conflict} : {}), ...(entry.undoBlocked ? {undoBlocked: entry.undoBlocked} : {})};
    if (!pending) {delete hunk.displayAfter; delete hunk.draftAfter;}
    return hunk;
  });
  const decisions = Object.fromEntries(hunks.map(hunk => [hunk.id, hunk.decision]));
  const after = renderAccepted(review.text, hunks, Object.fromEntries(hunks.map(hunk => [hunk.id, 'accepted' as Decision])));
  return {file: {path: review.path, before: review.text, after, reviewHunks: hunks}, hunks, decisions};
}
