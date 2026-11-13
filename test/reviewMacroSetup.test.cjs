'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const Module = require('node:module');
const {test, before, beforeEach} = require('node:test');
const repo = path.resolve(__dirname, '..');
let scratch, serial = 0, documents = [], prompts = [], choice = 'Set up', chosenRoot, onPrompt;
class Uri {
  constructor(file) { this.fsPath = path.resolve(file); this.scheme = 'file'; this.path = this.fsPath.replaceAll('\\', '/'); }
  toString() { return pathToFileURL(this.fsPath).href; }
  static file(file) { return new Uri(file); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
}
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const vscode = {
  Uri,
  workspace: {
    isTrusted: true, workspaceFolders: [],
    get textDocuments() { return documents; },
    getWorkspaceFolder(uri) { return this.workspaceFolders.find(folder => contains(folder.uri.fsPath, uri.fsPath)); },
  },
  window: {
    async showInformationMessage(message, options, ...items) {
      prompts.push({message, options, items});
      if (options?.modal) { await onPrompt?.(); return choice; }
    },
    async showOpenDialog(options) { prompts.push({dialog: options}); return chosenRoot ? [chosenRoot] : undefined; },
  },
};
const load = Module._load;
Module._load = function(name, parent, main) { return name === 'vscode' ? vscode : load.call(this, name, parent, main); };
require('tsx/cjs');
let setupReviewMacros, inspectReviewMacros;
try { ({setupReviewMacros, inspectReviewMacros} = require('../src/reviewMacroSetup.ts')); }
finally { Module._load = load; }
const extension = Uri.file(repo);
const preamble = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nBody.\n\\end{document}\n';
before(async () => {
  assert.match(await fs.readFile(path.join(repo, '.gitignore'), 'utf8'), /(^|\n)\.codex-\*\//);
  await fs.mkdir(path.join(repo, '.codex-test'), {recursive: true});
  scratch = await fs.mkdtemp(path.join(repo, '.codex-test', 'review-macros-'));
});
beforeEach(() => {
  documents = []; prompts = []; choice = 'Set up'; chosenRoot = undefined; onPrompt = undefined;
  vscode.workspace.isTrusted = true; vscode.workspace.workspaceFolders = [];
});
async function fixture(text = preamble) {
  const dir = path.join(scratch, 'case-' + (++serial));
  await fs.mkdir(dir);
  const root = Uri.file(path.join(dir, 'main.tex'));
  const macro = path.join(dir, 'review-macro.tex');
  await fs.writeFile(root.fsPath, text);
  vscode.workspace.workspaceFolders = [{uri: Uri.file(dir), name: 'fixture'}];
  return {dir, root, macro, text};
}
async function absent(file) { await assert.rejects(fs.stat(file), {code: 'ENOENT'}); }
test('setup creates a bundled macro and queues an import without modifying CRLF/BOM source', async () => {
  const item = await fixture('\uFEFF' + preamble.replaceAll('\n', '\r\n'));
  const plans = [];
  await setupReviewMacros(item.root, extension, async plan => plans.push(plan));
  assert.equal(await fs.readFile(item.root.fsPath, 'utf8'), item.text);
  assert.equal(await fs.readFile(item.macro, 'utf8'), await fs.readFile(path.join(repo, 'media/review-macro.tex'), 'utf8'));
  assert.equal(plans.length, 1); assert.equal(plans[0].line, 3);
  assert.equal(plans[0].text, '\\input{review-macro.tex}'); assert.equal(plans[0].original, item.text);
  assert.equal(plans[0].rootUri.fsPath, item.root.fsPath);
  assert.match(prompts.find(prompt => prompt.options?.modal).options.detail, /pending revision request/);
  assert.equal((await inspectReviewMacros(item.root)).ready, false, 'An unaccepted import is not treated as loaded.');
});
test('a valid existing relative import is reused unchanged without creating another macro', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '\\input{shared/review}\n\\begin{document}'));
  await fs.mkdir(path.join(item.dir, 'shared'));
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), path.join(item.dir, 'shared', 'review.tex'));
  const status = await inspectReviewMacros(item.root);
  assert.equal(status.ready, true);
  await setupReviewMacros(item.root, extension, async () => assert.fail('No proposal needed.'));
  assert.equal(await fs.readFile(item.root.fsPath, 'utf8'), item.text);
  await absent(item.macro);
  assert.equal(prompts.some(prompt => prompt.options?.modal), false);
});
test('a valid absolute shared macro import outside the project remains unchanged', async () => {
  const external = path.join(scratch, 'shared-' + (++serial) + '.tex');
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), external);
  const item = await fixture(preamble.replace('\\begin{document}', '\\input{' + external.replaceAll('\\', '/') + '}\n\\begin{document}'));
  assert.equal((await inspectReviewMacros(item.root)).ready, true);
  await setupReviewMacros(item.root, extension, async () => assert.fail('Existing import must be preserved.'));
  assert.equal(await fs.readFile(item.root.fsPath, 'utf8'), item.text);
  await absent(item.macro);
});
test('TeX root directive finds the parent and keeps fragment unchanged', async () => {
  const item = await fixture();
  const fragment = Uri.file(path.join(item.dir, 'chapter.tex'));
  await fs.writeFile(fragment.fsPath, '% !TeX root = main.tex\nChapter.\n');
  let plan;
  await setupReviewMacros(fragment, extension, async value => { plan = value; });
  assert.equal(plan.rootUri.fsPath, item.root.fsPath); assert.equal(plan.line, 3);
  assert.equal(await fs.readFile(fragment.fsPath, 'utf8'), '% !TeX root = main.tex\nChapter.\n');
});
test('a fragment without root metadata asks for the root, and cancellation writes nothing', async () => {
  const item = await fixture();
  const fragment = Uri.file(path.join(item.dir, 'chapter.tex'));
  await fs.writeFile(fragment.fsPath, 'Chapter.\n');
  await setupReviewMacros(fragment, extension, async () => assert.fail('Cancelled.'));
  await absent(item.macro);
  assert.match(prompts[0].dialog.title, /root LaTeX document/);
  chosenRoot = item.root;
  let count = 0;
  await setupReviewMacros(fragment, extension, async () => count++);
  assert.equal(count, 1);
});
test('existing unimported macro is reused and is never overwritten', async () => {
  const item = await fixture();
  const custom = (await fs.readFile(path.join(repo, 'media/review-macro.tex'), 'utf8')) + '\n% Personal customizations.\n';
  await fs.writeFile(item.macro, custom);
  await setupReviewMacros(item.root, extension, async () => {});
  assert.equal(await fs.readFile(item.macro, 'utf8'), custom);
  assert.match(prompts.find(prompt => prompt.options?.modal).options.detail, /^Reuse:/);
});
test('partial definitions, missing imported files, and ulem option conflicts block duplicate setup', async () => {
  for (const [extra, expected] of [
    ['\\newcommand{\\reviewadd}[1]{#1}\n', /Only some review macros/],
    ['\\input{review-macro.tex}\n', /Cannot inspect preamble input/],
    ['\\usepackage{ulem}\n', /normalem/],
    ['\\input{\\sharedmacro}\n', /dynamic LaTeX input/],
  ]) {
    const item = await fixture(preamble.replace('\\begin{document}', extra + '\\begin{document}'));
    await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), expected);
    assert.equal(await fs.readFile(item.root.fsPath, 'utf8'), item.text);
    await absent(item.macro);
  }
});
test('commented imports and definitions do not count as loaded', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '% \\input{missing}\n% \\newcommand{\\reviewadd}[1]{#1}\n\\begin{document}'));
  const status = await inspectReviewMacros(item.root);
  assert.equal(status.ready, false); assert.match(status.reason, /Set up LaTeX/);
  await setupReviewMacros(item.root, extension, async () => {});
});
test('dirty roots and changed inputs are preserved', async () => {
  const item = await fixture();
  documents = [{uri: item.root, isDirty: true}];
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /Save/);
  await absent(item.macro);
  documents = [];
  onPrompt = async () => { await fs.appendFile(item.root.fsPath, '% User edit.\n'); };
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /changed while preparing/);
  await absent(item.macro);
  assert.equal(await fs.readFile(item.root.fsPath, 'utf8'), item.text + '% User edit.\n');
});
test('cancelled setup, untrusted workspace, or missing callback never creates a macro', async () => {
  const item = await fixture();
  choice = undefined;
  await setupReviewMacros(item.root, extension, async () => assert.fail());
  await absent(item.macro);
  choice = 'Set up'; vscode.workspace.isTrusted = false;
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /Trust/);
  await absent(item.macro);
  vscode.workspace.isTrusted = true;
  await assert.rejects(setupReviewMacros(item.root, extension), /pending import proposal handler/);
  await absent(item.macro);
});
test('failed proposal removes only the exact newly-created macro', async () => {
  const first = await fixture();
  await assert.rejects(setupReviewMacros(first.root, extension, async () => { throw new Error('Proposal failed.'); }), /Proposal failed/);
  await absent(first.macro);
  assert.equal(await fs.readFile(first.root.fsPath, 'utf8'), first.text);
  const second = await fixture();
  await assert.rejects(setupReviewMacros(second.root, extension, async () => {
    await fs.appendFile(second.macro, '% Concurrent user change.\n');
    throw new Error('Proposal failed.');
  }), /Proposal failed/);
  assert.match(await fs.readFile(second.macro, 'utf8'), /Concurrent user change/);
});
test('unsafe root directives are rejected and existing invalid macro files remain untouched', async () => {
  const item = await fixture();
  await fs.writeFile(item.macro, '% Existing unrelated file.\n');
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /does not define all three/);
  assert.equal(await fs.readFile(item.macro, 'utf8'), '% Existing unrelated file.\n');
  const fragment = Uri.file(path.join(item.dir, 'fragment.tex'));
  await fs.writeFile(fragment.fsPath, '% !TeX root = fragment.tex\nText.\n');
  assert.match((await inspectReviewMacros(fragment)).reason, /cycle/);
});

test('nested preamble inputs resolve relative to the root document working directory', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '\\input{shared/preamble}\n\\begin{document}'));
  await fs.mkdir(path.join(item.dir, 'shared'));
  await fs.writeFile(path.join(item.dir, 'shared', 'preamble.tex'), '\\input{review-macro}\n');
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), item.macro);
  assert.equal((await inspectReviewMacros(item.root)).ready, true);
});
test('duplicate imports and modern partial macro definitions are blocked', async () => {
  const duplicate = await fixture(preamble.replace('\\begin{document}', '\\input{review-macro}\n\\input{review-macro}\n\\begin{document}'));
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), duplicate.macro);
  assert.match((await inspectReviewMacros(duplicate.root)).reason, /same input more than once/);
  const modern = await fixture(preamble.replace('\\begin{document}', '\\NewDocumentCommand{\\reviewadd}{m}{#1}\n\\begin{document}'));
  await assert.rejects(setupReviewMacros(modern.root, extension, async () => assert.fail()), /Only some review macros/);
  await absent(modern.macro);
});
test('root selection cannot escape the original workspace', async () => {
  const item = await fixture('A chapter fragment.\n');
  const outside = Uri.file(path.join(scratch, 'outside-root-' + (++serial) + '.tex'));
  await fs.writeFile(outside.fsPath, preamble);
  chosenRoot = outside;
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /inside an open local workspace/);
  await absent(item.macro);
});
test('trust revocation and a concurrent macro creation prevent setup without overwriting anything', async () => {
  const revoked = await fixture();
  onPrompt = async () => { vscode.workspace.isTrusted = false; };
  await assert.rejects(setupReviewMacros(revoked.root, extension, async () => assert.fail()), /Trust/);
  await absent(revoked.macro);
  vscode.workspace.isTrusted = true;
  const concurrent = await fixture();
  onPrompt = async () => { await fs.writeFile(concurrent.macro, '% Added during confirmation.\n'); };
  await assert.rejects(setupReviewMacros(concurrent.root, extension, async () => assert.fail()), {code: 'EEXIST'});
  assert.equal(await fs.readFile(concurrent.macro, 'utf8'), '% Added during confirmation.\n');
});
test('a macro created by someone else is kept after proposal failure', async () => {
  const item = await fixture();
  const macro = await fs.readFile(path.join(repo, 'media/review-macro.tex'), 'utf8');
  await fs.writeFile(item.macro, macro);
  await assert.rejects(setupReviewMacros(item.root, extension, async () => { throw new Error('Proposal failed.'); }), /Proposal failed/);
  assert.equal(await fs.readFile(item.macro, 'utf8'), macro);
});
test('includeonly is not mistaken for an input, while dynamic import helpers require manual inspection', async () => {
  const ordinary = await fixture(preamble.replace('\\begin{document}', '\\includeonly{chapter1}\n\\begin{document}'));
  await setupReviewMacros(ordinary.root, extension, async () => {});
  const dynamic = await fixture(preamble.replace('\\begin{document}', '\\subimport{shared/}{preamble}\n\\begin{document}'));
  await assert.rejects(setupReviewMacros(dynamic.root, extension, async () => assert.fail()), /conditional or imported input/);
});

test('a selected fragment root can be remembered for later read-only capability checks', async () => {
  const item = await fixture();
  const fragment = Uri.file(path.join(item.dir, 'chapter.tex'));
  await fs.writeFile(fragment.fsPath, 'Chapter.\n');
  chosenRoot = item.root;
  let pending;
  const selected = await setupReviewMacros(fragment, extension, async plan => { pending = plan; });
  assert.equal(selected.fsPath, item.root.fsPath);
  assert.equal((await inspectReviewMacros(fragment, selected)).ready, false, 'The queued import still needs Accept.');
  await fs.writeFile(item.root.fsPath, preamble.replace('\\begin{document}', pending.text + '\n\\begin{document}'));
  assert.equal((await inspectReviewMacros(fragment, selected)).ready, true);
  assert.equal((await inspectReviewMacros(fragment)).ready, false, 'Inspection does not silently guess a root.');
  const selectedAgain = await setupReviewMacros(fragment, extension, async () => assert.fail('The import is already ready.'));
  assert.equal(selectedAgain.fsPath, selected.fsPath);
});
test('current explicit TeX root metadata takes precedence over remembered root choices', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '\\input{review-macro}\n\\begin{document}'));
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), item.macro);
  const other = Uri.file(path.join(item.dir, 'other.tex'));
  await fs.writeFile(other.fsPath, preamble);
  const fragment = Uri.file(path.join(item.dir, 'chapter.tex'));
  await fs.writeFile(fragment.fsPath, '% !TeX root = other.tex\nChapter.\n');
  const status = await inspectReviewMacros(fragment, item.root);
  assert.equal(status.rootUri.fsPath, other.fsPath);
  assert.equal(status.ready, false);
  await fs.writeFile(other.fsPath, 'This is not a root.\n');
  const incomplete = await inspectReviewMacros(fragment, item.root);
  assert.equal(incomplete.ready, false, 'A stale fallback must not override an explicit incomplete root.');
});
test('a remembered root outside the target workspace is rejected', async () => {
  const item = await fixture('Fragment.\n');
  const outside = Uri.file(path.join(scratch, 'other-workspace-' + (++serial), 'main.tex'));
  await fs.mkdir(path.dirname(outside.fsPath));
  await fs.writeFile(outside.fsPath, preamble);
  vscode.workspace.workspaceFolders.push({uri: Uri.file(path.dirname(outside.fsPath)), name: 'other'});
  const status = await inspectReviewMacros(item.root, outside);
  assert.equal(status.ready, false);
  assert.match(status.reason, /outside the selected workspace/);
});

test('conditional, local, and deferred review definitions never report ready', async () => {
  const definitions = '\\newcommand{\\reviewadd}[1]{#1}\n\\newcommand{\\reviewdel}[1]{#1}\n\\newcommand{\\reviewdelmath}[1]{#1}\n';
  for (const wrapped of [
    '\\iffalse\n' + definitions + '\\fi\n',
    '\\iftrue\n' + definitions + '\\fi\n',
    '\\begingroup\n' + definitions + '\\endgroup\n',
    '{\n' + definitions + '}\n',
    '\\newcommand{\\unused}{\n' + definitions + '}\n',
    '\\def\\unused{\n' + definitions + '}\n',
    '\\AtBeginDocument{\n' + definitions + '}\n',
    '\\begin{filecontents*}{unused.tex}\n' + definitions + '\\end{filecontents*}\n',
  ]) {
    const item = await fixture(preamble.replace('\\begin{document}', wrapped + '\\begin{document}'));
    const status = await inspectReviewMacros(item.root);
    assert.equal(status.ready, false, wrapped);
    assert.match(status.reason, /manual inspection/i, wrapped);
    await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /manual inspection/i);
    await absent(item.macro);
  }
});
test('scoped, conditional, and deferred inputs are not treated as loaded macros', async () => {
  for (const extra of [
    '\\iffalse\\input{review-macro}\\fi\n',
    '\\begingroup\\input{review-macro}\\endgroup\n',
    '{\\input{review-macro}}\n',
    '\\newcommand{\\unused}{\\input{review-macro}}\n',
  ]) {
    const item = await fixture(preamble.replace('\\begin{document}', extra + '\\begin{document}'));
    await fs.copyFile(path.join(repo, 'media/review-macro.tex'), item.macro);
    const status = await inspectReviewMacros(item.root);
    assert.equal(status.ready, false);
    assert.match(status.reason, /manual inspection/i);
  }
});
test('ordinary macro definitions and conditionals outside review setup remain supported', async () => {
  const extra = '\\newif\\ifdraft\n\\newcommand{\\ordinary}[2][x]{{\\color{blue}#1} #2}\n' +
    '\\NewDocumentCommand{\\modern}{m}{\\textbf{#1}}\n\\def\\custom#1{\\iftrue #1\\fi}\n' +
    '\\iftrue\\relax\\fi\n\\input{review-macro}\n';
  const item = await fixture(preamble.replace('\\begin{document}', extra + '\\begin{document}'));
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), item.macro);
  assert.equal((await inspectReviewMacros(item.root)).ready, true);
});
test('definitions after endinput are not counted as available', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '\\input{partial}\n\\begin{document}'));
  const macro = await fs.readFile(path.join(repo, 'media/review-macro.tex'), 'utf8');
  await fs.writeFile(path.join(item.dir, 'partial.tex'), '\\endinput\n' + macro);
  assert.equal((await inspectReviewMacros(item.root)).ready, false);
});
test('ulem option conflicts remain blocked even when all macro names are present', async () => {
  const item = await fixture(preamble.replace('\\begin{document}', '\\usepackage{ulem}\n\\input{review-macro}\n\\begin{document}'));
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), item.macro);
  const status = await inspectReviewMacros(item.root);
  assert.equal(status.ready, false);
  assert.match(status.reason, /normalem/);
  await assert.rejects(setupReviewMacros(item.root, extension, async () => assert.fail()), /normalem/);
});
test('automatic import requires a standalone begin-document line, while existing imports still inspect', async () => {
  const unsafe = await fixture('\\documentclass{article}\\begin{document}\nBody.\n\\end{document}\n');
  await assert.rejects(setupReviewMacros(unsafe.root, extension, async () => assert.fail()), /own line/);
  await absent(unsafe.macro);
  const ready = await fixture('\\documentclass{article}\\input{review-macro}\\begin{document}\nBody.\n\\end{document}\n');
  await fs.copyFile(path.join(repo, 'media/review-macro.tex'), ready.macro);
  assert.equal((await inspectReviewMacros(ready.root)).ready, true);
});
