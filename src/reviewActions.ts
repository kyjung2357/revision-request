import {diffArrays} from 'diff';

export type ReviewAction = 'comment' | 'markRemoved' | 'markAdded';
export interface ReviewActionInput {
  path: string;
  /** Complete displayed block contents, excluding the structural final newline. */
  before: string;
  after: string;
  /** Original source up to the start of this block. */
  prefix: string;
}
export interface ReviewActionOption {id: ReviewAction; label: string; enabled: boolean; reason?: string}
const labels: Record<ReviewAction, string> = {
  comment: 'Comment out changed lines',
  markRemoved: 'Mark removed text in red',
  markAdded: 'Mark added text in blue'
};
const texPath = /\.(?:tex|ltx|latex)$/i;
const maxText = 5 * 1024 * 1024;
function fail(message: string): never {throw new Error(message);}
function validate(input: ReviewActionInput) {
  for (const value of [input.path, input.before, input.after, input.prefix]) {
    if (typeof value !== 'string' || value.length > maxText || /[\0\r]/.test(value))
      fail('Review actions require bounded text with LF line endings.');
  }
}
function language(path: string): 'tex' | 'python' | 'code' | 'markdown' | 'unsupported' {
  if (texPath.test(path)) return 'tex';
  if (/\.(?:py|pyw|pyi)$/i.test(path)) return 'python';
  if (/\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|c|h|cc|cpp|cxx|hpp|cs|java|go|rs|swift|kt|jsonc)$/i.test(path)) return 'code';
  if (/\.(?:md|markdown)$/i.test(path)) return 'markdown';
  return 'unsupported';
}
/** Only inspect lexical context; this is not a language parser or a validity claim. */
function codeContext(prefix: string, python: boolean): string {
  let quote = '', quoteWidth = 1, verbatim = false, blockComment = false, lineComment = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]!, next = prefix[i + 1];
    if (lineComment) {if (c === '\n') lineComment = false; continue;}
    if (blockComment) {if (c === '*' && next === '/') {blockComment = false; i++;} continue;}
    if (quote) {
      if (verbatim && c === '"' && next === '"') {i++; continue;}
      if (!verbatim && c === '\\') {i++; continue;}
      if (prefix.startsWith(quote.repeat(quoteWidth), i)) {
        i += quoteWidth - 1; quote = ''; quoteWidth = 1; verbatim = false;
      }
      continue;
    }
    if (python && c === '#') {lineComment = true; continue;}
    if (!python && c === '/' && next === '/') {lineComment = true; i++; continue;}
    if (!python && c === '/' && next === '*') {blockComment = true; i++; continue;}
    if (!python && c === 'R' && next === '"') {
      const raw = /^R"([^\s()\\]{0,16})\(/.exec(prefix.slice(i));
      if (raw) {
        const terminator = ')' + raw[1] + '"', end = prefix.indexOf(terminator,i + raw[0].length);
        if (end < 0) return 'The block starts inside a raw string.';
        i = end + terminator.length - 1; continue;
      }
    }
    if (c === '"' || c === "'" || (!python && c === '\u0060')) {
      quote = c; quoteWidth = prefix.startsWith(c.repeat(3),i) && (python || c === '"') ? 3 : 1;
      if (!python && quoteWidth === 3) while (prefix[i + quoteWidth] === c) quoteWidth++;
      verbatim = !python && c === '"' && prefix[i - 1] === '@';
      i += quoteWidth - 1;
    }
  }
  if (quote || blockComment) return 'The block starts inside a string or block comment.';
  const lastLine = prefix.replace(/\n$/, '').split('\n').at(-1) || '';
  if (/\\\s*$/.test(lastLine)) return 'The preceding line continues into this block.';
  return '';
}
const mathEnvironments = new Set(['math','displaymath','equation','equation*','align','align*','alignat','alignat*','gather','gather*','multline','multline*','flalign','flalign*','aligned','alignedat','gathered','split','cases','matrix','pmatrix','bmatrix','Bmatrix','vmatrix','Vmatrix','smallmatrix']);
const verbatimEnvironments = new Set(['verbatim','verbatim*','Verbatim','lstlisting','minted','alltt']);
interface TexContext {mode: string; environments: string[]; braces: number; unsafe: boolean}
function mathMode(context: TexContext) {return Boolean(context.mode || context.environments.some(name => mathEnvironments.has(name)));}
function balancedPrefixEnd(text: string, start: number): number {
  const opener = text[start], closer = opener === '{' ? '}' : ']';
  let depth = 1;
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') {at++; continue;}
    if (text[at] === '%') {const end = text.indexOf('\n',at); if (end < 0) return -1; at = end; continue;}
    if (text[at] === opener) depth++;
    if (text[at] === closer) {depth--; if (depth === 0) return at + 1;}
  }
  return -1;
}
function texContext(prefix: string): TexContext {
  const context: TexContext = {mode:'',environments:[],braces:0,unsafe:false};
  for (let i = 0; i < prefix.length;) {
    const literal = context.environments.at(-1);
    if (literal && verbatimEnvironments.has(literal)) {
      const endToken = '\\end{' + literal + '}', end = prefix.indexOf(endToken,i);
      if (end < 0) return context;
      context.environments.pop(); i = end + endToken.length; continue;
    }
    const c = prefix[i]!;
    if (c === '%') {const end = prefix.indexOf('\n', i); i = end < 0 ? prefix.length : end + 1; continue;}
    if (c === '\\') {
      const match = /^\\(?:begin|end)\s*\{([^{}]+)\}/.exec(prefix.slice(i));
      if (match) {
        if (match[0].startsWith('\\begin')) context.environments.push(match[1]!);
        else if (context.environments.at(-1) === match[1]) context.environments.pop();
        else context.unsafe = true;
        i += match[0].length; continue;
      }
      const command = /^\\(?:[A-Za-z@]+|.)/.exec(prefix.slice(i))?.[0] || '\\';
      if (/^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment)$/.test(command)) {
        let at = i + command.length, groups = 0;
        if (prefix[at] === '*') at++;
        while (/\s/.test(prefix[at] || '')) at++;
        if (prefix[at] === '\\') at += /^\\(?:[A-Za-z@]+|.)/.exec(prefix.slice(at))?.[0].length || 1;
        while (true) {
          while (/\s/.test(prefix[at] || '')) at++;
          if (prefix[at] !== '{' && prefix[at] !== '[') break;
          const end = balancedPrefixEnd(prefix,at);
          if (end < 0) {context.unsafe = true; return context;}
          if (prefix[at] === '{') groups++;
          at = end;
        }
        if (!groups) context.unsafe = true;
        i = at; continue;
      }
      if (/^\\(?:def|gdef|edef|xdef)$/.test(command)) {
        const start = prefix.indexOf('{',i + command.length);
        const end = start < 0 ? -1 : balancedPrefixEnd(prefix,start);
        if (end < 0) {context.unsafe = true; return context;}
        i = end; continue;
      }
      if (command === '\\(' || command === '\\[') context.mode = command;
      else if (command === '\\)' || command === '\\]') context.mode = '';
      else if (command === '\\verb') {
        const offset = i + command.length + (prefix[i + command.length] === '*' ? 1 : 0);
        const delimiter = prefix[offset];
        const end = delimiter ? prefix.indexOf(delimiter, offset + 1) : -1;
        if (end < 0) {context.unsafe = true; return context;}
        i = end + 1; continue;
      } else if (command === '\\catcode') context.unsafe = true;
      i += command.length; continue;
    }
    if (c === '$') {const token = prefix[i + 1] === '$' ? '$$' : '$'; context.mode = context.mode ? '' : token; i += token.length; continue;}
    if (c === '{') context.braces++;
    if (c === '}') context.braces--;
    i++;
  }
  return context;
}
function comment(input: ReviewActionInput): string {
  const kind = language(input.path);
  if (kind === 'unsupported') fail('This language has no supported line-comment action.');
  if (!input.after.trim()) fail('There are no proposed lines to comment out.');
  if (input.prefix && !input.prefix.endsWith('\n')) fail('Commenting requires complete lines.');
  if (kind === 'python' || kind === 'code') {
    const issue = codeContext(input.prefix, kind === 'python');
    if (issue) fail(issue);
    const ending = codeContext(input.prefix + input.after + '\n', kind === 'python');
    if (ending) fail('Commenting requires a complete block without an open string, comment, or line continuation.');
  }
  if (kind === 'tex') {
    const context = texContext(input.prefix);
    if (context.unsafe || context.environments.some(name => verbatimEnvironments.has(name))) fail('Comments are unavailable in this TeX context.');
    const ending = texContext(input.prefix + input.after + '\n');
    if (ending.unsafe || ending.mode !== context.mode || ending.braces !== context.braces ||
        ending.environments.join('\0') !== context.environments.join('\0'))
      fail('Commenting requires complete TeX groups and environment boundaries within the selected block.');
  }
  if (kind === 'markdown') {
    let fence = '';
    for (const line of input.prefix.split('\n')) {
      const marker = /^ {0,3}(\u0060{3,}|~{3,})/.exec(line)?.[1];
      if (!marker) continue;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    }
    if (fence || input.prefix.lastIndexOf('<!--') > input.prefix.lastIndexOf('-->') ||
        /<(?:script|style|pre|textarea|code)\b/i.test(input.prefix) ||
        /\u0060/.test(input.prefix.split('\n').at(-2) || '') ||
        /--|[<>]|\u0060|~{3,}|^(?: {4}|\t)/m.test(input.after))
      fail('HTML comments are available only for plain Markdown text outside code and HTML blocks.');
    return '<!--\n' + input.after + '\n-->';
  }
  const marker = kind === 'python' ? '#' : kind === 'tex' ? '%' : '//';
  return input.after.split('\n').map(line => {
    if (!line.trim()) return line;
    const indent = /^\s*/.exec(line)![0];
    const body = line.slice(indent.length);
    return body.startsWith(marker) ? line : indent + marker + ' ' + body;
  }).join('\n');
}

interface Atom {
  text: string; math: boolean; forbidden?: string; script?: boolean; mathWrapper?: boolean; atomic?: boolean;
  head?: string; tail?: string; children?: Atom[];
}
const unsafeCommands = /^(?:begin|end|label|ref|eqref|autoref|pageref|cite\w*|input|include|includeonly|usepackage|RequirePackage|documentclass|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|def|gdef|edef|xdef|let|catcode|csname|endcsname|verb|url|href|includegraphics|bibliography|bibliographystyle|write|openout|closeout|special|section|subsection|subsubsection|chapter|part|item|setcounter|addtocounter|tag|notag|nonumber|color|definecolor|textcolor)$/;
const needsBraces = /^(?:frac|dfrac|tfrac|sqrt|overset|underset|stackrel|text|textrm|textbf|textit|textsf|texttt|emph|mbox|mathbb|mathcal|mathfrak|mathrm|mathbf|mathsf|mathit|mathtt|operatorname|boldsymbol|hat|widehat|bar|overline|underline|vec|dot|ddot|tilde|widetilde|breve|check|acute|grave)$/;
const textArgumentCommands = /^(?:text|textrm|textbf|textit|textsf|texttt|textnormal|textup|textmd|textsc|emph|mbox|operatorname)$/;
const safeArgumentCommands = /^(?:text|textrm|textbf|textit|textsf|texttt|textnormal|textup|textmd|textsc|emph|mbox|operatorname|frac|dfrac|tfrac|binom|dbinom|tbinom|sqrt|overset|underset|stackrel|mathbb|mathcal|mathfrak|mathrm|mathbf|mathsf|mathit|mathtt|boldsymbol|hat|widehat|bar|overline|underline|vec|dot|ddot|tilde|widetilde|breve|check|acute|grave|boxed|ensuremath)$/;
// Unknown macros may read dimensions, filenames, counters, or an unbraced
// argument. Wrapping their argument would change its grammar.
const safeBareCommands = new Set((
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega ' +
  'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega ' +
  'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln exp lim limsup liminf sup inf min max det dim gcd ker Pr ' +
  'sum prod coprod int iint iiint oint bigcup bigcap bigvee bigwedge bigoplus bigotimes ' +
  'infty partial nabla ell hbar imath jmath Re Im wp emptyset varnothing top bot forall exists nexists neg angle triangle ' +
  'le leq ge geq ne neq equiv approx sim simeq cong asymp propto ll gg subset supset subseteq supseteq in notin ni ' +
  'cup cap setminus uplus sqcup sqcap vee wedge oplus ominus otimes oslash odot times div cdot pm mp circ bullet star ast ' +
  'to mapsto gets leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow longrightarrow longleftarrow longleftrightarrow ' +
  'ldots cdots vdots ddots dots aleph beth complement prime backslash vert Vert lvert rvert lVert rVert ' +
  'quad qquad enspace thinspace textbackslash textendash textemdash TeX LaTeX'
).split(' '));
function safeBare(name: string) {return safeBareCommands.has(name) || /^[%&#$_{}!,;: ]$/.test(name);}
function parseTex(text: string, initial: TexContext): Atom[] {
  const context: TexContext = {...initial,environments:[...initial.environments]};
  let position = 0, count = 0;
  let nestingDepth = 0;
  const parse = (closing?: string): Atom[] => {
    if (++nestingDepth > 64) fail('TeX nesting exceeds the safe markup limit.');
    const atoms: Atom[] = [];
    while (position < text.length) {
      if (++count > 20000) fail('This block is too large for safe TeX markup.');
      const start = position, math = mathMode(context), c = text[position]!;
      if (closing && c === closing) {position++; nestingDepth--; return atoms;}
      if (c === '}') fail('The block contains an unmatched TeX delimiter.');
      if (c === '{') {
        position++;
        const children = parse('}');
        atoms.push({text:text.slice(start,position),math,head:'{',tail:'}',children});
        continue;
      }
      if (c === '\\') {
        const command = /^\\([A-Za-z@]+|[\s\S])/.exec(text.slice(position));
        if (!command) fail('The block ends in an incomplete TeX command.');
        const name = command[1]!;
        position += command[0].length;
        let head = command[0];
        if (text[position] === '*' && /^[A-Za-z]/.test(name)) head += text[position++]!;
        const args: Atom[] = [];
        while (true) {
          const spaces = /^[ \t]*/.exec(text.slice(position))![0];
          const opener = text[position + spaces.length];
          if (opener !== '{' && opener !== '[') break;
          position += spaces.length + 1;
          const savedMode = context.mode, savedEnvironments = context.environments;
          const textArgument = textArgumentCommands.test(name), mathArgument = name === 'ensuremath';
          if (textArgument || mathArgument) {context.mode = mathArgument ? 'ensuremath' : ''; context.environments = [];}
          const children = parse(opener === '{' ? '}' : ']');
          if (textArgument || mathArgument) {context.mode = savedMode; context.environments = savedEnvironments;}
          args.push({text: spaces + opener + children.map(atom => atom.text).join('') + (opener === '{' ? '}' : ']'),
            math,head:spaces + opener,tail:opener === '{' ? '}' : ']',children});
        }
        if (needsBraces.test(name) && !args.length) fail('Use complete braced command arguments before adding TeX markup.');
        const forbidden = name === '\\' || ['(',')','[',']','left','right','middle'].includes(name) || unsafeCommands.test(name) ||
          (args.length ? !safeArgumentCommands.test(name) : !safeBare(name))
          ? 'Markup cannot safely wrap TeX structure, alignment, references, or incomplete command arguments.' : undefined;
        atoms.push({text:text.slice(start,position),math,forbidden,...(name === 'operatorname' ? {atomic:true} : {}),...(name === 'ensuremath' ? {mathWrapper:true} : {}),...(args.length ? {head,tail:'',children:args} : {})});
        if (name === '(' || name === '[') context.mode = '\\' + name;
        else if (name === ')' || name === ']') context.mode = '';
        else if ((name === 'begin' || name === 'end') && args.length) {
          const environment = args[0]!.children?.map(atom => atom.text).join('') || '';
          if (name === 'begin') context.environments.push(environment);
          else if (context.environments.at(-1) === environment) context.environments.pop();
          else fail('The TeX environment boundaries do not match.');
        }
        continue;
      }
      if (c === '$') {
        const delimiter = text[position + 1] === '$' ? '$$' : '$';
        position += delimiter.length; context.mode = context.mode ? '' : delimiter;
        atoms.push({text:delimiter,math,forbidden:'Markup cannot wrap a changed math delimiter.'}); continue;
      }
      if ((c === '^' || c === '_') && math) {
        position++;
        const spaces = /^[ \t]*/.exec(text.slice(position))![0];
        position += spaces.length;
        let children: Atom[];
        if (text[position] === '{') {position++; children = parse('}');}
        else {
          const token = /^(?:\\[A-Za-z]+|\\[^A-Za-z]|[^\\{}\s])/.exec(text.slice(position))?.[0];
          if (!token || (token.startsWith('\\') && needsBraces.test(token.slice(1))))
            fail('Use complete braced superscripts and subscripts before adding markup.');
          position += token.length;
          children = [{text:token,math}];
        }
        atoms.push({text:text.slice(start,position),math,head:c + spaces,tail:'',children,script:true});
        continue;
      }
      if (c === '%' || c === '&' || c === '^' || c === '_') {
        if (c === '%') {const end = text.indexOf('\n',position); position = end < 0 ? text.length : end;}
        else position++;
        atoms.push({text:text.slice(start,position),math,forbidden:'Markup cannot wrap comments, alignment markers, or script operators.'}); continue;
      }
      const word = (math ? /^(?:\d+(?:\.\d+)?|[ \t]+|\n)/u : /^(?:[\p{L}\p{N}]+|[ \t]+|\n)/u).exec(text.slice(position))?.[0];
      position += word?.length || (text.codePointAt(position)! > 0xffff ? 2 : 1);
      atoms.push({text:text.slice(start,position),math});
    }
    if (closing) fail('The block contains an incomplete TeX group or command argument.');
    nestingDepth--; return atoms;
  };
  return parse();
}
function unsafe(atom: Atom): string | undefined {
  return atom.forbidden || (atom.script ? 'Markup cannot wrap a newly added or removed script operator.' : undefined) ||
    (atom.mathWrapper ? 'A changed inline math wrapper must remain outside text deletion markup.' : undefined) || atom.children?.map(unsafe).find(Boolean);
}
interface Marks {removed: boolean; added: boolean}
function markup(nodes: Atom[], added: boolean): string {
  let output = '', pending = '', mode = false;
  const flush = () => {
    if (!pending) return;
    // Removed separators belong inside the marker too. Otherwise stripping a
    // marker for the next action would accidentally retain deleted spaces/lines.
    output += /\S/.test(pending)
      ? '\\' + (added ? 'reviewadd' : mode ? 'reviewdelmath' : 'reviewdel') + '{' + pending + '}'
      : added ? pending : '';
    pending = '';
  };
  for (const atom of nodes) {
    const issue = unsafe(atom);
    if (issue) fail(issue);
    if (atom.text === '\n') {
      if (added) {flush(); output += '\n';}
      else {pending += '\n'; flush();}
      continue;
    }
    if (pending && atom.math !== mode) flush();
    mode = atom.math; pending += atom.text;
  }
  flush(); return output;
}
function renderTex(before: Atom[], after: Atom[], marks: Marks, depth = 0): string {
  if (depth > 64) fail('TeX nesting exceeds the safe markup limit.');
  const parts = diffArrays(before,after,{comparator:(a,b) => a.text === b.text && a.math === b.math,timeout:100,maxEditLength:2000});
  if (!parts) fail('This change is too large for safe TeX markup.');
  let output = '';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!part.removed && !part.added) {output += part.value.map(atom => atom.text).join(''); continue;}
    const next = parts[index + 1];
    if (part.removed && next?.added && part.value.length === next.value.length &&
        part.value.some((atom, at) => atom.children && next.value[at]?.children && atom.head === next.value[at]?.head)) {
      for (let at = 0; at < part.value.length; at++) {
        const old = part.value[at]!, replacement = next.value[at]!;
        if (!old.forbidden && !replacement.forbidden && !old.atomic && !replacement.atomic && old.children && replacement.children &&
            old.head === replacement.head && old.tail === replacement.tail && old.math === replacement.math) {
          const inner = renderTex(old.children,replacement.children,marks,depth + 1);
          output += old.head + (old.script ? '{' + inner + '}' : inner + old.tail);
        } else {
          if (marks.removed) output += markup([old],false);
          output += marks.added ? markup([replacement],true) : replacement.text;
        }
      }
      index++; continue;
    }
    if (part.removed) {if (marks.removed) output += markup(part.value,false);}
    else output += marks.added ? markup(part.value,true) : part.value.map(atom => atom.text).join('');
  }
  return output;
}
function unwrapReview(text: string): {clean:string; marks:Marks} {
  let clean = '', position = 0;
  const marks: Marks = {removed:false,added:false};
  while (position < text.length) {
    const found = /\\(reviewadd|reviewdelmath|reviewdel)\{/.exec(text.slice(position));
    if (!found) {clean += text.slice(position); break;}
    clean += text.slice(position,position + found.index);
    const begin = position + found.index + found[0].length;
    let at = begin, nesting = 1;
    for (; at < text.length && nesting; at++) {
      if (text[at] === '\\') {at++; continue;}
      if (text[at] === '{') nesting++;
      else if (text[at] === '}') nesting--;
    }
    if (nesting) fail('An existing review marker is incomplete.');
    const value = text.slice(begin,at - 1);
    if (/\\review(?:add|delmath|del)\b/.test(value)) fail('Nested review markers cannot be transformed automatically.');
    if (found[1] === 'reviewadd') {marks.added = true; clean += value;}
    else marks.removed = true;
    position = at;
  }
  return {clean,marks};
}
function mark(input: ReviewActionInput, action: Exclude<ReviewAction,'comment'>): string {
  if (!texPath.test(input.path)) fail('Red and blue source markup is available for LaTeX only.');
  if (/\\review(?:add|delmath|del)\b/.test(input.before)) fail('This block already contains original review markup; edit it manually to preserve it.');
  const context = texContext(input.prefix);
  if (context.unsafe || context.braces !== 0 || context.environments.some(name => verbatimEnvironments.has(name)))
    fail('The block begins inside an incomplete or unsupported TeX context.');
  const unwrapped = unwrapReview(input.after);
  const original = parseTex(input.before,context), proposed = parseTex(unwrapped.clean,context);
  if (unwrapped.marks.added || unwrapped.marks.removed) {
    if (renderTex(original,proposed,unwrapped.marks) !== input.after)
      fail('Existing review markup was edited or was not generated by this action; preserve it manually.');
  }
  const flag = action === 'markAdded' ? 'added' : 'removed';
  if (unwrapped.marks[flag]) fail(flag === 'added' ? 'Added text is already marked in blue.' : 'Removed text is already marked in red.');
  if (flag === 'removed' && !input.before.trim()) fail('This addition has no removed text to mark.');
  if (flag === 'added' && !unwrapped.clean.trim()) fail('This deletion has no added text to mark.');
  const result = renderTex(original,proposed,{...unwrapped.marks,[flag]:true});
  if (result === input.after) fail(flag === 'added' ? 'There is no added text to mark.' : 'There is no removed text to mark.');
  return result;
}
export function applyReviewAction(input: ReviewActionInput, action: ReviewAction): string {
  validate(input);
  if (action === 'comment') return comment(input);
  if (action === 'markAdded' || action === 'markRemoved') return mark(input,action);
  return fail('Unknown review action.');
}
export function getReviewActions(input: ReviewActionInput): ReviewActionOption[] {
  return (['comment','markRemoved','markAdded'] as const).map(id => {
    try {applyReviewAction(input,id); return {id,label:labels[id],enabled:true};}
    catch (error) {return {id,label:labels[id],enabled:false,reason:error instanceof Error ? error.message : String(error)};}
  });
}

