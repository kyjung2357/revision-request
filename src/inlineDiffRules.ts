import { pythonRules, javascriptRules, jsonRules } from './codeInlineDiffRules';
import { createMarkdownRules } from './markdownInlineDiffRules';

/** Language-specific display tokens. These rules never edit source or review boundaries. */
export interface InlineToken { text: string; start: number; end: number; delimiterDepth?: number }
export interface InlineHighlight { text: string; changed: boolean }
export interface InlineHighlightPair { before: InlineHighlight[]; after: InlineHighlight[] }
interface AtomicGroup { open: number; atom: number; close: number }
export interface InlineTokenization { tokens: InlineToken[]; groups: AtomicGroup[] }
export interface InlineTokenizer { tokenize(text: string): InlineTokenization }
export interface InlineDiffRules extends InlineTokenizer { createTokenizer?(): InlineTokenizer }

function tokensFrom(text: string, pattern: RegExp): InlineToken[] {
  return Array.from(text.matchAll(pattern), match => ({text: match[0], start: match.index!, end: match.index! + match[0].length}));
}
const plainRules: InlineDiffRules = {
  tokenize: text => ({tokens: tokensFrom(text, /\S+/gu), groups: []})
};
const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
function singleAtom(text: string): boolean {
  // A control word or control symbol remains indivisible, including escaped braces.
  if (/^\\(?:[A-Za-z]+|[^\r\n])$/u.test(text)) return true;
  const iterator = graphemes.segment(text)[Symbol.iterator]();
  return !iterator.next().done && Boolean(iterator.next().done);
}
const closing: Record<string, string> = {'(': ')', '[': ']', '{': '}'};
const texRules: InlineDiffRules = {
  tokenize(text) {
    // Retain whitespace-delimited chunks between commands and literal delimiters.
    // Thus i+1 is one chunk, whereas x - y consists of three chunks.
    const tokens = tokensFrom(text, /\\(?:[A-Za-z]+|[\s\S])?|[()[\]{}]|[^\s\\()[\]{}]+/gu);
    const stack: number[] = [], groups: AtomicGroup[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (Object.hasOwn(closing, token.text)) {stack.push(index); continue;}
      if (![')', ']', '}'].includes(token.text)) continue;
      const openIndex = stack.pop();
      if (openIndex === undefined || closing[tokens[openIndex]!.text] !== token.text) {
        // Malformed nesting must not pair delimiters across the mismatch.
        stack.length = 0; continue;
      }
      tokens[openIndex]!.delimiterDepth = token.delimiterDepth = stack.length;
      // Exactly one token between the delimiters; nesting cannot swallow an inner group.
      if (index !== openIndex + 2) continue;
      const atom = tokens[openIndex + 1]!;
      if (!singleAtom(atom.text)) continue;
      if (/\S/u.test(text.slice(tokens[openIndex]!.end, atom.start)) || /\S/u.test(text.slice(atom.end, token.start))) continue;
      groups.push({open: openIndex, atom: openIndex + 1, close: index});
    }
    return {tokens, groups};
  }
};

function fenceRules(label: string): InlineDiffRules | undefined {
  switch (label.toLowerCase()) {
    case 'py': case 'python': case 'python3': return pythonRules;
    case 'js': case 'javascript': case 'jsx': case 'ts': case 'typescript': case 'tsx': return javascriptRules;
    case 'json': case 'jsonc': return jsonRules;
    case 'tex': case 'latex': case 'ltx': return texRules;
    default: return undefined;
  }
}
const markdownRules = createMarkdownRules(fenceRules);

/** Use the original target path, not the .rr filename. Unknown languages keep whitespace chunks. */
export function inlineDiffRulesFor(targetPath?: string): InlineDiffRules {
  if (!targetPath) return plainRules;
  if (/\.(?:tex|ltx|latex)$/i.test(targetPath)) return texRules;
  if (/\.(?:py|pyw|pyi)$/i.test(targetPath)) return pythonRules;
  if (/\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i.test(targetPath)) return javascriptRules;
  if (/\.(?:json|jsonc)$/i.test(targetPath)) return jsonRules;
  if (/\.(?:md|markdown)$/i.test(targetPath)) return markdownRules;
  return plainRules;
}

/** Anchor identical atoms before diffing; keep whitespace outside the comparison keys. */
export function inlineComparisonKeys(before: InlineTokenization, after: InlineTokenization): [string[], string[]] {
  const identity = (side: InlineTokenization, group: AtomicGroup) => JSON.stringify([
    side.tokens[group.open]!.text, side.tokens[group.atom]!.text, side.tokens[group.close]!.text
  ]);
  const beforeAtoms = new Set(before.groups.map(group => identity(before, group)));
  const afterAtoms = new Set(after.groups.map(group => identity(after, group)));
  const keys = (side: InlineTokenization, other: Set<string>) => {
    const result = side.tokens.map(token => token.delimiterDepth === undefined
      ? JSON.stringify(['text', token.text]) : JSON.stringify(['delimiter', token.delimiterDepth, token.text]));
    for (const group of side.groups) {
      const atom = identity(side, group);
      if (!other.has(atom)) continue;
      for (const [role, index] of [group.open, group.atom, group.close].entries()) {
        result[index] = JSON.stringify(['atom', atom, role]);
      }
    }
    return result;
  };
  return [keys(before, afterAtoms), keys(after, beforeAtoms)];
}

function changedNonWhitespace(segments: readonly InlineHighlight[], start: number, end: number): boolean {
  let offset = 0;
  for (const segment of segments) {
    const next = offset + segment.text.length;
    if (next > start && offset < end && segment.changed &&
        /\S/u.test(segment.text.slice(Math.max(0, start - offset), Math.min(segment.text.length, end - offset)))) return true;
    offset = next;
    if (offset >= end) break;
  }
  return false;
}
function widen(segments: InlineHighlight[], ranges: Array<[number, number]>): InlineHighlight[] {
  if (!ranges.length) return segments;
  const text = segments.map(segment => segment.text).join('');
  // The caller bounds each line to 8192 UTF-16 units; offsets always preserve raw text.
  const changed = new Uint8Array(text.length);
  let offset = 0;
  for (const segment of segments) {
    if (segment.changed) changed.fill(1, offset, offset + segment.text.length);
    offset += segment.text.length;
  }
  for (const [start, end] of ranges) changed.fill(1, start, end);
  // Expanded groups can make formerly separate changed runs adjacent across spaces.
  for (let start = 0; start < text.length;) {
    if (changed[start]) {start++; continue;}
    let end = start + 1;
    while (end < text.length && !changed[end]) end++;
    if (start > 0 && end < text.length && /^\s+$/u.test(text.slice(start, end))) changed.fill(1, start, end);
    start = end;
  }
  const result: InlineHighlight[] = [];
  let start = 0;
  for (let end = 1; end <= text.length; end++) {
    if (end < text.length && changed[end] === changed[start]) continue;
    result.push({text: text.slice(start, end), changed: changed[start] === 1}); start = end;
  }
  return result;
}

/** Expand corresponding single-atom groups only for content/delimiter edits, never padding alone. */
export function expandAtomicHighlights(
  before: InlineTokenization, after: InlineTokenization, matches: ReadonlyMap<number, number>, pair: InlineHighlightPair
): InlineHighlightPair {
  if (!before.groups.length || !after.groups.length) return pair;
  const afterOpen = new Map(after.groups.map(group => [group.open, group]));
  const afterAtom = new Map(after.groups.map(group => [group.atom, group]));
  const oldRanges: Array<[number, number]> = [], newRanges: Array<[number, number]> = [];
  for (const old of before.groups) {
    const openMatch = matches.get(old.open), closeMatch = matches.get(old.close), atomMatch = matches.get(old.atom);
    let next = openMatch === undefined ? undefined : afterOpen.get(openMatch);
    if (!next || next.close !== closeMatch) {
      // A changed bracket style can still pair through the identical single atom.
      next = atomMatch === undefined ? undefined : afterAtom.get(atomMatch);
    }
    if (!next) continue;
    if ((next.open !== openMatch || next.close !== closeMatch) &&
        before.tokens[old.open]!.text === after.tokens[next.open]!.text &&
        before.tokens[old.close]!.text === after.tokens[next.close]!.text) continue;
    const oldRange: [number, number] = [before.tokens[old.open]!.start, before.tokens[old.close]!.end];
    const newRange: [number, number] = [after.tokens[next.open]!.start, after.tokens[next.close]!.end];
    if (!changedNonWhitespace(pair.before, ...oldRange) && !changedNonWhitespace(pair.after, ...newRange)) continue;
    oldRanges.push(oldRange); newRanges.push(newRange);
  }
  return {before: widen(pair.before, oldRanges), after: widen(pair.after, newRanges)};
}
