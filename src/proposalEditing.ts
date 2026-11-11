import { diffArrays } from 'diff';
import { computeHunks, parseRequest, renderAccepted, type Decision, type Hunk, type RequestFile } from './core';

export interface PendingHunkEdit {
  file: RequestFile;
  decisions: Record<string, Decision>;
  changed: boolean;
}

interface TextLine { text: string; ending: string }
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const normalized = (text: string) => text.replace(/\r\n|\r/g, '\n');

function validateText(value: string, label: string): void {
  if (typeof value !== 'string') throw new Error(label + ' must be text.');
  if (value.includes('\0')) throw new Error(label + ' contains a NUL character.');
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new Error(label + ' exceeds the 5 MiB snapshot limit.');
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error(label + ' contains an unpaired Unicode surrogate.');
  }
}

function validateFile(file: RequestFile): void {
  validateText(file.before, 'Original snapshot');
  validateText(file.after, 'Proposed snapshot');
  parseRequest(JSON.stringify({ version: 1, title: 'Edit pending proposal', files: [file] }));
  if (file.before.startsWith('\uFEFF') !== file.after.startsWith('\uFEFF')) {
    throw new Error('Keep the original UTF-8 BOM unchanged in the proposal.');
  }
}

function splitLines(text: string): TextLine[] {
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []).map(line => {
    const ending = line.match(/(?:\r\n|\r|\n)$/)?.[0] ?? '';
    return { text: line.slice(0, line.length - ending.length), ending };
  });
}

function preferredEnding(file: RequestFile, hunk: Hunk, proposedOffset: number): string {
  const blockEnding = (hunk.after.match(/\r\n|\r|\n/) ?? hunk.before.match(/\r\n|\r|\n/))?.[0];
  if (blockEnding) return blockEnding;
  // An insertion at a boundary follows the nearest preceding source line.
  let preceding: string | undefined;
  for (const match of file.after.matchAll(/\r\n|\r|\n/g)) {
    if (match.index >= proposedOffset) return preceding ?? match[0];
    preceding = match[0];
  }
  return preceding ?? file.before.match(/\r\n|\r|\n/)?.[0] ?? '\n';
}

/** Restore exact endings on matching proposed lines, and preserve draft EOF intent. */
function restoreEndings(previous: string, draft: string, fallback: string): string {
  const oldLines = splitLines(previous);
  const newLines = splitLines(draft);
  const components = diffArrays(oldLines.map(line => line.text), newLines.map(line => line.text), { timeout: 1500 });
  if (!components) throw new Error('This edit is too large to compare quickly. Make a smaller change.');
  const output: string[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const component of components) {
    if (component.removed) {
      oldIndex += component.value.length;
      continue;
    }
    for (let index = 0; index < component.value.length; index++) {
      const next = newLines[newIndex++]!;
      const old = component.added ? undefined : oldLines[oldIndex++];
      output.push(next.text, next.ending ? old?.ending || fallback : '');
    }
  }
  return output.join('');
}

/**
 * Edit only a pending proposal block. No source or review state is mutated.
 * The textarea draft represents the complete hunk.after with LF-normalized EOLs.
 */
export function editPendingHunk(
  file: RequestFile,
  decisions: Record<string, Decision>,
  hunkId: string,
  draft: string,
): PendingHunkEdit {
  validateFile(file);
  validateText(draft, 'Draft');
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new Error('The proposal contains invalid review decisions.');
  }
  const previousHunks = computeHunks(file);
  const previousIds = new Set(previousHunks.map(hunk => hunk.id));
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision !== 'pending' && decision !== 'accepted' && decision !== 'ignored') {
      throw new Error('The proposal contains an invalid review decision.');
    }
    if (decision !== 'pending' && !previousIds.has(id)) {
      throw new Error('A resolved change is stale or missing. Reload the request before editing.');
    }
  }
  const previousDecisions: Record<string, Decision> = Object.fromEntries(
    previousHunks.map(hunk => [hunk.id, decisions[hunk.id] ?? 'pending']),
  );
  const selected = previousHunks.find(hunk => hunk.id === hunkId);
  if (!selected) throw new Error('This change no longer exists. Reload the request before editing.');
  if (previousDecisions[hunkId] !== 'pending') throw new Error('Only pending changes can be edited.');

  const expectedTarget = renderAccepted(file.before, previousHunks, previousDecisions);
  const normalizedDraft = normalized(draft);
  if (normalizedDraft === normalized(selected.after)) {
    return { file, decisions: previousDecisions, changed: false };
  }
  let proposedOffset = selected.start;
  for (const hunk of previousHunks) {
    if (hunk.id === selected.id) break;
    proposedOffset += hunk.after.length - (hunk.end - hunk.start);
  }
  if (file.after.slice(proposedOffset, proposedOffset + selected.after.length) !== selected.after) {
    throw new Error('This proposal block has moved. Reload the request before editing.');
  }
  const replacement = restoreEndings(selected.after, normalizedDraft, preferredEnding(file, selected, proposedOffset));
  const after = file.after.slice(0, proposedOffset) + replacement + file.after.slice(proposedOffset + selected.after.length);
  const nextFile: RequestFile = { ...file, after };
  validateFile(nextFile);
  if (after === file.after) return { file, decisions: previousDecisions, changed: false };

  const nextHunks = computeHunks(nextFile);
  const nextIds = new Set(nextHunks.map(hunk => hunk.id));
  for (const hunk of previousHunks) {
    if (previousDecisions[hunk.id] !== 'pending' && !nextIds.has(hunk.id)) {
      throw new Error('This edit would merge or change an accepted or ignored block. Undo that decision before editing across it.');
    }
  }
  const nextDecisions: Record<string, Decision> = Object.fromEntries(
    nextHunks.map(hunk => [hunk.id, previousDecisions[hunk.id] ?? 'pending']),
  );
  if (renderAccepted(nextFile.before, nextHunks, nextDecisions) !== expectedTarget) {
    throw new Error('This edit would change the accepted source content. The proposal was not changed.');
  }
  return { file: nextFile, decisions: nextDecisions, changed: true };
}

interface JsonRange { start: number; end: number }
function skipWhitespace(text: string, start: number): number {
  while (start < text.length && /\s/.test(text[start]!)) start++;
  return start;
}
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  throw new Error('The request contains an unterminated JSON string.');
}

/** Skip one already-validated JSON value without recursive stack growth. */
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let depth = 1;
    let index = start + 1;
    while (index < text.length && depth) {
      const character = text[index]!;
      if (character === '"') { index = stringEnd(text, index); continue; }
      if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') depth--;
      index++;
    }
    return index;
  }
  let index = start;
  while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index++;
  return index;
}

/** JSON.parse uses the last duplicate property; the token edit follows that rule. */
function objectProperty(text: string, start: number, name: string): JsonRange | undefined {
  let found: JsonRange | undefined;
  let index = skipWhitespace(text, start + 1);
  while (text[index] !== '}') {
    const end = stringEnd(text, index);
    const key: unknown = JSON.parse(text.slice(index, end));
    const valueStart = skipWhitespace(text, skipWhitespace(text, end) + 1);
    const valueFinish = valueEnd(text, valueStart);
    if (key === name) found = { start: valueStart, end: valueFinish };
    index = skipWhitespace(text, valueFinish);
    if (text[index] === ',') index = skipWhitespace(text, index + 1);
    else break;
  }
  return found;
}

/**
 * Change only the effective files[0].after JSON string token.
 * Preserve all other raw bytes, including unknown metadata, large numbers,
 * duplicate properties, indentation, escaping, the request BOM, and line endings.
 */
export function replaceRequestAfter(text: string, after: string): string {
  const request = parseRequest(text);
  validateFile({ ...request.files[0]!, after });
  if (request.files[0]!.after === after) return text;
  const root = skipWhitespace(text, text.startsWith('\uFEFF') ? 1 : 0);
  const files = objectProperty(text, root, 'files');
  if (!files || text[files.start] !== '[') throw new Error('The request has no files array.');
  const fileStart = skipWhitespace(text, files.start + 1);
  const value = objectProperty(text, fileStart, 'after');
  if (!value || text[value.start] !== '"') throw new Error('The request has no proposed-text string.');
  const updated = text.slice(0, value.start) + JSON.stringify(after) + text.slice(value.end);
  parseRequest(updated);
  return updated;
}
