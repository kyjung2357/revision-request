import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyReviewAction, getReviewActions, type ReviewActionInput} from '../src/reviewActions';
const input = (before: string, after: string, path = 'paper.tex', prefix = ''): ReviewActionInput => ({before,after,path,prefix});
const run = (before: string, after: string, action: 'comment'|'markRemoved'|'markAdded', path = 'paper.tex', prefix = '') =>
  applyReviewAction(input(before,after,path,prefix),action);
test('TeX text keeps unchanged wording and composes red removal with blue addition in either order', () => {
  const before = 'The value is old.', after = 'The value is new.';
  assert.equal(run(before,after,'markRemoved'),String.raw`The value is \reviewdel{old}new.`);
  assert.equal(run(before,after,'markAdded'),String.raw`The value is \reviewadd{new}.`);
  const red = run(before,after,'markRemoved'), blue = run(before,after,'markAdded');
  const both = String.raw`The value is \reviewdel{old}\reviewadd{new}.`;
  assert.equal(run(before,red,'markAdded'),both);
  assert.equal(run(before,blue,'markRemoved'),both);
  assert.equal(getReviewActions(input(before,both)).find(option => option.id === 'markAdded')!.enabled,false);
  assert.equal(getReviewActions(input(before,both)).find(option => option.id === 'markRemoved')!.enabled,false);
});
test('TeX chooses text versus math deletion and preserves whole commands', () => {
  assert.equal(run(String.raw`Let \(\alpha = 2\).`,String.raw`Let \(\beta = 3\).`,'markRemoved'),
    String.raw`Let \(\reviewdelmath{\alpha}\beta = \reviewdelmath{2}3\).`);
  assert.equal(run(String.raw`\alpha + x`,String.raw`\beta + x`,'markAdded','paper.tex','\\begin{equation}\n'),
    String.raw`\reviewadd{\beta} + x`);
});
test('changed coefficients inside complete fraction and formatting arguments stay local', () => {
  assert.equal(run(String.raw`\frac{1}{2}`,String.raw`\frac{1}{3}`,'markAdded','paper.tex','\\[\n'),
    String.raw`\frac{1}{\reviewadd{3}}`);
  assert.equal(run(String.raw`\textbf{old word}`,String.raw`\textbf{new word}`,'markRemoved'),
    String.raw`\textbf{\reviewdel{old}new word}`);
});
test('new plain text paragraphs use one macro per physical line', () => {
  assert.equal(run('','First line\n\nSecond line','markAdded'),
    String.raw`\reviewadd{First line}` + '\n\n' + String.raw`\reviewadd{Second line}`);
  assert.equal(run('First line\nSecond line','','markRemoved'),
    String.raw`\reviewdel{First line` + '\n}' + String.raw`\reviewdel{Second line}`);
});
test('simple math additions inside unchanged display environments are supported', () => {
  assert.equal(run('\\[\nx = 2\n\\]','\\[\nx = 3\n\\]','markAdded'), '\\[\nx = \\reviewadd{3}\n\\]');
});
test('unsafe TeX changes are disabled instead of wrapping environments, labels, or delimiters', () => {
  for (const [before,after] of [
    ['', '\\begin{align}\nx &= y \\\\\n\\end{align}'],
    ['\\label{old}','\\label{new}'],
    ['\\frac12','\\frac34'],
    ['x','x & y'],
    ['x','\\(x\\)'],
    ['x','{x'],
    ['x','\\left(x\\right)']
  ]) {
    assert.throws(() => run(before!,after!,'markAdded'), Error, JSON.stringify(after));
  }
  assert.equal(getReviewActions(input('x','y','paper.tex','\\textbf{\n')).find(option => option.id === 'markAdded')!.enabled,false);
});
test('original or manually modified review markup is preserved by declining further automatic transforms', () => {
  assert.throws(() => run(String.raw`\reviewadd{old}`,'new','markAdded'),/already contains/);
  assert.throws(() => run('old',String.raw`\reviewadd{unrelated}new`,'markRemoved'),/not generated/);
  assert.throws(() => run('old',String.raw`\reviewadd{new`,'markRemoved'),/incomplete/);
});
test('Python comments each proposed line and keeps indentation and blank lines', () => {
  assert.equal(run('old','    print(1)\n\n    print(2)','comment','main.py'),'    # print(1)\n\n    # print(2)');
  assert.equal(run('old','  # existing\n  call()','comment','main.py'),'  # existing\n  # call()');
});
test('comment actions reject partial lines and strings or block comments already open above the hunk', () => {
  for (const [path,prefix] of [['main.py','value = """\n'],['main.py','value = \\\n'],['main.ts','const s = \u0060\n'],['main.ts','/* unfinished\n']]) {
    assert.throws(() => run('old','new','comment',path,prefix),/inside|continues/);
  }
  assert.throws(() => run('old','new','comment','main.py','value = '),/complete lines/);
  assert.equal(run('old','new','comment','main.py','value = """done"""\n'),'# new');
});
test('complete multiline strings that start within the selected block can be commented together', () => {
  assert.equal(run('old','text = """\nhello\n"""','comment','main.py'),'# text = """\n# hello\n# """');
});
test('code and JSONC use slash comments; strict JSON does not acquire unsupported markup', () => {
  for (const path of ['a.ts','a.js','a.cpp','a.jsonc']) assert.equal(run('old','  value','comment',path),'  // value');
  for (const path of ['a.json','a.yaml','a.txt']) assert.equal(getReviewActions(input('old','new',path)).every(option => !option.enabled),true);
});
test('non-TeX languages expose but disable red and blue markup with a reason', () => {
  for (const path of ['a.py','a.ts','a.md','a.jsonc']) {
    const actions = getReviewActions(input('old','new',path));
    assert.equal(actions.length,3);
    assert.equal(actions[1]!.enabled,false);
    assert.match(actions[1]!.reason!,/LaTeX/);
  }
});
test('TeX commenting works in math but is disabled inside literal environments', () => {
  assert.equal(run('old','  x = 2','comment','a.tex','\\begin{equation}\n'),'  % x = 2');
  assert.throws(() => run('old','x','comment','a.tex','\\begin{verbatim}\n'),/TeX context/);
});
test('Markdown HTML comments are restricted to plain text', () => {
  assert.equal(run('old','New paragraph\nnext line','comment','a.md'),'<!--\nNew paragraph\nnext line\n-->');
  for (const [prefix,after] of [['\u0060\u0060\u0060python\n','print(1)'],['<!--\n','new'],['','    code'],['','a --> b'],['','<tag>'],['','\u0060code\u0060']]) {
    assert.throws(() => run('old',after,'comment','a.md',prefix),/plain Markdown/);
  }
});
test('pure insertion and deletion expose only the meaningful markup direction', () => {
  assert.equal(getReviewActions(input('','new'))[1]!.enabled,false);
  assert.equal(getReviewActions(input('old',''))[2]!.enabled,false);
  assert.equal(getReviewActions(input('old',''))[0]!.enabled,false);
  assert.equal(getReviewActions(input('same','same')).slice(1).every(option => !option.enabled),true);
});
test('actions never mutate the supplied input and reject unknown actions', () => {
  const proposal = Object.freeze(input('old','new'));
  assert.equal(applyReviewAction(proposal,'markAdded'),String.raw`\reviewadd{new}`);
  assert.equal(proposal.after,'new');
  assert.throws(() => applyReviewAction(proposal,'oops' as any),/Unknown/);
});


test('changed bare and braced scripts keep both old and new values inside the same script argument', () => {
  for (const [before,after,expected] of [
    ['x^2','x^3',String.raw`x^{\reviewdelmath{2}\reviewadd{3}}`],
    ['x_i','x_j',String.raw`x_{\reviewdelmath{i}\reviewadd{j}}`],
    ['x^{2}','x^{3}',String.raw`x^{\reviewdelmath{2}\reviewadd{3}}`],
    [String.raw`x_\alpha`,String.raw`x_\beta`,String.raw`x_{\reviewdelmath{\alpha}\reviewadd{\beta}}`]
  ]) {
    const red = run(before!,after!,'markRemoved','a.tex','\\[\n');
    assert.equal(run(before!,red,'markAdded','a.tex','\\[\n'),expected);
    const blue = run(before!,after!,'markAdded','a.tex','\\[\n');
    assert.equal(run(before!,blue,'markRemoved','a.tex','\\[\n'),expected);
  }
  assert.throws(() => run('x','x^2','markAdded','a.tex','\\[\n'),/script/);
});
test('text arguments inside math use text deletion rather than a mathchoice', () => {
  assert.equal(run(String.raw`\text{old}`,String.raw`\text{new}`,'markRemoved','a.tex','\\[\n'),
    String.raw`\text{\reviewdel{old}new}`);
  assert.equal(run(String.raw`\operatorname{old}`,String.raw`\operatorname{new}`,'markRemoved','a.tex','\\[\n'),
    String.raw`\reviewdelmath{\operatorname{old}}\operatorname{new}`);
});
test('unchanged align environment and row boundaries remain outside markup', () => {
  const before = '\\begin{align}\nx &= 2 \\\\\ny &= 4\n\\end{align}';
  const after = '\\begin{align}\nx &= 3 \\\\\ny &= 5\n\\end{align}';
  assert.equal(run(before,after,'markAdded'),'\\begin{align}\nx &= \\reviewadd{3} \\\\\ny &= \\reviewadd{5}\n\\end{align}');
});
test('ordinary macro definitions and a completed verbatim environment do not leak math modes', () => {
  for (const prefix of [
    '\\newcommand{\\startmath}{\\(}\n',
    '\\def\\startmath{\\(}\n',
    '\\begin{verbatim}\n$$ { \\def\n\\end{verbatim}\n'
  ]) assert.equal(run('old','new','markRemoved','a.tex',prefix),String.raw`\reviewdel{old}new`);
});
test('C-family raw, verbatim, and text-block strings do not receive line-comment markers internally', () => {
  for (const [path,prefix] of [
    ['a.cpp','auto text = R"delimiter(contains " quote\n'],
    ['a.cs','var text = @"contains "" quote\n'],
    ['a.cs','var text = """contains " quote\n'],
    ['a.java','String text = """\ncontains " quote\n']
  ]) assert.throws(() => run('old','new','comment',path,prefix),/string/);
  assert.equal(run('old','new','comment','a.cpp','auto text = R"del(complete " quote)del";\n'),'// new');
});
test('deeply nested TeX fails within the explicit nesting limit', () => {
  assert.throws(() => run('x','{'.repeat(100)+'y'+'}'.repeat(100),'markAdded'),/nesting/);
});


test('math coefficients do not include the unchanged variable in markup', () => {
  const before = 'a = 2x', after = 'a = 3x';
  assert.equal(run(before,after,'markAdded','a.tex','\\[\n'),String.raw`a = \reviewadd{3}x`);
  assert.equal(run(before,after,'markRemoved','a.tex','\\[\n'),String.raw`a = \reviewdelmath{2}3x`);
});
test('sequential actions do not retain removed spaces or line breaks in the clean proposal', () => {
  for (const [before,after] of [
    ['The old value','The value'],
    ['First old line\nSecond old line','New line'],
    ['A\nremoved\nB','A\nB'],
    ['old\n\ntext','new\ntext'],
    ['x = 2\nz = 4','x = 3']
  ]) {
    const red = run(before!,after!,'markRemoved');
    const directBlue = getReviewActions(input(before!,after!)).find(action => action.id === 'markAdded')!;
    if (!directBlue.enabled) continue;
    const blue = run(before!,after!,'markAdded');
    assert.equal(run(before!,red,'markAdded'),run(before!,blue,'markRemoved'),JSON.stringify([before,after]));
  }
});


test('commenting cannot remove a string or block opener while its closer remains outside the block', () => {
  for (const [path,after] of [
    ['a.py','value = """'],
    ['a.ts','const value = \u0060hello'],
    ['a.ts','/* opening comment'],
    ['a.cpp','auto value = R"tag('],
    ['a.py','value = \\']
  ]) assert.throws(() => run('old',after!,'comment',path),/complete block/);
  assert.equal(run('old','/* whole comment */\ncall()','comment','a.ts'),'// /* whole comment */\n// call()');
});
test('TeX comments keep group and environment boundaries outside the selected block intact', () => {
  assert.throws(() => run('old','\\begin{equation}\nx = 2','comment'),/complete TeX/);
  assert.throws(() => run('old','\\textbf{new','comment'),/complete TeX/);
  assert.equal(run('old','\\begin{equation}\nx = 2\n\\end{equation}','comment'),'% \\begin{equation}\n% x = 2\n% \\end{equation}');
});


test('dimension, counter, and unknown macro arguments are never rewritten as markup text', () => {
  for (const [before,after] of [
    [String.raw`\hspace{1cm}`,String.raw`\hspace{2cm}`],
    [String.raw`\setlength{\parindent}{1pt}`,String.raw`\setlength{\parindent}{2pt}`],
    [String.raw`\custommacro{old}`,String.raw`\custommacro{new}`],
    [String.raw`\oldmacro`,String.raw`\newmacro`]
  ]) {
    assert.throws(() => run(before!,after!,'markAdded'));
    assert.throws(() => run(before!,after!,'markRemoved'));
  }
  assert.equal(run(String.raw`\hspace{1cm} old`,String.raw`\hspace{1cm} new`,'markAdded'),
    String.raw`\hspace{1cm} \reviewadd{new}`);
});
test('ensuremath arguments receive math markup even outside an enclosing math environment', () => {
  const before = String.raw`\ensuremath{a}`, after = String.raw`\ensuremath{b}`;
  assert.equal(run(before,after,'markRemoved'),String.raw`\ensuremath{\reviewdelmath{a}b}`);
  assert.equal(run(before,run(before,after,'markRemoved'),'markAdded'),
    String.raw`\ensuremath{\reviewdelmath{a}\reviewadd{b}}`);
});


test('delimiter-size commands and style declarations are not wrapped away from their effects', () => {
  for (const [before,after] of [
    [String.raw`\bigl(x\bigr)`,String.raw`\Bigl(x\Bigr)`],
    ['x',String.raw`\displaystyle x`],
    ['Text',String.raw`\bfseries Text`],
    [String.raw`\foo x`,String.raw`\barcommand x`]
  ]) {
    assert.throws(() => run(before!,after!,'markAdded','a.tex','\\[\n'));
  }
});


test('operatorname stays atomic so its removed label receives a math strikethrough', () => {
  const before = String.raw`\operatorname{min}(x)`, after = String.raw`\operatorname{max}(x)`;
  const red = run(before,after,'markRemoved','a.tex','\\[\n');
  assert.equal(red,String.raw`\reviewdelmath{\operatorname{min}}\operatorname{max}(x)`);
  const both = String.raw`\reviewdelmath{\operatorname{min}}\reviewadd{\operatorname{max}}(x)`;
  assert.equal(run(before,red,'markAdded','a.tex','\\[\n'),both);
  const blue = run(before,after,'markAdded','a.tex','\\[\n');
  assert.equal(run(before,blue,'markRemoved','a.tex','\\[\n'),both);
});

