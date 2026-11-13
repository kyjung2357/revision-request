import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';
import { inlineDiffRulesFor } from './inlineDiffRules';
import { createInlineDiffContext, type InlineDiffContext } from './inlineDiffContext';
import { computeInlineChanges, type InlineChangeLine } from './inlineChanges';
export { computeInlineChanges, type InlineSegment, type InlineChangeLine } from './inlineChanges';

/** A review decision never changes the proposal's base snapshot. */
export type Decision = 'pending' | 'accepted' | 'ignored';

export interface RequestExplanation {
  /** The first original line of the change group (one based). */
  line: number;
  /** Empty text explicitly suppresses the file-level reason for this group. */
  text: string;
}

export interface RequestFile {
  /** A forward-slash path relative to the workspace containing the request. */
  path: string;
  before: string;
  after: string;
  reason?: string;
  explanations?: RequestExplanation[];
  /** Internal atomic groups resolved from snippets; never read from raw JSON. */
  reviewHunks?: Hunk[];
}

export interface Hunk {
  id: string;
  index: number;
  /** UTF-16 offsets into the original text, end exclusive. */
  start: number;
  end: number;
  before: string;
  after: string;
  /** Display-only line text when a physical append includes its preceding separator. */
  displayAfter?: string;
  /** Exact editable logical block, excluding only its physical final line ending. */
  draftAfter?: string;
  /** One-based line positions. A pure insertion/deletion may have zero lines. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  contextBefore: string[];
  contextAfter: string[];
}

const MAX_TEXT_BYTES = 5 * 1024 * 1024;


function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum: number, nonempty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  if (nonempty && !value.trim()) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} contains a NUL character; only text files are supported.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximum) {
    throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : string(value, label, maximum);
}

function explanations(value: unknown, label: string): RequestExplanation[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error(`${label} must be an array with at most 10000 entries.`);
  }
  const seen = new Set<number>();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = object(entry, itemLabel);
    if (typeof item.line !== 'number' || !Number.isSafeInteger(item.line) || item.line < 1) {
      throw new Error(`${itemLabel}.line must be a positive safe integer.`);
    }
    if (seen.has(item.line)) {
      throw new Error(`${label} contains a duplicate original line: ${item.line}.`);
    }
    seen.add(item.line);
    return { line: item.line, text: string(item.text, `${itemLabel}.text`, 50_000) };
  });
}

function relativePath(value: unknown, label: string): string {
  const result = string(value, label, 4096, true);
  if (result.includes('\\')) {
    throw new Error(`${label} must use forward slashes.`);
  }
  if (result.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(result)) {
    throw new Error(`${label} must be relative to the workspace.`);
  }
  const segments = result.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain empty, "." or ".." path segments.`);
  }
  if (segments.some(segment => /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment))) {
    throw new Error(`${label} contains an invalid or ambiguous file name.`);
  }
  if (segments.some(segment => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`${label} contains a reserved Windows file name.`);
  }
  return result;
}

/** Validate internal complete snapshots used to compute or generate review groups. */
export function validateRequestFile(value: unknown): RequestFile {
  const file = object(value, 'File');
  return {
    path: relativePath(file.path, 'File.path'),
    before: string(file.before, 'File.before', MAX_TEXT_BYTES),
    after: string(file.after, 'File.after', MAX_TEXT_BYTES),
    ...(file.reason === undefined ? {} : {reason: optionalString(file.reason, 'File.reason', 50_000)}),
    ...(file.explanations === undefined ? {} : {explanations: explanations(file.explanations, 'File.explanations')}),
  };
}

/** Split text without normalizing CRLF, CR, LF, or the final newline. */
function lines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function displayLine(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/, '');
}

/** Highlight pending blocks in the same lexical context as the visible review columns. */
export function computeFileInlineChanges(
  file: RequestFile, hunks: Hunk[], decisions: Record<string, Decision>, timeBudgetMs = 120,
): Map<string, InlineChangeLine[]> {
  const deadline = Date.now() + Math.max(0, timeBudgetMs);
  const result = new Map<string, InlineChangeLine[]>();
  if (!hunks.some(hunk => (decisions[hunk.id] ?? 'pending') === 'pending')) return result;
  let context: InlineDiffContext | undefined;
  if (inlineDiffRulesFor(file.path).createTokenizer && Date.now() < deadline) {
    const rightDecisions: Record<string, Decision> = Object.fromEntries(hunks.map(hunk =>
      [hunk.id, decisions[hunk.id] === 'ignored' ? 'ignored' : 'accepted']));
    const before = renderAccepted(file.before, hunks, decisions).replace(/^\uFEFF/, '');
    const after = renderAccepted(file.before, hunks, rightDecisions).replace(/^\uFEFF/, '');
    context = createInlineDiffContext(file.path, before, after, deadline);
  }
  let leftDelta = 0, rightDelta = 0;
  for (const hunk of hunks) {
    const decision = decisions[hunk.id] ?? 'pending';
    if (decision === 'pending') {
      result.set(hunk.id, computeInlineChanges({
        before: hunk.before, after: hunk.displayAfter ?? hunk.after,
        oldStart: hunk.oldStart + leftDelta, newStart: hunk.oldStart + rightDelta,
      }, Math.min(40, Math.max(0, deadline - Date.now())), file.path, context));
    }
    const delta = hunk.newLines - hunk.oldLines;
    if (decision === 'accepted') leftDelta += delta;
    if (decision !== 'ignored') rightDelta += delta;
  }
  return result;
}

export function validateRequestPath(value: unknown): string { return relativePath(value, 'Request.path'); }

/** Derive independently reviewable groups; does not access the filesystem. */
export function computeHunks(file: RequestFile): Hunk[] {
  if (file.reviewHunks) {
    const accepted = Object.fromEntries(file.reviewHunks.map(hunk => [hunk.id, 'accepted' as Decision]));
    if (renderAccepted(file.before, file.reviewHunks, accepted) !== file.after) throw new Error('Invalid atomic review groups.');
    return file.reviewHunks.map(hunk => ({...hunk}));
  }
  if (file.before === file.after) {
    return [];
  }
  const original = lines(file.before);
  const proposed = lines(file.after);
  const components = diffArrays(original, proposed, { timeout: 1500 });
  if (!components) {
    throw new Error(`The changes in "${file.path}" are too large to compare quickly. Split this request into smaller changes.`);
  }
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldOffset = 0;
  let partIndex = 0;
  while (partIndex < components.length) {
    const component = components[partIndex]!;
    if (!component.added && !component.removed) {
      oldIndex += component.value.length;
      newIndex += component.value.length;
      oldOffset += component.value.join('').length;
      partIndex++;
      continue;
    }

    const start = oldOffset;
    const oldStart = oldIndex + 1;
    const newStart = newIndex + 1;
    let removed = '';
    let added = '';
    let oldLines = 0;
    let newLines = 0;
    while (partIndex < components.length) {
      const changed = components[partIndex]!;
      if (!changed.added && !changed.removed) {
        break;
      }
      const value = changed.value.join('');
      if (changed.removed) {
        removed += value;
        oldLines += changed.value.length;
        oldIndex += changed.value.length;
        oldOffset += value.length;
      } else {
        added += value;
        newLines += changed.value.length;
        newIndex += changed.value.length;
      }
      partIndex++;
    }

    const end = oldOffset;
    const id = createHash('sha256')
      .update(JSON.stringify([file.path, start, end, removed, added]))
      .digest('hex').slice(0, 24);
    hunks.push({
      id,
      index: hunks.length,
      start,
      end,
      before: removed,
      after: added,
      oldStart,
      oldLines,
      newStart,
      newLines,
      contextBefore: original.slice(Math.max(0, oldStart - 4), oldStart - 1).map(displayLine),
      contextAfter: original.slice(oldIndex, oldIndex + 3).map(displayLine),
    });
  }
  return hunks;
}

/**
 * Rebuild the expected target from the immutable base and accepted groups only.
 * Calling this is safe: the returned text must still be applied by the host.
 */
export function renderAccepted(
  before: string,
  hunks: Hunk[],
  decisions: Record<string, Decision>,
): string {
  const parts: string[] = [];
  const ids = new Set<string>();
  let position = 0;
  for (const hunk of hunks) {
    if (
      !Number.isInteger(hunk.start) || !Number.isInteger(hunk.end) ||
      hunk.start < position || hunk.end < hunk.start || hunk.end > before.length ||
      before.slice(hunk.start, hunk.end) !== hunk.before || ids.has(hunk.id)
    ) {
      throw new Error('The proposal contains invalid, overlapping, or stale change groups.');
    }
    ids.add(hunk.id);
    const decision = decisions[hunk.id] ?? 'pending';
    if (decision !== 'pending' && decision !== 'accepted' && decision !== 'ignored') {
      throw new Error('The proposal contains an invalid review decision.');
    }
    parts.push(before.slice(position, hunk.start));
    parts.push(decision === 'accepted' ? hunk.after : hunk.before);
    position = hunk.end;
  }
  parts.push(before.slice(position));
  return parts.join('');
}

/** Content-bound storage key: changing the proposal invalidates old decisions. */
export function requestFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
