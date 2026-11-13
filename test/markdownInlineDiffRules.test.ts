import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMarkdownRules} from '../src/markdownInlineDiffRules';
import type {InlineDiffRules, InlineTokenization} from '../src/inlineDiffRules';

const markdown = createMarkdownRules(() => undefined);
const values = (result: InlineTokenization) => result.tokens.map(token => token.text);
function exact(text: string, result: InlineTokenization) {
  let end = 0, restored = '';
  for (const token of result.tokens) {
    assert.ok(token.start >= end && token.end > token.start);
    assert.match(text.slice(end, token.start), /^\s*$/u);
    assert.equal(token.text, text.slice(token.start, token.end));
    assert.match(token.text, /\S/u);
    restored += text.slice(end, token.start) + token.text; end = token.end;
  }
  assert.match(text.slice(end), /^\s*$/u);
  assert.equal(restored + text.slice(end), text);
}

test('Markdown prose keeps words whole while separating unchanged markup', () => {
  for (const [text, expected] of [
    ['**old title**', ['**', 'old', 'title', '**']],
    ['# Heading with _old words_', ['#', 'Heading', 'with', '_', 'old', 'words', '_']],
    ['Keep first_name intact.', ['Keep', 'first_name', 'intact.']],
    ['~~old title~~', ['~~', 'old', 'title', '~~']],
    ['[old title](https://example.test/a_(b))', ['[', 'old', 'title', ']', '(', 'https://example.test/a_(b)', ')']],
    ['![old image](image.png)', ['!', '[', 'old', 'image', ']', '(', 'image.png', ')']],
    ['\\*literal\\*', ['\\*', 'literal', '\\*']],
    ['<em>old words</em>', ['<', 'em', '>', 'old', 'words', '<', '/em', '>']],
  ] as const) {
    const result = markdown.tokenize(text); assert.deepEqual(values(result), expected); exact(text, result);
  }
});

test('Markdown inline code keeps literal whitespace words and backtick delimiters separate', () => {
  for (const [text, expected] of [
    ['Use `first_name(x)` here.', ['Use', '`', 'first_name(x)', '`', 'here.']],
    ['Use ``a`b *c*`` here.', ['Use', '``', 'a`b', '*c*', '``', 'here.']],
    ['`**literal**` then **bold**', ['`', '**literal**', '`', 'then', '**', 'bold', '**']],
  ] as const) {
    const result = markdown.tokenize(text); assert.deepEqual(values(result), expected); exact(text, result);
  }
  const tokenizer = markdown.createTokenizer!();
  assert.deepEqual(values(tokenizer.tokenize('`first')), ['`', 'first']);
  assert.deepEqual(values(tokenizer.tokenize('**literal**` tail')), ['**', 'literal', '**', '`', 'tail']);
  tokenizer.tokenize('`unfinished');
  assert.deepEqual(values(tokenizer.tokenize('**new paragraph**')), ['**', 'new', 'paragraph', '**']);
});

test('Markdown known fences delegate to a fresh stateful language tokenizer', () => {
  const visited: Array<{instance: number; text: string}> = []; let count = 0;
  const code: InlineDiffRules = {
    tokenize: () => {throw new Error('Use a persistent delegate when available');},
    createTokenizer() {
      const instance = ++count;
      return {tokenize(text) {
        visited.push({instance, text});
        return {tokens: Array.from(text.matchAll(/\w+|[^\s\w]/gu), match =>
          ({text: match[0], start: match.index!, end: match.index! + match[0].length})), groups: []};
      }};
    }
  };
  const labels: string[] = [];
  const tokenizer = createMarkdownRules(label => {labels.push(label); return label === 'python' ? code : undefined;}).createTokenizer!();
  tokenizer.tokenize('   ```PyThOn extra-info');
  for (const line of ['x+1', '', '# comment', '``` too early', '``', '~~~~']) exact(line, tokenizer.tokenize(line));
  assert.equal(visited.length, 6); assert.ok(visited.every(item => item.instance === 1));
  assert.deepEqual(values(tokenizer.tokenize('   ````  ')), ['````']);
  assert.deepEqual(values(tokenizer.tokenize('**prose**')), ['**', 'prose', '**']);
  tokenizer.tokenize('~~~python'); tokenizer.tokenize('y+2'); tokenizer.tokenize('~~~~');
  assert.equal(visited.at(-1)!.instance, 2); assert.deepEqual(labels, ['python', 'python']);
});

test('Markdown unknown and unlabelled fences remain literal with exact closing rules', () => {
  for (const opener of ['```unknown', '```', '~~~']) {
    const tokenizer = markdown.createTokenizer!(); tokenizer.tokenize(opener);
    assert.deepEqual(values(tokenizer.tokenize('**old** a[i+1]')), ['**old**', 'a[i+1]']);
    assert.deepEqual(values(tokenizer.tokenize(opener[0]!.repeat(3) + ' still-code')), [opener[0]!.repeat(3), 'still-code']);
    tokenizer.tokenize(opener[0]!.repeat(4));
    assert.deepEqual(values(tokenizer.tokenize('**prose**')), ['**', 'prose', '**']);
  }
});

test('Markdown malformed input and Unicode preserve every code point and whitespace gap', () => {
  for (const text of [
    '[label](unclosed', '[a](one\\)two)', '```bad`info', '    ```python',
    '\t**indented code**', '*e\u0301clair* 한글😀', '😀[word](a_(b))',
    '```', '\\😀 **글자**', 'a\u00a0**b**\tc', '~~'.repeat(1000), '_'.repeat(1000),
    '[x](' + '('.repeat(1000) + 'a' + ')'.repeat(1001),
  ]) exact(text, markdown.tokenize(text));
  let calls = 0;
  const tokenizer = createMarkdownRules(() => {calls++; return undefined;}).createTokenizer!();
  tokenizer.tokenize('    ```python'); tokenizer.tokenize('```bad`info');
  assert.equal(calls, 0, 'Indented code and backtick info strings do not open fences');
});
