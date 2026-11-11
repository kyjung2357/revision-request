import { diffArrays } from 'diff';
import { validateRequestFile, type RequestExplanation } from './core';
import { parseRequestDocument, resolveRequest, sourceLines, minimalLineReplacement, type RevisionRequest, type RequestEntry } from './request';
export interface SnapshotRequestOptions { reason?: string; explanations?: RequestExplanation[]; time?: string }
/** Generate one minimal fragment per changed original line, plus explicit line additions/deletions. */
export function createRequestFromSnapshots(path: string, before: string, after: string, options: SnapshotRequestOptions = {}): RevisionRequest {
  const validated = validateRequestFile({path, before, after, reason: options.reason, explanations: options.explanations});
  if (Buffer.from(before, 'utf8').toString('utf8') !== before || Buffer.from(after, 'utf8').toString('utf8') !== after) throw new Error('Snapshots must contain valid Unicode.');
  if (before.startsWith('\uFEFF') !== after.startsWith('\uFEFF')) throw new Error('Keep the original UTF-8 BOM unchanged in the proposal.');
  const original = sourceLines(before), proposed = sourceLines(after), entries: RequestEntry[] = [];
  const parts = diffArrays(original.map(line => line.content), proposed.map(line => line.content), {timeout: 1500});
  if (!parts) throw new Error('The file is too large to compare quickly.');
  let oldIndex = 0, newIndex = 0, index = 0;
  const reason = (line: number) => validated.explanations?.find(item => item.line === line)?.text ?? options.reason ?? '';
  while (index < parts.length) {
    const part = parts[index]!;
    if (!part.added && !part.removed) { oldIndex += part.value.length; newIndex += part.value.length; index++; continue; }
    let removed = 0, added = 0;
    while (index < parts.length && (parts[index]!.added || parts[index]!.removed)) {
      const change = parts[index++]!; if (change.removed) removed += change.value.length; else added += change.value.length;
    }
    const paired = Math.min(removed, added);
    for (let item = 0; item < paired; item++) {
      const line = oldIndex + item + 1, replacement = minimalLineReplacement(original[oldIndex + item]!.content, proposed[newIndex + item]!.content);
      entries.push({line, ...replacement, reason: reason(line), status: 'pending'});
    }
    for (let item = paired; item < removed; item++) {
      const line = oldIndex + item + 1;
      entries.push({line, before: original[oldIndex + item]!.content, after: null, reason: reason(line), status: 'pending'});
    }
    for (let item = paired; item < added; item++) {
      const line = oldIndex + removed + 1;
      entries.push({line, before: null, after: proposed[newIndex + item]!.content, reason: reason(line), status: 'pending'});
    }
    oldIndex += removed; newIndex += added;
  }
  const request = parseRequestDocument(JSON.stringify({path: validated.path, time: options.time ?? new Date().toISOString(), request: entries}));
  if (resolveRequest(request, before).file.after !== after) throw new Error('The proposed file changes line endings or final-newline formatting that this request cannot reproduce exactly. Preserve the original line endings and inferred endings of added lines.');
  return request;
}
