import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const names = ['reviewadd', 'reviewdel', 'reviewdelmath'] as const;
const MAX_BYTES = 5 * 1024 * 1024;
export interface SetupImportPlan {
  rootUri: vscode.Uri;
  /** Exact saved root text, including its BOM and line endings. */
  original: string;
  /** One-based line before which the import is proposed. */
  line: number;
  text: string;
}
export interface ReviewMacroStatus { ready: boolean; rootUri?: vscode.Uri; reason?: string }
interface Snapshot { uri: vscode.Uri; bytes: Buffer; text: string; real: string }
interface Inspection extends ReviewMacroStatus {
  root?: Snapshot; begin?: number; snapshots?: Snapshot[]; blocked?: boolean;
}
const contains = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const samePath = (left: string, right: string) => path.relative(left, right) === '';
const dirty = (uri: vscode.Uri) => vscode.workspace.textDocuments.some(document =>
  document.uri.scheme === 'file' && samePath(document.uri.fsPath, uri.fsPath) && document.isDirty);
function assertTrusted() {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before setting up LaTeX review macros.');
}
async function workspaceFor(uri: vscode.Uri) {
  if (uri.scheme !== 'file') throw new Error('Choose a local LaTeX file in this workspace.');
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || folder.uri.scheme !== 'file') throw new Error('The LaTeX file must be inside an open local workspace.');
  const root = await fs.realpath(folder.uri.fsPath);
  const real = await fs.realpath(uri.fsPath);
  const relative = path.relative(root, real);
  if (!contains(root, real) || relative.split(path.sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error('LaTeX setup must stay inside the workspace and outside .git.');
  }
  if (!samePath(path.resolve(folder.uri.fsPath), root) || !samePath(path.resolve(uri.fsPath), real)) {
    throw new Error('Choose a LaTeX file and workspace without symbolic links for macro setup.');
  }
  return folder;
}
async function snapshot(uri: vscode.Uri): Promise<Snapshot> {
  if (dirty(uri)) throw new Error('Save "' + path.basename(uri.fsPath) + '" before setting up review macros.');
  const info = await fs.stat(uri.fsPath);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('LaTeX setup requires regular UTF-8 files no larger than 5 MiB.');
  const bytes = await fs.readFile(uri.fsPath);
  if (bytes.length > MAX_BYTES) throw new Error('The LaTeX file exceeds the 5 MiB text limit.');
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error('LaTeX setup requires valid UTF-8 text.'); }
  if (text.includes('\0')) throw new Error('LaTeX setup does not support binary files.');
  return {uri, bytes, text, real: await fs.realpath(uri.fsPath)};
}
/** Keep offsets stable while excluding TeX comments, including escaped percent signs. */
function uncomment(text: string): string {
  return text.replace(/(^|[\r\n])([^\r\n]*)/g, (_whole, newline: string, line: string) => {
    for (let index = 0; index < line.length; index++) {
      if (line[index] !== '%') continue;
      let escapes = 0;
      for (let at = index - 1; at >= 0 && line[at] === '\\'; at--) escapes++;
      if (escapes % 2 === 0) return newline + line.slice(0, index) + ' '.repeat(line.length - index);
    }
    return newline + line;
  });
}
interface PreambleSyntax {
  definitions: Map<string, number>;
  inputs: string[];
  ulemWithoutNormalem: boolean;
}
const declarationCommands = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand',
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'def', 'gdef', 'edef', 'xdef', 'let',
]);
const reviewDeclaration = /\\(?:(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)\*?\s*\{?\s*\\review(?:add|delmath|del)\b|(?:def|gdef|edef|xdef|let)\s*\\review(?:add|delmath|del)\b)/;
const importCommand = /\\(?:input|include|import|subimport|InputIfFileExists|IfFileExists)(?![A-Za-z@])/;
const manualSyntax = () => new Error('Scoped, conditional, or deferred review macro definitions or inputs require manual inspection.');
function controlAt(code: string, start: number): {name: string; end: number} | undefined {
  if (code[start] !== '\\' || start + 1 >= code.length) return;
  const word = /^[A-Za-z@]+/.exec(code.slice(start + 1))?.[0];
  return {name: word ?? code[start + 1]!, end: start + 1 + (word?.length ?? 1)};
}
function spaceAt(code: string, start: number): number {
  let index = start;
  while (index < code.length && /\s/.test(code[index]!)) index++;
  return index;
}
function groupAt(code: string, start: number, open = '{', close = '}'): {value: string; end: number} {
  if (code[start] !== open) throw new Error('An unsupported LaTeX declaration requires manual macro inspection.');
  let depth = 1, braces = 0;
  for (let index = start + 1; index < code.length; index++) {
    const control = controlAt(code, index);
    if (control) { index = control.end - 1; continue; }
    if (open === '[') {
      if (code[index] === '{') braces++;
      if (code[index] === '}') braces--;
      if (braces > 0) continue;
    }
    if (code[index] === open) depth++;
    if (code[index] === close && --depth === 0) return {value: code.slice(start + 1, index), end: index + 1};
  }
  throw new Error('An unbalanced LaTeX declaration requires manual macro inspection.');
}
function inspectDeferred(code: string) {
  if (reviewDeclaration.test(code) || importCommand.test(code) || /\\csname\s*review(?:add|delmath|del)\b/.test(code)) {
    throw manualSyntax();
  }
}
/** Count only declarations that execute unconditionally at the preamble's top level. */
function inspectSyntax(code: string): PreambleSyntax {
  const result: PreambleSyntax = {definitions: new Map(names.map(name => [name, 0])), inputs: [], ulemWithoutNormalem: false};
  let index = 0, braces = 0, groups = 0, conditionals = 0, environments = 0;
  const scoped = () => braces > 0 || groups > 0 || conditionals > 0 || environments > 0;
  while (index < code.length) {
    const control = controlAt(code, index);
    if (!control) {
      if (code[index] === '{') braces++;
      if (code[index] === '}') braces = Math.max(0, braces - 1);
      index++; continue;
    }
    const command = control.name;
    index = control.end;
    if (command === 'newif') {
      const next = controlAt(code, spaceAt(code, index));
      if (next) index = next.end;
      continue;
    }
    if (/^if[A-Za-z@]*$/.test(command)) { conditionals++; continue; }
    if (command === 'fi') { conditionals = Math.max(0, conditionals - 1); continue; }
    if (command === 'begingroup' || command === 'bgroup') { groups++; continue; }
    if (command === 'endgroup' || command === 'egroup') { groups = Math.max(0, groups - 1); continue; }
    if (command === 'begin' || command === 'end') {
      const at = spaceAt(code, index);
      if (code[at] === '{') {
        const environment = groupAt(code, at); index = environment.end;
        environments = Math.max(0, environments + (command === 'begin' ? 1 : -1));
      }
      continue;
    }
    if (command === 'endinput') {
      if (scoped()) { inspectDeferred(code.slice(index)); throw manualSyntax(); }
      break;
    }
    if (['string', 'noexpand', 'aftergroup', 'afterassignment', 'csname'].includes(command)) {
      // These can turn following declaration-looking tokens into data or delayed code.
      inspectDeferred(code.slice(index));
    }
    if (declarationCommands.has(command)) {
      index = spaceAt(code, index);
      if (code[index] === '*') index = spaceAt(code, index + 1);
      let macro: string | undefined;
      if (code[index] === '{') {
        const name = groupAt(code, index); index = name.end;
        macro = /^\\([A-Za-z@]+)$/.exec(name.value.trim())?.[1];
      } else {
        const name = controlAt(code, index); macro = name?.name;
        if (name) index = name.end;
      }
      if (!macro) throw new Error('An unsupported LaTeX declaration requires manual macro inspection.');
      if (names.includes(macro as typeof names[number])) {
        if (scoped() || command === 'let' || command === 'renewcommand' || command === 'RenewDocumentCommand') throw manualSyntax();
        result.definitions.set(macro, result.definitions.get(macro)! + 1);
      }
      index = spaceAt(code, index);
      if (command === 'let') {
        if (code[index] === '=') index = spaceAt(code, index + 1);
        index = controlAt(code, index)?.end ?? index + 1;
        continue;
      }
      if (['def', 'gdef', 'edef', 'xdef'].includes(command)) {
        while (index < code.length && code[index] !== '{') index = controlAt(code, index)?.end ?? index + 1;
      } else if (/DocumentCommand$/.test(command)) {
        const signature = groupAt(code, index); inspectDeferred(signature.value);
        index = spaceAt(code, signature.end);
      } else {
        for (let count = 0; count < 2 && code[index] === '['; count++) {
          const option = groupAt(code, index, '[', ']'); inspectDeferred(option.value);
          index = spaceAt(code, option.end);
        }
      }
      const body = groupAt(code, index); inspectDeferred(body.value);
      index = body.end;
      continue;
    }
    if (command === 'input' || command === 'include') {
      if (scoped()) throw manualSyntax();
      index = spaceAt(code, index);
      if (code[index] === '{') {
        const input = groupAt(code, index); result.inputs.push(input.value.trim()); index = input.end;
      } else {
        const value = /^[^\s%{}]+/.exec(code.slice(index))?.[0];
        if (!value) throw new Error('A dynamic LaTeX input requires manual macro inspection.');
        result.inputs.push(value); index += value.length;
      }
      continue;
    }
    if (['import', 'subimport', 'InputIfFileExists', 'IfFileExists'].includes(command)) {
      throw new Error('This preamble uses conditional or imported input paths. Check review macro imports manually.');
    }
    if (command === 'usepackage' || command === 'RequirePackage') {
      index = spaceAt(code, index);
      let options = '';
      if (code[index] === '[') { const option = groupAt(code, index, '[', ']'); options = option.value; index = spaceAt(code, option.end); }
      const packages = groupAt(code, index); index = packages.end;
      if (packages.value.split(',').map(value => value.trim()).includes('ulem') &&
          !options.split(',').map(value => value.trim()).includes('normalem')) result.ulemWithoutNormalem = true;
    }
  }
  return result;
}
function inputPath(parent: string, value: string): string {
  if (!value || /[\\{}#~\r\n]/.test(value)) throw new Error('A dynamic LaTeX input cannot be inspected automatically. Check review macro imports manually.');
  // Literal Windows drive paths use forward slashes in TeX.
  const resolved = path.isAbsolute(value) ? value : path.resolve(path.dirname(parent), value);
  return path.extname(resolved) ? resolved : resolved + '.tex';
}
function rootHint(text: string): string | undefined {
  return text.split(/\r\n|\r|\n/).slice(0, 30).join('\n').match(/^\s*%\s*!\s*TeX\s+root\s*=\s*(.*?)\s*$/im)?.[1];
}
async function findRoot(target: vscode.Uri): Promise<Snapshot | undefined> {
  const folder = await workspaceFor(target);
  let current = target;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    const item = await snapshot(current);
    if (seen.has(item.real)) throw new Error('The % !TeX root directives contain a cycle.');
    seen.add(item.real);
    const hint = rootHint(item.text);
    if (hint) {
      const value = hint.replace(/^["']|["']$/g, '');
      const next = vscode.Uri.file(path.resolve(path.dirname(item.uri.fsPath), value));
      await workspaceFor(next);
      if (!contains(folder.uri.fsPath, next.fsPath)) throw new Error('The TeX root must stay in the selected workspace.');
      current = next;
      continue;
    }
    return /\\begin\s*\{document\}/.test(uncomment(item.text)) ? item : undefined;
  }
  throw new Error('The % !TeX root chain is too long.');
}
async function inspectRoot(root: Snapshot): Promise<Inspection> {
  const clean = uncomment(root.text);
  const starts = [...clean.matchAll(/\\begin\s*\{document\}/g)];
  if (starts.length !== 1) return {ready: false, rootUri: root.uri, root, blocked: true, reason: 'Choose a root with exactly one \\begin{document}.'};
  const begin = starts[0]!.index!;
  const lineStart = Math.max(clean.lastIndexOf('\n', begin - 1), clean.lastIndexOf('\r', begin - 1)) + 1;
  const counts = new Map<string, number>(names.map(name => [name, 0]));
  const snapshots: Snapshot[] = [];
  const visited = new Set<string>();
  let packageConflict: string | undefined;
  async function visit(item: Snapshot, text: string, depth: number): Promise<void> {
    if (depth > 12 || snapshots.length >= 32) throw new Error('The preamble input tree is too large to inspect automatically.');
    if (visited.has(item.real)) throw new Error('The preamble loads the same input more than once. Check review macro definitions manually.');
    visited.add(item.real); snapshots.push(item);
    const code = uncomment(text);
    const syntax = inspectSyntax(code);
    for (const [name, count] of syntax.definitions) counts.set(name, counts.get(name)! + count);
    if (syntax.ulemWithoutNormalem) packageConflict = 'The existing ulem package must use the normalem option before adding these review macros.';
    for (const value of syntax.inputs) {
      const target = inputPath(root.uri.fsPath, value);
      let next: Snapshot;
      try { next = await snapshot(vscode.Uri.file(target)); }
      catch (error) { throw new Error('Cannot inspect preamble input "' + target + '". ' + (error instanceof Error ? error.message : String(error))); }
      await visit(next, next.text, depth + 1);
    }
  }
  try { await visit(root, root.text.slice(0, begin), 0); }
  catch (error) {
    return {ready: false, rootUri: root.uri, root, begin, snapshots, blocked: true, reason: error instanceof Error ? error.message : String(error)};
  }
  if (packageConflict) return {ready: false, rootUri: root.uri, root, begin, snapshots, blocked: true, reason: packageConflict};
  const values = names.map(name => counts.get(name)!);
  if (values.some(value => value > 1)) return {ready: false, rootUri: root.uri, root, begin, snapshots, blocked: true, reason: 'Duplicate review macro definitions were found. Keep one definition of each macro before setup.'};
  if (values.every(value => value === 1)) return {ready: true, rootUri: root.uri, root, begin, snapshots};
  if (values.some(value => value > 0)) return {ready: false, rootUri: root.uri, root, begin, snapshots, blocked: true, reason: 'Only some review macros are defined. Complete the existing definitions instead of loading a duplicate macro file.'};
  if (clean.slice(lineStart, begin).trim()) {
    return {ready: false, rootUri: root.uri, root, blocked: true, reason: 'Put \\begin{document} on its own line before automatic setup.'};
  }
  return {ready: false, rootUri: root.uri, root, begin, snapshots, reason: 'Set up LaTeX review macros before accepting marked text.'};
}
/** Read-only, conservative preamble inspection. This does not run TeX or change files. */
export async function inspectReviewMacros(targetUri: vscode.Uri, rootOverride?: vscode.Uri): Promise<ReviewMacroStatus> {
  try {
    let root = await findRoot(targetUri);
    // A remembered manual selection is only a fallback. Explicit current TeX root metadata wins.
    if (!root && rootOverride && !rootHint((await snapshot(targetUri)).text)) {
      const folder = await workspaceFor(targetUri);
      await workspaceFor(rootOverride);
      if (!contains(folder.uri.fsPath, rootOverride.fsPath)) throw new Error('The remembered LaTeX root is outside the selected workspace.');
      root = await findRoot(rootOverride);
    }
    if (!root) return {ready: false, reason: 'Choose the root LaTeX document to set up review macros.'};
    const status = await inspectRoot(root);
    return {ready: status.ready, rootUri: status.rootUri, reason: status.reason};
  } catch (error) { return {ready: false, reason: error instanceof Error ? error.message : String(error)}; }
}
async function unchanged(items: Snapshot[]): Promise<void> {
  assertTrusted();
  for (const item of items) {
    if (dirty(item.uri) || !samePath(item.real, await fs.realpath(item.uri.fsPath)) ||
        !item.bytes.equals(await fs.readFile(item.uri.fsPath))) {
      throw new Error('The LaTeX source or macro input changed while preparing setup. Try again.');
    }
  }
}
/**
 * Explicitly prepare a project's macro file and queue an import proposal.
 * The original source is never written here; the queued import still requires Accept.
 */
export async function setupReviewMacros(
  targetUri: vscode.Uri, extensionUri: vscode.Uri, queueImport: (plan: SetupImportPlan) => Promise<void>,
): Promise<vscode.Uri | undefined> {
  assertTrusted();
  const folder = await workspaceFor(targetUri);
  let root = await findRoot(targetUri);
  if (!root) {
    const chosen = await vscode.window.showOpenDialog({
      title: 'Select the root LaTeX document containing \\begin{document}',
      openLabel: 'Select LaTeX root', canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      defaultUri: folder.uri, filters: {'LaTeX files': ['tex', 'ltx']},
    });
    if (!chosen?.[0]) return;
    await workspaceFor(chosen[0]);
    if (!contains(folder.uri.fsPath, chosen[0].fsPath)) throw new Error('Choose a root inside the same workspace as the reviewed file.');
    root = await findRoot(chosen[0]);
    if (!root) throw new Error('The selected file is not a root LaTeX document.');
  }
  const inspection = await inspectRoot(root);
  if (inspection.ready) {
    await vscode.window.showInformationMessage('LaTeX review macros are already loaded. The existing import is unchanged.');
    return root.uri;
  }
  if (inspection.blocked) throw new Error(inspection.reason);
  const macroUri = vscode.Uri.file(path.join(path.dirname(root.uri.fsPath), 'review-macro.tex'));
  const realParent = await fs.realpath(path.dirname(macroUri.fsPath));
  if (!samePath(realParent, path.dirname(macroUri.fsPath))) throw new Error('The macro destination must not use a symbolic link.');
  const bundled = await snapshot(vscode.Uri.joinPath(extensionUri, 'media', 'review-macro.tex'));
  let existing: Snapshot | undefined;
  try {
    const stat = await fs.lstat(macroUri.fsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The existing review-macro.tex must be a regular file, not a symbolic link.');
    existing = await snapshot(macroUri);
    const present = inspectSyntax(uncomment(existing.text)).definitions;
    if (!names.every(name => present.get(name) === 1)) throw new Error('The existing review-macro.tex does not define all three review macros exactly once. It was not overwritten.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const action = await vscode.window.showInformationMessage('Set up LaTeX review macros?', {
    modal: true,
    detail: (existing ? 'Reuse: ' : 'Create: ') + macroUri.fsPath +
      '\n\nPropose adding \\input{review-macro.tex} before \\begin{document} in:\n' + root.uri.fsPath +
      '\n\nThe import is a pending revision request. Your original stays unchanged until you Accept it. Existing macro files are never overwritten.',
  }, 'Set up');
  if (action !== 'Set up') return;
  if (typeof queueImport !== 'function') throw new Error('LaTeX setup requires a pending import proposal handler.');
  await workspaceFor(root.uri);
  await unchanged([...(inspection.snapshots ?? [root]), ...(existing ? [existing] : []), bundled]);
  let created: Awaited<ReturnType<typeof fs.stat>> | undefined;
  let completed = false;
  try {
    if (!existing) {
      await fs.writeFile(macroUri.fsPath, bundled.bytes, {flag: 'wx'});
      created = await fs.lstat(macroUri.fsPath);
    }
    await unchanged(inspection.snapshots ?? [root]);
    await queueImport({
      rootUri: root.uri, original: root.text,
      line: root.text.slice(0, inspection.begin!).split(/\r\n|\r|\n/).length,
      text: '\\input{review-macro.tex}',
    });
    completed = true;
  } finally {
    if (created && !completed) {
      // Clean up only the file this action created, never a replacement or user edit.
      try {
        const current = await fs.lstat(macroUri.fsPath);
        if (current.isFile() && current.dev === created.dev && current.ino === created.ino &&
            current.birthtimeMs === created.birthtimeMs && current.mtimeMs === created.mtimeMs &&
            current.size === created.size && bundled.bytes.equals(await fs.readFile(macroUri.fsPath))) {
          const final = await fs.lstat(macroUri.fsPath);
          if (final.isFile() && final.dev === current.dev && final.ino === current.ino && final.birthtimeMs === current.birthtimeMs &&
              final.mtimeMs === current.mtimeMs && final.size === current.size) await fs.unlink(macroUri.fsPath);
        }
      } catch { /* Keep the macro if its identity or contents can no longer be verified. */ }
    }
  }
  await vscode.window.showInformationMessage('LaTeX review macro import proposed. Accept that import before accepting marked text.');
  return root.uri;
}
