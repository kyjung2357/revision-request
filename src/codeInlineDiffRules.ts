import type {InlineDiffRules, InlineToken, InlineTokenization} from './inlineDiffRules';

/** Lightweight display lexers, not parsers: tokens retain exact source offsets. */
type Language = 'python' | 'javascript' | 'json';
type Frame =
  | {kind: 'code'; interpolation?: 'python' | 'javascript'; braces: number; brackets: number; regexAllowed: boolean}
  | {kind: 'string'; quote: string; triple: boolean; raw: boolean; formatted: boolean; key: boolean; continued: boolean}
  | {kind: 'comment'}
  | {kind: 'format'};
interface Container {kind: '{' | '['; key: boolean}
const pyIdentifier = /[_\p{ID_Start}][_\p{ID_Continue}]*/uy;
const jsIdentifier = /(?:[$_\p{ID_Start}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\}))(?:[$\u200c\u200d_\p{ID_Continue}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\}))*/uy;
const decimal = String.raw`(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?`;
const pyNumber = new RegExp(String.raw`(?:0[xX](?:_?[\da-fA-F])+|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|${decimal}[jJ]?)`, 'y');
const jsNumber = new RegExp(String.raw`(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|${decimal}n?)`, 'y');
const jsonNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const pyPrefix = /(?:[rRuUbBfF]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF])(?=['"])/y;
const pyOperators = /\*\*=|\/\/=|<<=|>>=|\*\*|\/\/|<<|>>|:=|->|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|@=|&=|\|=|\^=|\.\.\.|[^]/uy;
const jsOperators = />>>=|===|!==|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|>>>|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\.\.\.|[^]/uy;
const regexPrefixWords = new Set(['return', 'throw', 'case', 'delete', 'typeof', 'void', 'new', 'yield', 'await', 'in', 'instanceof', 'of']);
function matchAt(pattern: RegExp, text: string, offset: number): string | undefined {
  pattern.lastIndex = offset;
  return pattern.exec(text)?.[0];
}
function pointLength(text: string, index: number): number { return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1; }
function escapeEnd(text: string, start: number, python: boolean): number {
  if (start + 1 >= text.length) return text.length;
  const code = text[start + 1];
  if ((code === 'u' && text[start + 2] === '{') || (python && code === 'N' && text[start + 2] === '{')) {
    const end = text.indexOf('}', start + 3);
    if (end >= 0) return end + 1;
  }
  const digits = code === 'x' ? 2 : code === 'u' ? 4 : python && code === 'U' ? 8 : 0;
  if (digits) {
    let end = start + 2;
    while (end < Math.min(text.length, start + 2 + digits) && /[\da-fA-F]/.test(text[end]!)) end++;
    return end;
  }
  if (python && /[0-7]/.test(code!)) {
    let end = start + 2;
    while (end < Math.min(text.length, start + 4) && /[0-7]/.test(text[end]!)) end++;
    return end;
  }
  return start + 1 + pointLength(text, start + 1);
}

function createCodeTokenizer(language: Language) {
  const python = language === 'python', javascript = language === 'javascript';
  const frames: Frame[] = [{kind: 'code', braces: 0, brackets: 0, regexAllowed: true}];
  const containers: Container[] = [];
  return {
    tokenize(text: string): InlineTokenization {
      const tokens: InlineToken[] = [];
      let index = 0;
      const emit = (start: number, end: number) => {
        if (end > start) tokens.push({text: text.slice(start, end), start, end});
      };
      const push = (frame: Frame) => { if (frames.length < 128) frames.push(frame); };
      const words = (start: number, end: number) => {
        let at = start;
        while (at < end) {
          if (/\s/u.test(text[at]!)) {at++; continue;}
          const begin = at;
          while (at < end && !/\s/u.test(text[at]!)) at += pointLength(text, at);
          emit(begin, at);
        }
      };
      const parentCode = () => {
        for (let at = frames.length - 1; at >= 0; at--) {
          const frame = frames[at]!;
          if (frame.kind === 'code') {frame.regexAllowed = false; return;}
        }
      };
      while (index < text.length) {
        const frame = frames[frames.length - 1]!;
        const begin = index;
        if (frame.kind === 'comment') {
          const close = text.indexOf('*/', index);
          words(index, close < 0 ? text.length : close);
          if (close < 0) {index = text.length; continue;}
          emit(close, close + 2); index = close + 2; frames.pop(); continue;
        }
        if (frame.kind === 'format') {
          if (text[index] === '}') {emit(index, ++index); frames.pop(); continue;}
          if (text[index] === '{') {
            emit(index, ++index); push({kind: 'code', interpolation: 'python', braces: 0, brackets: 0, regexAllowed: true}); continue;
          }
          if (/\s/u.test(text[index]!)) {index++; continue;}
          while (index < text.length && !/[{}\s]/u.test(text[index]!)) index += pointLength(text, index);
          emit(begin, index); continue;
        }
        if (frame.kind === 'string') {
          const delimiter = frame.quote.repeat(frame.triple ? 3 : 1);
          if (text.startsWith(delimiter, index)) {
            emit(index, index + delimiter.length); index += delimiter.length; frames.pop(); parentCode(); continue;
          }
          if (frame.key) {
            // JSON property names are one unit, including embedded spaces and escapes.
            while (index < text.length && text[index] !== '"') {
              index = text[index] === '\\' ? escapeEnd(text, index, false) : index + pointLength(text, index);
            }
            emit(begin, index); continue;
          }
          if (frame.formatted && python && (text.startsWith('{{', index) || text.startsWith('}}', index))) {
            emit(index, index + 2); index += 2; continue;
          }
          if (frame.formatted && ((python && text[index] === '{') || (javascript && text.startsWith('${', index)))) {
            const size = python ? 1 : 2;
            emit(index, index + size); index += size;
            push({kind: 'code', interpolation: python ? 'python' : 'javascript', braces: 0, brackets: 0, regexAllowed: true}); continue;
          }
          if (!frame.raw && text[index] === '\\') {
            // Unlike JS templates, a slash cannot escape a Python f-string brace.
            if (python && frame.formatted && /[{}]/.test(text[index + 1] ?? '')) {emit(index, ++index); continue;}
            index = escapeEnd(text, index, python); emit(begin, index);
            frame.continued = index === text.length && begin === text.length - 1;
            continue;
          }
          if (/\s/u.test(text[index]!)) {index++; continue;}
          while (index < text.length) {
            if (/\s/u.test(text[index]!) || text.startsWith(delimiter, index) ||
                (!frame.raw && text[index] === '\\') ||
                (frame.formatted && python && /[{}]/.test(text[index]!)) ||
                (frame.formatted && javascript && text.startsWith('${', index))) break;
            // A raw Python slash still protects the following quote from ending the literal.
            if (frame.raw && text[index] === '\\' && (text[index + 1] === frame.quote || text[index + 1] === '\\')) index += 1 + pointLength(text, index + 1);
            else index += pointLength(text, index);
          }
          // An unmatched single } in a malformed f-string is still a visible token.
          if (index === begin) index += pointLength(text, index);
          emit(begin, index); continue;
        }

        if (/\s/u.test(text[index]!)) {index++; continue;}
        if ((python && text[index] === '#') || (!python && text.startsWith('//', index))) {
          const size = python ? 1 : 2;
          emit(index, index + size); words(index + size, text.length); index = text.length; continue;
        }
        if (!python && text.startsWith('/*', index)) {
          emit(index, index + 2); index += 2; push({kind: 'comment'}); continue;
        }
        if (frame.interpolation && text[index] === '}' && frame.braces === 0) {
          emit(index, ++index); frames.pop(); continue;
        }
        if (python && frame.interpolation && text[index] === ':' && frame.braces === 0 && frame.brackets === 0) {
          emit(index, ++index); frames.pop(); push({kind: 'format'}); continue;
        }
        const prefix = python ? matchAt(pyPrefix, text, index) : undefined;
        const quoteAt = index + (prefix?.length ?? 0);
        const quote = text[quoteAt];
        if (quote === '"' || (language !== 'json' && (quote === "'" || (javascript && quote === '`')))) {
          if (prefix) {emit(index, quoteAt); index = quoteAt;}
          const triple = python && text.startsWith(quote.repeat(3), index);
          const length = triple ? 3 : 1;
          let key = false;
          if (language === 'json') {
            key = containers[containers.length - 1]?.key ?? false;
            // Also recognize isolated property lines without their opening object context.
            if (!key) {
              let end = index + 1;
              while (end < text.length && text[end] !== '"') end = text[end] === '\\' ? escapeEnd(text, end, false) : end + pointLength(text, end);
              key = /^\s*:/.test(text.slice(end + 1));
            }
          }
          emit(index, index + length); index += length;
          push({kind: 'string', quote, triple, raw: Boolean(prefix && /r/i.test(prefix)),
            formatted: javascript ? quote === '`' : Boolean(prefix && /f/i.test(prefix)), key, continued: false});
          continue;
        }
        const privateName = javascript && text[index] === '#' ? matchAt(jsIdentifier, text, index + 1) : undefined;
        const identifier = privateName ? '#' + privateName : matchAt(python ? pyIdentifier : jsIdentifier, text, index);
        if (identifier) {
          index += identifier.length; emit(begin, index); frame.regexAllowed = regexPrefixWords.has(identifier); continue;
        }
        const number = matchAt(python ? pyNumber : language === 'json' ? jsonNumber : jsNumber, text, index);
        if (number) {index += number.length; emit(begin, index); frame.regexAllowed = false; continue;}
        if (javascript && text[index] === '/' && frame.regexAllowed && text[index - 1] !== '<') {
          let end = index + 1, inClass = false;
          for (; end < text.length; end++) {
            if (text[end] === '\\') {end++; continue;}
            if (text[end] === '[') inClass = true;
            else if (text[end] === ']') inClass = false;
            else if (text[end] === '/' && !inClass) break;
          }
          if (end < text.length) {
            end++;
            while (end < text.length && /[A-Za-z]/.test(text[end]!)) end++;
            emit(index, end); index = end; frame.regexAllowed = false; continue;
          }
        }
        const operator = matchAt(python ? pyOperators : jsOperators, text, index)!;
        index += operator.length; emit(begin, index);
        if (operator === '{') frame.braces++;
        if (operator === '}') frame.braces = Math.max(0, frame.braces - 1);
        if (operator === '(' || operator === '[') frame.brackets++;
        if (operator === ')' || operator === ']') frame.brackets = Math.max(0, frame.brackets - 1);
        frame.regexAllowed = ![')', ']', '}', '++', '--', '.', '?.'].includes(operator);
        if (language === 'json') {
          if (operator === '{' || operator === '[') containers.push({kind: operator, key: operator === '{'});
          else if (operator === '}' || operator === ']') containers.pop();
          else if (containers.length && operator === ':') containers[containers.length - 1]!.key = false;
          else if (containers.length && operator === ',') containers[containers.length - 1]!.key = containers[containers.length - 1]!.kind === '{';
        }
      }
      const last = frames[frames.length - 1]!;
      if (last.kind === 'string' && !last.triple && last.quote !== '`') {
        const trailingSlashes = last.raw ? /\\+$/.exec(text)?.[0].length ?? 0 : 0;
        if (last.continued || trailingSlashes % 2 === 1) last.continued = false;
        else frames.pop(); // A malformed ordinary string cannot consume following source lines.
      }
      return {tokens, groups: []};
    }
  };
}
function rules(language: Language): InlineDiffRules & {createTokenizer(): ReturnType<typeof createCodeTokenizer>} {
  return {tokenize: text => createCodeTokenizer(language).tokenize(text), createTokenizer: () => createCodeTokenizer(language)};
}
export const pythonRules = rules('python');
export const javascriptRules = rules('javascript');
export const jsonRules = rules('json');
