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
  return `'use strict';\nwindow.__xss = 0;\nwindow.__messages = [];\nwindow.__savedState = {};\nwindow.__fixture = ${JSON.stringify(fixture)};\n` +
    `window.__setReview = next => { window.__review = structuredClone(next); window.dispatchEvent(new MessageEvent('message', { data: window.__review })); };\n` +
    `window.acquireVsCodeApi = () => ({ getState: () => window.__savedState, setState: value => { window.__savedState = value; }, postMessage: message => {\n` +
    `window.__messages.push(structuredClone(message));\n` +
    `if (message.type === 'decide' || message.type === 'decideFile' || message.type === 'undo') {\n` +
    `const next = structuredClone(window.__review); const file = next.files.find(item => item.path === message.filePath);\n` +
    `if (!file || message.revision !== next.revision) throw new Error('Invalid decision transport');\n` +
    `if (message.type === 'undo') { const hunk = file.hunks.find(item => item.id === message.hunkId); if (!hunk || hunk.decision === 'pending') throw new Error('Invalid undo transport'); hunk.decision = 'pending'; }\n` +
    `else for (const hunk of file.hunks) if (hunk.decision === 'pending' && (message.type === 'decideFile' || hunk.id === message.hunkId)) hunk.decision = message.decision;\n` +
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
    assert.ok(Math.abs(pair.left.width - pair.right.width) < 1.1, 'Pair ' + index + ' has equal column widths');
  }
  for (const pair of [...measurements.headings, ...measurements.rows]) assert.ok(Math.abs(measurements.banner.right.x - pair.right.x) < 1.1, 'Banner and source column dividers align horizontally');
  assert.ok(measurements.scroll.height > 150, 'Comparison retains a usable height');
  assert.ok(measurements.scroll.total > measurements.scroll.height, 'Fixture must overflow vertically');
}
async function assertTextProjection() {
  const actual = await cdp.evaluate(`(() => {
    const data = {};
    for (const side of ['left', 'right']) {
      const cells = Array.from(document.querySelectorAll('.code-side.' + side + '[data-line]'));
      data[side] = { text: cells.map(cell => cell.querySelector('.code-text').textContent.replace(/\u200b/g, '')).join('\\n'), numbers: cells.map(cell => Number(cell.dataset.line)) };
    }
    return { data, state: window.__review };
  })()`);
  const file = actual.state.files[0];
  for (const side of ['left', 'right']) {
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
        assert.ok(row.sourceEnd <= row.actionStart + 0.6, 'Source text is clipped before controls');
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
      assert.equal(popover.close.beforeWidth, '14px'); assert.equal(popover.close.afterWidth, '14px');
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
      await assertTextProjection();
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
