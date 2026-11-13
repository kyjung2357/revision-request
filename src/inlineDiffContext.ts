import { inlineDiffRulesFor, type InlineTokenization } from './inlineDiffRules';

/** One forward pass per displayed side; unchanged lines still advance lexical state. */
export interface InlineDiffContext {
  before(line: number, text: string): InlineTokenization | undefined;
  after(line: number, text: string): InlineTokenization | undefined;
}

export function createInlineDiffContext(
  targetPath: string | undefined, before: string, after: string, deadline: number,
): InlineDiffContext {
  const rules = inlineDiffRulesFor(targetPath);
  const side = (source: string) => {
    if (!rules.createTokenizer) {
      return (_line: number, text: string) =>
        text.length <= 8192 && Date.now() < deadline ? rules.tokenize(text) : undefined;
    }
    const tokenizer = rules.createTokenizer();
    const physicalLine = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gy;
    let offset = 0, line = 0, stopped = false;
    let current = '', tokens: InlineTokenization | undefined;
    return (wanted: number, expected: string): InlineTokenization | undefined => {
      if (stopped || !Number.isSafeInteger(wanted) || wanted < 1 || wanted < line) return undefined;
      while (line < wanted) {
        if (Date.now() >= deadline) {stopped = true; return undefined;}
        physicalLine.lastIndex = offset;
        const next = physicalLine.exec(source);
        if (!next) {stopped = true; return undefined;}
        offset += next[0].length;
        current = next[0].replace(/(?:\r\n|\r|\n)$/, '');
        line++;
        // Once context is unknown, do not guess string/fence state on later lines.
        if (current.length > 8192) {stopped = true; return undefined;}
        tokens = tokenizer.tokenize(current);
      }
      return current === expected ? tokens : undefined;
    };
  };
  return {before: side(before), after: side(after)};
}
