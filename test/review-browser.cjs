/* Actual Chromium layout tests for production media/review.js and media/review.css.
 * Run: node test/review-browser.cjs
 * No additional packages or browser downloads. HTTP and CDP bind to localhost; only the
 * VS Code transport and host state are mocked. Target-file writes are covered
 * separately by the real Extension Host suite.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { diffChars } = require('diff');

const root = path.resolve(__dirname, '..');
const scratchRoot = path.join(root, '.codex-test-ui');
const runName = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(scratchRoot, runName);
const results = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser, server, cdp, browserLog = '', runCreated = false;

async function findBrowser() {
  const candidates = [
    process.env.RR_BROWSER_EXECUTABLE,
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* Try next installed browser. */ }
  }
  throw new Error('No installed Edge/Chrome found. Set RR_BROWSER_EXECUTABLE to an existing Chromium browser.');
}

function createFixture() {
  let before = '', after = '';
  const hunks = [];
  const lineCount = text => (text.match(/\n/g) || []).length;
  const keep = text => { before += text; after += text; };
  const change = (id, original, proposed) => {
    hunks.push({ id, index: hunks.length, start: before.length, end: before.length + original.length,
      before: original, after: proposed, oldStart: lineCount(before) + 1, newStart: lineCount(after) + 1,
      oldLines: lineCount(original), newLines: lineCount(proposed), contextBefore: [], contextAfter: [], decision: 'pending' });
    before += original; after += proposed;
  };
  keep('Literal <img src=x onerror="window.__xss=1"> & <script>window.__xss=2</script>\n');
  keep('Opening unchanged context.\n');
  change('grow', 'Let \\(F_1(x)=x^2+α\\) and \\(G_1(y)=y+β\\), 한글😀.\n',
    'Let \\(F_2(x)=x^3+λ\\) and \\(G_2(y)=y+γ\\), 한글😃.\nReplacement second.\nReplacement third.\n');
  keep('Context after replacement.\nAnother unchanged line.\n');
  change('delete', 'Remove first.\nRemove second.\nRemove third.\n', '');
  keep('Context after deletion.\nAnother stable line.\n');
  change('insert', '', 'Inserted <svg onload="window.__xss=3">literal</svg>.\nInserted second.\n');
  keep('Context after insertion.\nAnother shared line.\n');
  change('shrink', 'Old long first.\nOld long second.\nOld long third.\n', 'Short replacement.\n');
  for (let line = 1; line <= 100; line++) keep('Shared trailing context ' + String(line).padStart(3, '0') + '.\n');
  return { type: 'state', revision: 'browser-fixture-v1', requestName: 'manuscript.tex.rr',
    title: 'Review <img src=x onerror="window.__xss=4"> as text',
    description: 'A long explanation to exercise expanding and wrapping the reason area. '.repeat(8) + '<script>window.__xss=5</script>',
    trusted: true, busy: false, unchangedOpacity: 20,
    files: [{ path: 'examples/manuscript.tex', before,
      reason: 'Reason <svg onload="window.__xss=6">literal content</svg>', hunks }] };
}
const fixture = createFixture();
fixture.files[0].hunks[0].explanation = 'Specific reason <img src=x onerror="window.__xss=7"> kept as text. ' + 'Additional context for this change. '.repeat(8);
fixture.files[0].hunks[1].explanation = '';
fixture.files[0].hunks[2].explanation = 'An insertion needs its own rationale.';
// The fourth hunk deliberately omits explanation; blank and absent are both disabled.

// Match the production host contract: paired source rows, no line ending in spans.
for (const hunk of fixture.files[0].hunks) {
  const lines = value => { const result = value ? value.replace(/\r\n|\r/g, '\n').split('\n') : []; if (result.at(-1) === '') result.pop(); return result; };
  const before = lines(hunk.before), after = lines(hunk.after);
  hunk.inlineChanges = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
    const parts = diffChars(before[index] || '', after[index] || '');
    return {
      before: parts.filter(part => !part.added).map(part => ({ text: part.value, changed: Boolean(part.removed) })),
      after: parts.filter(part => !part.removed).map(part => ({ text: part.value, changed: Boolean(part.added) }))
    };
  });
}
function mockScript() {
  return `'use strict';\nwindow.__xss = 0;\nwindow.__messages = [];\nwindow.__savedState = JSON.parse(sessionStorage.getItem('rr-view-state') || '{}');\nwindow.__fixture = ${JSON.stringify(fixture)};\n` +
    `window.__setReview = next => { window.__review = structuredClone(next); window.dispatchEvent(new MessageEvent('message', { data: window.__review })); };\n` +
    `window.acquireVsCodeApi = () => ({ getState: () => window.__savedState, setState: value => { window.__savedState = value; sessionStorage.setItem('rr-view-state', JSON.stringify(value)); }, postMessage: message => {\n` +
    `window.__messages.push(structuredClone(message));\n` +
    `if (message.type === 'decide' || message.type === 'decideFile' || message.type === 'undo') {\n` +
    `const next = structuredClone(window.__review); const file = next.files.find(item => item.path === message.filePath);\n` +
    `if (!file || message.revision !== next.revision) throw new Error('Invalid decision transport');\n` +
    `if (message.type === 'undo') { const hunk = file.hunks.find(item => item.id === message.hunkId); if (!hunk || hunk.decision === 'pending') throw new Error('Invalid undo transport'); hunk.decision = 'pending'; }\n` +
    `else for (const hunk of file.hunks) if (hunk.decision === 'pending' && (message.type === 'decideFile' || hunk.id === message.hunkId)) hunk.decision = message.decision;\n` +
    `if (next.closed && file.hunks.some(hunk => hunk.decision === 'pending')) next.closed = false;\n` +
    `window.__setReview(next); }\n` +
    `} });\n`;
}

async function startServer() {
  const css = await fs.readFile(path.join(root, 'media', 'review.css'));
  const js = await fs.readFile(path.join(root, 'media', 'review.js'));
  const html = Buffer.from('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Revision Request layout fixture</title><link rel="stylesheet" href="/review.css"></head><body><div id="app"></div><script src="/mock.js"></script><script src="/review.js"></script></body></html>');
  const routes = new Map([
    ['/', ['text/html; charset=utf-8', html]],
    ['/review.css', ['text/css; charset=utf-8', css]],
    ['/review.js', ['text/javascript; charset=utf-8', js]],
    ['/mock.js', ['text/javascript; charset=utf-8', Buffer.from(mockScript())]]
  ]);
  server = http.createServer((request, response) => {
    const route = routes.get(request.url);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'");
    if (!route) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', route[0]); response.end(route[1]);
  });
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port + '/';
}

class Devtools {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.exceptions = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails);
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('CDP socket closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to browser CDP')), { once: true });
    });
    return new Devtools(socket);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

async function startBrowser(executable, url) {
  const profile = path.join(runDir, 'profile');
  await fs.mkdir(profile, { recursive: true });
  browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--metrics-recording-only',
    '--proxy-server=' + url, '--proxy-bypass-list=localhost;127.0.0.1', '--disable-quic',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError;
  browser.on('error', error => { launchError = error; });
  for (const stream of [browser.stdout, browser.stderr]) stream.on('data', chunk => { browserLog = (browserLog + chunk).slice(-64000); });
  let port;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error('Browser exited while starting: ' + browserLog);
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]); if (port) break; } catch { /* Browser is starting. */ }
    await delay(100);
  }
  if (!port) throw new Error('Browser did not expose local CDP: ' + browserLog);
  let target;
  while (Date.now() < deadline) {
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page'); } catch { /* Devtools may not yet be serving. */ }
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error('No isolated browser page available');
  cdp = await Devtools.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  while (Date.now() < deadline) {
    if (await cdp.evaluate("Boolean(window.__messages && window.__messages.some(message => message.type === 'ready'))")) return;
    await delay(50);
  }
  throw new Error('Production review.js did not send ready');
}

const settle = () => cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function runTest(name, action) {
  try { const detail = await action(); results.push({ name, passed: true, detail }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); throw error; }
}
async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(runDir, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function resetFixture(width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate('window.__messages = []; window.__savedState = {}; window.__setReview(structuredClone(window.__fixture))');
  await settle();
}

// Read actual Chromium geometry, including rows outside the visible viewport.
async function geometry() {
  return cdp.evaluate(`(() => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const pair = node => ({ left: rect(node.children[0]), right: rect(node.children[1]), children: node.children.length });
    const scroll = document.querySelector('[data-scroll-area]');
    return {
      banner: pair(document.querySelector('.comparison-header')),
      headings: Array.from(document.querySelectorAll('.hunk-heading'), pair),
      rows: Array.from(document.querySelectorAll('.diff-row[data-pair="code"]'), pair),
      spacers: { left: document.querySelectorAll('.code-side.left.empty').length, right: document.querySelectorAll('.code-side.right.empty').length },
      scroll: { top: scroll.scrollTop, height: scroll.clientHeight, total: scroll.scrollHeight, rect: rect(scroll) },
      scrollers: document.querySelectorAll('[data-scroll-area]').length,
      viewport: { width: innerWidth, height: innerHeight }
    };
  })()`);
}
function assertAligned(measurements) {
  assert.equal(measurements.scrollers, 1, 'Both columns must use one shared vertical scroll container');
  assert.ok(measurements.rows.length > 100, 'Long fixture must exercise scrolling');
  for (const [index, pair] of [measurements.banner, ...measurements.headings, ...measurements.rows].entries()) {
    assert.equal(pair.children, 2, 'Pair ' + index + ' has exactly two sides');
    assert.ok(pair.left.height > 0, 'Pair ' + index + ' has visible height');
    assert.ok(Math.abs(pair.left.y - pair.right.y) < 0.6, 'Pair ' + index + ' starts at the same vertical position');
    assert.ok(Math.abs(pair.left.height - pair.right.height) < 0.6, 'Pair ' + index + ' has equal side heights');
    assert.ok(Math.abs(pair.left.width - measurements.banner.left.width) < 1.1, 'Pair ' + index + ' matches the original column width');
    assert.ok(Math.abs(pair.right.width - measurements.banner.right.width) < 1.1, 'Pair ' + index + ' matches the proposed column width');
  }
  for (const pair of [...measurements.headings, ...measurements.rows]) assert.ok(Math.abs(measurements.banner.right.x - pair.right.x) < 1.1, 'Banner and source column dividers align horizontally');
  assert.ok(measurements.scroll.height > 150, 'Comparison retains a usable height');
  assert.ok(measurements.scroll.total > measurements.scroll.height, 'Fixture must overflow vertically');
}
async function assertTextProjection(sides = ['left', 'right']) {
  const actual = await cdp.evaluate(`(() => {
    const data = {};
    for (const side of ['left', 'right']) {
      const cells = Array.from(document.querySelectorAll('.code-side.' + side + '[data-line]'));
      data[side] = { text: cells.map(cell => cell.querySelector('.code-text').textContent.replace(/\u200b/g, '')).join('\\n'), numbers: cells.map(cell => Number(cell.dataset.line)) };
    }
    return { data, state: window.__review };
  })()`);
  const file = actual.state.files[0];
  for (const side of sides) {
    let expected = '', offset = 0;
    for (const hunk of file.hunks) {
      expected += file.before.slice(offset, hunk.start);
      expected += side === 'left' ? hunk.decision === 'accepted' ? hunk.after : hunk.before : hunk.decision === 'ignored' ? hunk.before : hunk.after;
      offset = hunk.end;
    }
    expected += file.before.slice(offset);
    assert.equal(actual.data[side].text, expected, side + ' displays the exact expected source lines');
    assert.deepEqual(actual.data[side].numbers, actual.data[side].numbers.map((_, index) => index + 1), side + ' line numbers are consecutive');
  }
}
async function opacityValues() {
  return cdp.evaluate(`(() => {
    const effective = node => { let value = 1; while (node && node.nodeType === 1) { value *= Number(getComputedStyle(node).opacity); node = node.parentElement; } return value; };
    const values = selector => Array.from(document.querySelectorAll(selector), effective);
    return {
      rightContext: values('.code-side.right.context .code-text'),
      rightPending: values('.code-side.right.added .code-text'),
      left: values('.code-side.left[data-line] .code-text'),
      actions: values('.hunk-pending .action-gutter button:not(:disabled)'),
      sliderCount: document.querySelectorAll('input[type=range]').length
    };
  })()`);
}
function assertOpacity(actual, expected) {
  assert.ok(actual.rightContext.length > 100, 'There are right-side unchanged rows');
  for (const value of actual.rightContext) assert.ok(Math.abs(value - expected) < 0.0001, 'Right unchanged text opacity equals setting');
  for (const group of ['rightPending', 'left', 'actions']) {
    assert.ok(actual[group].length > 0, group + ' exists');
    for (const value of actual[group]) assert.equal(value, 1, group + ' stays fully opaque');
  }
  assert.equal(actual.sliderCount, 0, 'Opacity is controlled in extension settings, not a preview slider');
}
async function clickDecision(id, decision) {
  const key = fixture.files[0].path + ':' + id + ':' + decision;
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === ${JSON.stringify(key)});
    if (!button || button.disabled) throw new Error('Expected enabled decision button');
    button.click();
  })()`);
  await settle();
  const message = await cdp.evaluate('window.__messages.filter(message => message.type === "decide").at(-1)');
  assert.deepEqual(message, { type: 'decide', filePath: fixture.files[0].path, hunkId: id,
    decision: decision === 'accept' ? 'accepted' : 'ignored', revision: fixture.revision });
}

async function inlinePresentation() {
  return cdp.evaluate(`(() => {
    const row = document.querySelector('[data-hunk-row="grow"]');
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const alpha = color => color === 'transparent' ? 0 : color.startsWith('rgba(') ? Number(color.slice(color.lastIndexOf(',') + 1, -1)) : 1;
    const sides = {};
    for (const side of ['left', 'right']) {
      const cell = row.querySelector('.code-side.' + side);
      const source = cell.querySelector('.code-text');
      const spans = Array.from(source.querySelectorAll('.inline-common, .inline-changed'), span => {
        const css = getComputedStyle(span);
        return { text: span.textContent, changed: span.classList.contains('inline-changed'), rect: rect(span),
          colorAlpha: alpha(css.color), background: css.backgroundColor, backgroundAlpha: alpha(css.backgroundColor) };
      });
      const background = getComputedStyle(cell).backgroundColor;
      sides[side] = { text: source.textContent, background, backgroundAlpha: alpha(background), spans };
    }
    const effective = node => { let value = 1; while (node && node.nodeType === 1) { value *= Number(getComputedStyle(node).opacity); node = node.parentElement; } return value; };
    const context = Array.from(document.querySelectorAll('.code-side.context .code-text'), node => ({
      right: node.closest('.code-side').classList.contains('right'), colorAlpha: alpha(getComputedStyle(node).color), opacity: effective(node)
    }));
    return { sides, context, controls: document.querySelectorAll('input,select').length,
      rowHighlight: document.querySelector('.review-app').classList.contains('highlight-changed-lines'),
      onlyChanged: document.querySelector('.review-app').classList.contains('show-only-changed-text'),
      code: document.querySelector('.paired-document').textContent,
      injected: document.querySelectorAll('#app img,#app svg,#app script').length, xss: window.__xss };
  })()`);
}
function inlineRects(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.sides).map(([side, value]) => [side, value.spans.map(span => ({ text: span.text, changed: span.changed, rect: span.rect }))]));
}
function assertInlinePresentation(snapshot, lineHighlight, onlyChanged, baseline) {
  assert.equal(snapshot.rowHighlight, lineHighlight); assert.equal(snapshot.onlyChanged, onlyChanged);
  assert.equal(snapshot.controls, 0, 'Highlight preferences live only in extension settings');
  assert.equal(snapshot.injected, 0); assert.equal(snapshot.xss, 0);
  for (const [side, value] of Object.entries(snapshot.sides)) {
    const common = value.spans.filter(span => !span.changed), changed = value.spans.filter(span => span.changed);
    assert.ok(common.length >= 4 && changed.length >= 6, 'Several separated inline edits retain common LaTeX syntax');
    assert.equal(value.text, fixture.files[0].hunks[0][side === 'left' ? 'before' : 'after'].split('\n')[0], 'Spans preserve exact LaTeX/Unicode text');
    assert.ok(value.text.includes('한글') && value.text.includes(side === 'left' ? '😀' : '😃'), 'Unicode stays literal');
    assert.ok(lineHighlight ? value.backgroundAlpha > 0 : value.backgroundAlpha === 0, 'Only the row tint follows Highlight Changed Lines');
    for (const span of changed) {
      assert.ok(span.backgroundAlpha > 0 && span.backgroundAlpha > value.backgroundAlpha, 'Changed characters retain a stronger background');
      assert.ok(span.colorAlpha > 0, 'Changed characters remain visible');
    }
    for (const span of common) assert.ok(onlyChanged ? span.colorAlpha === 0 : span.colorAlpha > 0, 'Only common pending characters follow Show Only Changed Text');
    if (baseline) assert.deepEqual(changed.map(span => span.background), baseline.sides[side].spans.filter(span => span.changed).map(span => span.background), 'Character highlights are independent of both settings');
  }
  for (const item of snapshot.context) {
    assert.ok(item.colorAlpha > 0, 'Unrelated context foreground remains visible');
    assert.equal(item.opacity, item.right ? 0.2 : 1, 'Unrelated context keeps its existing opacity');
  }
  if (baseline) assert.deepEqual(inlineRects(snapshot), inlineRects(baseline), 'Hiding common text preserves every span position and width');
}
async function inspectHunkActions(id) {
  return cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('[data-hunk-row]')).find(node => node.dataset.hunkRow === ${JSON.stringify(id)});
    if (!row) throw new Error('Missing visible hunk action row');
    const actions = row.querySelector('.inline-actions');
    const rect = node => { if (!node) return null; const box = node.getBoundingClientRect(); return { x: box.x, right: box.right, height: box.height }; };
    const undo = Array.from(actions.querySelectorAll('button')).find(button => button.textContent === 'Undo');
    return { accept: rect(actions.querySelector('.button-accept')), why: rect(actions.querySelector('.why-toggle')),
      badge: rect(actions.querySelector('.badge')), undo: rect(undo), badgeText: actions.querySelector('.badge')?.textContent,
      changedSpans: row.closest('.hunk').querySelectorAll('.inline-changed').length,
      whyCount: actions.querySelectorAll('.why-toggle').length, buttons: Array.from(actions.querySelectorAll('button'), button => button.textContent),
      emptyPair: row.querySelectorAll('.code-side.empty').length === 2,
      hasLineNumbers: Boolean(row.querySelector('.code-side[data-line]')) };
  })()`);
}
async function clickUndo(id) {
  const key = fixture.files[0].path + ':' + id + ':undo';
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === ${JSON.stringify(key)});
    if (!button || button.disabled) throw new Error('Expected enabled Undo button');
    button.focus({ preventScroll: true }); button.click();
  })()`);
  await settle();
  const message = await cdp.evaluate('window.__messages.filter(message => message.type === "undo").at(-1)');
  assert.deepEqual(message, { type: 'undo', filePath: fixture.files[0].path, hunkId: id, revision: fixture.revision });
}
async function clickWhy(id) {
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.why-toggle')).find(item => item.dataset.whyId === ${JSON.stringify(id)});
    if (!button || button.disabled) throw new Error('Expected enabled Why button');
    button.click();
  })()`);
  await settle();
}
async function assertNoLayoutShift(before) {
  const after = await geometry(); assertAligned(after);
  assert.deepEqual(after.rows, before.rows, 'Popover must not move source rows');
  assert.deepEqual(after.banner, before.banner, 'Popover must not change banner height');
  assert.equal(after.scroll.top, before.scroll.top, 'Popover must not move the shared scroll position');
}

async function editSnapshot() {
  return cdp.evaluate("(() => { const editor = document.querySelector('.pending-editor'); if (!editor) return null; const area = editor.querySelector('textarea'); const box = editor.getBoundingClientRect(); const areaBox = area.getBoundingClientRect(); const gutter = editor.querySelector('.action-gutter').getBoundingClientRect(); return {draft:area.value, readOnly:area.readOnly, wrap:area.wrap, whiteSpace:getComputedStyle(area).whiteSpace, selection:[area.selectionStart,area.selectionEnd], scroll:[area.scrollTop,area.scrollLeft], error:editor.querySelector('.pending-editor-error')?.textContent, saveDisabled:editor.querySelector('[data-focus-key=\"edit:save\"]').disabled, focused:document.activeElement.dataset.focusKey, rect:{x:box.x,y:box.y,right:box.right,bottom:box.bottom}, area:{x:areaBox.x,right:areaBox.right,width:area.clientWidth,scrollWidth:area.scrollWidth}, gutter:{x:gutter.x,right:gutter.right}, position:getComputedStyle(editor).position, role:editor.getAttribute('role'), buttons:Array.from(editor.querySelectorAll('.action-gutter button'),node=>node.textContent), persisted:window.__savedState.editing}; })()");
}
async function openEdit(id, method = 'click', row = 0) {
  const findSource = "Array.from(document.querySelectorAll('[data-edit-hunk]')).find(node => node.dataset.editHunk === " + JSON.stringify(id) + " && Number(node.dataset.editRow) === " + row + ")";
  if (method === 'click') {
    const point = await cdp.evaluate("(() => { const source = " + findSource + "; if (!source) throw new Error('Missing editable pending source'); source.scrollIntoView({block:'nearest'}); const box=source.getBoundingClientRect(); return {x:box.x+Math.min(12,box.width/2),y:box.y+Math.min(10,box.height/2)}; })()");
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
  } else {
    await cdp.evaluate("(() => { const source = " + findSource + "; if (!source) throw new Error('Missing editable pending source'); source.focus({preventScroll:true}); source.dispatchEvent(new KeyboardEvent('keydown',{key:" + JSON.stringify(method) + ",bubbles:true,cancelable:true})); })()");
  }
  await settle();
}
async function editorKey(key, modifiers = {}) {
  await cdp.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown'," + JSON.stringify({key, bubbles:true,cancelable:true,...modifiers}) + "))");
  await settle();
}
async function writeDraft(draft) {
  await cdp.evaluate("(() => { const area = document.querySelector('.pending-editor textarea'); area.value = " + JSON.stringify(draft) + "; area.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()");
  await settle();
}
async function editAck(message, fields) {
  await cdp.evaluate("window.dispatchEvent(new MessageEvent('message',{data:" + JSON.stringify({type:'editResult',filePath:message.filePath,hunkId:message.hunkId,editId:message.editId,...fields}) + "}))");
  await settle();
}
function assertInlineEditor(snapshot, width) {
  assert.ok(snapshot, 'Pending code has an in-place editor');
  assert.notEqual(snapshot.position, 'fixed', 'Editing must not open a floating popup');
  assert.notEqual(snapshot.position, 'absolute', 'Editor participates in the comparison layout');
  assert.notEqual(snapshot.role, 'dialog', 'Editing happens in the code column, not a dialog');
  assert.equal(snapshot.wrap, 'soft');
  assert.ok(['pre-wrap', 'break-spaces'].includes(snapshot.whiteSpace), 'Draft preserves source whitespace while soft-wrapping');
  assert.ok(snapshot.rect.x >= width / 2 - 10 && snapshot.rect.right <= width + 0.6, 'Editor stays in the proposed pane');
  assert.ok(snapshot.area.x >= snapshot.rect.x && snapshot.area.right <= snapshot.gutter.x + 0.6, 'Draft text ends before the action rail');
  assert.ok(snapshot.area.scrollWidth <= snapshot.area.width + 1, 'The draft is fully readable without horizontal scrolling');
  assert.deepEqual([...snapshot.buttons].sort(), ['Cancel', 'Save'], 'Save/Cancel replace decision controls on the editing block');
}
async function originalProjection() {
  return cdp.evaluate("Array.from(document.querySelectorAll('.code-side.left[data-line] .code-text'),node=>node.textContent.replace(/\u200b/g,'')).join('\\n')");
}
async function runEditorTests(width) {
  await resetFixture(width);
  await runTest(width + 'px: one click edits pending code in place, reserves the action rail, and cancel restores the proposal', async () => {
    const original = await originalProjection();
    const originalInline = await cdp.evaluate("Array.from(document.querySelectorAll('[data-hunk-row=\"grow\"] .code-side.left .inline-common,[data-hunk-row=\"grow\"] .code-side.left .inline-changed'),node=>({text:node.textContent,changed:node.classList.contains('inline-changed')}))");
    await openEdit('grow', 'click', 1);
    const editingInline = await cdp.evaluate("Array.from(document.querySelectorAll('.hunk-editing .code-side.left .inline-common,.hunk-editing .code-side.left .inline-changed'),node=>({text:node.textContent,changed:node.classList.contains('inline-changed')}))");
    assert.deepEqual(editingInline,originalInline,'In-place editing preserves the original side intraline highlights and common text');
    assert.ok(editingInline.some(part=>part.changed)&&editingInline.some(part=>!part.changed));
    let opened = await editSnapshot();
    assert.equal(opened.draft, fixture.files[0].hunks[0].after, 'Editing exposes the complete pending hunk');
    assert.equal(opened.focused, 'edit:draft');
    assertInlineEditor(opened, width);
    const clickedRowStart = fixture.files[0].hunks[0].after.indexOf('\n') + 1;
    const clickedRowEnd = fixture.files[0].hunks[0].after.indexOf('\n', clickedRowStart);
    assert.ok(opened.selection[0] >= clickedRowStart && opened.selection[0] <= clickedRowEnd, 'Caret starts within the clicked proposed row');
    assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('.inline-actions button,.file-actions button')).filter(button=>!button.dataset.focusKey?.startsWith('edit:')).every(button=>button.disabled)"), true, 'Drafting blocks review decisions');
    const messages = await cdp.evaluate('window.__messages.length');
    await cdp.evaluate("Array.from(document.querySelectorAll('.inline-actions button')).find(node=>node.textContent==='Accept')?.click()");
    assert.equal(await cdp.evaluate('window.__messages.length'), messages, 'Disabled Accept cannot submit a decision');
    assertAligned(await geometry());
    assert.equal(await originalProjection(), original, 'Entering an editor preserves every original line');
    await screenshot('comparison-' + width + '-pending-editor');
    await cdp.send('Input.insertText', {text:'Typed directly. '}); await settle();
    opened = await editSnapshot();
    assert.ok(opened.draft.includes('Typed directly. '), 'Real keyboard input edits the focused inline textarea');
    await writeDraft('Unsubmitted draft <script>window.__xss=99</script>\n');
    await cdp.evaluate("document.querySelector('[data-focus-key=\"edit:save\"]').focus()");
    await editorKey('Escape');
    assert.equal(await editSnapshot(), null, 'Escape from any editor control cancels');
    assert.equal(await cdp.evaluate('document.activeElement.dataset.editRow'), '1', 'Cancel restores the clicked row, including a non-first row');
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'), fixture.files[0].hunks[0].after);
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>message.type==='editPending').length"), 0);
    await assertTextProjection(); assertAligned(await geometry());
    await openEdit('delete', 'click'); assert.equal((await editSnapshot()).draft, '', 'Pure deletion has an editable empty proposal');
    await writeDraft('Replacement for the deleted lines.\nSecond line.\n');
    assertInlineEditor(await editSnapshot(), width); assertAligned(await geometry());
    await editorKey('Escape');
    await openEdit('insert', 'F2'); await writeDraft(''); assertInlineEditor(await editSnapshot(), width); await editorKey('Escape');
    await clickDecision('grow', 'accept'); await clickDecision('insert', 'ignore');
    assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('[data-edit-hunk]')).some(node=>['grow','insert'].includes(node.dataset.editHunk))"), false, 'Accepted and ignored rows are not editable');
    await clickUndo('grow'); await openEdit('grow', 'Enter'); await editorKey('Escape');
    await resetFixture(width);
  });
  await runTest(width + 'px: multiline inline draft and caret survive busy refreshes; stale revisions never retarget a save', async () => {
    await openEdit('grow', 'F2');
    const draft = '\t' + 'long_draft '.repeat(35) + '<img src=x onerror="window.__xss=91">\n' + 'draft line\n'.repeat(20);
    await writeDraft(draft);
    await cdp.evaluate("(() => { const area=document.querySelector('.pending-editor textarea'); area.setSelectionRange(7,19); area.dispatchEvent(new Event('select')); })()");
    const prior = await editSnapshot(); assertInlineEditor(prior, width);
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=44; window.__setReview({...window.__review,busy:true})"); await settle();
    let current = await editSnapshot();
    assert.equal(current.draft,draft); assert.deepEqual(current.selection,prior.selection); assert.deepEqual(current.scroll,prior.scroll);
    assert.equal(current.persisted.draft,draft); assert.equal(current.saveDisabled,true); assert.equal(current.focused,'edit:draft');
    assertInlineEditor(current, width);
    assert.equal((await geometry()).scroll.top,44); assertAligned(await geometry());
    await cdp.evaluate("window.__setReview({...window.__review,busy:false})"); await settle();
    assert.equal((await editSnapshot()).saveDisabled,false);
    const originalRevision = (await editSnapshot()).persisted.revision;
    await cdp.evaluate("window.__setReview({...window.__review,revision:'externally-changed'})"); await settle();
    current = await editSnapshot();
    assert.equal(current.draft,draft); assert.equal(current.persisted.revision,originalRevision); assert.equal(current.saveDisabled,true);
    assert.ok(current.error.includes('request changed')); assert.equal(current.focused,'edit:draft');
    await editorKey('Enter',{ctrlKey:true});
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>message.type==='editPending').length"),0, 'Stale shortcut cannot submit with a newer revision');
    assert.equal(await cdp.evaluate('window.__xss'),0);
    await editorKey('Escape');
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=0");
    await resetFixture(width);
  });
  await runTest(width + 'px: a removed hunk or invalid request keeps the inline draft visible and cancellable', async () => {
    const draft = 'Keep this unsaved proposal for copying.\nSecond draft line.\n';
    for (const invalidRequest of [false,true]) {
      await resetFixture(width); await openEdit('grow'); await writeDraft(draft);
      await cdp.evaluate(invalidRequest
        ? "window.__setReview({...window.__review,revision:'',files:[],error:'The request could not be parsed.'})"
        : "(() => { const next=structuredClone(window.__review); next.revision='hunk-removed'; next.files[0].hunks=next.files[0].hunks.filter(hunk=>hunk.id!=='grow'); window.__setReview(next); })()");
      await settle();
      const editor = await editSnapshot();
      assert.ok(editor, 'A stale or unparseable request cannot hide an unsaved draft');
      assert.equal(editor.draft,draft); assert.equal(editor.saveDisabled,true);
      assert.notEqual(editor.position,'fixed'); assert.notEqual(editor.role,'dialog');
      assert.ok(editor.area.width > 40, 'Stale draft retains a visible text area');
      assert.ok(editor.error.includes('request changed'));
      await cdp.evaluate("document.querySelector('.pending-editor textarea').select()");
      assert.deepEqual((await editSnapshot()).selection,[0,draft.length],'The complete draft remains selectable for copying');
      const cancelDisabled = await cdp.evaluate("document.querySelector('.pending-editor [data-focus-key=\"edit:cancel\"]').disabled");
      assert.equal(cancelDisabled,false,'Cancel stays available after the request disappears');
      await cdp.evaluate("document.querySelector('.pending-editor [data-focus-key=\"edit:cancel\"]').click()"); await settle();
      assert.equal(await editSnapshot(),null);
    }
    await resetFixture(width);
  });
  await runTest(width + 'px: inline Save correlates acknowledgements, keeps failed drafts, and updates only the proposal', async () => {
    await openEdit('grow');
    const draft = 'Edited proposal <svg onload="window.__xss=92">literal</svg>.\nA second revised line.\n';
    await writeDraft(draft);
    const sourceBefore = await originalProjection();
    await editorKey('Enter',{ctrlKey:true});
    let message = await cdp.evaluate("window.__messages.filter(message=>message.type==='editPending').at(-1)");
    assert.deepEqual({...message,editId:undefined},{type:'editPending',filePath:fixture.files[0].path,hunkId:'grow',draft,revision:fixture.revision,editId:undefined});
    assert.ok(typeof message.editId==='string' && message.editId.length>0);
    assert.equal((await editSnapshot()).readOnly,true); assert.equal((await editSnapshot()).saveDisabled,true);
    await editAck(message,{success:true,editId:'unrelated-edit-id',revision:'unrelated-revision'});
    assert.equal((await editSnapshot()).draft,draft,'Unrelated acknowledgements cannot close or change a draft');
    await cdp.evaluate("window.__setReview({...window.__review,busy:true})"); await settle();
    assert.equal((await editSnapshot()).draft,draft);
    await cdp.evaluate("window.__setReview({...window.__review,busy:false})"); await settle();
    const error = 'Request save failed <img src=x onerror="window.__xss=93">.';
    await editAck(message,{success:false,error});
    let editor = await editSnapshot();
    assert.equal(editor.draft,draft); assert.equal(editor.error,error); assert.equal(editor.readOnly,false); assert.equal(editor.saveDisabled,false); assert.equal(editor.focused,'edit:draft');
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'),fixture.files[0].hunks[0].after,'Failed save retains original proposal');
    await editorKey('Enter',{metaKey:true});
    const retry = await cdp.evaluate("window.__messages.filter(message=>message.type==='editPending').at(-1)");
    assert.notEqual(retry.editId,message.editId); assert.equal(retry.revision,fixture.revision); assert.equal(retry.draft,draft);
    await editAck(message,{success:false,error:'Delayed first result'});
    assert.equal((await editSnapshot()).readOnly,true,'Old attempt cannot unlock a newer pending save');
    await cdp.evaluate("(() => { const next=structuredClone(window.__review); next.revision='browser-edited-v2'; const hunk=next.files[0].hunks[0]; hunk.after=" + JSON.stringify(draft) + "; hunk.id='grow-edited'; hunk.newLines=2; delete hunk.inlineChanges; window.__setReview(next); })()");
    await settle();
    assert.equal((await editSnapshot()).draft,draft,'New state before acknowledgement still preserves the draft');
    assert.equal(await originalProjection(),sourceBefore,'Saving proposal does not alter the original projection');
    await editAck(retry,{success:true,revision:'browser-edited-v2',changed:true});
    assert.equal(await editSnapshot(),null,'Only matching successful acknowledgement closes the editor');
    assert.equal(await cdp.evaluate('document.activeElement.dataset.editHunk'),'grow-edited','Focus follows the newly computed pending hunk');
    assert.equal(await cdp.evaluate('window.__savedState.editing'),null);
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].decision'),'pending');
    await assertTextProjection(); assertAligned(await geometry()); assert.equal(await cdp.evaluate('window.__xss'),0);
    await screenshot('comparison-' + width + '-edited-proposal');
    await resetFixture(width);
  });
}

async function completionSnapshot() {
  return cdp.evaluate(`(() => {
    const dialog=document.querySelector('.completion-dialog'); if(!dialog)return null;
    const box=dialog.getBoundingClientRect(), input=dialog.querySelector('.completion-remember input');
    const yes=dialog.querySelector('[data-focus-key="completion:yes"]'), no=dialog.querySelector('[data-focus-key="completion:no"]');
    const label=input.closest('label').getBoundingClientRect(), actions=yes.parentElement.getBoundingClientRect();
    return {text:dialog.textContent,role:dialog.getAttribute('role'),modal:dialog.getAttribute('aria-modal'),focusWithin:dialog.contains(document.activeElement),focusedKey:document.activeElement.dataset.focusKey,
      checked:input.checked,checkDisabled:input.disabled,yesDisabled:yes.disabled,noDisabled:no.disabled,
      error:dialog.querySelector('.completion-error')?.textContent,
      rect:{x:box.x,y:box.y,right:box.right,bottom:box.bottom},label:{x:label.x,right:label.right},actions:{x:actions.x,right:actions.right}};
  })()`);
}
async function showCompletion(id, width) {
  await resetFixture(width);
  await cdp.evaluate("(() => { const next=structuredClone(window.__review); for(const hunk of next.files[0].hunks)hunk.decision='ignored'; window.__setReview(next); })()");
  await settle();
  const message={type:'completionPrompt',completionId:id,revision:fixture.revision,requestName:fixture.requestName};
  await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(message)+'}))'); await settle();
  return message;
}
async function completionAck(prompt, fields) {
  await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'completionResult',completionId:prompt.completionId,revision:prompt.revision,...fields})+'}))'); await settle();
}
async function runCompletionTests(width) {
  await runTest(width + 'px: completed state alone stays quiet and explicit deletion prompt sends No with the chosen preference', async () => {
    await resetFixture(width);
    await cdp.evaluate("(() => { const next=structuredClone(window.__review); for(const hunk of next.files[0].hunks)hunk.decision='ignored'; window.__setReview(next); })()"); await settle();
    assert.equal(await completionSnapshot(),null,'Opening an already completed request never asks for deletion');
    const prompt=await showCompletion('completion-no-'+width,width);
    let snapshot=await completionSnapshot();
    assert.ok(snapshot); assert.ok(snapshot.text.includes('Delete this .rr file?'));
    assert.equal(snapshot.role,'dialog'); assert.equal(snapshot.modal,'true'); assert.equal(snapshot.checked,false);
    assert.equal(snapshot.focusWithin,true); assert.equal(snapshot.focusedKey,'completion:no','The initial keyboard action keeps the request');
    assert.ok(snapshot.text.includes('Remember my choice'));
    assert.ok(snapshot.rect.x>=0&&snapshot.rect.right<=width&&snapshot.rect.y>=0&&snapshot.rect.bottom<=850,'Completion prompt fits the viewport');
    assert.ok(snapshot.label.right<=snapshot.actions.x+1,'Remember checkbox stays to the left of Yes/No');
    await screenshot('comparison-'+width+'-completion-prompt');
    await cdp.evaluate("document.querySelector('.completion-remember input').click(); document.querySelector('[data-focus-key=\"completion:no\"]').click()"); await settle();
    let message=await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').at(-1)");
    assert.deepEqual(message,{type:'resolveCompletion',completionId:prompt.completionId,revision:prompt.revision,deleteRequest:false,rememberChoice:true});
    snapshot=await completionSnapshot();
    assert.equal(snapshot.yesDisabled,true); assert.equal(snapshot.noDisabled,true); assert.equal(snapshot.checkDisabled,true);
    assert.equal(snapshot.focusWithin,true,'Resolving keeps keyboard focus inside the modal even when its controls are disabled');
    await completionAck(prompt,{completionId:'unrelated-prompt',success:true});
    assert.ok(await completionSnapshot(),'A different completion acknowledgement cannot close this prompt');
    await completionAck(prompt,{success:false,error:'Could not retain the request <img src=x onerror="window.__xss=96">.'});
    snapshot=await completionSnapshot();
    assert.ok(snapshot.error.includes('Could not retain')); assert.equal(snapshot.checked,true); assert.equal(snapshot.noDisabled,false);
    assert.equal(await cdp.evaluate('window.__xss'),0);
    await cdp.evaluate("document.querySelector('[data-focus-key=\"completion:no\"]').click()"); await settle();
    await completionAck(prompt,{success:true});
    assert.equal(await completionSnapshot(),null);
    await cdp.evaluate("window.__setReview(structuredClone(window.__review))"); await settle();
    assert.equal(await completionSnapshot(),null,'A state refresh after No cannot reopen the prompt');
    await resetFixture(width);
  });
  await runTest(width + 'px: completion Yes is revision-bound and dismissing the dialog does not remember a delete choice', async () => {
    const prompt=await showCompletion('completion-yes-'+width,width);
    await cdp.evaluate("document.querySelector('.completion-remember input').click(); document.querySelector('[data-focus-key=\"completion:yes\"]').click()"); await settle();
    const message=await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').at(-1)");
    assert.deepEqual(message,{type:'resolveCompletion',completionId:prompt.completionId,revision:prompt.revision,deleteRequest:true,rememberChoice:true});
    await completionAck(prompt,{success:false,error:'The request could not be deleted.'});
    await cdp.evaluate("window.__setReview({...window.__review,busy:true})"); await settle();
    assert.equal((await completionSnapshot()).yesDisabled,true,'Busy review cannot submit deletion');
    await cdp.evaluate("window.__setReview({...window.__review,busy:false,revision:'changed-after-completion'})"); await settle();
    assert.equal((await completionSnapshot()).yesDisabled,true,'Stale completion cannot delete a changed request');
    const count=await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').length");
    await cdp.evaluate("document.querySelector('[data-focus-key=\"completion:yes\"]').click()"); await settle();
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').length"),count);
    await cdp.evaluate("document.querySelector('[data-focus-key=\"completion:close\"]').click()"); await settle();
    const dismissal=await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').at(-1)");
    assert.deepEqual(dismissal,{type:'resolveCompletion',completionId:prompt.completionId,revision:prompt.revision,deleteRequest:false,rememberChoice:false},'Close keeps the request without persisting the checkbox');
    await completionAck(prompt,{success:true}); assert.equal(await completionSnapshot(),null);
    const escape=await showCompletion('completion-escape-'+width,width);
    await cdp.evaluate("document.querySelector('.completion-remember input').click(); document.querySelector('.completion-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"); await settle();
    assert.deepEqual(await cdp.evaluate("window.__messages.filter(message=>message.type==='resolveCompletion').at(-1)"),{type:'resolveCompletion',completionId:escape.completionId,revision:escape.revision,deleteRequest:false,rememberChoice:false});
    await completionAck(escape,{success:true}); await resetFixture(width);
  });
  await runTest(width + 'px: invalid RR exposes a direct Delete this RR action below Open RR as JSON', async () => {
    await resetFixture(width);
    await cdp.evaluate("window.__setReview({...window.__review,revision:'',files:[],error:'The request could not be parsed.'})"); await settle();
    const actions=await cdp.evaluate(`(() => {const open=document.querySelector('[data-focus-key="empty:source"]'), remove=document.querySelector('[data-focus-key="empty:delete-request"]');if(!open||!remove)return null;const a=open.getBoundingClientRect(),b=remove.getBoundingClientRect();return {label:remove.textContent,openBottom:a.bottom,deleteTop:b.y,disabled:remove.disabled};})()`);
    assert.ok(actions); assert.equal(actions.label,'Delete this RR'); assert.equal(actions.disabled,false);
    assert.ok(actions.deleteTop>=actions.openBottom,'Delete this RR is below Open RR as JSON');
    await cdp.evaluate("document.querySelector('[data-focus-key=\"empty:delete-request\"]').click()"); await settle();
    assert.deepEqual(await cdp.evaluate("window.__messages.filter(message=>message.type==='deleteRequest').at(-1)"),{type:'deleteRequest'});
    await resetFixture(width);
  });
}

async function splitSnapshot() {
  return cdp.evaluate(`(() => {
    const separator=document.querySelector('.pane-splitter'), header=document.querySelector('.comparison-header'), scroll=document.querySelector('[data-scroll-area]');
    const box=separator.getBoundingClientRect(), left=header.children[0].getBoundingClientRect(), right=header.children[1].getBoundingClientRect();
    const rail=document.querySelector('.action-gutter').getBoundingClientRect();
    return {role:separator.getAttribute('role'),orientation:separator.getAttribute('aria-orientation'),
      value:Number(separator.getAttribute('aria-valuenow')),min:Number(separator.getAttribute('aria-valuemin')),max:Number(separator.getAttribute('aria-valuemax')),
      x:box.x+box.width/2,y:Math.min(24,box.bottom-2),available:scroll.clientWidth,
      left:left.width,right:right.width,divider:right.x,rail:rail.width,ratio:left.width/scroll.clientWidth,
      saved:window.__savedState.splitRatio,dragging:document.querySelector('.review-app').classList.contains('resizing-panes'),
      sourceWidths:Array.from(document.querySelectorAll('.code-side .code-source'),node=>({side:node.closest('.code-side').classList.contains('right')?'right':'left',width:node.clientWidth,scrollWidth:node.scrollWidth})),
      headerFit:Array.from(header.querySelectorAll('.summary .badge,.file-actions .button'),node=>{const r=node.getBoundingClientRect();return r.x>=right.x-1&&r.right<=right.right+1;})};
  })()`);
}
async function dragSplitter(ratio, cancel = false, refresh = false) {
  const start=await splitSnapshot();
  await cdp.evaluate("document.querySelector('.pane-splitter').addEventListener('pointerdown',event=>window.__splitPointer=event.pointerId,{once:true})");
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:start.x,y:start.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:start.available*ratio,y:start.y});
  await settle();
  if(cancel) await cdp.evaluate("document.querySelector('.pane-splitter').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.__splitPointer,bubbles:true}))");
  if(refresh) await cdp.evaluate("window.__setReview(structuredClone(window.__review))");
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:start.available*ratio,y:start.y});
  await settle();
  return splitSnapshot();
}
async function splitKey(key, shiftKey = false) {
  await cdp.evaluate("(() => {const separator=document.querySelector('.pane-splitter');separator.focus({preventScroll:true});separator.dispatchEvent(new KeyboardEvent('keydown',"+JSON.stringify({key,shiftKey,bubbles:true,cancelable:true})+"));})()");
  await settle(); return splitSnapshot();
}
async function resetSplit() {
  const point=await splitSnapshot();
  for(const clickCount of [1,2]) {
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount,x:point.x,y:point.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount,x:point.x,y:point.y});
  }
  await settle();
}
function assertSplitGeometry(value) {
  assert.equal(value.role,'separator'); assert.equal(value.orientation,'vertical');
  assert.ok(Math.abs(value.x-value.divider)<1.1,'Splitter hit target is centered on the header/body divider');
  assert.ok(Math.abs(value.left+value.right-value.available)<1.1,'Both panes fill the width excluding the native vertical scrollbar');
  assert.ok(value.headerFit.every(Boolean),'Status badges and action buttons remain within the right pane');
  for(const source of value.sourceWidths) {
    assert.ok(source.width>=79,'Minimum pane widths leave readable code beside the fixed rail');
    assert.ok(source.scrollWidth<=source.width+1,'Resizing never hides code horizontally');
  }
}
async function reloadPreview() {
  await cdp.send('Page.reload',{ignoreCache:true});
  const deadline=Date.now()+6000;
  while(Date.now()<deadline) {
    if(await cdp.evaluate("Boolean(window.__messages?.some(message=>message.type==='ready'))"))break;
    await delay(40);
  }
  await cdp.evaluate("window.__setReview(structuredClone(window.__fixture))"); await settle();
}
async function runSplitterTests(width) {
  await resetFixture(width); await resetSplit();
  await runTest(width+'px: dragging the central divider resizes every paired row and keeps the fixed action rail',async()=>{
    const before=await splitSnapshot(), text=await cdp.evaluate("JSON.stringify(window.__review)");
    const moved=await dragSplitter(.35);
    assertSplitGeometry(moved); assert.ok(moved.left<before.left-30); assert.ok(moved.right>before.right+30);
    assert.ok(Math.abs(moved.rail-before.rail)<.6,'The action rail retains its fixed width');
    assert.ok(Math.abs(moved.saved-moved.ratio)<.002); assert.equal(moved.dragging,false);
    assertAligned(await geometry()); await assertTextProjection();
    assert.equal(await cdp.evaluate("JSON.stringify(window.__review)"),text,'Pane resizing cannot alter review content or decisions');
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>['decide','editPending','undo'].includes(message.type)).length"),0);
    await screenshot('comparison-'+width+'-resized-panes');
    const cancelled=await dragSplitter(.52,true);
    assert.ok(Math.abs(cancelled.ratio-moved.ratio)<.002,'Pointer cancellation restores the pre-drag ratio');
    assert.equal(cancelled.dragging,false);
    const refreshed=await dragSplitter(.4,false,true);
    assert.ok(Math.abs(refreshed.ratio-.4)<.003,'A host refresh safely finishes and retains the current drag');
    assert.equal(refreshed.dragging,false); assertAligned(await geometry());
    await resetSplit();
  });
  await runTest(width+'px: divider keyboard controls honor minimum widths and double-click restores equal panes',async()=>{
    let current=await splitKey('ArrowLeft');
    assert.ok(Math.abs(current.ratio-.48)<.003);
    current=await splitKey('ArrowLeft',true);
    assert.ok(Math.abs(current.ratio-.38)<.003);
    current=await splitKey('Home'); assertSplitGeometry(current);
    assert.ok(Math.abs(current.ratio*100-current.min)<1);
    current=await splitKey('End'); assertSplitGeometry(current);
    assert.ok(Math.abs(current.ratio*100-current.max)<1);
    assertAligned(await geometry()); await assertTextProjection();
    await resetSplit(); current=await splitSnapshot();
    assert.ok(Math.abs(current.ratio-.5)<.002,'Double-click resets to an even split');
    assert.equal(current.saved,.5);
  });
  await runTest(width+'px: resizing an inline draft preserves its caret, grows its height, and survives preview reload',async()=>{
    await openEdit('grow');
    const draft='Long proposed line: '+'wide_code '.repeat(45)+'\nSecond line.\n';
    await writeDraft(draft);
    await cdp.evaluate("(() => {const area=document.querySelector('.pending-editor textarea');area.setSelectionRange(7,19);area.dispatchEvent(new Event('select'));window.__splitDraftNode=area;})()");
    const before=await editSnapshot(), original=await originalProjection();
    const oldHeight=await cdp.evaluate("document.querySelector('.pending-editor textarea').getBoundingClientRect().height");
    const moved=await dragSplitter(.35);
    const after=await editSnapshot();
    assert.equal(after.draft,draft); assert.deepEqual(after.selection,before.selection);
    assert.equal(await cdp.evaluate("window.__splitDraftNode===document.querySelector('.pending-editor textarea')"),true,'Dragging does not replace the focused input DOM');
    assert.equal(after.focused,'edit:draft'); assert.equal(await originalProjection(),original);
    const newHeight=await cdp.evaluate("document.querySelector('.pending-editor textarea').getBoundingClientRect().height");
    assert.ok(newHeight<oldHeight,'A wider proposed pane reflows and reduces the draft height');
    assert.ok(after.area.scrollWidth<=after.area.width+1); assertAligned(await geometry());
    await cdp.evaluate("window.__setReview(structuredClone(window.__review))"); await settle();
    assert.equal((await editSnapshot()).draft,draft); assert.deepEqual((await editSnapshot()).selection,before.selection);
    assert.ok(Math.abs((await splitSnapshot()).ratio-moved.ratio)<.002);
    await editorKey('Escape'); await reloadPreview();
    const reloaded=await splitSnapshot();
    assert.ok(Math.abs(reloaded.ratio-moved.ratio)<.002,'The saved pane ratio restores after the preview webview reloads');
    assertAligned(await geometry()); await assertTextProjection();
    await resetSplit(); await resetFixture(width);
  });
}

async function runLayoutTests() {
  for (const width of [1200, 620]) {
    await resetFixture(width);
    await runTest(width + 'px: equal banners, row heights, and insertion/deletion spacers', async () => {
      const measurements = await geometry(); assertAligned(measurements);
      assert.deepEqual(measurements.spacers, { left: 4, right: 5 });
      for (let index = 1; index < measurements.rows.length; index++) {
        const previous = measurements.rows[index - 1].left;
        assert.ok(Math.abs(measurements.rows[index].left.y - previous.y - previous.height) < 0.6,
          'No control-only rows or vertical gaps between consecutive source rows');
      }
      await assertTextProjection(); await screenshot('comparison-' + width + '-initial');
      return { rows: measurements.rows.length, bannerHeight: measurements.banner.left.height, spacers: measurements.spacers };
    });
    await runTest(width + 'px: long code wraps before controls with aligned logical rows and no hidden final text', async () => {
      const prefix = '\tconst long_value = ' + 'long_token '.repeat(12) + 'UNBROKEN_' + 'x'.repeat(95);
      const beforeLine = prefix + ' ORIGINAL_END\n';
      const afterLine = prefix + ' PROPOSED_END\n';
      const tail = Array.from({length: 105}, (_, index) => 'unchanged tail ' + index + '\n').join('');
      const parts = diffChars(beforeLine.slice(0, -1), afterLine.slice(0, -1));
      const longState = { ...structuredClone(fixture), files: [{path: fixture.files[0].path, before: beforeLine + tail,
        hunks: [{id: 'long', index: 0, start: 0, end: beforeLine.length, before: beforeLine, after: afterLine,
          oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, decision: 'pending', contextBefore: [], contextAfter: [],
          inlineChanges: [{before: parts.filter(part => !part.added).map(part => ({text: part.value, changed: Boolean(part.removed)})),
            after: parts.filter(part => !part.removed).map(part => ({text: part.value, changed: Boolean(part.added)}))}]}] }] };
      const metrics = () => cdp.evaluate(`(() => {
        const rect = node => { const box = node.getBoundingClientRect(); return {x: box.x, y: box.y, right: box.right, bottom:box.bottom, width: box.width, height: box.height}; };
        const data = {horizontalBars:document.querySelectorAll('[data-horizontal],.horizontal-bars').length};
        for (const side of ['left', 'right']) {
          const cell = document.querySelector('.hunk .code-side.' + side); const source = cell.querySelector('.code-source');
          const code = source.querySelector('.code-text'); const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
          const nodes = []; while (walker.nextNode()) if (walker.currentNode.textContent.length) nodes.push(walker.currentNode);
          const first = document.createRange(); first.setStart(nodes[0], 0); first.setEnd(nodes[0], 1);
          const lastNode = nodes.at(-1); const last = document.createRange(); last.setStart(lastNode, lastNode.textContent.length - 1); last.setEnd(lastNode, lastNode.textContent.length);
          const action = cell.querySelector('.inline-actions');
          data[side] = {source: rect(source), code: rect(code), first: rect(first), last: rect(last),
            row: rect(cell), gutter: cell.querySelector('.action-gutter') ? rect(cell.querySelector('.action-gutter')) : null,
            action:action ? rect(action) : null, text:code.textContent,
            clientWidth:source.clientWidth, scrollWidth:source.scrollWidth,
            numbers:Array.from(cell.querySelectorAll('.line-number'),node=>node.textContent), whitespace:getComputedStyle(code).whiteSpace,
            lineHeight:parseFloat(getComputedStyle(code).lineHeight)};
        }
        return data;
      })()`);
      const check = async () => {
        const current = await metrics();
        assert.equal(current.horizontalBars, 0, 'Soft-wrapped comparison has no horizontal scrollbars');
        for (const side of ['left', 'right']) {
          const value = current[side];
          assert.ok(['pre-wrap','break-spaces'].includes(value.whitespace), 'Whitespace is preserved while code wraps');
          assert.ok(value.last.y > value.first.y + value.lineHeight, 'A long logical line spans multiple visual lines');
          assert.ok(value.last.x >= value.source.x - 0.6 && value.last.right <= value.source.right + 0.6, 'The complete final character remains within the source column');
          assert.ok(value.last.bottom <= value.source.bottom + 0.6, 'The final wrapped line is not vertically clipped');
          assert.ok(value.scrollWidth <= value.clientWidth + 1, 'No source text is hidden in horizontal overflow, including long unbroken tokens');
          assert.deepEqual(value.numbers,['1'],'Wrapped continuations do not invent logical line numbers');
          assert.equal(value.text, (side === 'left' ? beforeLine : afterLine).slice(0,-1), 'Soft wrapping never changes source text, tabs, or spaces');
        }
        assert.ok(current.right.source.right <= current.right.gutter.x + 0.6, 'Code column ends before the fixed action rail');
        assert.ok(current.right.action.y - current.right.row.y < current.right.lineHeight, 'Action buttons stay on the first visual line');
        const layout = await geometry(); assertAligned(layout); await assertTextProjection();
        assert.ok(layout.scroll.rect.y + layout.scroll.rect.height >= layout.viewport.height - 1, 'Removing the horizontal scrollbar also removes its reserved bottom strip');
        return current;
      };
      try {
        await cdp.evaluate('window.__setReview(' + JSON.stringify(longState) + ')'); await settle();
        const start = await check();
        await screenshot('comparison-' + width + '-wrapped-long-code');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width:width===1200?620:1200,height:850,deviceScaleFactor:1,mobile:false});
        await settle(); await check();
        await cdp.send('Emulation.setDeviceMetricsOverride', {width,height:850,deviceScaleFactor:1,mobile:false});
        await settle(); const restored = await check();
        assert.deepEqual(restored.right.gutter,start.right.gutter,'Resizing back restores the action rail and row geometry');
        await cdp.evaluate("window.__setReview(structuredClone(window.__review))"); await settle(); await check();
      } finally {
        await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop = 0");
        await settle(); await resetFixture(width);
      }
    });
    await runEditorTests(width);
    await runCompletionTests(width);
    await runSplitterTests(width);
    await runTest(width+'px: closed requests show completion status without suppressing action errors or target guards',async()=>{
      await resetFixture(width);
      await cdp.evaluate("(() => {const next=structuredClone(window.__review);next.closed=true;for(const hunk of next.files[0].hunks)hunk.decision='accepted';next.files[0].issue='The original changed after this request was closed.';next.files[0].currentText='CURRENT FILE INTRODUCTION'+String.fromCharCode(10)+next.files[0].before+['Additional current line.','Another current line.',''].join(String.fromCharCode(10));window.__setReview(next);})()");await settle();
      const closed=await cdp.evaluate("({info:Array.from(document.querySelectorAll('.notice-info p'),node=>node.textContent),errors:Array.from(document.querySelectorAll('.notice-error p'),node=>node.textContent),undo:Array.from(document.querySelectorAll('.inline-actions button'),node=>({text:node.textContent,disabled:node.disabled}))})");
      assert.deepEqual(closed.info,['This revision request is closed.']);assert.deepEqual(closed.errors,[]);
      const currentText='CURRENT FILE INTRODUCTION\n'+fixture.files[0].before+'Additional current line.\nAnother current line.\n';
      assert.equal(await originalProjection(),currentText,'Closed original shows the complete current file, including external prefix and appended lines');
      const neutral=await cdp.evaluate("({label:document.querySelector('.pane-banner.left .eyebrow').textContent,highlights:document.querySelectorAll('.paired-document .code-side.left .inline-changed,.paired-document .code-side.left.removed,.paired-document .code-side.left.added').length,editable:document.querySelectorAll('[data-edit-hunk]').length,numbers:Array.from(document.querySelectorAll('.code-side.left[data-line]'),node=>Number(node.dataset.line))})");
      assert.equal(neutral.label,'ORIGINAL');assert.equal(neutral.highlights,0);assert.equal(neutral.editable,0);
      assert.deepEqual(neutral.numbers,neutral.numbers.map((_,index)=>index+1),'Current original lines are neither duplicated nor dropped');
      await assertTextProjection(['right']);assertAligned(await geometry());
      await screenshot('comparison-'+width+'-closed-current-original');
      await cdp.evaluate("(() => {const next=structuredClone(window.__review);next.files[0].currentText='Short current file without a final newline';window.__setReview(next);})()");await settle();
      assert.equal(await originalProjection(),'Short current file without a final newline');
      await assertTextProjection(['right']);assertAligned(await geometry());
      await cdp.evaluate("(() => {const next=structuredClone(window.__review);next.files[0].currentText="+JSON.stringify(currentText)+";window.__setReview(next);})()");await settle();
      assert.ok(closed.undo.length>0&&closed.undo.every(button=>button.text==='Undo'&&button.disabled),'Closed display does not weaken stale target Undo guards');
      await cdp.evaluate("window.__setReview({...window.__review,error:'Undo could not be completed.'})");await settle();
      assert.deepEqual(await cdp.evaluate("Array.from(document.querySelectorAll('.notice-error p'),node=>node.textContent)"),['Undo could not be completed.']);
      await cdp.evaluate("(() => {const next=structuredClone(window.__review);next.error=undefined;next.files[0].issue=undefined;window.__setReview(next);})()");await settle();
      await clickUndo('grow');
      assert.equal(await cdp.evaluate('window.__review.closed'),false);
      assert.ok(await cdp.evaluate("document.querySelectorAll('.paired-document .left .code-text').length>0"),'Undo restores the original column when a change becomes pending');
      await assertTextProjection();assertAligned(await geometry());
      await cdp.evaluate("window.__setReview({...window.__review,closed:true,files:[],error:undefined})");await settle();
      assert.equal(await cdp.evaluate("document.querySelector('.empty-state h2').textContent"),'This revision request is closed.');
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('[data-focus-key=\"empty:source\"]')&&document.querySelector('[data-focus-key=\"empty:delete-request\"]'))"));
      assert.equal(await completionSnapshot(),null,'Closed state never invents a deletion confirmation');
      await resetFixture(width);
    });

    await runTest(width + 'px: larger banner items align actual bulk button edges with inline controls', async () => {
      const layout = await cdp.evaluate(`(() => {
        const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
        const summary = document.querySelector('.summary-row .summary');
        const bulk = document.querySelector('.summary-row .file-actions');
        return { row: rect(document.querySelector('.summary-row')), summary: rect(summary), bulk: rect(bulk),
          gutter: rect(document.querySelector('.code-side.right .action-gutter')),
          badges: Array.from(summary.querySelectorAll('.badge'), rect),
          buttons: Array.from(bulk.querySelectorAll('button'), rect),
          inlineButtons: Array.from(document.querySelectorAll('.inline-actions button'), rect),
          inlineGroups: Array.from(document.querySelectorAll('.hunk-pending .inline-actions'), group => Array.from(group.querySelectorAll('button'), rect)) };
      })()`);
      assert.equal(layout.badges.length, 3); assert.equal(layout.buttons.length, 2);
      assert.ok(Math.abs(layout.bulk.x - layout.gutter.x) < 0.6, 'Bulk region begins at the code action gutter');
      assert.ok(Math.abs(layout.bulk.width - layout.gutter.width) < 0.6, 'Bulk region has the code action gutter width');
      assert.ok(layout.summary.right <= layout.bulk.x + 0.6, 'Counters and bulk controls do not overlap');
      const first = layout.badges[0];
      for (const item of [...layout.badges, ...layout.buttons]) {
        assert.ok(Math.abs(item.y - first.y) < 0.6, 'All banner badges and buttons share a top edge');
        assert.ok(Math.abs(item.height - first.height) < 0.6, 'All banner badges and buttons have equal heights');
        assert.ok(item.y >= layout.row.y - 0.6 && item.bottom <= layout.row.bottom + 0.6, 'All controls stay in one banner row');
      }
      assert.ok(first.height >= 23.4, 'Banner badges and buttons are enlarged to at least 24px');
      for (const item of layout.inlineButtons) {
        assert.ok(Math.abs(item.height - 18) < 0.6, 'Inline buttons retain their compact 18px height');
        assert.ok(first.height > item.height + 4, 'Banner items are visibly larger than inline controls');
      }
      assert.equal(layout.inlineGroups.length, 4);
      for (const group of layout.inlineGroups) {
        assert.equal(group.length, 3);
        assert.ok(Math.abs(layout.buttons[0].x - group[0].x) < 0.6, 'Actual Accept all left edge matches actual inline Accept left edge');
        assert.ok(Math.abs(layout.buttons[1].right - group[2].right) < 0.6, 'Actual Ignore all right edge matches actual inline Why right edge');
      }
      for (const [items, container] of [[layout.badges, layout.summary], [layout.buttons, layout.bulk]]) {
        for (let index = 0; index < items.length; index++) {
          assert.ok(items[index].x >= container.x - 0.6 && items[index].right <= container.right + 0.6, 'Controls are contained in their own region');
          if (index) assert.ok(items[index - 1].right <= items[index].x + 0.6, 'Adjacent controls do not overlap');
        }
      }
      return { bannerHeight: first.height, inlineHeight: layout.inlineButtons[0].height,
        acceptAllLeft: layout.buttons[0].x, inlineAcceptLeft: layout.inlineGroups[0][0].x,
        ignoreAllRight: layout.buttons[1].right, inlineWhyRight: layout.inlineGroups[0][2].right };
    });
    await runTest(width + 'px: Accept/Ignore/Why sit inline in the first changed right row', async () => {
      const controls = await cdp.evaluate(`(() => ({
        obsolete: document.querySelectorAll('.hunk-heading, .change-number, .location, .removal-note, .reason').length,
        rows: Array.from(document.querySelectorAll('.diff-row[data-hunk-row]'), row => {
          const right = row.querySelector('.code-side.right'); const actions = right.querySelector('.inline-actions');
          const source = right.querySelector('.code-source'); const buttons = Array.from(actions.querySelectorAll('button'));
          return { first: row.closest('.hunk').querySelector('.diff-row') === row, labels: buttons.map(button => button.textContent),
            y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height,
            actionY: actions.getBoundingClientRect().y, actionHeight: actions.getBoundingClientRect().height,
            gap: right.getBoundingClientRect().right - actions.getBoundingClientRect().right,
            sourceEnd: source.getBoundingClientRect().right, actionStart: actions.getBoundingClientRect().left };
        })
      }))()`);
      assert.equal(controls.obsolete, 0, 'No separate hunk heading or banner explanation remains'); assert.equal(controls.rows.length, 4);
      for (const row of controls.rows) {
        assert.equal(row.first, true); assert.deepEqual(row.labels, ['Accept', 'Ignore', 'Why']);
        assert.ok(row.actionY >= row.y - 0.6 && row.actionY + row.actionHeight <= row.y + row.height + 0.6, 'Controls fit within their source row');
        assert.ok(row.gap >= 0 && row.gap <= 12, 'Controls sit at the far right of the proposed pane');
        assert.ok(row.sourceEnd <= row.actionStart + 0.6, 'Source text wraps before controls');
      }
    });
    await runTest(width + 'px: left filename opens only the original target without changing review state', async () => {
      const actual = await cdp.evaluate(`(() => {
        const file = window.__review.files[0]; const key = file.path + ':original';
        const buttons = Array.from(document.querySelectorAll('[data-focus-key]')).filter(button => button.dataset.focusKey === key);
        const button = buttons[0]; const before = JSON.stringify(window.__review);
        const result = { count: buttons.length, text: button.textContent, tag: button.tagName,
          inFilename: Boolean(button.closest('.pane-banner.left .pane-filename')),
          topbarCount: document.querySelectorAll('.topbar, .brand, .topbar-tools').length,
          toolbarActions: Array.from(document.querySelectorAll('[data-focus-key]')).filter(item => item.dataset.focusKey === 'source' || item.dataset.focusKey === file.path + ':diff').length };
        button.click(); result.stateUnchanged = before === JSON.stringify(window.__review);
        result.message = window.__messages.filter(message => message.type === 'openTarget').at(-1); return result;
      })()`);
      assert.equal(actual.count, 1); assert.equal(actual.text, fixture.files[0].path); assert.equal(actual.tag, 'BUTTON');
      assert.equal(actual.inFilename, true); assert.equal(actual.topbarCount, 0, 'The full topbar is removed'); assert.equal(actual.toolbarActions, 0, 'Native diff and JSON actions moved out of the preview toolbar'); assert.equal(actual.stateUnchanged, true);
      assert.deepEqual(actual.message, { type: 'openTarget', filePath: fixture.files[0].path });
    });
    await runTest(width + 'px: hostile request strings render literally without injected elements', async () => {
      const actual = await cdp.evaluate(`({ xss: window.__xss, injected: document.querySelectorAll('#app img, #app svg, #app script').length,
        titleElements: document.querySelectorAll('.request-title').length, titleVisible: document.getElementById('app').textContent.includes(window.__fixture.title),
        descriptionVisible: document.getElementById('app').textContent.includes(window.__fixture.description),
        code: document.querySelector('.code-side.left .code-text').textContent })`);
      assert.equal(actual.xss, 0); assert.equal(actual.injected, 0); assert.equal(actual.titleElements, 0); assert.equal(actual.titleVisible, false, 'Request title stays metadata-only');
      assert.equal(actual.descriptionVisible, false, 'Description is metadata, with no banner disclosure');
      assert.ok(actual.code.includes('<img src=x onerror="window.__xss=1">'));
    });
    let inlineBaseline, inlineGeometry;
    await runTest(width + 'px: default inline rendering isolates separate LaTeX and Unicode character changes', async () => {
      inlineBaseline = await inlinePresentation(); inlineGeometry = await geometry();
      assertInlinePresentation(inlineBaseline, true, false); await assertTextProjection();
    });
    for (const [lineHighlight, onlyChanged] of [[false, false], [false, true], [true, false], [true, true]]) {
      await runTest(width + 'px: inline settings lines=' + lineHighlight + ', onlyChanged=' + onlyChanged + ' preserve layout and independent styling', async () => {
        await cdp.evaluate('window.__setReview({ ...window.__review, highlightChangedLines: ' + lineHighlight + ', showOnlyChangedText: ' + onlyChanged + ' })');
        await settle(); const current = await inlinePresentation();
        assertInlinePresentation(current, lineHighlight, onlyChanged, inlineBaseline);
        assert.deepEqual((await geometry()).rows, inlineGeometry.rows, 'Neither setting changes paired row geometry');
        assertOpacity(await opacityValues(), 0.2); await assertTextProjection();
        if (!lineHighlight && onlyChanged) await screenshot('comparison-' + width + '-characters-only');
      });
    }
    await cdp.evaluate('window.__setReview({ ...window.__review, highlightChangedLines: true, showOnlyChangedText: false })'); await settle();
    await runTest(width + 'px: default opacity20 changes only right unchanged text', async () => {
      await cdp.evaluate('(() => { const next = structuredClone(window.__review); delete next.unchangedOpacity; window.__setReview(next); })()');
      await settle(); assertOpacity(await opacityValues(), 0.2);
    });
    for (const opacity of [0, 100]) {
      await runTest(width + 'px: settings opacity' + opacity + ' changes only right unchanged text', async () => {
        await cdp.evaluate('window.__setReview({ ...window.__review, unchangedOpacity: ' + opacity + ' })');
        await settle(); assertOpacity(await opacityValues(), opacity / 100); assertAligned(await geometry());
      });
    }
    await cdp.evaluate('window.__setReview({ ...window.__review, unchangedOpacity: 20 })'); await settle();
    await runTest(width + 'px: Why is disabled and dim for blank or missing explanations', async () => {
      const states = await cdp.evaluate(`Array.from(document.querySelectorAll('.why-toggle'), button => ({
        id: button.dataset.whyId, disabled: button.disabled, opacity: Number(getComputedStyle(button).opacity), title: button.title
      }))`);
      assert.equal(states.length, 4);
      for (const state of states) {
        const enabled = state.id === 'grow' || state.id === 'insert';
        assert.equal(state.disabled, !enabled);
        if (enabled) assert.equal(state.opacity, 1); else { assert.ok(state.opacity < 1); assert.ok(state.title.length > 0); }
      }
      await cdp.evaluate('document.querySelector("[data-why-id=delete]").click(); document.querySelector("[data-why-id=shrink]").click()');
      assert.equal(await cdp.evaluate('Boolean(document.querySelector(".why-popover"))'), false);
    });
    await runTest(width + 'px: Why popover renders safe text without moving comparison rows', async () => {
      const before = await geometry(); await clickWhy('grow'); await assertNoLayoutShift(before);
      const popover = await cdp.evaluate(`(() => {
        const node = document.querySelector('.why-popover'); const box = node.getBoundingClientRect();
        return { text: node.querySelector('.explanation-copy').textContent, role: node.getAttribute('role'), injected: node.querySelectorAll('img,svg,script').length,
          xss: window.__xss, focused: document.activeElement === node,
          close: { width: node.querySelector('.why-close').getBoundingClientRect().width, height: node.querySelector('.why-close').getBoundingClientRect().height,
            beforeWidth: getComputedStyle(node.querySelector('.why-close'), '::before').width, afterWidth: getComputedStyle(node.querySelector('.why-close'), '::after').width,
            beforeContent: getComputedStyle(node.querySelector('.why-close'), '::before').content, afterContent: getComputedStyle(node.querySelector('.why-close'), '::after').content }, x: box.x, y: box.y, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
      })()`);
      assert.equal(popover.text, fixture.files[0].hunks[0].explanation); assert.equal(popover.role, 'dialog');
      assert.equal(popover.injected, 0); assert.equal(popover.xss, 0); assert.equal(popover.focused, true, 'Why dialog receives keyboard focus');
      assert.ok(popover.close.width >= 24 && popover.close.height >= 24, 'Why close has a generous hit area');
      assert.equal(popover.close.beforeWidth, '10px'); assert.equal(popover.close.afterWidth, '10px');
      assert.notEqual(popover.close.beforeContent, 'none'); assert.notEqual(popover.close.afterContent, 'none');
      assert.ok(popover.x >= 0 && popover.right <= popover.viewportWidth + 1, 'Popover fits horizontally');
      assert.ok(popover.y >= 0 && popover.bottom <= popover.viewportHeight + 1, 'Popover fits vertically');
      await screenshot('comparison-' + width + '-why');
      await cdp.evaluate('window.__setReview(structuredClone(window.__review))'); await settle();
      assert.ok(await cdp.evaluate('Boolean(document.querySelector(".why-popover"))'), 'Explanation survives a host state refresh');
      await assertNoLayoutShift(before);
    });
    await runTest(width + 'px: Why closes by toggle, Escape, outside click, and close button without moving rows', async () => {
      const before = await geometry();
      const assertClosed = async () => {
        await settle(); assert.equal(await cdp.evaluate('Boolean(document.querySelector(".why-popover"))'), false);
        await assertNoLayoutShift(before);
      };
      await clickWhy('grow'); await assertClosed();
      await clickWhy('grow');
      await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))'); await assertClosed();
      await clickWhy('grow');
      await cdp.evaluate('document.querySelector(".pane-banner.left").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))'); await assertClosed();
      await clickWhy('grow');
      await cdp.evaluate('document.querySelector(".why-popover button").click()'); await assertClosed();
    });
    await runTest(width + 'px: shared vertical scrolling preserves row correspondence', async () => {
      const before = await geometry();
      await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop = 420'); await settle();
      const scrolled = await geometry(); assertAligned(scrolled); assert.equal(scrolled.scroll.top, 420);
      for (let index = 0; index < before.rows.length; index++) {
        assert.ok(Math.abs((before.rows[index].left.y - scrolled.rows[index].left.y) - (420 - before.scroll.top)) < 0.6);
        assert.ok(Math.abs((before.rows[index].right.y - scrolled.rows[index].right.y) - (420 - before.scroll.top)) < 0.6);
      }
      return { scrollTop: scrolled.scroll.top, rows: scrolled.rows.length };
    });
    for (const action of [
      { id: 'grow', decision: 'accept', spacers: { left: 2, right: 5 } },
      { id: 'delete', decision: 'accept', spacers: { left: 3, right: 3 }, zeroRows: true },
      { id: 'insert', decision: 'ignore', spacers: { left: 2, right: 4 }, zeroRows: true },
      { id: 'shrink', decision: 'ignore', spacers: { left: 2, right: 2 } }
    ]) {
      let beforeDecision, pendingActions;
      await runTest(width + 'px: ' + action.decision + ' ' + action.id + ' preserves alignment and the intended projection', async () => {
        beforeDecision = await geometry(); pendingActions = await inspectHunkActions(action.id);
        await clickDecision(action.id, action.decision);
        const after = await geometry(); assertAligned(after); assert.deepEqual(after.spacers, action.spacers);
        assert.equal(after.scroll.top, beforeDecision.scroll.top, 'Decision rerender retains shared scroll position');
        await assertTextProjection(); return { rows: after.rows.length, spacers: after.spacers };
      });
      await runTest(width + 'px: resolved ' + action.id + ' has aligned badge/Undo and restores only that block to pending', async () => {
        const resolved = await inspectHunkActions(action.id);
        assert.equal(resolved.whyCount, 0, 'Resolved block replaces Why with Undo');
        assert.equal(resolved.changedSpans, 0, 'Accepted or ignored content no longer has pending character highlights');
        assert.deepEqual(resolved.buttons, ['Undo']);
        assert.ok(resolved.badgeText.includes(action.decision === 'accept' ? 'Accepted' : 'Ignored'));
        assert.ok(Math.abs(resolved.badge.x - pendingActions.accept.x) < 0.6, 'Resolved badge left edge aligns with pending Accept');
        assert.ok(Math.abs(resolved.undo.right - pendingActions.why.right) < 0.6, 'Undo right edge aligns with pending Why');
        if (action.zeroRows) {
          assert.equal(resolved.emptyPair, true, 'Zero-line resolved block keeps a paired blank row for Undo');
          assert.equal(resolved.hasLineNumbers, false, 'Blank Undo row does not invent line numbers');
        }
        const priorDecisions = await cdp.evaluate('window.__review.files[0].hunks.map(hunk => ({ id: hunk.id, decision: hunk.decision }))');
        const priorScroll = (await geometry()).scroll.top;
        await clickUndo(action.id);
        const current = await cdp.evaluate('window.__review.files[0].hunks.map(hunk => ({ id: hunk.id, decision: hunk.decision }))');
        assert.deepEqual(current, priorDecisions.map(item => item.id === action.id ? { ...item, decision: 'pending' } : item), 'Undo changes only the selected decision');
        const undone = await geometry(); assertAligned(undone);
        assert.deepEqual(undone.spacers, beforeDecision.spacers, 'Undo restores the exact pending alignment');
        assert.equal(undone.scroll.top, priorScroll, 'Undo retains the shared scroll position');
        await assertTextProjection();
        const restored = await inspectHunkActions(action.id);
        assert.deepEqual(restored.buttons, ['Accept', 'Ignore', 'Why']);
        assert.equal(restored.changedSpans, pendingActions.changedSpans, 'Undo restores the original character highlights');
        assert.ok(restored.changedSpans > 0);
        assert.equal(await cdp.evaluate('document.activeElement.dataset.focusKey'), fixture.files[0].path + ':' + action.id + ':accept', 'Undo restores focus to pending Accept');
        // Reapply for the next independent hunk scenario, preserving the staged fixture.
        await clickDecision(action.id, action.decision); assertAligned(await geometry()); await assertTextProjection();
        return { badgeLeft: resolved.badge.x, pendingAcceptLeft: pendingActions.accept.x,
          undoRight: resolved.undo.right, pendingWhyRight: pendingActions.why.right, zeroRowUndo: Boolean(action.zeroRows) };
      });
    }
    await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop = 0'); await settle();
    await runTest(width + 'px: resizing the resolved review retains alignment and decisions', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: width === 1200 ? 620 : 1200, height: 850, deviceScaleFactor: 1, mobile: false });
      await settle(); assertAligned(await geometry()); await assertTextProjection();
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
      await settle(); assertAligned(await geometry()); await assertTextProjection();
    });
    await screenshot('comparison-' + width + '-resolved');
    await runTest(width + 'px: stale-target warning shows snapshot and disables Accept', async () => {
      await cdp.evaluate(`(() => { const next = structuredClone(window.__fixture); next.files[0].issue = 'The original has changed; create a fresh request.'; window.__setReview(next); })()`);
      await settle(); assertAligned(await geometry());
      const stale = await cdp.evaluate(`({ label: document.querySelector('.pane-banner.left .eyebrow').textContent,
        notice: document.querySelector('.notice').textContent,
        acceptDisabled: Array.from(document.querySelectorAll('.button-accept')).every(button => button.disabled),
        ignoreEnabled: Array.from(document.querySelectorAll('.inline-actions button')).filter(button => button.textContent === 'Ignore').every(button => !button.disabled) })`);
      assert.equal(stale.label, 'REQUEST SNAPSHOT'); assert.ok(stale.notice.includes('original has changed'));
      assert.equal(stale.acceptDisabled, true); assert.equal(stale.ignoreEnabled, true); await assertTextProjection();
    });    await runTest(width + 'px: repeated missing-target errors appear once while distinct action errors remain visible', async () => {
      const missing = 'The target file does not exist. Version 1 reviews existing files.';
      await cdp.evaluate(`(() => { const next = structuredClone(window.__fixture); next.error = ${JSON.stringify(missing)}; next.files[0].issue = next.error; window.__setReview(next); })()`);
      await settle(); assertAligned(await geometry());
      const problem = await cdp.evaluate(`({ label: document.querySelector('.pane-banner.left .eyebrow').textContent,
        errors: Array.from(document.querySelectorAll('.notice-error p'), node => node.textContent),
        acceptDisabled: Array.from(document.querySelectorAll('.button-accept')).every(button => button.disabled),
        ignoreEnabled: Array.from(document.querySelectorAll('.inline-actions button')).filter(button => button.textContent === 'Ignore').every(button => !button.disabled) })`);
      assert.deepEqual(problem.errors, [missing], 'Identical request and target errors show only once');
      assert.equal(problem.label, 'REQUEST SNAPSHOT'); assert.equal(problem.acceptDisabled, true); assert.equal(problem.ignoreEnabled, true);
      await assertTextProjection(); await screenshot('comparison-' + width + '-missing-target');
      const actionError = 'The request could not be opened as JSON.';
      await cdp.evaluate(`window.__setReview({ ...window.__review, error: ${JSON.stringify(actionError)} })`);
      await settle(); assertAligned(await geometry());
      const errors = await cdp.evaluate(`Array.from(document.querySelectorAll('.notice-error p'), node => node.textContent)`);
      assert.deepEqual(errors, [actionError, missing], 'Distinct action and target errors are both retained');
      const reviewBeforeDismissal = await cdp.evaluate('JSON.stringify(window.__review)');
      const close = await cdp.evaluate(`(() => { const button = document.querySelector('.notice-error .notice-close'); const box = button.getBoundingClientRect();
        return {width: box.width, height: box.height, stroke: getComputedStyle(button, '::before').width, label: button.getAttribute('aria-label')}; })()`);
      assert.equal(close.width, 24); assert.equal(close.height, 24); assert.equal(close.stroke, '10px'); assert.equal(close.label, 'Dismiss error message');
      await cdp.evaluate("document.querySelector('.notice-error .notice-close').click()"); await settle();
      assert.deepEqual(await cdp.evaluate("Array.from(document.querySelectorAll('.notice-error p'), node => node.textContent)"), [missing], 'Closing one message retains a distinct issue');
      await cdp.evaluate("document.querySelector('.notice-error .notice-close').click()"); await settle();
      assert.equal(await cdp.evaluate("document.querySelectorAll('.notice-error').length"), 0);
      assert.equal(await cdp.evaluate('JSON.stringify(window.__review)'), reviewBeforeDismissal, 'Dismissal changes presentation only');
      assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('.button-accept')).every(button => button.disabled)"), true);
      assert.equal(await cdp.evaluate("document.querySelector('.pane-banner.left .eyebrow').textContent"), 'REQUEST SNAPSHOT');
      await clickWhy('grow');
      await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); window.__setReview(structuredClone(window.__review))'); await settle();
      assert.equal(await cdp.evaluate("document.querySelectorAll('.notice-error').length"), 0, 'Why and unchanged host refreshes preserve dismissal');
      const newError = 'A new action failed.';
      await cdp.evaluate(`window.__setReview({ ...window.__review, error: ${JSON.stringify(newError)} })`); await settle();
      assert.deepEqual(await cdp.evaluate("Array.from(document.querySelectorAll('.notice-error p'), node => node.textContent)"), [newError], 'A different error is shown immediately');
      await clickDecision('grow', 'ignore');
      assert.deepEqual(await cdp.evaluate("Array.from(document.querySelectorAll('.notice-error p'), node => node.textContent)"), [newError, missing], 'A new review action reveals still-active errors again');
      assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('.button-accept')).every(button => button.disabled)"), true);
      assertAligned(await geometry()); await assertTextProjection();
    });

  }
}
async function main() {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.split(/\r?\n/).some(line => /^\/?\.codex-\*\/?$/.test(line.trim()) || /^\/?\.codex-test-ui\/?$/.test(line.trim())),
    'Refuse to create artifacts until .codex-test-ui is ignored.');
  const executable = await findBrowser();
  await fs.mkdir(runDir, { recursive: true }); runCreated = true;
  const url = await startServer();
  console.log('Browser: ' + executable); console.log('Artifacts: ' + runDir);
  await startBrowser(executable, url);
  await runLayoutTests();
  assert.equal(cdp.exceptions.length, 0, 'Production JavaScript must not throw browser exceptions');
  console.log('Real browser layout: ' + results.length + '/' + results.length + ' checks passed.');
}

main().catch(async error => {
  process.exitCode = 1; console.error(error.stack || error);
  if (cdp) try { await screenshot('failure'); } catch { /* Retain other evidence if the page exited. */ }
}).finally(async () => {
  if (runCreated) {
    const report = { timestamp: new Date().toISOString(), passed: results.filter(item => item.passed).length,
      failed: results.filter(item => !item.passed).length, complete: !process.exitCode, results,
      browserExceptions: cdp?.exceptions || [], artifactDirectory: runDir };
    await fs.writeFile(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(scratchRoot, 'latest-results.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(runDir, 'browser.log'), browserLog);
  }
  if (cdp) { try { await cdp.send('Browser.close'); } catch { /* Browser may close the socket before replying. */ } cdp.socket.close(); }
  if (browser && browser.exitCode === null) {
    await Promise.race([once(browser, 'exit'), delay(2000)]);
    if (browser.exitCode === null) browser.kill();
  }
  if (server) await new Promise(resolve => server.close(resolve));
});
