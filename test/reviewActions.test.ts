import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyReviewAction, getReviewActions, type ReviewActionInput} from '../src/reviewActions';
const input = (before: string, after: string, path = 'paper.tex', prefix = ''): ReviewActionInput => ({before,after,path,prefix});
const run = (before: string, after: string, path = 'paper.tex', prefix = '') =>
  applyReviewAction(input(before,after,path,prefix), 'comment');

test('one action preserves complete original TeX lines and leaves the proposed text active', () => {
  const before = 'The value is old.', after = 'The value is new.';
  assert.equal(run(before,after), '% The value is old.\nThe value is new.');
  assert.deepEqual(getReviewActions(input(before,after)), [{id:'comment',label:'Keep original as comments',enabled:true}]);
  const multiline = '\\begin{align}\nx &= 2 \\\\\ny &= 4\n\\end{align}';
  assert.equal(run(multiline, 'x = 3'), '% \\begin{align}\n% x &= 2 \\\\\n% y &= 4\n% \\end{align}\nx = 3');
});

test('Python keeps original indentation, blank lines, comments, and trailing spaces', () => {
  assert.equal(run('    print(1)  \n\n    # explanation', '    print(2)', 'main.py'),
    '    # print(1)  \n#\n    # # explanation\n    print(2)');
  assert.equal(run('\told\n  ', '\tnew\n\n', 'main.py'), '\t# old\n  #\n\tnew\n\n');
});

test('code and JSONC use slash comments; strict JSON and unknown languages stay disabled', () => {
  for (const path of ['a.ts','a.js','a.cpp','a.jsonc']) assert.equal(run('  old', '  value', path), '  // old\n  value');
  for (const path of ['a.json','a.yaml','a.txt']) {
    const actions = getReviewActions(input('old','new',path));
    assert.equal(actions.length,1);
    assert.equal(actions[0]!.enabled,false);
    assert.match(actions[0]!.reason!,/supported comment/);
  }
});

test('pure insertions are unavailable; deletions retain the original as comments', () => {
  assert.throws(() => run('', 'new'), /no original lines/);
  assert.equal(getReviewActions(input('', 'new'))[0]!.enabled,false);
  assert.equal(run('old\nsecond',''), '% old\n% second');
  assert.equal(run('   ','new'), '   %\nnew');
});

test('the original-line flag distinguishes an original blank line from an insertion', () => {
  assert.equal(applyReviewAction({...input('','new'),hasOriginal:true},'comment'), '%\nnew');
  assert.equal(applyReviewAction({...input('','', 'a.py'),hasOriginal:true},'comment'), '#');
  assert.throws(() => applyReviewAction({...input('','new'),hasOriginal:false},'comment'), /no original lines/);
  assert.throws(() => applyReviewAction({...input('old','new'),hasOriginal:'yes' as any},'comment'), /boolean/);
});

test('a repeated action refuses to duplicate the exact original comment prefix', () => {
  for (const path of ['a.tex','a.py','a.ts','a.md']) {
    const after = run('old\nsecond','new',path);
    assert.throws(() => run('old\nsecond',after,path), /already preserved/);
    assert.equal(getReviewActions(input('old\nsecond',after,path))[0]!.enabled,false);
    const deleted = run('old','',path);
    assert.throws(() => run('old',deleted,path), /already preserved/);
  }
});

test('the proposed text, including existing source markup, remains byte-for-byte unchanged', () => {
  const after = String.raw`\reviewdel{previous}\reviewadd{proposed}` + '\n  \n';
  assert.equal(run(String.raw`\reviewadd{old}`,after), '% \\reviewadd{old}\n' + after);
  assert.equal(run('old','new\n\n'), '% old\nnew\n\n');
});

test('partial lines, open strings and comments, and preceding continuations are refused', () => {
  for (const [path,prefix] of [
    ['main.py','value = """\n'], ['main.py','value = \\\n'],
    ['main.ts','const s = \u0060\n'], ['main.ts','/* unfinished\n']
  ]) assert.throws(() => run('old','new',path,prefix), /inside|continues/);
  assert.throws(() => run('old','new','main.py','value = '), /complete lines/);
  assert.equal(run('old','new','main.py','value = """done"""\n'), '# old\nnew');
});

test('retained proposed multiline string and block-comment boundaries need not end inside the block', () => {
  for (const [path,before,after] of [
    ['a.py','value = """old','value = """new'],
    ['a.ts','const value = \u0060old','const value = \u0060new'],
    ['a.ts','/* old','/* new'],
    ['a.cpp','auto value = R"tag(old','auto value = R"tag(new']
  ]) {
    const marker = path!.endsWith('.py') ? '#' : '//';
    assert.equal(run(before!,after!,path), marker + ' ' + before + '\n' + after);
  }
  assert.equal(run('text = """\nhello\n"""','text = "new"','main.py'), '# text = """\n# hello\n# """\ntext = "new"');
});

test('raw, verbatim, and text-block strings remain protected at the insertion boundary', () => {
  for (const [path,prefix] of [
    ['a.cpp','auto text = R"delimiter(contains " quote\n'],
    ['a.cs','var text = @"contains "" quote\n'],
    ['a.cs','var text = """contains " quote\n'],
    ['a.java','String text = """\ncontains " quote\n'],
    ['a.rs','let text = r#"contains " quote\n'],
    ['a.swift','let text = #"contains " quote\n'],
    ['a.go','text := \u0060contains " quote\n']
  ]) assert.throws(() => run('old','new',path,prefix), /string/);
  assert.equal(run('old','new','a.cpp','auto text = R"del(complete " quote)del";\n'), '// old\nnew');
  assert.equal(run('old','new','a.rs','fn value<\'a>() {\n'), '// old\nnew');
});

test('commented C and C++ originals cannot splice the proposed line into a comment', () => {
  for (const path of ['a.c','a.h','a.cpp','a.hpp']) {
    for (const before of ['old \\', 'old \\  ', 'old ??/', 'old ??/\t'])
      assert.throws(() => run(before,'new',path), /continuation/);
    assert.throws(() => run('old','new',path,'previous ??/\n'), /continues/);
  }
  assert.equal(run('old \\', 'new', 'a.ts'), '// old \\\nnew');
  assert.equal(run('old \\\nsecond','new','a.cpp'), '// old \\\n// second\nnew');
});

test('Unicode line endings cannot terminate generated comments in the middle of an original line', () => {
  for (const separator of ['\u2028','\u2029'])
    assert.throws(() => run('old' + separator + 'active','new','a.ts'), /Unicode line separators/);
  for (const before of [String.raw`old \u000a active`,String.raw`old \uu000D active`])
    assert.throws(() => run(before,'new','a.java'), /Unicode newline/);
});

test('TeX comments work in math and ordinary groups while active proposal boundaries remain intact', () => {
  assert.equal(run('  x = 2','  x = 3','a.tex','\\begin{equation}\n'), '  % x = 2\n  x = 3');
  assert.equal(run('old','new','a.tex','\\textbf{\n'), '% old\nnew');
  for (const [before,after] of [
    ['\\begin{equation}\nx = 2','\\begin{equation}\nx = 3'],
    ['\\textbf{old','\\textbf{new'],
    ['old}','new}'],
    ['x = 2\n\\end{equation}','x = 3\n\\end{equation}']
  ]) {
    const prefix = before!.includes('end{equation}') ? '\\begin{equation}\n' : before === 'old}' ? '\\textbf{\n' : '';
    assert.equal(run(before!,after!,'a.tex',prefix), before!.split('\n').map(line => '% ' + line).join('\n') + '\n' + after);
  }
});

test('literal TeX environments and altered comment catcodes remain unavailable', () => {
  for (const prefix of ['\\begin{verbatim}\n','\\begin{BVerbatim}\n','\\begin{LVerbatim}\n','\\begin{lstlisting}\n','\\begin{minted}{python}\n','\\verb|unfinished\n','\\catcode`\\%=12\n'])
    assert.throws(() => run('old','new','a.tex',prefix), /TeX context/);
  assert.equal(run('old','new','a.tex','\\begin{verbatim}\n$$ { \\def\n\\end{verbatim}\n'), '% old\nnew');
});

test('completed macro definitions do not execute literal-looking TeX commands during inspection', () => {
  for (const prefix of ['\\newcommand{\\start}{\\begin{verbatim}}\n','\\def\\start{\\begin{verbatim}}\n'])
    assert.equal(run('old','new','a.tex',prefix), '% old\nnew');
});

test('Markdown preserves original plain text in an HTML comment and leaves new Markdown untouched', () => {
  assert.equal(run('Old paragraph\nnext line','New paragraph','a.md'), '<!--\nOld paragraph\nnext line\n-->\nNew paragraph');
  assert.equal(run('Old paragraph','<div>new</div>\n\u0060\u0060\u0060js\ncode','a.md'),
    '<!--\nOld paragraph\n-->\n<div>new</div>\n\u0060\u0060\u0060js\ncode');
  assert.equal(run('Old paragraph','','a.md'), '<!--\nOld paragraph\n-->');
});

test('Markdown comments are refused inside literal contexts or for unsafe original comment bodies', () => {
  for (const prefix of ['\u0060\u0060\u0060python\n','<!--\n','<pre>\n','before \u0060code\n','before \u0060code\ncontinued\n','\u0060\u0060\u0060js\n\u0060\u0060\u0060 not a closer\n'])
    assert.throws(() => run('old','new','a.md',prefix), /plain Markdown/);
  for (const before of ['    code','a --> b','<tag>','\u0060code\u0060','~~~'])
    assert.throws(() => run(before,'new','a.md'), /plain Markdown/);
  assert.equal(run('old','new','a.md','\u0060\u0060\u0060js\ncode\n\u0060\u0060\u0060\n'), '<!--\nold\n-->\nnew');
});

test('actions do not mutate their input and reject invalid input or obsolete actions', () => {
  const proposal = Object.freeze(input('old','new'));
  assert.equal(applyReviewAction(proposal,'comment'), '% old\nnew');
  assert.equal(proposal.after,'new');
  for (const action of ['markAdded','markRemoved','oops'])
    assert.throws(() => applyReviewAction(proposal,action as any), /Unknown/);
  for (const before of ['old\r\nline','old\0line'])
    assert.throws(() => run(before,'new'), /LF line endings/);
});

test('an active blank proposed line remains distinct from a deletion', () => {
  assert.equal(applyReviewAction({...input('old',''),hasProposed:true},'comment'), '% old\n');
  assert.equal(applyReviewAction({...input('old',''),hasProposed:false},'comment'), '% old');
  assert.equal(applyReviewAction({...input('old','new'),hasProposed:false},'comment'), '% old\nnew');
  assert.throws(() => applyReviewAction({...input('old',''),hasProposed:1 as any},'comment'), /boolean/);
});