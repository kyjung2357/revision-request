import type { InlineDiffRules, InlineToken, InlineTokenization } from './inlineDiffRules';

type LineTokenizer = Pick<InlineDiffRules, 'tokenize'>;
interface Fence { marker: string; length: number; tokenizer?: LineTokenizer }

function plain(text: string): InlineTokenization {
  return {tokens: Array.from(text.matchAll(/\S+/gu), match =>
    ({text: match[0], start: match.index!, end: match.index! + match[0].length})), groups: []};
}
const whitespace = (value: string | undefined) => value !== undefined && /\s/u.test(value);
const wordCharacter = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}\p{M}]/u.test(value);
const escapedPunctuation = (value: string | undefined) => value !== undefined && /^[!-/:-@\[-`{-~]$/u.test(value);

/** Find a complete link destination without treating balanced URL parentheses as markup. */
function destinationEnd(text: string, start: number): number | undefined {
  let depth = 1;
  for (let cursor = start; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') {cursor++; continue;}
    if (text[cursor] === '(') depth++;
    if (text[cursor] === ')' && --depth === 0) return cursor;
  }
  return undefined;
}

function createTokenizer(resolveFence: (label: string) => InlineDiffRules | undefined): LineTokenizer {
  let fence: Fence | undefined;
  return {
    tokenize(text) {
      // Fences belong to block syntax. A longer closer is valid, but a shorter
      // marker or any non-whitespace suffix remains literal code content.
      const marker = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/u.exec(text);
      if (fence) {
        if (marker && marker[2]![0] === fence.marker && marker[2]!.length >= fence.length && /^\s*$/u.test(marker[3]!)) {
          fence = undefined;
          return plain(text);
        }
        return fence.tokenizer ? fence.tokenizer.tokenize(text) : plain(text);
      }
      if (marker && !(marker[2]![0] === '`' && marker[3]!.includes('`'))) {
        const label = marker[3]!.trim().split(/\s+/u)[0] ?? '';
        const rules = resolveFence(label.toLowerCase());
        fence = {marker: marker[2]![0]!, length: marker[2]!.length,
          tokenizer: rules?.createTokenizer?.() ?? rules};
        const start = marker[1]!.length, end = start + marker[2]!.length;
        const rest = plain(text.slice(end)).tokens.map(token => ({...token, start: token.start + end, end: token.end + end}));
        return {tokens: [{text: text.slice(start, end), start, end}, ...rest], groups: []};
      }
      if (!text.trim()) return {tokens: [], groups: []};
      // Indented blocks have no language annotation. Keep their contents literal.
      if (/^(?: {4}|\t)/u.test(text)) return plain(text);
      const tokens: InlineToken[] = [];
      // Only complete spans on this physical line enter literal mode. An
      // unmatched backtick must not swallow markup in later prose lines.
      let codeTicks = 0;
      const nextTickRun = new Map<number, number>();
      const lastTickRun = new Map<number, number>();
      for (const match of Array.from(text.matchAll(/`+/gu)).reverse()) {
        const next = lastTickRun.get(match[0].length);
        if (next !== undefined) nextTickRun.set(match.index!, next);
        lastTickRun.set(match[0].length, match.index!);
      }
      const push = (start: number, end: number) => {
        if (end > start) tokens.push({text: text.slice(start, end), start, end});
      };
      const ticksEnd = (start: number) => {let end = start + 1; while (text[end] === '`') end++; return end;};
      const internalUnderscore = (at: number) => text[at] === '_' && wordCharacter(text[at - 1]) && wordCharacter(text[at + 1]);
      const headingStart = /^ {0,3}(?=#)/u.exec(text)?.[0].length;
      const special = (at: number) => {
        const value = text[at]!;
        if (value === '_' && internalUnderscore(at)) return false;
        return '`*_~[]()<>'.includes(value) || (value === '!' && text[at + 1] === '[') ||
          (value === '\\' && escapedPunctuation(text[at + 1])) ||
          (value === '#' && at === headingStart);
      };
      let cursor = 0, incompleteDestination = false;
      while (cursor < text.length) {
        if (whitespace(text[cursor])) {cursor++; continue;}
        const start = cursor, value = text[cursor]!;
        if (value === '`') {
          const end = ticksEnd(cursor), count = end - cursor;
          if (codeTicks === 0) {push(cursor, end); if (nextTickRun.has(cursor)) codeTicks = count; cursor = end; continue;}
          if (count === codeTicks) {push(cursor, end); codeTicks = 0; cursor = end; continue;}
        }
        if (codeTicks) {
          // Literal inline-code words are never tokenized as Markdown markup.
          // Stop only at a matching backtick run; other runs belong to the word.
          while (cursor < text.length && !whitespace(text[cursor])) {
            if (text[cursor] === '`') {
              const end = ticksEnd(cursor);
              if (end - cursor === codeTicks) break;
              cursor = end;
            } else cursor += text.codePointAt(cursor)! > 0xffff ? 2 : 1;
          }
          push(start, cursor); continue;
        }
        if (value === '\\' && escapedPunctuation(text[cursor + 1])) {
          push(cursor, cursor + 2); cursor += 2; continue;
        }
        if (!incompleteDestination && value === ']' && text[cursor + 1] === '(') {
          const end = destinationEnd(text, cursor + 2);
          if (end !== undefined) {
            push(cursor, cursor + 1); push(cursor + 1, cursor + 2);
            for (const token of plain(text.slice(cursor + 2, end)).tokens) {
              push(cursor + 2 + token.start, cursor + 2 + token.end);
            }
            push(end, end + 1); cursor = end + 1; continue;
          }
          // An unmatched nested destination uses ordinary prose for this line;
          // do not rescan the remaining suffix for every following link marker.
          incompleteDestination = true;
        }
        if (special(cursor)) {
          cursor++;
          if ('*_~#'.includes(value)) while (text[cursor] === value) cursor++;
          push(start, cursor); continue;
        }
        cursor += text.codePointAt(cursor)! > 0xffff ? 2 : 1;
        while (cursor < text.length && !whitespace(text[cursor]) && !special(cursor)) {
          cursor += text.codePointAt(cursor)! > 0xffff ? 2 : 1;
        }
        push(start, cursor);
      }
      return {tokens, groups: []};
    }
  };
}

/** Markdown prose rules with language-aware fenced blocks and literal fallback. */
export function createMarkdownRules(resolveFence: (label: string) => InlineDiffRules | undefined): InlineDiffRules {
  return {
    tokenize: text => createTokenizer(resolveFence).tokenize(text),
    createTokenizer: () => createTokenizer(resolveFence)
  };
}
