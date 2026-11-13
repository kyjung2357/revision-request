export type ReviewAction = 'comment';
export interface ReviewActionInput {
  path: string;
  /** Complete displayed block contents, excluding the structural final newline. */
  before: string;
  after: string;
  /** Original source up to the start of this block. */
  prefix: string;
  /** Distinguishes an original blank line from an insertion with no original lines. */
  hasOriginal?: boolean;
  /** Keeps an active blank proposed line distinct from a deletion. */
  hasProposed?: boolean;
}
export interface ReviewActionOption {id: ReviewAction; label: string; enabled: boolean; reason?: string}
const label = 'Keep original as comments';
const maxText = 5 * 1024 * 1024;
function fail(message: string): never {throw new Error(message);}
function validate(input: ReviewActionInput) {
  for (const value of [input.path, input.before, input.after, input.prefix]) {
    if (typeof value !== 'string' || value.length > maxText || /[\0\r]/.test(value))
      fail('Review actions require bounded text with LF line endings.');
  }
  for (const value of [input.hasOriginal,input.hasProposed]) {
    if (value !== undefined && typeof value !== 'boolean') fail('Line availability must be a boolean.');
  }
}
function language(path: string): 'tex' | 'python' | 'code' | 'markdown' | 'unsupported' {
  if (/\.(?:tex|ltx|latex)$/i.test(path)) return 'tex';
  if (/\.(?:py|pyw|pyi)$/i.test(path)) return 'python';
  if (/\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|c|h|cc|cpp|cxx|hpp|cs|java|go|rs|swift|kt|jsonc)$/i.test(path)) return 'code';
  if (/\.(?:md|markdown)$/i.test(path)) return 'markdown';
  return 'unsupported';
}
/** Only inspect the insertion boundary; this is not a parser or a validity claim. */
function codeContext(prefix: string, path: string, python: boolean): string {
  let quote = '', quoteWidth = 1, verbatim = false, blockDepth = 0, lineComment = false;
  const rust = /\.rs$/i.test(path), swift = /\.swift$/i.test(path);
  const nestedComments = rust || swift || /\.kt$/i.test(path);
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]!, next = prefix[i + 1];
    if (lineComment) {if (c === '\n' || c === '\u2028' || c === '\u2029') lineComment = false; continue;}
    if (blockDepth) {
      if (nestedComments && c === '/' && next === '*') {blockDepth++; i++;}
      else if (c === '*' && next === '/') {blockDepth--; i++;}
      continue;
    }
    if (quote) {
      if (verbatim && c === '"' && next === '"') {i++; continue;}
      if (!verbatim && c === '\\' && !(quote === '\u0060' && /\.go$/i.test(path))) {i++; continue;}
      if (prefix.startsWith(quote.repeat(quoteWidth), i)) {
        i += quoteWidth - 1; quote = ''; quoteWidth = 1; verbatim = false;
      }
      continue;
    }
    if (python && c === '#') {lineComment = true; continue;}
    if (!python && c === '/' && next === '/') {lineComment = true; i++; continue;}
    if (!python && c === '/' && next === '*') {blockDepth = 1; i++; continue;}
    if (!python && c === 'R' && next === '"') {
      const raw = /^R"([^\s()\\]{0,16})\(/.exec(prefix.slice(i));
      if (raw) {
        const terminator = ')' + raw[1] + '"', end = prefix.indexOf(terminator, i + raw[0].length);
        if (end < 0) return 'The block starts inside a raw string.';
        i = end + terminator.length - 1; continue;
      }
    }
    const raw = rust ? /^(?:br|cr|r)(#{0,255})"/.exec(prefix.slice(i)) :
      swift ? /^(#+)("""|")/.exec(prefix.slice(i)) : null;
    if (raw) {
      const terminator = (swift ? raw[2] : '"') + raw[1]!, end = prefix.indexOf(terminator, i + raw[0].length);
      if (end < 0) return 'The block starts inside a raw string.';
      i = end + terminator.length - 1; continue;
    }
    // A Rust lifetime is not a character literal.
    if (rust && c === "'" && /^'[A-Za-z_][A-Za-z_0-9]*(?!')/.test(prefix.slice(i)) &&
        !/^'[A-Za-z_]'/.test(prefix.slice(i))) continue;
    if (c === '"' || c === "'" || (!python && c === '\u0060')) {
      quote = c; quoteWidth = prefix.startsWith(c.repeat(3), i) && (python || c === '"') ? 3 : 1;
      if (!python && quoteWidth === 3) while (prefix[i + quoteWidth] === c) quoteWidth++;
      verbatim = !python && c === '"' && prefix[i - 1] === '@';
      i += quoteWidth - 1;
    }
  }
  if (quote || blockDepth) return 'The block starts inside a string or block comment.';
  const lastLine = prefix.replace(/\n$/, '').split('\n').at(-1) || '';
  if (/\\\s*$/.test(lastLine) || (/\.(?:c|h|cc|cpp|cxx|hpp)$/i.test(path) && /\?\?\/\s*$/.test(lastLine)))
    return 'The preceding line continues into this block.';
  return '';
}
const verbatimEnvironments = new Set(['verbatim','verbatim*','Verbatim','Verbatim*','BVerbatim','LVerbatim','lstlisting','minted','alltt']);
function balancedPrefixEnd(text: string, start: number): number {
  const opener = text[start], closer = opener === '{' ? '}' : ']';
  let depth = 1;
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') {at++; continue;}
    if (text[at] === '%') {const end = text.indexOf('\n', at); if (end < 0) return -1; at = end; continue;}
    if (text[at] === opener) depth++;
    if (text[at] === closer && --depth === 0) return at + 1;
  }
  return -1;
}
function unsafeTexContext(prefix: string): boolean {
  const environments: string[] = [];
  for (let i = 0; i < prefix.length;) {
    const literal = environments.at(-1);
    if (literal && verbatimEnvironments.has(literal)) {
      const endToken = '\\end{' + literal + '}', end = prefix.indexOf(endToken, i);
      if (end < 0) return true;
      environments.pop(); i = end + endToken.length; continue;
    }
    const c = prefix[i]!;
    if (c === '%') {const end = prefix.indexOf('\n', i); i = end < 0 ? prefix.length : end + 1; continue;}
    if (c !== '\\') {i++; continue;}
    const match = /^\\(?:begin|end)\s*\{([^{}]+)\}/.exec(prefix.slice(i));
    if (match) {
      if (match[0].startsWith('\\begin')) environments.push(match[1]!);
      else if (environments.at(-1) === match[1]) environments.pop();
      else return true;
      i += match[0].length; continue;
    }
    const command = /^\\(?:[A-Za-z@]+|.)/.exec(prefix.slice(i))?.[0] || '\\';
    // Skip completed definitions: literal-looking commands in a macro body have
    // not been executed. Incomplete definitions remain conservative.
    if (/^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment)$/.test(command)) {
      let at = i + command.length, groups = 0;
      if (prefix[at] === '*') at++;
      while (/\s/.test(prefix[at] || '')) at++;
      if (prefix[at] === '\\') at += /^\\(?:[A-Za-z@]+|.)/.exec(prefix.slice(at))?.[0].length || 1;
      while (true) {
        while (/\s/.test(prefix[at] || '')) at++;
        if (prefix[at] !== '{' && prefix[at] !== '[') break;
        const end = balancedPrefixEnd(prefix, at);
        if (end < 0) return true;
        if (prefix[at] === '{') groups++;
        at = end;
      }
      if (!groups) return true;
      i = at; continue;
    }
    if (/^\\(?:def|gdef|edef|xdef)$/.test(command)) {
      const start = prefix.indexOf('{', i + command.length);
      const end = start < 0 ? -1 : balancedPrefixEnd(prefix, start);
      if (end < 0) return true;
      i = end; continue;
    }
    if (command === '\\verb' || command === '\\lstinline') {
      const offset = i + command.length + (prefix[i + command.length] === '*' ? 1 : 0);
      const delimiter = prefix[offset];
      const end = delimiter ? prefix.indexOf(delimiter, offset + 1) : -1;
      if (end < 0) return true;
      i = end + 1; continue;
    }
    if (command === '\\catcode') return true;
    i += command.length;
  }
  return environments.some(name => verbatimEnvironments.has(name));
}
function markdownComments(input: ReviewActionInput): string {
  let fence = '', inlineCode = '';
  for (const line of input.prefix.split('\n')) {
    const match = /^ {0,3}(?:>\s*)*(\u0060{3,}|~{3,})(.*)$/.exec(line), marker = match?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^[ \t]*$/.test(match![2]!)) fence = '';
      continue;
    }
    if (marker && !inlineCode) {fence = marker; continue;}
    for (let i = 0; i < line.length; i++) {
      if (!inlineCode && line[i] === '\\') {i++; continue;}
      if (line[i] !== '\u0060') continue;
      const delimiter = /^\u0060+/.exec(line.slice(i))![0];
      if (!inlineCode) inlineCode = delimiter;
      else if (inlineCode === delimiter) inlineCode = '';
      i += delimiter.length - 1;
    }
  }
  if (fence || inlineCode || input.prefix.lastIndexOf('<!--') > input.prefix.lastIndexOf('-->') ||
      /<(?:script|style|pre|textarea|code)\b/i.test(input.prefix) ||
      /--|[<>]|\u0060|~{3,}|^(?: {4}|\t)/m.test(input.before))
    fail('HTML comments are available only for plain Markdown text outside code and HTML blocks.');
  return '<!--\n' + input.before + '\n-->';
}
function comment(input: ReviewActionInput): string {
  const kind = language(input.path);
  if (kind === 'unsupported') fail('This language has no supported comment action.');
  if (!(input.hasOriginal ?? input.before.length > 0)) fail('This insertion has no original lines to preserve.');
  if (input.prefix && !input.prefix.endsWith('\n')) fail('Commenting requires complete lines.');
  if (kind === 'python' || kind === 'code') {
    const issue = codeContext(input.prefix, input.path, kind === 'python');
    if (issue) fail(issue);
    if (kind === 'code' && /[\u2028\u2029]/.test(input.before))
      fail('Unicode line separators cannot be safely preserved in line comments.');
    if (/\.(?:c|h|cc|cpp|cxx|hpp)$/i.test(input.path) && /(?:\\|\?\?\/)[ \t]*$/.test(input.before))
      fail('A trailing line continuation could comment out the proposed text.');
    if (/\.java$/i.test(input.path) && /\\u+(?:000a|000d)/i.test(input.before))
      fail('Java Unicode newline escapes cannot be safely preserved in line comments.');
  }
  if (kind === 'tex' && unsafeTexContext(input.prefix)) fail('Comments are unavailable in this TeX context.');
  const marker = kind === 'python' ? '#' : kind === 'tex' ? '%' : '//';
  const preserved = kind === 'markdown' ? markdownComments(input) : input.before.split('\n').map(line => {
    const indent = /^[ \t]*/.exec(line)![0], body = line.slice(indent.length);
    return indent + marker + (body ? ' ' + body : '');
  }).join('\n');
  if (input.after === preserved || input.after.startsWith(preserved + '\n'))
    fail('The original lines are already preserved as comments.');
  // Only OLD is transformed. NEW may intentionally open or close a group,
  // environment, or string whose other boundary lies outside this block.
  return preserved + (input.after || input.hasProposed ? '\n' + input.after : '');
}
export function applyReviewAction(input: ReviewActionInput, action: ReviewAction): string {
  validate(input);
  if (action === 'comment') return comment(input);
  return fail('Unknown review action.');
}
export function getReviewActions(input: ReviewActionInput): ReviewActionOption[] {
  try {applyReviewAction(input, 'comment'); return [{id:'comment',label,enabled:true}];}
  catch (error) {return [{id:'comment',label,enabled:false,reason:error instanceof Error ? error.message : String(error)}];}
}
