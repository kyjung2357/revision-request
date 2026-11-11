import { diffArrays } from 'diff';
import { validateRequestFile, type RequestExplanation } from './core';
import { parseRequestDocument, resolveRequest, sourceLines, minimalBlockReplacement, type RevisionRequest, type RequestEntry } from './request';
export interface SnapshotRequestOptions { reason?: string; explanations?: RequestExplanation[]; time?: string }
/** Generate one atomic entry per contiguous changed block, keeping boundary context minimal. */
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
    const addBlock = (oldOffset: number, newOffset: number, oldCount: number, newCount: number) => {
      const line = oldOffset + 1;
      const previous = original.slice(oldOffset, oldOffset + oldCount).map(item => item.content).join('\n');
      const next = proposed.slice(newOffset, newOffset + newCount).map(item => item.content).join('\n');
      const replacement = oldCount && newCount ? minimalBlockReplacement(previous, next)
        : {before: oldCount ? previous : null, after: newCount ? next : null};
      const reasons = [...new Set(Array.from({length: Math.max(1, oldCount)}, (_, offset) => reason(line + offset)))];
      const hasReason = options.reason !== undefined || validated.explanations?.some(item =>
        item.line >= line && item.line < line + Math.max(1, oldCount));
      entries.push({line, ...replacement, ...(hasReason ? {reason: reasons.filter(Boolean).join('\n\n')} : {}), status: 'pending'});
    };
    if (removed > 1 && (removed === added || added === 0)) {
      // Explicitly different explanations identify separate review intentions.
      let start = 0;
      for (let end = 1; end <= removed; end++) {
        if (end < removed && reason(oldIndex + end + 1) === reason(oldIndex + start + 1)) continue;
        addBlock(oldIndex + start, newIndex + (added ? start : 0), end - start, added ? end - start : 0);
        start = end;
      }
    } else addBlock(oldIndex, newIndex, removed, added);
    oldIndex += removed; newIndex += added;
  }
  const request = parseRequestDocument(JSON.stringify({path: validated.path, time: options.time ?? new Date().toISOString(), request: entries}));
  if (resolveRequest(request, before).file.after !== after) throw new Error('The proposed file changes line endings or final-newline formatting that this request cannot reproduce exactly. Preserve the original line endings and inferred endings of added lines.');
  return request;
}
