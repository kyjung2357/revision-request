/** Conservative line boundaries for snapshot-generated TeX proposals, not a TeX parser. */
interface Environment { name: string; start: number; end: number; children: Environment[] }
interface Segment { start: number; count: number; kind: string }
export interface SnapshotGroup {
  oldOffset: number; newOffset: number; oldCount: number; newCount: number; atomic: boolean;
}
const rawEnvironments = new Set(['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment']);

/** Match literal environments, ignoring comments, escaped commands and verbatim bodies. */
function environments(lines: readonly string[]): Environment[] | undefined {
  const roots: Environment[] = [], stack: Environment[] = [];
  const open = (name: string, line: number) => {
    const node = {name, start: line, end: -1, children: []};
    (stack.at(-1)?.children ?? roots).push(node); stack.push(node);
  };
  const close = (name: string, line: number) => {
    if (stack.at(-1)?.name !== name) return false;
    stack.pop()!.end = line + 1; return true;
  };
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    let cursor = 0;
    const raw = stack.at(-1);
    if (raw && rawEnvironments.has(raw.name)) {
      const end = /^\s*\\end\s*\{([^{}]+)\}/.exec(text);
      if (!end || end[1] !== raw.name) continue;
      close(raw.name, line); cursor = end[0].length;
    }
    while (cursor < text.length) {
      if (stack.length > 256) return undefined;
      if (text[cursor] === '%') break;
      if (text[cursor] !== '\\') { cursor++; continue; }
      const rest = text.slice(cursor);
      const verb = /^\\verb\*?([^a-zA-Z\s])/.exec(rest);
      if (verb) {
        const end = rest.indexOf(verb[1]!, verb[0].length);
        if (end < 0) return undefined;
        cursor += end + 1; continue;
      }
      const token = /^\\(begin|end)\s*\{([^{}]+)\}/.exec(rest);
      if (token) {
        const name = token[2]!;
        if (token[1] === 'begin') open(name, line);
        else if (!close(name, line)) return undefined;
        cursor += token[0].length;
        // A raw environment's content is literal until its closing line.
        if (token[1] === 'begin' && rawEnvironments.has(name)) break;
        continue;
      }
      if (rest.startsWith('\\[')) { open('[]', line); cursor += 2; continue; }
      if (rest.startsWith('\\]')) {
        if (!close('[]', line)) return undefined;
        cursor += 2; continue;
      }
      // Also skips escaped percent signs and the second slash of \\begin.
      cursor += 2;
    }
  }
  return stack.length ? undefined : roots;
}

function segments(roots: Environment[], start: number, count: number): Segment[] {
  if (!count) return [];
  const end = start + count, spans: Segment[] = [];
  const visit = (nodes: Environment[]) => {
    // Siblings are ordered, so many tiny edits do not rescan every earlier environment.
    let first = 0, last = nodes.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (nodes[middle]!.end <= start) first = middle + 1; else last = middle;
    }
    for (let index = first; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.start >= end) break;
      if (node.end <= start || node.start >= end) continue;
      // An unchanged enclosing document/proof must not swallow its child boundaries.
      if (node.start < start && node.end > end) { visit(node.children); continue; }
      const from = Math.max(start, node.start), to = Math.min(end, node.end);
      const kind = 'environment:' + (node.start >= start ? 'open' : '') + (node.end <= end ? 'close' : '');
      const previous = spans.at(-1);
      // Several delimiters can share a physical line; never duplicate that line.
      if (previous && previous.start + previous.count > from) {
        previous.count = Math.max(previous.start + previous.count, to) - previous.start;
        previous.kind = 'environment:shared-line';
      } else spans.push({start: from, count: to - from, kind});
    }
  };
  visit(roots);
  const result: Segment[] = [];
  let cursor = start;
  for (const span of spans) {
    if (cursor < span.start) result.push({start: cursor, count: span.start - cursor, kind: 'text'});
    result.push(span); cursor = span.start + span.count;
  }
  if (cursor < end) result.push({start: cursor, count: end - cursor, kind: 'text'});
  return result;
}

/** Split only when the before/after structures give an unambiguous correspondence. */
export function createLatexGrouping(path: string, before: readonly string[], after: readonly string[]) {
  if (!/\.(?:tex|ltx|latex)$/i.test(path)) return undefined;
  const oldEnvironments = environments(before), newEnvironments = environments(after);
  // Do not guess at boundaries in incomplete or mismatched source structures.
  if (!oldEnvironments || !newEnvironments) return undefined;
  return (oldOffset: number, newOffset: number, oldCount: number, newCount: number): SnapshotGroup[] => {
    const oldParts = segments(oldEnvironments, oldOffset, oldCount), newParts = segments(newEnvironments, newOffset, newCount);
    if (!oldCount) return newParts.map(part => ({oldOffset, newOffset: part.start, oldCount: 0, newCount: part.count, atomic: part.kind !== 'text'}));
    if (!newCount) return oldParts.map(part => ({oldOffset: part.start, newOffset, oldCount: part.count, newCount: 0, atomic: part.kind !== 'text'}));
    if (oldParts.length === newParts.length && oldParts.every((part, index) => part.kind === newParts[index]!.kind)) {
      return oldParts.map((part, index) => ({oldOffset: part.start, newOffset: newParts[index]!.start,
        oldCount: part.count, newCount: newParts[index]!.count, atomic: part.kind !== 'text'}));
    }
    return [{oldOffset, newOffset, oldCount, newCount,
      atomic: [...oldParts, ...newParts].some(part => part.kind !== 'text')}];
  };
}
