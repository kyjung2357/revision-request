import test from 'node:test';
import assert from 'node:assert/strict';
import {pythonRules, javascriptRules, jsonRules} from '../src/codeInlineDiffRules';
import type {InlineTokenization} from '../src/inlineDiffRules';

function contents(result: InlineTokenization, source: string) {
  let end = 0;
  for (const token of result.tokens) {
    assert.ok(token.start >= end && token.end > token.start);
    assert.equal(token.text, source.slice(token.start, token.end));
    assert.match(source.slice(end, token.start), /^\s*$/u, 'Only whitespace may be omitted between tokens');
    end = token.end;
  }
  assert.match(source.slice(end), /^\s*$/u);
  assert.deepEqual(result.groups, [], 'Code rules never expand unchanged brackets');
  return result.tokens.map(token => token.text);
}
function tokens(rules: typeof pythonRules, text: string) { return contents(rules.tokenize(text), text); }

test('Python identifiers, numeric literals, longest operators and punctuation are separate whole units', () => {
  assert.deepEqual(tokens(pythonRules, 'total += item["price"] * 0.95'), ['total', '+=', 'item', '[', '"', 'price', '"', ']', '*', '0.95']);
  assert.deepEqual(tokens(pythonRules, 'a[i+1] <= first_name **= 0xFF'), ['a', '[', 'i', '+', '1', ']', '<=', 'first_name', '**=', '0xFF']);
  assert.deepEqual(tokens(pythonRules, '1_000 1.25e-3 .5 2j 0b_101 0o_77'), ['1_000', '1.25e-3', '.5', '2j', '0b_101', '0o_77']);
  assert.deepEqual(tokens(pythonRules, '한글_이름 = cafe\u0301 + 😀'), ['한글_이름', '=', 'cafe\u0301', '+', '😀']);
});

test('Python string and comment words do not become code operators', () => {
  assert.deepEqual(tokens(pythonRules, 'value = "load old x+y" # keep first_name x-y'), ['value', '=', '"', 'load', 'old', 'x+y', '"', '#', 'keep', 'first_name', 'x-y']);
  assert.deepEqual(tokens(pythonRules, String.raw`"old\nnew\u0061\N{GREEK SMALL LETTER ALPHA}"`), ['"', 'old', String.raw`\n`, 'new', String.raw`\u0061`, String.raw`\N{GREEK SMALL LETTER ALPHA}`, '"']);
  assert.deepEqual(tokens(pythonRules, String.raw`r"old\nnew"`), ['r', '"', String.raw`old\nnew`, '"']);
  assert.deepEqual(tokens(pythonRules, String.raw`r"say\"hello"`), ['r', '"', String.raw`say\"hello`, '"']);
});

test('Python f-strings separate literal words, expressions, conversions and format fields', () => {
  assert.deepEqual(tokens(pythonRules, 'f"Hello {user.name}, {x+y!r:>10}"'), ['f', '"', 'Hello', '{', 'user', '.', 'name', '}', ',', '{', 'x', '+', 'y', '!', 'r', ':', '>10', '}', '"']);
  assert.deepEqual(tokens(pythonRules, 'f"{value:.{digits}f}"'), ['f', '"', '{', 'value', ':', '.', '{', 'digits', '}', 'f', '}', '"']);
  assert.deepEqual(tokens(pythonRules, 'f"{{literal}} {data[\'key\']}"'), ['f', '"', '{{', 'literal', '}}', '{', 'data', '[', "'", 'key', "'", ']', '}', '"']);
  assert.deepEqual(tokens(pythonRules, 'rf"path\\{name}"'), ['rf', '"', 'path\\', '{', 'name', '}', '"']);
});

test('Python triple strings preserve their word context across physical lines', () => {
  const tokenizer = pythonRules.createTokenizer();
  assert.deepEqual(contents(tokenizer.tokenize('message = """Hello'), 'message = """Hello'), ['message', '=', '"""', 'Hello']);
  assert.deepEqual(contents(tokenizer.tokenize('old_name+x is literal'), 'old_name+x is literal'), ['old_name+x', 'is', 'literal']);
  assert.deepEqual(contents(tokenizer.tokenize('"""; a[i+1]'), '"""; a[i+1]'), ['"""', ';', 'a', '[', 'i', '+', '1', ']']);
  assert.deepEqual(tokens(pythonRules, 'old_name+x is literal'), ['old_name', '+', 'x', 'is', 'literal'], 'Fresh line tokenization never leaks an earlier call state');
});

test('ordinary unterminated strings reset after the physical line while explicit continuations survive', () => {
  for (const rules of [pythonRules, javascriptRules, jsonRules]) {
    const scanner = rules.createTokenizer();
    scanner.tokenize('"unterminated');
    assert.deepEqual(contents(scanner.tokenize('a+b'), 'a+b'), ['a', '+', 'b']);
  }
  const scanner = pythonRules.createTokenizer();
  scanner.tokenize('"hello\\');
  assert.deepEqual(contents(scanner.tokenize('x+y"'), 'x+y"'), ['x+y', '"']);
  const rawScanner = pythonRules.createTokenizer();
  rawScanner.tokenize('r"hello\\');
  assert.deepEqual(contents(rawScanner.tokenize('x+y"'), 'x+y"'), ['x+y', '"']);
});

test('JavaScript and TypeScript operators, names, private names and literals remain whole', () => {
  assert.deepEqual(tokens(javascriptRules, 'user?.first_name !== 0xFFn && count >>>= 2'), ['user', '?.', 'first_name', '!==', '0xFFn', '&&', 'count', '>>>=', '2']);
  assert.deepEqual(tokens(javascriptRules, 'amount = 1_000.5e-2; value ??= 12n'), ['amount', '=', '1_000.5e-2', ';', 'value', '??=', '12n']);
  assert.deepEqual(tokens(javascriptRules, 'type Result<T> = T | undefined;'), ['type', 'Result', '<', 'T', '>', '=', 'T', '|', 'undefined', ';']);
  assert.deepEqual(tokens(javascriptRules, '$value_한글 = cafe\u0301'), ['$value_한글', '=', 'cafe\u0301']);
});

test('JavaScript strings, comments, regular expressions and division are distinguished', () => {
  assert.deepEqual(tokens(javascriptRules, '"old x+y" // keep x-y'), ['"', 'old', 'x+y', '"', '//', 'keep', 'x-y']);
  assert.deepEqual(tokens(javascriptRules, String.raw`const pattern = /a[\/]b+/giu; x / y / z;`), ['const', 'pattern', '=', String.raw`/a[\/]b+/giu`, ';', 'x', '/', 'y', '/', 'z', ';']);
  assert.deepEqual(tokens(javascriptRules, String.raw`'\u{1F600}\x41\n'`), ["'", String.raw`\u{1F600}`, String.raw`\x41`, String.raw`\n`, "'"]);
});

test('JavaScript block comments carry state across lines and return to code after closing', () => {
  const scanner = javascriptRules.createTokenizer();
  assert.deepEqual(contents(scanner.tokenize('/* old words'), '/* old words'), ['/*', 'old', 'words']);
  assert.deepEqual(contents(scanner.tokenize('a+b */ a+b'), 'a+b */ a+b'), ['a+b', '*/', 'a', '+', 'b']);
});

test('JavaScript templates use words outside expressions and code inside nested expressions', () => {
  assert.deepEqual(tokens(javascriptRules, '`Hello ${user.name}: ${items[i+1]}`'), ['`', 'Hello', '${', 'user', '.', 'name', '}', ':', '${', 'items', '[', 'i', '+', '1', ']', '}', '`']);
  assert.deepEqual(tokens(javascriptRules, '`outer ${`inner ${x+y}`} end`'), ['`', 'outer', '${', '`', 'inner', '${', 'x', '+', 'y', '}', '`', '}', 'end', '`']);
  const scanner = javascriptRules.createTokenizer();
  scanner.tokenize('`first line');
  assert.deepEqual(contents(scanner.tokenize('x+y ${a+b}`'), 'x+y ${a+b}`'), ['x+y', '${', 'a', '+', 'b', '}', '`']);
});

test('JSON names are atomic including spaces while string values use words', () => {
  assert.deepEqual(tokens(jsonRules, '{"old key": "old value", "fontSize": 14}'), ['{', '"', 'old key', '"', ':', '"', 'old', 'value', '"', ',', '"', 'fontSize', '"', ':', '14', '}']);
  assert.deepEqual(tokens(jsonRules, '  "old key": false,'), ['"', 'old key', '"', ':', 'false', ',']);
  assert.deepEqual(tokens(jsonRules, String.raw`{"old\u0020key": "old\nvalue"}`), ['{', '"', String.raw`old\u0020key`, '"', ':', '"', 'old', String.raw`\n`, 'value', '"', '}']);
});

test('JSON object/array context distinguishes multiline property names and array values', () => {
  const scanner = jsonRules.createTokenizer();
  scanner.tokenize('{');
  assert.deepEqual(contents(scanner.tokenize('  "old key"'), '  "old key"'), ['"', 'old key', '"']);
  scanner.tokenize(': [');
  assert.deepEqual(contents(scanner.tokenize('"old value",'), '"old value",'), ['"', 'old', 'value', '"', ',']);
  scanner.tokenize('],');
  assert.deepEqual(contents(scanner.tokenize('"next key"'), '"next key"'), ['"', 'next key', '"']);
});

test('JSONC comments do not disturb object state or split prose into code tokens', () => {
  const scanner = jsonRules.createTokenizer();
  scanner.tokenize('{ /* comment');
  assert.deepEqual(contents(scanner.tokenize('a+b */ "old key": "new value"'), 'a+b */ "old key": "new value"'), ['a+b', '*/', '"', 'old key', '"', ':', '"', 'new', 'value', '"']);
});

test('malformed and Unicode content retain exact non-whitespace spans without throwing', () => {
  const samples = ['😀 + 😃', '"\\', "f'{{{{{", '`' + '${'.repeat(130) + 'x', '"'.repeat(8000), '/* ' + 'word '.repeat(1000), '  \t', '\uD83D', '\uDE00', 'r"\\"', 'f"{x:{y}}"'];
  for (const rules of [pythonRules, javascriptRules, jsonRules]) {
    for (const sample of samples) contents(rules.tokenize(sample), sample);
  }
});

test('escaped and private JavaScript names remain indivisible, and JSX closing tags are not regex literals', () => {
  assert.deepEqual(tokens(javascriptRules, String.raw`obj.#old_name + \u0061bc`), ['obj', '.', '#old_name', '+', String.raw`\u0061bc`]);
  assert.deepEqual(tokens(javascriptRules, '</div></section>'), ['<', '/', 'div', '>', '<', '/', 'section', '>']);
});

test('backslashes cannot suppress Python f-string interpolation but can escape a JS template marker', () => {
  assert.deepEqual(tokens(pythonRules, String.raw`f"path\{user.name}"`), ['f', '"', 'path', '\\', '{', 'user', '.', 'name', '}', '"']);
  assert.deepEqual(tokens(javascriptRules, '`hello \\${name}`'), ['`', 'hello', '\\$', '{name}', '`']);
});

test('JSON and JSONC numbers keep their sign, fractional digits and exponent together', () => {
  assert.deepEqual(tokens(jsonRules, '{"offset": -1, "rate": -1.25e-3, "zero": -0}'),
    ['{', '"', 'offset', '"', ':', '-1', ',', '"', 'rate', '"', ':', '-1.25e-3', ',', '"', 'zero', '"', ':', '-0', '}']);
  assert.deepEqual(tokens(jsonRules, '/* offset */ -2 // negative'), ['/*', 'offset', '*/', '-2', '//', 'negative']);
  assert.deepEqual(tokens(pythonRules, 'a-1'), ['a', '-', '1']);
  assert.deepEqual(tokens(javascriptRules, 'a-1'), ['a', '-', '1']);
});
