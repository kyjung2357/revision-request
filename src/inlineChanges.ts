import { diffArrays } from 'diff';
import { inlineComparisonKeys, expandAtomicHighlights } from './inlineDiffRules';
import { createInlineDiffContext, type InlineDiffContext } from './inlineDiffContext';

/** Split text without normalizing CRLF, CR, LF, or the final newline. */
function lines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function displayLine(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/, '');
}

export interface InlineSegment {
  text: string;
  changed: boolean;
}
export interface InlineChangeLine {
  before: InlineSegment[];
  after: InlineSegment[];
}

/**
 * Zip displayed old/new lines and highlight tokens using the target language rules.
 * This is presentation metadata only; it never changes hunk boundaries.
 * Large or costly comparisons conservatively mark the entire paired line.
 */
export function computeInlineChanges(
  hunk: {before: string; after: string; oldStart?: number; newStart?: number},
  timeBudgetMs = 40, targetPath?: string, context?: InlineDiffContext,
): InlineChangeLine[] {
  const beforeLines = lines(hunk.before).map(displayLine);
  const afterLines = lines(hunk.after).map(displayLine);
  const deadline = Date.now() + Math.max(0, timeBudgetMs);
  const whole = (text: string | undefined, changed: boolean): InlineSegment[] =>
    text === undefined ? [] : [{text, changed}];
  const result: InlineChangeLine[] = [];
  const tokens = context ?? createInlineDiffContext(targetPath, hunk.before, hunk.after, deadline);
  const oldStart = context ? hunk.oldStart ?? 1 : 1;
  const newStart = context ? hunk.newStart ?? 1 : 1;
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index++) {
    const before = beforeLines[index];
    const after = afterLines[index];
    if (before === after) {
      result.push({before: whole(before, false), after: whole(after, false)});
      continue;
    }
    const remaining = deadline - Date.now();
    if (before === undefined || after === undefined || before.length > 8192 || after.length > 8192 || remaining <= 0) {
      result.push({before: whole(before, true), after: whole(after, true)});
      continue;
    }
    // Separate display tokenization from the common bounded diff and exact projection.
    const beforeTokens = tokens.before(oldStart + index, before), afterTokens = tokens.after(newStart + index, after);
    if (!beforeTokens || !afterTokens) {
      result.push({before: whole(before, true), after: whole(after, true)});
      continue;
    }
    const beforeWords = beforeTokens.tokens, afterWords = afterTokens.tokens;
    const [beforeKeys, afterKeys] = inlineComparisonKeys(beforeTokens, afterTokens);
    const tokenBudget = deadline - Date.now();
    const parts = tokenBudget > 0 ? diffArrays(beforeKeys, afterKeys,
      {timeout: Math.min(20, tokenBudget), maxEditLength: 512}) : undefined;
    if (!parts) {
      result.push({before: whole(before, true), after: whole(after, true)});
      continue;
    }
    const pair: InlineChangeLine = {before: [], after: []};
    const append = (segments: InlineSegment[], text: string, changed: boolean) => {
      if (!text) return;
      const previous = segments[segments.length - 1];
      if (previous?.changed === changed) previous.text += text;
      else segments.push({text, changed});
    };
    const appendGap = (oldText: string, newText: string) => {
      // Only shared boundary whitespace stays normal. Whitespace inside a
      // consecutive block of changed words belongs to the changed highlight.
      let start = 0;
      while (start < oldText.length && start < newText.length &&
        oldText[start] === newText[start] && /\s/u.test(oldText[start]!)) start++;
      let end = 0;
      while (end < oldText.length - start && end < newText.length - start &&
        oldText[oldText.length - end - 1] === newText[newText.length - end - 1] &&
        /\s/u.test(oldText[oldText.length - end - 1]!)) end++;
      for (const [segments, text] of [[pair.before, oldText], [pair.after, newText]] as const) {
        append(segments, text.slice(0, start), false);
        append(segments, text.slice(start, text.length - end), true);
        append(segments, text.slice(text.length - end), false);
      }
    };
    const matches = new Map<number, number>();
    let oldWord = 0;
    let newWord = 0;
    let oldEnd = 0;
    let newEnd = 0;
    for (const part of parts) {
      if (part.removed) oldWord += part.value.length;
      else if (part.added) newWord += part.value.length;
      else for (let index = 0; index < part.value.length; index++) {
        matches.set(oldWord, newWord);
        const oldMatch = beforeWords[oldWord++]!;
        const newMatch = afterWords[newWord++]!;
        appendGap(before.slice(oldEnd, oldMatch.start), after.slice(newEnd, newMatch.start));
        append(pair.before, oldMatch.text, false);
        append(pair.after, newMatch.text, false);
        oldEnd = oldMatch.end;
        newEnd = newMatch.end;
      }
    }
    appendGap(before.slice(oldEnd), after.slice(newEnd));
    result.push(expandAtomicHighlights(beforeTokens, afterTokens, matches, pair));
  }
  return result;
}

