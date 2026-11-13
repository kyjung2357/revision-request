import { computeInlineChanges, type InlineChangeLine } from './inlineChanges';
import { createInlineDiffContext } from './inlineDiffContext';

export interface ReviewHighlightInput {
  path: string;
  /** Original block with its physical line endings. */
  before: string;
  /** Editable logical lines; a trailing newline represents a logical blank line. */
  draft: string;
  /** Visible document text before the block on each independent review side. */
  beforePrefix: string;
  afterPrefix: string;
  /** Distinguish one empty proposed line from a deletion with no proposed lines. */
  hasProposed: boolean;
}

function prefixContext(prefix: string, deadline: number): {text: string; start: number} | undefined {
  let text = prefix.replace(/^\uFEFF/, '');
  // Appending after an unterminated EOF still starts a new displayed logical row.
  if (text && !/[\r\n]$/.test(text)) text += '\n';
  const endings = /\r\n|\r|\n/g;
  let start = 1;
  while (endings.exec(text)) {
    if (Date.now() >= deadline) return undefined;
    start++;
  }
  return Date.now() < deadline ? {text, start} : undefined;
}

/** Browser entry, exported as RRHighlight.compute by the IIFE build. */
export function compute(input: ReviewHighlightInput, timeBudgetMs = 40): InlineChangeLine[] {
  const deadline = Date.now() + Math.max(0, timeBudgetMs);
  // Restore only the structural ending: the draft's own trailing blanks remain rows.
  const after = input.hasProposed || input.draft ? input.draft + '\n' : '';
  const block = {before: input.before, after};
  const before = prefixContext(input.beforePrefix, deadline);
  const proposed = prefixContext(input.afterPrefix, deadline);
  if (!before || !proposed) return computeInlineChanges(block, 0, input.path);
  // A context is forward-only and deadline-bound, so each edit needs a fresh one.
  const context = createInlineDiffContext(input.path,
    (before.text + input.before).replace(/^\uFEFF/, ''),
    (proposed.text + after).replace(/^\uFEFF/, ''), deadline);
  return computeInlineChanges({...block, oldStart: before.start, newStart: proposed.start},
    Math.max(0, deadline - Date.now()), input.path, context);
}
