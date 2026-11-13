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
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const scratchRoot = path.join(root, '.codex-test-ui');
const runName = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(scratchRoot, runName);
const results = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser, server, cdp, computeInlineChanges, computeFileInlineChanges, parseRequestDocument, resolveRequest, createRequestViewHtml, browserLog = '', runCreated = false;

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
    trusted: true, busy: false, unchangedOpacity: 20, defaultLayout: 'sideBySide',
    files: [{ path: 'examples/manuscript.tex', before,
      reason: 'Reason <svg onload="window.__xss=6">literal content</svg>', hunks }] };
}
const fixture = createFixture();
fixture.files[0].hunks[0].explanation = 'Specific reason <img src=x onerror="window.__xss=7"> kept as text. ' + 'Additional context for this change. '.repeat(8);
fixture.files[0].hunks[1].explanation = '';
fixture.files[0].hunks[2].explanation = 'An insertion needs its own rationale.';
// The fourth hunk deliberately omits explanation; blank and absent are both disabled.

// Inline fixtures use the production core helper loaded in main().
function mockScript() {
  return `'use strict';\nwindow.__xss = 0;\nwindow.__messages = [];\nwindow.__savedState = JSON.parse(sessionStorage.getItem('rr-view-state') || '{}');\nwindow.__fixture = ${JSON.stringify(fixture)};\n` +
    `window.__setReview = next => { window.__review = structuredClone(next); window.dispatchEvent(new MessageEvent('message', { data: window.__review })); };\n` +
    `window.acquireVsCodeApi = () => ({ getState: () => window.__savedState, setState: value => { window.__savedState = value; sessionStorage.setItem('rr-view-state', JSON.stringify(value)); }, postMessage: message => {\n` +
    `window.__messages.push(structuredClone(message));\n` +
    `if (message.type === 'reviewActions' && !window.__deferReviewActions) { queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'reviewActionsResult',editId:message.editId,reviewActions:[{id:'comment',label:'Comment out changed lines',enabled:true},{id:'markRemoved',label:'Mark removed text in red',enabled:false,reason:'Test setup requires macros.'},{id:'markAdded',label:'Mark added text in blue',enabled:false,reason:'Test setup requires macros.'}]}}))); }\n` +
    `if (message.type === 'decide' || message.type === 'decideFile' || message.type === 'undo') {\n` +
    `if (window.__deferDecisions) return;\n` +
    `const next = structuredClone(window.__review); const file = next.files.find(item => item.path === message.filePath);\n` +
    `if (!file || message.revision !== next.revision) throw new Error('Invalid decision transport');\n` +
    `if (message.type === 'undo') { const hunk = file.hunks.find(item => item.id === message.hunkId); if (!hunk || hunk.decision === 'pending') throw new Error('Invalid undo transport'); hunk.decision = 'pending'; }\n` +
    `else for (const hunk of file.hunks) if (hunk.decision === 'pending' && (message.type === 'decideFile' || hunk.id === message.hunkId)) hunk.decision = message.decision;\n` +
    `if (next.closed && file.hunks.some(hunk => hunk.decision === 'pending')) next.closed = false;\n` +
    `window.__setReview(next); if(message.quickDecisionId && !window.__deferQuickAck) queueMicrotask(()=>window.dispatchEvent(new MessageEvent("message",{data:{type:"quickDecisionResult",quickDecisionId:message.quickDecisionId,filePath:message.filePath,hunkId:message.hunkId,decision:message.decision,success:true}}))); }\n` +
    `} });\n`;
}

async function startServer() {
  const [css,js,createCss,createJs] = await Promise.all(['review.css','review.js','create-request.css','create-request.js'].map(name=>fs.readFile(path.join(root,'media',name))));
  const createTheme = ':root{--vscode-foreground:#d4d4d4;--vscode-editor-background:#1e1e1e;--vscode-descriptionForeground:#aaa;--vscode-input-background:#252526;--vscode-input-foreground:#d4d4d4;--vscode-panel-border:#555;--vscode-button-secondaryForeground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryHoverBackground:#45494e;--vscode-button-foreground:#fff;--vscode-button-background:#0e639c;--vscode-button-hoverBackground:#1177bb;--vscode-focusBorder:#007fd4;--vscode-errorForeground:#f48771;}';
  let createHtml = createRequestViewHtml({cspSource:"'self'",asWebviewUri:uri=>({toString:()=>'/'+path.basename(uri.fsPath)})},{fsPath:root});
  const nonce = createHtml.match(/<script nonce="([^"]+)"/)[1];
  createHtml = createHtml.replace('</head>','<link rel="stylesheet" href="/create-theme.css"></head>').replace('<script nonce=', '<script nonce="'+nonce+'" src="/create-mock.js"></script><script nonce=');
  const createMock = "window.__createMessages=[];window.__xss=0;window.__setCreate=state=>{window.__createState=structuredClone(state);window.dispatchEvent(new MessageEvent('message',{data:state}));};window.acquireVsCodeApi=()=>({postMessage:message=>window.__createMessages.push(structuredClone(message)),getState:()=>({}),setState:()=>{}});";
  const html = Buffer.from('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Revision Request layout fixture</title><link rel="stylesheet" href="/review.css"></head><body><div id="app"></div><script src="/mock.js"></script><script src="/review.js"></script></body></html>');
  const routes = new Map([
    ['/', ['text/html; charset=utf-8', html]],
    ['/review.css', ['text/css; charset=utf-8', css]],
    ['/review.js', ['text/javascript; charset=utf-8', js]],
    ['/mock.js', ['text/javascript; charset=utf-8', Buffer.from(mockScript())]],
    ['/create', ['text/html; charset=utf-8', Buffer.from(createHtml)]],
    ['/create-request.css', ['text/css; charset=utf-8', createCss]],
    ['/create-request.js', ['text/javascript; charset=utf-8', createJs]],
    ['/create-theme.css', ['text/css; charset=utf-8', Buffer.from(createTheme)]],
    ['/create-mock.js', ['text/javascript; charset=utf-8', Buffer.from(createMock)]]
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
    button.focus({preventScroll:true}); button.click();
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
      injected: Array.from(document.querySelectorAll('#app img,#app svg,#app script')).filter(node=>!node.matches('.quick-review-toggle > svg.quick-review-icon')).length, xss: window.__xss };
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
    assert.ok(common.length >= 2, 'Separated word edits retain common source text');
    const oldSide = side === 'left';
    const expected = fixture.files[0].hunks[0].inlineChanges[0][oldSide ? 'before' : 'after'];
    assert.deepEqual(changed.map(span => span.text), expected.filter(segment => segment.changed).map(segment => segment.text),
      'Rendering preserves the language-specific highlight boundaries supplied by the core');
    assert.equal(value.text, fixture.files[0].hunks[0][side === 'left' ? 'before' : 'after'].split('\n')[0], 'Spans preserve exact LaTeX/Unicode text');
    assert.ok(value.text.includes('한글') && value.text.includes(side === 'left' ? '😀' : '😃'), 'Unicode stays literal');
    assert.ok(lineHighlight ? value.backgroundAlpha > 0 : value.backgroundAlpha === 0, 'Only the row tint follows Highlight Changed Lines');
    for (const span of changed) {
      assert.ok(span.backgroundAlpha > 0 && span.backgroundAlpha > value.backgroundAlpha, 'Changed words retain a stronger background');
      assert.ok(span.colorAlpha > 0, 'Changed words remain visible');
    }
    for (const span of common) assert.ok(onlyChanged ? span.colorAlpha === 0 : span.colorAlpha > 0, 'Only common pending words follow Show Only Changed Text');
    if (baseline) assert.deepEqual(changed.map(span => span.background), baseline.sides[side].spans.filter(span => span.changed).map(span => span.background), 'Word highlights are independent of both settings');
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
  await cdp.evaluate('(() => { const existing=document.querySelector(".why-popover"); if(existing){existing.querySelector(".why-close").click();return;} const toggle=Array.from(document.querySelectorAll(".why-toggle")).find(item=>item.dataset.whyId==='+JSON.stringify(id)+'); if(!toggle || toggle.disabled)throw Error("Expected enabled actions button");toggle.click(); document.querySelector(".review-action-why")?.click(); })()');
  await settle();
}
async function clickMore(id) {
  await cdp.evaluate('(() => { const toggle=Array.from(document.querySelectorAll(".review-menu-toggle")).find(item=>item.dataset.whyId==='+JSON.stringify(id)+');if(!toggle || toggle.disabled)throw Error("Expected enabled actions button");toggle.click(); })()');
  await settle();
}
async function assertNoLayoutShift(before) {
  const after = await geometry(); assertAligned(after);
  assert.deepEqual(after.rows, before.rows, 'Popover must not move source rows');
  assert.deepEqual(after.banner, before.banner, 'Popover must not change banner height');
  assert.equal(after.scroll.top, before.scroll.top, 'Popover must not move the shared scroll position');
}

async function editSnapshot() {
  return cdp.evaluate("(() => { const editor = document.querySelector('.pending-editor'); if (!editor) return null; const area = editor.querySelector('textarea'); const box = editor.getBoundingClientRect(); const areaBox = area.getBoundingClientRect(); const gutter = editor.querySelector('.action-gutter').getBoundingClientRect(); return {draft:area.value, readOnly:area.readOnly, wrap:area.wrap, whiteSpace:getComputedStyle(area).whiteSpace, selection:[area.selectionStart,area.selectionEnd], direction:area.selectionDirection, scroll:[area.scrollTop,area.scrollLeft], error:editor.querySelector('.pending-editor-error')?.textContent, acceptDisabled:editor.querySelector('[data-focus-key=\"edit:accept\"]').disabled, focused:document.activeElement.dataset.focusKey, rect:{x:box.x,y:box.y,right:box.right,bottom:box.bottom}, area:{x:areaBox.x,right:areaBox.right,width:area.clientWidth,scrollWidth:area.scrollWidth}, gutter:{x:gutter.x,right:gutter.right}, position:getComputedStyle(editor).position, role:editor.getAttribute('role'), buttons:Array.from(editor.querySelectorAll('.action-gutter button'),node=>node.textContent), persisted:window.__savedState.editing}; })()");
}
async function directEditorSnapshot(id, remember = false) {
  return cdp.evaluate(`(() => {
    const source = Array.from(document.querySelectorAll('[data-edit-hunk]')).find(node => node.dataset.editHunk === ${JSON.stringify(id)});
    const area = source?.querySelector('textarea');
    if (!area) throw new Error('Pending source must already contain its native input before focus');
    const mirror = source.querySelector('.code-text'), row = source.closest('.diff-row');
    const rect = node => { const box = node.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width,height:box.height}; };
    const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT); let first;
    while (walker.nextNode()) if (walker.currentNode.textContent.length) {first=walker.currentNode; break;}
    const glyph = document.createRange(); glyph.setStart(first,0); glyph.setEnd(first,1);
    const css = getComputedStyle(area), mirrorCss = getComputedStyle(mirror);
    const typography = style => Object.fromEntries(['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','tabSize','whiteSpace','wordBreak','overflowWrap'].map(key=>[key,style[key]]));
    if (${remember}) {window.__directPendingArea=area; window.__directPendingRow=row;}
    return {draft:area.value, text:mirror.textContent, row:rect(row), mirror:rect(mirror), glyph:rect(glyph), area:rect(area),
      sameInput:window.__directPendingArea===area, sameRow:window.__directPendingRow===row, focused:document.activeElement===area,
      selection:[area.selectionStart,area.selectionEnd], typography:typography(css), mirrorTypography:typography(mirrorCss),
      border:['Top','Right','Bottom','Left'].map(side=>css['border'+side+'Width']),
      padding:['Top','Right','Bottom','Left'].map(side=>css['padding'+side]), outline:css.outlineStyle,
      shadow:css.boxShadow, background:css.backgroundColor, cellBackground:getComputedStyle(source.closest('.code-side')).backgroundColor};
  })()`);
}
function assertSeamlessInput(snapshot) {
  assert.deepEqual(snapshot.border,['0px','0px','0px','0px'],'Native input adds no border');
  assert.deepEqual(snapshot.padding,['0px','0px','0px','0px'],'Native input adds no text inset');
  assert.equal(snapshot.outline,'none','Focus adds no blue outline');
  assert.equal(snapshot.shadow,'none','Native input adds no box shadow');
  assert.ok(['transparent','rgba(0, 0, 0, 0)'].includes(snapshot.background),'Native input leaves the code background visible');
  assert.deepEqual(snapshot.typography,snapshot.mirrorTypography,'Caret and selection use the same text metrics as the visible code');
  for (const coordinate of ['x','y','width','height']) {
    assert.ok(Math.abs(snapshot.area[coordinate]-snapshot.mirror[coordinate])<0.6,'Native input overlays the existing code '+coordinate);
  }
}
async function nativeEditorKey(key, modifiers = 0) {
  const keys = {Home:36,End:35,ArrowRight:39,ArrowLeft:37,ArrowUp:38,ArrowDown:40,PageUp:33,PageDown:34};
  const event = {key,code:key,windowsVirtualKeyCode:keys[key],nativeVirtualKeyCode:keys[key],modifiers};
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',...event});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...event});
  await settle();
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
  assert.deepEqual([...snapshot.buttons].sort(), ['Accept', 'Ignore', '⋯'], 'Editing keeps the normal decision controls');
}
async function originalProjection() {
  return cdp.evaluate("Array.from(document.querySelectorAll('.code-side.left[data-line] .code-text'),node=>node.textContent.replace(/\u200b/g,'')).join('\\n')");
}
function singleLineFixture(before = 'Old text.\n', after = 'New text.\n', targetPath = fixture.files[0].path) {
  const hunk = {id:'direct',index:0,start:0,end:before.length,before,after,oldStart:1,newStart:1,
    oldLines:before?1:0,newLines:after?1:0,decision:'pending',contextBefore:[],contextAfter:[]};
  hunk.inlineChanges = computeInlineChanges(hunk, 40, targetPath);
  return {...structuredClone(fixture),files:[{path:targetPath,
    before:before+Array.from({length:105},(_,index)=>'Unchanged context '+index+'\n').join(''),hunks:[hunk]}]};
}

async function runLanguageHighlightTests(width) {
  await runTest(width+'px: TeX atom groups, padding-only edits and commands render exact language-specific highlights', async () => {
    const cases = [
      ['f(a)', 'f(b)', ['(a)'], ['(b)']],
      ['f( a )', 'f( b )', ['( a )'], ['( b )']],
      ['{a} [ b ]', '{c} [ d ]', ['{a} [ b ]'], ['{c} [ d ]']],
      ['(x - y)', '(x + y)', ['-'], ['+']],
      ['a[i+1]', 'a[i+2]', ['i+1'], ['i+2']],
      ['(a)', '( a )', [], [' ', ' ']],
      ['(\\alpha)', '(\\beta)', ['(\\alpha)'], ['(\\beta)']],
      ['\\alpha(x)', '\\beta(x)', ['\\alpha'], ['\\beta']],
      ['(a)(b)', '(b)', ['(a)'], []],
      ['(a)', '( b )(a)', [], ['( b )']],
      ['((a))', '([b])', ['(a)'], ['[b]']],
      ['((a))', '((b))', ['(a)'], ['(b)']]
    ];
    for (const [before,after,oldChanged,newChanged] of cases) {
      await resetFixture(width);
      const current = singleLineFixture(before+'\n',after+'\n');
      await cdp.evaluate('window.__setReview('+JSON.stringify(current)+')'); await settle();
      const visible = await cdp.evaluate('(()=>{const result={};for(const side of ["left","right"]){const cell=document.querySelector(".hunk .code-side."+side),source=cell.querySelector(".code-source"),code=source.querySelector(".code-text"),box=source.getBoundingClientRect(),gutter=cell.querySelector(".action-gutter")?.getBoundingClientRect();result[side]={text:code.textContent,changed:Array.from(code.querySelectorAll(".inline-changed"),node=>node.textContent),width:source.clientWidth,scroll:source.scrollWidth,right:box.right,gutter:gutter?.left};}return result;})()');
      assert.equal(visible.left.text,before); assert.equal(visible.right.text,after);
      assert.deepEqual(visible.left.changed,oldChanged,before+' old highlights');
      assert.deepEqual(visible.right.changed,newChanged,after+' new highlights');
      for(const side of ['left','right']) assert.ok(visible[side].scroll<=visible[side].width+1,'Highlight grouping cannot hide source text');
      assert.ok(visible.right.right<=visible.right.gutter+.6,'Highlights stay inside the code column before buttons');
      assertAligned(await geometry()); await assertTextProjection();
      assert.equal(await cdp.evaluate('window.__messages.some(message=>["decide","undo","editAndAccept"].includes(message.type))'),false);
    }
    await screenshot('comparison-'+width+'-tex-highlight-groups');
    const python = singleLineFixture('f(a)\n','f(b)\n','examples/sample.py');
    await cdp.evaluate('window.__setReview('+JSON.stringify(python)+')'); await settle();
    assert.deepEqual(await cdp.evaluate('Array.from(document.querySelectorAll(".hunk .code-side.left .inline-changed"),node=>node.textContent)'),['a']);
    assert.deepEqual(await cdp.evaluate('Array.from(document.querySelectorAll(".hunk .code-side.right .inline-changed"),node=>node.textContent)'),['b']);
    await assertTextProjection(); await resetFixture(width);
  });
}

async function runProgrammingHighlightTests(width) {
  await runTest(width+'px: Python JS JSON and Markdown show exact token highlights in both layouts', async () => {
    const cases = [
      ['examples/main.py','a[i+1]','a[i+2]',['1'],['2']],
      ['examples/main.py','first_name = 0.95','last_name = 0.99',['first_name','0.95'],['last_name','0.99']],
      ['examples/app.ts','user?.name === 1','user?.title !== 1',['name ==='],['title !==']],
      ['examples/app.js','`Hello ${name}`','`Hello ${user}`',['name'],['user']],
      ['examples/config.json','{"old key": "old value"}','{"new key": "new value"}',['old key','old'],['new key','new']],
      ['examples/README.md','**old title**','**new title**',['old'],['new']],
    ];
    for (const [target,before,after,oldChanged,newChanged] of cases) {
      await resetFixture(width);
      await cdp.evaluate('window.__setReview('+JSON.stringify(singleLineFixture(before+'\n',after+'\n',target))+')'); await settle();
      for (const mode of ['sideBySide','unified']) {
        if (mode === 'unified') await toggleLayout();
        const visible=await cdp.evaluate('(()=>{const result={};for(const side of ["left","right"]){const code=document.querySelector(".hunk .code-side."+side+" .code-text");result[side]={text:code.textContent,changed:Array.from(code.querySelectorAll(".inline-changed"),node=>node.textContent)};}return result;})()');
        assert.equal(visible.left.text,before); assert.equal(visible.right.text,after);
        assert.deepEqual(visible.left.changed,oldChanged); assert.deepEqual(visible.right.changed,newChanged);
        if (mode === 'sideBySide') {assertAligned(await geometry()); await assertTextProjection();}
      }
      await toggleLayout();
    }
    await resetFixture(width);
    const source='# Example\n~~~python\na[i+1]\n~~~\n**old title**\n'+Array.from({length:105},(_,index)=>'Unchanged context '+index+'\n').join('');
    const doc={path:'examples/README.md',request:[{line:3,before:'1',after:'2',status:'pending'},{line:5,before:'old',after:'new',status:'pending'}]};
    const resolved=resolveRequest(doc,source), highlights=computeFileInlineChanges(resolved.file,resolved.hunks,{},1000);
    const state={...structuredClone(fixture),files:[{path:doc.path,before:source,hunks:resolved.hunks.map(hunk=>({...hunk,decision:'pending',inlineChanges:highlights.get(hunk.id)}))}]};
    await cdp.evaluate('window.__setReview('+JSON.stringify(state)+')'); await settle();
    assert.deepEqual(await cdp.evaluate('Array.from(document.querySelectorAll(".hunk"),hunk=>Array.from(hunk.querySelectorAll(".right .inline-changed"),span=>span.textContent))'),[['2'],['new']]);
    assertAligned(await geometry()); await assertTextProjection();
    await screenshot('comparison-'+width+'-language-highlights');
    await resetFixture(width);
  });
}

async function clickEditorOffset(offset, alt = true) {
  const point = await cdp.evaluate('(() => {const area=document.querySelector(".pending-editor textarea");area.scrollIntoView({block:"nearest"});const mirror=area.parentElement.querySelector(".code-text");const walker=document.createTreeWalker(mirror,NodeFilter.SHOW_TEXT);let remaining='+offset+',last;while(walker.nextNode()){last=walker.currentNode;if(remaining<=last.length)break;remaining-=last.length;}const range=document.createRange();range.setStart(last,Math.min(remaining,last.length));range.collapse(true);const rect=range.getBoundingClientRect();return {x:rect.x+.2,y:rect.y+rect.height/2};})()');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,modifiers:alt?1:0,...point});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,modifiers:alt?1:0,...point});
  await settle();
}
async function editorCursors() {return cdp.evaluate('({primary:[document.querySelector(".pending-editor textarea").selectionStart,document.querySelector(".pending-editor textarea").selectionEnd],secondary:window.__savedState.editing.secondarySelections||[],visible:document.querySelectorAll(".editor-extra-caret").length,count:Number(document.querySelector(".pending-editor textarea").dataset.cursorCount)})');}
async function runMulticursorTests(width) {
  const begin = async text => {await resetFixture(width);await openEdit('grow');await writeDraft(text);await clickEditorOffset(0,false);};
  await runTest(width+'px: Alt-click adds real inline cursors and simultaneous typing, deletion, undo, redo and selections',async()=>{
    await begin('alpha one\nbeta one\ngamma one');
    await clickEditorOffset(6,false);await clickEditorOffset(15);await clickEditorOffset(25);
    let cursors=await editorCursors();assert.equal(cursors.count,3);assert.equal(cursors.visible,2);
    assert.deepEqual(cursors.primary,[25,25]);assert.deepEqual(cursors.secondary.map(item=>item.start),[6,15]);
    await cdp.send('Input.insertText',{text:'X'});await settle();
    assert.equal((await editSnapshot()).draft,'alpha Xone\nbeta Xone\ngamma Xone');
    await editorKey('z',{ctrlKey:true});assert.equal((await editSnapshot()).draft,'alpha one\nbeta one\ngamma one');assert.equal((await editorCursors()).count,3);
    await editorKey('z',{ctrlKey:true,shiftKey:true});assert.equal((await editSnapshot()).draft,'alpha Xone\nbeta Xone\ngamma Xone');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await settle();
    assert.equal((await editSnapshot()).draft,'alpha one\nbeta one\ngamma one');
    await nativeEditorKey('ArrowRight',8);await nativeEditorKey('ArrowRight',8);await nativeEditorKey('ArrowRight',8);
    await cdp.send('Input.insertText',{text:'two'});await settle();assert.equal((await editSnapshot()).draft,'alpha two\nbeta two\ngamma two');
    await screenshot('multicursor-'+width);
    await editorKey('Escape');assert.equal((await editorCursors()).count,1);assert.ok(await editSnapshot(),'First Escape clears extra cursors without losing draft');
    await editorKey('Escape');assert.equal(await editSnapshot(),null);
  });
  await runTest(width+'px: multi-cursor paste, grapheme deletion and committed IME input preserve Unicode and cancel/save behavior',async()=>{
    await begin('a\nb');await clickEditorOffset(1,false);await clickEditorOffset(3);
    await cdp.evaluate('(()=>{const data=new DataTransfer();data.setData("text/plain","😀é");document.querySelector(".pending-editor textarea").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));})()');await settle();
    assert.equal((await editSnapshot()).draft,'a😀é\nb😀é');
    for(let i=0;i<2;i++){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}await settle();
    assert.equal((await editSnapshot()).draft,'a\nb','Backspace removes whole combining graphemes and emoji at all cursors');
    await cdp.send('Input.imeSetComposition',{text:'ㅎ',selectionStart:1,selectionEnd:1});await settle();
    assert.equal((await editSnapshot()).draft,'a\nbㅎ','Intermediate IME text is not duplicated');
    await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
    await cdp.send('Input.insertText',{text:'한'});await settle();
    assert.equal((await editSnapshot()).draft,'a한\nb한','One committed Korean composition is replicated once');
    await editorKey('z',{ctrlKey:true});assert.equal((await editSnapshot()).draft,'a\nb');
    await editorKey('y',{ctrlKey:true});assert.equal((await editSnapshot()).draft,'a한\nb한');
    assert.equal(await cdp.evaluate('window.__messages.filter(message=>message.type==="editAndAccept"||message.type==="decide").length'),0,'Multi-cursor edits are local drafts');
    await editorKey('Enter',{ctrlKey:true});
    const message=await cdp.evaluate('window.__messages.filter(message=>message.type==="editAndAccept").at(-1)');assert.equal(message.draft,'a한\nb한');
    await editAck(message,{ok:false,error:'Injected failure'});assert.equal((await editorCursors()).count,2,'Failed save retains all cursor positions');
    await editorKey('Escape');await editorKey('Escape');assert.equal(await editSnapshot(),null);
  });
  await runTest(width+'px: canceled composition keeps different selected words and unsupported native edits clear extra cursors',async()=>{
    await begin('red\nblue');await clickEditorOffset(0,false);await clickEditorOffset(4);await nativeEditorKey('ArrowRight',8);
    const selected=await editorCursors();assert.equal(selected.count,2);
    await cdp.evaluate('(()=>{const area=document.querySelector(".pending-editor textarea");area.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));area.dispatchEvent(new CompositionEvent("compositionend",{data:"",bubbles:true}));})()');await settle();
    assert.equal((await editSnapshot()).draft,'red\nblue','Canceling an untouched composition never copies one selected word over another');
    assert.deepEqual(await editorCursors(),selected);
    await cdp.evaluate('(()=>{const area=document.querySelector(".pending-editor textarea");area.dispatchEvent(new InputEvent("beforeinput",{inputType:"insertFromDrop",data:"!",bubbles:true,cancelable:false}));area.setRangeText("!",area.selectionStart,area.selectionEnd,"end");area.dispatchEvent(new InputEvent("input",{inputType:"insertFromDrop",data:"!",bubbles:true}));})()');await settle();
    assert.equal((await editorCursors()).count,1);assert.equal((await editSnapshot()).draft,'red\n!lue');
    await editorKey('z',{ctrlKey:true});assert.equal((await editSnapshot()).draft,'red\nblue','Native fallback remains undoable');
    await editorKey('Escape');
  });
  await runTest(width+'px: wrapped Alt-click positions and multi-cursor drafts survive refresh and resize',async()=>{
    const draft='prefix '+('long_token '.repeat(25))+'END\nsecond END';
    await begin(draft);await clickEditorOffset(draft.indexOf('END'),false);await clickEditorOffset(draft.lastIndexOf('END'));
    assert.equal((await editorCursors()).count,2);
    await cdp.evaluate('window.__setReview(structuredClone(window.__review))');await settle();
    assert.equal((await editSnapshot()).draft,draft);assert.equal((await editorCursors()).count,2);assert.equal((await editorCursors()).visible,1);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:width+100,height:850,deviceScaleFactor:1,mobile:false});await settle();
    assert.equal((await editorCursors()).count,2);await cdp.send('Input.insertText',{text:'new_'});await settle();
    assert.equal((await editSnapshot()).draft,draft.replaceAll('END','new_END'));
    await editorKey('a',{ctrlKey:true});await cdp.evaluate('document.querySelector(".pending-editor textarea").select()');await cdp.send('Input.insertText',{text:'one whole buffer'});await settle();
    assert.equal((await editSnapshot()).draft,'one whole buffer');assert.equal((await editorCursors()).count,1,'Select all returns to a single selection');
    await editorKey('Escape');await resetFixture(width);
  });
}
async function runEditorTests(width) {
  await resetFixture(width);
  await runTest(width + 'px: clicking a pending line preserves its native input, glyph position, and row height', async () => {
    const directState = singleLineFixture(), after = directState.files[0].hunks[0].after;
    await cdp.evaluate('window.__setReview('+JSON.stringify(directState)+')'); await settle();
    const initial = await directEditorSnapshot('direct',true), layout = await geometry();
    assert.equal(initial.draft,'New text.','The structural terminal newline does not create an editable blank row');
    assertSeamlessInput(initial);
    await openEdit('direct');
    const focused = await directEditorSnapshot('direct');
    assert.equal(focused.sameInput,true,'The first click keeps the existing textarea DOM and native selection');
    assert.equal(focused.sameRow,true,'The first click keeps the existing comparison row DOM');
    assert.equal(focused.focused,true); assertSeamlessInput(focused);
    assert.deepEqual(focused.row,initial.row,'Focusing a one-line proposal adds no row height');
    assert.deepEqual(focused.glyph,initial.glyph,'Visible code glyphs do not move when editing starts');
    assert.equal(focused.cellBackground,initial.cellBackground,'Focusing adds no separate editor background');
    assert.deepEqual((await geometry()).rows,layout.rows,'Focusing shifts no comparison row');
    assertInlineEditor(await editSnapshot(),width);
    await screenshot('comparison-'+width+'-direct-pending-editor');
    await nativeEditorKey('Home',2);
    for (let index=0;index<3;index++) await nativeEditorKey('ArrowRight',8);
    assert.deepEqual((await editSnapshot()).selection,[0,3],'Real keyboard selection addresses the visible word');
    await cdp.send('Input.insertText',{text:'Fresh'}); await settle();
    const typed = await directEditorSnapshot('direct');
    assert.equal(typed.draft,'Fresh text.','Real keyboard input replaces the selected pending word');
    assert.equal(typed.text,typed.draft,'The visible code mirror follows native keyboard edits');
    assert.equal(typed.sameInput,true,'Typing retains the original input DOM');
    assert.equal(typed.row.height,initial.row.height,'A one-line keyboard edit adds no blank row');
    assert.deepEqual(typed.selection,[5,5],'Native selection collapses after the inserted word');
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'),after,'An unsaved edit leaves the proposal state intact');
    await screenshot('comparison-'+width+'-direct-pending-typed');
    await editorKey('Escape');
    assert.equal(await editSnapshot(),null); await assertTextProjection(); assertAligned(await geometry());
    await resetFixture(width);
  });
  await runTest(width + 'px: lightweight busy updates preserve the active input, selection, and comparison rows', async () => {
    await cdp.evaluate('window.__setReview('+JSON.stringify(singleLineFixture())+')'); await settle();
    await openEdit('direct');
    await cdp.evaluate("(() => {const area=document.querySelector('.pending-editor textarea');area.setSelectionRange(1,5,'backward');area.dispatchEvent(new Event('select'));window.__busyArea=area;window.__busyRows=Array.from(document.querySelectorAll('.diff-row'));})()");
    const before=await editSnapshot(), layout=await geometry();
    await cdp.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'busy',busy:true}}))"); await settle();
    const busy=await editSnapshot();
    assert.equal(await cdp.evaluate("window.__busyArea===document.querySelector('.pending-editor textarea')&&window.__busyRows.every((row,index)=>row===document.querySelectorAll('.diff-row')[index])"),true,'Busy notification replaces neither input nor rows');
    assert.equal(busy.draft,before.draft); assert.deepEqual(busy.selection,before.selection); assert.equal(busy.direction,'backward');
    assert.equal(busy.readOnly,true); assert.equal(busy.acceptDisabled,true); assert.equal(busy.focused,'edit:draft');
    assert.deepEqual((await geometry()).rows,layout.rows);
    await cdp.send('Input.insertText',{text:'blocked'}); await settle();
    assert.equal((await editSnapshot()).draft,before.draft,'Busy input cannot accept an accidental edit');
    await cdp.evaluate("window.__setReview({...window.__review,busy:false})"); await settle();
    assert.equal((await editSnapshot()).direction,'backward','Full refresh restores the active end of a selection');
    await nativeEditorKey('ArrowRight',8);
    assert.deepEqual((await editSnapshot()).selection,[2,5],'Shift+Right shrinks the backward selection from its active start');
    await editorKey('Escape'); await resetFixture(width);
  });
  await runTest(width + 'px: typing into a deletion consistently shows a proposed line before and after refresh', async () => {
    await cdp.evaluate('window.__setReview('+JSON.stringify(singleLineFixture('Old text.\n',''))+')'); await settle();
    await openEdit('direct');
    const appearance=()=>cdp.evaluate("(() => {const cell=document.querySelector('.pending-editor');return {added:cell.classList.contains('added'),empty:cell.classList.contains('empty'),number:cell.querySelector('.line-number').textContent,marker:cell.querySelector('.line-marker').textContent,background:getComputedStyle(cell).backgroundImage,text:cell.querySelector('.code-text').textContent.replace(/\\u200b/g,'')};})()");
    const blank=await appearance(); assert.equal(blank.empty,true); assert.equal(blank.number,'');
    await cdp.send('Input.insertText',{text:'Replacement'}); await settle();
    const typed=await appearance();
    assert.equal(typed.added,true); assert.equal(typed.empty,false); assert.equal(typed.number,'1'); assert.equal(typed.marker,'+'); assert.equal(typed.background,'none');
    await cdp.evaluate('window.__setReview(structuredClone(window.__review))'); await settle();
    assert.deepEqual(await appearance(),typed,'A host refresh does not change deletion-draft presentation');
    await writeDraft(''); const emptied=await appearance();
    assert.equal(emptied.empty,true); assert.equal(emptied.number,''); assert.equal(emptied.marker,' ');
    await editorKey('Escape'); await resetFixture(width);
  });
  await runTest(width + 'px: one click edits pending code in place, reserves the action rail, and cancel restores the proposal', async () => {
    const original = await originalProjection();
    const originalInline = await cdp.evaluate("Array.from(document.querySelectorAll('[data-hunk-row=\"grow\"] .code-side.left .inline-common,[data-hunk-row=\"grow\"] .code-side.left .inline-changed'),node=>({text:node.textContent,changed:node.classList.contains('inline-changed')}))");
    await openEdit('grow', 'click', 1);
    const editingInline = await cdp.evaluate("Array.from(document.querySelectorAll('.hunk-editing .code-side.left .inline-common,.hunk-editing .code-side.left .inline-changed'),node=>({text:node.textContent,changed:node.classList.contains('inline-changed')}))");
    assert.deepEqual(editingInline,originalInline,'In-place editing preserves the original side intraline highlights and common text');
    assert.ok(editingInline.some(part=>part.changed)&&editingInline.some(part=>!part.changed));
    let opened = await editSnapshot();
    assert.equal(opened.draft, fixture.files[0].hunks[0].after.replace(/\n$/, ''), 'Editing exposes the complete pending hunk without its structural terminal newline');
    assert.equal(opened.focused, 'edit:draft');
    assertInlineEditor(opened, width);
    const clickedRowStart = fixture.files[0].hunks[0].after.indexOf('\n') + 1;
    const clickedRowEnd = fixture.files[0].hunks[0].after.indexOf('\n', clickedRowStart);
    assert.ok(opened.selection[0] >= clickedRowStart && opened.selection[0] <= clickedRowEnd, 'Caret starts within the clicked proposed row');
    assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('.inline-actions button,.file-actions button')).filter(button=>!button.dataset.focusKey?.startsWith('edit:')).every(button=>button.disabled)"), true, 'Drafting blocks review decisions');
    const messages = await cdp.evaluate('window.__messages.length');
    await cdp.evaluate("Array.from(document.querySelectorAll('.inline-actions button')).find(node=>node.textContent==='Accept'&&!node.dataset.focusKey?.startsWith('edit:'))?.click()");
    assert.equal(await cdp.evaluate('window.__messages.length'), messages, 'Disabled Accept cannot submit a decision');
    assertAligned(await geometry());
    assert.equal(await originalProjection(), original, 'Entering an editor preserves every original line');
    await screenshot('comparison-' + width + '-pending-editor');
    await cdp.send('Input.insertText', {text:'Typed directly. '}); await settle();
    opened = await editSnapshot();
    assert.ok(opened.draft.includes('Typed directly. '), 'Real keyboard input edits the focused inline textarea');
    await writeDraft('Unsubmitted draft <script>window.__xss=99</script>\n');
    await cdp.evaluate("document.querySelector('[data-focus-key=\"edit:accept\"]').focus()");
    await editorKey('Escape');
    assert.equal(await editSnapshot(), null, 'Escape from any editor control cancels');
    assert.equal(await cdp.evaluate('document.activeElement.dataset.editRow'), '1', 'Cancel restores the clicked row, including a non-first row');
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'), fixture.files[0].hunks[0].after);
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').length"), 0);
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
  await runTest(width + 'px: multiline inline draft and caret survive busy refreshes; stale revisions never retarget acceptance', async () => {
    await openEdit('grow', 'F2');
    const draft = '\t' + 'long_draft '.repeat(35) + '<img src=x onerror="window.__xss=91">\n' + 'draft line\n'.repeat(20);
    await writeDraft(draft);
    await cdp.evaluate("(() => { const area=document.querySelector('.pending-editor textarea'); area.setSelectionRange(7,19); area.dispatchEvent(new Event('select')); })()");
    const prior = await editSnapshot(); assertInlineEditor(prior, width);
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=44; window.__setReview({...window.__review,busy:true})"); await settle();
    let current = await editSnapshot();
    assert.equal(current.draft,draft); assert.deepEqual(current.selection,prior.selection); assert.deepEqual(current.scroll,prior.scroll);
    assert.equal(current.persisted.draft,draft); assert.equal(current.acceptDisabled,true); assert.equal(current.focused,'edit:draft');
    assertInlineEditor(current, width);
    assert.equal((await geometry()).scroll.top,44); assertAligned(await geometry());
    await cdp.evaluate("window.__setReview({...window.__review,busy:false})"); await settle();
    assert.equal((await editSnapshot()).acceptDisabled,false);
    const originalRevision = (await editSnapshot()).persisted.revision;
    await cdp.evaluate("window.__setReview({...window.__review,revision:'externally-changed'})"); await settle();
    current = await editSnapshot();
    assert.equal(current.draft,draft); assert.equal(current.persisted.revision,originalRevision); assert.equal(current.acceptDisabled,true);
    assert.ok(current.error.includes('request changed')); assert.equal(current.focused,'edit:draft');
    await editorKey('Enter',{ctrlKey:true});
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').length"),0, 'Stale shortcut cannot submit with a newer revision');
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
      assert.equal(editor.draft,draft); assert.equal(editor.acceptDisabled,true);
      assert.notEqual(editor.position,'fixed'); assert.notEqual(editor.role,'dialog');
      assert.ok(editor.area.width > 40, 'Stale draft retains a visible text area');
      assert.ok(editor.error.includes('request changed'));
      await cdp.evaluate("document.querySelector('.pending-editor textarea').select()");
      assert.deepEqual((await editSnapshot()).selection,[0,draft.length],'The complete draft remains selectable for copying');
      await editorKey('Escape');
      assert.equal(await editSnapshot(),null);
    }
    await resetFixture(width);
  });
  await runTest(width + 'px: inline Accept correlates acknowledgements, keeps failed drafts, and applies the edited block', async () => {
    await openEdit('grow');
    const draft = 'Edited proposal <svg onload="window.__xss=92">literal</svg>.\nA second revised line.\n';
    await writeDraft(draft);
    await editorKey('Enter',{ctrlKey:true});
    let message = await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').at(-1)");
    assert.deepEqual({...message,editId:undefined},{type:'editAndAccept',filePath:fixture.files[0].path,hunkId:'grow',draft,revision:fixture.revision,editId:undefined});
    assert.ok(typeof message.editId==='string' && message.editId.length>0);
    assert.equal((await editSnapshot()).readOnly,true); assert.equal((await editSnapshot()).acceptDisabled,true);
    await editAck(message,{success:true,editId:'unrelated-edit-id',revision:'unrelated-revision'});
    assert.equal((await editSnapshot()).draft,draft,'Unrelated acknowledgements cannot close or change a draft');
    await cdp.evaluate("window.__setReview({...window.__review,busy:true})"); await settle();
    assert.equal((await editSnapshot()).draft,draft);
    await cdp.evaluate("window.__setReview({...window.__review,busy:false})"); await settle();
    const error = 'Accept failed <img src=x onerror="window.__xss=93">.';
    await editAck(message,{success:false,error});
    let editor = await editSnapshot();
    assert.equal(editor.draft,draft); assert.equal(editor.error,error); assert.equal(editor.readOnly,false); assert.equal(editor.acceptDisabled,false); assert.equal(editor.focused,'edit:draft');
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'),fixture.files[0].hunks[0].after,'Failed acceptance retains original proposal');
    await editorKey('Enter',{metaKey:true});
    const retry = await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').at(-1)");
    assert.notEqual(retry.editId,message.editId); assert.equal(retry.revision,fixture.revision); assert.equal(retry.draft,draft);
    await editAck(message,{success:false,error:'Delayed first result'});
    assert.equal((await editSnapshot()).readOnly,true,'Old attempt cannot unlock a newer pending acceptance');
    await cdp.evaluate("(() => { const next=structuredClone(window.__review); next.revision='browser-edited-v2'; const hunk=next.files[0].hunks[0]; hunk.after=" + JSON.stringify(draft) + "; hunk.id='grow-edited'; hunk.decision='accepted'; hunk.newLines=2; delete hunk.inlineChanges; window.__setReview(next); })()");
    await settle();
    assert.equal((await editSnapshot()).draft,draft,'New state before acknowledgement still preserves the draft');
    assert.ok((await originalProjection()).includes(draft.trimEnd()),'The accepted state displays the edited original');
    await editAck(retry,{success:true,revision:'browser-edited-v2',changed:true});
    assert.equal(await editSnapshot(),null,'Only matching successful acknowledgement closes the editor');
    assert.equal(await cdp.evaluate('document.activeElement.dataset.editHunk'),'delete','Focus advances to the next pending block');
    assert.equal(await cdp.evaluate('window.__savedState.editing'),null);
    assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].decision'),'accepted');
    assert.ok((await originalProjection()).includes(draft.trimEnd()),'The accepted edited text appears in the original projection');
    await assertTextProjection(); assertAligned(await geometry()); assert.equal(await cdp.evaluate('window.__xss'),0);
    await screenshot('comparison-' + width + '-edited-proposal');
    await resetFixture(width);
  });
}

async function runEditorDecisionTests(width) {
  await runTest(width+'px: configured editor shortcuts approve once and retain drafts across settings, IME and failed decisions',async()=>{
    await resetFixture(width);await openEdit('grow');await writeDraft('Editable draft');
    const sent=()=>cdp.evaluate('window.__messages.filter(message=>message.type==="editAndAccept")');
    const setting=async value=>{await cdp.evaluate('window.__setReview({...window.__review,acceptShortcut:'+JSON.stringify(value)+'})');await settle();};
    await setting('ctrlEnter');await editorKey('Tab');assert.equal((await editSnapshot()).draft,'Editable draft\t','Default Tab still inserts indentation');assert.equal((await sent()).length,0);
    await setting('none');await editorKey('Enter',{ctrlKey:true});await editorKey('Enter',{altKey:true});assert.equal((await sent()).length,0);
    const draft=(await editSnapshot()).draft;
    for(const [name,key,modifiers] of [['ctrlEnter','Enter',{ctrlKey:true}],['altEnter','Enter',{altKey:true}],['tab','Tab',{}],['shiftTab','Tab',{shiftKey:true}],['unexpected','Enter',{metaKey:true}]]) {
      await setting(name);assert.equal((await editSnapshot()).draft,draft,'Setting refresh never loses typed text');
      const count=(await sent()).length;
      await editorKey(key,{...modifiers,isComposing:true});await editorKey(key,{...modifiers,keyCode:229});await editorKey(key,{...modifiers,repeat:true});
      assert.equal((await sent()).length,count,'IME and held keys cannot approve');
      await editorKey(key,{...modifiers,ctrlKey:true,metaKey:true,altKey:true,shiftKey:true});assert.equal((await sent()).length,count,'Non-matching modifier combinations cannot approve');
      await editorKey(key,modifiers);const messages=await sent();assert.equal(messages.length,count+1);assert.equal(messages.at(-1).draft,draft);
      await editorKey(key,modifiers);assert.equal((await sent()).length,count+1,'An outstanding decision prevents duplicate approval');
      await editAck(messages.at(-1),{success:false,error:'Retain this draft.'});assert.equal((await editSnapshot()).draft,draft);
    }
    await setting('none');await cdp.evaluate("document.querySelector('[data-focus-key=\"edit:accept\"]').click()");await settle();
    const last=(await sent()).at(-1);assert.equal(last.draft,draft,'Accept button remains available with shortcuts disabled');
    await editAck(last,{success:false,error:'Retain this draft.'});await editorKey('Escape');await resetFixture(width);
  });
  await runTest(width+'px: editing Why preserves the draft and correlated Ignore discards it only after success',async()=>{
    await resetFixture(width);await openEdit('grow');await writeDraft('An unaccepted local draft.');
    const original=await originalProjection(),before=await geometry();
    await clickWhy('grow');assert.equal((await editSnapshot()).draft,'An unaccepted local draft.');await assertNoLayoutShift(before);
    await cdp.evaluate('document.querySelector(".why-popover .why-close").click()');await settle();
    assert.equal((await editSnapshot()).draft,'An unaccepted local draft.');
    const ignore=async()=>{await cdp.evaluate("document.querySelector('[data-focus-key=\"edit:ignore\"]').click()");await settle();return cdp.evaluate('window.__messages.filter(message=>message.type==="ignoreEdited").at(-1)');};
    const first=await ignore();assert.ok(first);assert.equal(first.draft,undefined,'Ignore never persists edited draft text');assert.equal((await editSnapshot()).readOnly,true);
    await editAck(first,{success:false,error:'Ignore failed.'});assert.equal((await editSnapshot()).draft,'An unaccepted local draft.');assert.equal((await editSnapshot()).readOnly,false);
    const second=await ignore();assert.notEqual(second.editId,first.editId);
    await editAck(first,{success:true,revision:'late-first'});assert.equal((await editSnapshot()).readOnly,true,'Late previous replies cannot discard this draft');
    await cdp.evaluate('(()=>{const next=structuredClone(window.__review);next.revision="ignored-v2";next.files[0].hunks[0].decision="ignored";window.__setReview(next);})()');await settle();
    assert.ok(await editSnapshot(),'Keep draft until its matching result arrives');await editAck(second,{success:true,revision:'ignored-v2'});
    assert.equal(await editSnapshot(),null);assert.equal(await originalProjection(),original);assert.equal(await cdp.evaluate('window.__review.files[0].hunks[0].after'),fixture.files[0].hunks[0].after);
    await resetFixture(width);
  });
}

async function runReviewActionTests(width) {
  await runTest(width+'px: More actions floats without starting an editor and supports keyboard navigation',async()=>{
    await resetFixture(width);if((await unifiedSnapshot()).unified)await toggleLayout();
    const before=await geometry();await clickMore('grow');await assertNoLayoutShift(before);
    const request=await cdp.evaluate("window.__messages.filter(m=>m.type==='reviewActions').at(-1)");
    assert.equal(request.hunkId,'grow');assert.equal(request.draft,fixture.files[0].hunks[0].after.replace(/\n$/,''));
    assert.equal(await cdp.evaluate('Boolean(document.querySelector(".pending-editor"))'),false);
    const menu=await cdp.evaluate('(() => {const m=document.querySelector(".review-action-menu"),r=m.getBoundingClientRect();return {role:m.getAttribute("role"),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()');
    assert.equal(menu.role,'menu');assert.ok(menu.x>=0&&menu.y>=0&&menu.right<=menu.width+1&&menu.bottom<=menu.height+1);
    await screenshot('review-actions-'+width);
    await cdp.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    assert.equal(await cdp.evaluate('document.activeElement.dataset.reviewAction'),'comment');
    await cdp.evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await settle();
    assert.equal(await cdp.evaluate('Boolean(document.querySelector(".review-action-menu"))'),false);
    assert.equal(await cdp.evaluate('document.activeElement.dataset.whyId'),'grow');
  });
  await runTest(width+'px: actions transform only the draft, retain Accept, and support local Undo',async()=>{
    await resetFixture(width);await clickMore('grow');
    const before=await cdp.evaluate('JSON.stringify(window.__review)');
    await cdp.evaluate('document.querySelector("[data-review-action=comment]").click()');await settle();
    const sent=await cdp.evaluate("window.__messages.filter(m=>m.type==='transformDraft').at(-1)");
    assert.equal(sent.action,'comment');assert.equal(sent.revision,fixture.revision);
    const draft='% '+sent.draft;
    await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'transformResult',editId:sent.editId,draft})+'}))');await settle();
    assert.equal((await editSnapshot()).draft,draft);assert.deepEqual((await editSnapshot()).buttons.sort(),['Accept','Ignore','⋯']);
    assert.equal(await cdp.evaluate('JSON.stringify(window.__review)'),before);
    assert.equal(await cdp.evaluate("window.__messages.filter(m=>['editPending','editAndAccept','decide'].includes(m.type)).length"),0);
    await editorKey('z',{ctrlKey:true});assert.equal((await editSnapshot()).draft,sent.draft);
    await clickMore('grow');const capabilities=await cdp.evaluate("window.__messages.filter(m=>m.type==='reviewActions').at(-1)");assert.equal(capabilities.draft,sent.draft);
    assert.equal(await cdp.evaluate('document.querySelector(".review-menu-setup").disabled'),true);
    await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await editorKey('Escape');await resetFixture(width);
  });
  await runTest(width+'px: failed transforms keep draft and stale responses cannot overwrite it',async()=>{
    await resetFixture(width);await clickMore('grow');await cdp.evaluate('document.querySelector("[data-review-action=comment]").click()');await settle();
    const sent=await cdp.evaluate("window.__messages.filter(m=>m.type==='transformDraft').at(-1)");
    await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'transformResult',editId:'stale',draft:'wrong'})+'}))');await settle();
    assert.equal((await editSnapshot()).draft,sent.draft);
    await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'transformResult',editId:sent.editId,error:'Cannot transform this syntax.'})+'}))');await settle();
    assert.equal((await editSnapshot()).draft,sent.draft);assert.equal(await cdp.evaluate('document.querySelector(".pending-editor-error").textContent'),'Cannot transform this syntax.');
    await editorKey('Escape');await resetFixture(width);
  });
}


function quickFixture() {
  const filePath='examples/quick-review.tex',positions=[5,45,90,130];
  const lines=Array.from({length:150},(_,index)=>'Context line '+String(index+1).padStart(3,'0')+'.');
  for(const line of positions)lines[line-1]='Original item '+line+'.';
  const baseline=lines.join('\n')+'\n';
  const request=parseRequestDocument(JSON.stringify({path:filePath,request:positions.map(line=>({
    line,before:'Original',after:'Revised',reason:'Explain the change at line '+line+'.',status:'pending'}))}));
  const review=resolveRequest(request,baseline,baseline);
  return {...structuredClone(fixture),revision:'quick-fixture',requestName:'quick-review.tex.rr',
    files:[{path:filePath,before:baseline,hunks:review.hunks.map((hunk,index)=>({...hunk,decision:'pending',
      explanation:request.request[index].reason,inlineChanges:computeInlineChanges(hunk,40,filePath)}))}]};
}
async function resetQuick(width,unified=false) {
  await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:{type:"toggleQuickReview",enabled:false}}));window.__deferDecisions=false;window.__deferQuickAck=false');
  await resetFixture(width);if((await unifiedSnapshot()).unified!==unified)await toggleLayout();
  const next=quickFixture();
  await cdp.evaluate('window.__messages=[];window.__setReview('+JSON.stringify(next)+');document.querySelector("[data-scroll-area]").scrollTop=0');
  await settle();return next;
}
async function quickSnapshot() {
  return cdp.evaluate(`(() => {
    const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const toggle=document.querySelector('.quick-review-toggle'),selected=[...document.querySelectorAll('.quick-review-selected')];
    const scroll=document.querySelector('[data-scroll-area]'),bulk=[...document.querySelectorAll('.file-actions > button')];
    return {enabled:toggle?.getAttribute('aria-pressed')==='true',disabled:toggle?.disabled,
      selected:selected.map(node=>({id:node.dataset.hunk,decision:node.dataset.quickDecision,key:node.dataset.focusKey,rect:rect(node)})),
      focused:{id:document.activeElement.dataset.hunk,decision:document.activeElement.dataset.quickDecision,key:document.activeElement.dataset.focusKey},
      colors:toggle?{text:getComputedStyle(toggle).color,background:getComputedStyle(toggle).backgroundColor,icon:getComputedStyle(toggle.querySelector('svg')).color,fill:getComputedStyle(toggle.querySelector('svg')).fill,border:getComputedStyle(toggle).borderTopColor}:null,
      toggle:rect(toggle),bulk:bulk.map(rect),badges:[...document.querySelectorAll('.summary .badge')].map(rect),
      left:rect(document.querySelector('.pane-banner.left')),right:rect(document.querySelector('.pane-banner.right')),
      scroll:{top:scroll.scrollTop,total:scroll.scrollHeight,rect:rect(scroll)},menu:Boolean(document.querySelector('.review-action-menu')),why:Boolean(document.querySelector('.why-popover')),
      decisions:window.__messages.filter(message=>message.type==='decide'),modeMessages:window.__messages.filter(message=>message.type==='quickReviewState')};
  })()`);
}
async function quickToggle(enabled) {
  if(enabled===undefined)await cdp.evaluate('document.querySelector(".quick-review-toggle").click()');
  else await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'toggleQuickReview',enabled})+'}))');
  await settle();
}
async function quickKey(key,modifiers=0) {
  const code={ArrowLeft:37,ArrowRight:39,Tab:9,Escape:27,Enter:13}[key];
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers});await settle();
}
async function quickAck(message,success=true,error) {
  const response={type:'quickDecisionResult',quickDecisionId:message.quickDecisionId,filePath:message.filePath,hunkId:message.hunkId,decision:message.decision,success,...(error?{error}:{})};
  await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(response)+'}))');await settle();
}
async function quickResolve(message) {
  await cdp.evaluate('(()=>{const next=structuredClone(window.__review),file=next.files.find(file=>file.path==='+JSON.stringify(message.filePath)+');file.hunks.find(hunk=>hunk.id==='+JSON.stringify(message.hunkId)+').decision='+JSON.stringify(message.decision)+';next.revision+="-decided";next.closed=file.hunks.every(hunk=>hunk.decision!=="pending");window.__setReview(next);})()');await settle();
}

function openingFixture() {
  const filePath='examples/open-review.txt';
  const lines=Array.from({length:230},(_,index)=>'Original source line '+String(index+1).padStart(3,'0')+'.');
  const baseline=lines.join('\n')+'\n';
  const request=parseRequestDocument(JSON.stringify({path:filePath,request:[
    {line:45,before:lines.slice(44,89).join('\n'),after:'First replacement line.\nSecond replacement line.',status:'pending'},
    {line:130,before:'Original',after:'Revised',status:'pending'},
    {line:190,before:'Original',after:'Revised',status:'pending'}
  ]}));
  const review=resolveRequest(request,baseline,baseline);
  return {...structuredClone(fixture),revision:'opening-fixture',requestName:'open-review.txt.rr',
    files:[{path:filePath,before:baseline,hunks:review.hunks.map(hunk=>({...hunk,decision:'pending',
      inlineChanges:computeInlineChanges(hunk,40,filePath)}))}]};
}
async function freshOpeningFixture(width,unified,stateOverride,messagesBeforeState=[]) {
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
  const next=stateOverride || openingFixture();
  const saved={layout:unified?'unified':'sideBySide',viewport:{top:4800},splitRatio:.5};
  await cdp.evaluate('window.addEventListener("pagehide",()=>sessionStorage.setItem("rr-view-state",'+JSON.stringify(JSON.stringify(saved))+'),{once:true})');
  await reloadPreview(next,messagesBeforeState);
  return next;
}
async function revealOpeningChange() {
  await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:{type:"revealFirstChange"}}))');await settle();
}
async function clickOpeningAction(id,action) {
  await cdp.evaluate('(()=>{const key=window.__review.files[0].path+":"+'+JSON.stringify(id)+'+":"+'+JSON.stringify(action)+';const button=[...document.querySelectorAll("[data-focus-key]")].find(node=>node.dataset.focusKey===key);if(!button||button.disabled)throw Error("Expected enabled "+key);button.focus({preventScroll:true});button.click();})()');await settle();
}
async function openingSnapshot() {
  return cdp.evaluate(String.raw`(() => {
    const scroll=document.querySelector('[data-scroll-area]'),block=scroll?.querySelector('.hunk-pending');
    const first=block?.querySelector('.diff-row'),view=scroll?.getBoundingClientRect();
    return {top:scroll?.scrollTop,id:block?.dataset.overviewHunk,
      firstOffset:first?.getBoundingClientRect().top-view?.top,
      firstRemoved:Boolean(first?.querySelector('.removed')),
      selected:[...document.querySelectorAll('.quick-review-selected')].map(node=>({id:node.dataset.hunk,decision:node.dataset.quickDecision})),
      focused:document.activeElement?.dataset.focusKey,
      decisions:window.__messages.filter(message=>['decide','decideFile','undo'].includes(message.type))};
  })()`);
}
async function assertOpeningChange(id,unified) {
  const view=await openingSnapshot();
  assert.equal(view.id,id);
  assert.ok(view.top>500,'Skip the long unchanged introduction');
  assert.ok(Math.abs(view.firstOffset-8)<1.1,'The first changed row starts just below the viewport top');
  if(unified)assert.equal(view.firstRemoved,true,'A unified replacement begins with removed text, not its Accept row');
  return view;
}
async function runOpenNavigationTests(width) {
  for(const unified of [false,true]) {
    const label=width+'px '+(unified?'unified':'side-by-side')+' opening';
    await runTest(label+': initial and reloaded previews reveal the first changed row instead of saved scroll',async()=>{
      const next=await freshOpeningFixture(width,unified),first=next.files[0].hunks[0].id;
      let view=await assertOpeningChange(first,unified);assert.equal(view.selected.length,0);assert.equal(view.decisions.length,0);
      await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop=4000');await settle();
      await reloadPreview(next);view=await assertOpeningChange(first,unified);assert.equal(view.decisions.length,0);
    });
    await runTest(label+': an early reveal waits for a ready, nonbusy comparison',async()=>{
      const next=openingFixture(),first=next.files[0].hunks[0].id;
      await freshOpeningFixture(width,unified,{...next,busy:true},[{type:'revealFirstChange'}]);
      await cdp.evaluate('window.__setReview('+JSON.stringify(next)+')');await settle();
      await assertOpeningChange(first,unified);
    });
    await runTest(label+': Accept, Undo, settings, errors and ordinary state updates preserve the viewport',async()=>{
      const next=await freshOpeningFixture(width,unified),first=next.files[0].hunks[0].id;
      await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop=3900');await settle();
      let before=await viewportSnapshot();await clickOpeningAction(first,'accept');await assertViewportPreserved(before);
      before=await viewportSnapshot();await clickOpeningAction(first,'undo');await assertViewportPreserved(before);
      before=await viewportSnapshot();
      await cdp.evaluate('window.__setReview({...structuredClone(window.__review),unchangedOpacity:45,error:"Temporary review error."})');await settle();await assertViewportPreserved(before);
      await cdp.evaluate('(()=>{const next=structuredClone(window.__review);delete next.error;window.__setReview(next);})()');await settle();await assertViewportPreserved(before);
    });
    await runTest(label+': explicit reopen selects first Accept in Quick Review without hiding the removed rows',async()=>{
      const next=await freshOpeningFixture(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await cdp.evaluate('[...document.querySelectorAll("[data-overview-hunk]")].find(node=>node.dataset.overviewHunk==='+JSON.stringify(ids[2])+').scrollIntoView({block:"start"})');await settle();
      await quickToggle(true);await quickKey('ArrowRight');assert.equal((await quickSnapshot()).selected[0].id,ids[2]);
      await revealOpeningChange();let view=await assertOpeningChange(ids[0],unified);
      assert.deepEqual(view.selected,[{id:ids[0],decision:'accepted'}]);assert.equal(view.decisions.length,0);
      assert.equal((await quickSnapshot()).focused.id,ids[0]);
      await revealOpeningChange();view=await assertOpeningChange(ids[0],unified);assert.equal(view.decisions.length,0);
      await quickToggle(false);await revealOpeningChange();await quickToggle(true);
      await assertOpeningChange(ids[0],unified);assert.equal((await quickSnapshot()).selected[0].id,ids[0]);
    });
    await runTest(label+': reopening keeps drafts but disarms offscreen editor and decision focus',async()=>{
      let next=await freshOpeningFixture(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await openEdit(ids[2]);await writeDraft('Retained local draft.');
      await revealOpeningChange();await assertOpeningChange(ids[0],unified);
      assert.equal((await editSnapshot()).draft,'Retained local draft.','Opening navigation retains the unsaved proposal');
      assert.equal(await cdp.evaluate('document.activeElement===document.querySelector("[data-scroll-area]")'),true);
      await editorKey('Enter',{ctrlKey:true});await quickKey('Enter');
      assert.equal(await cdp.evaluate('window.__messages.filter(message=>["decide","undo","editAndAccept","ignoreEdited"].includes(message.type)).length'),0,'A hidden draft cannot be approved by the old shortcut');
      for(const action of ['accept','undo']) {
        next=await freshOpeningFixture(width,unified);ids=next.files[0].hunks.map(h=>h.id);
        if(action==='undo')await clickOpeningAction(ids[2],'accept');
        await cdp.evaluate('(()=>{const key=window.__review.files[0].path+":"+'+JSON.stringify(ids[2])+'+":"+'+JSON.stringify(action)+';const button=[...document.querySelectorAll("[data-focus-key]")].find(node=>node.dataset.focusKey===key);button.scrollIntoView({block:"nearest"});button.focus({preventScroll:true});})()');await settle();
        const count=(await openingSnapshot()).decisions.length;
        await revealOpeningChange();await assertOpeningChange(ids[0],unified);
        assert.equal(await cdp.evaluate('document.activeElement===document.querySelector("[data-scroll-area]")'),true);
        await quickKey('Enter');assert.equal((await openingSnapshot()).decisions.length,count,'Enter cannot trigger the previous '+action+' button');
      }
    });
    await runTest(label+': reopening during a quick decision waits for both result and state',async()=>{
      const next=await freshOpeningFixture(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await cdp.evaluate('[...document.querySelectorAll("[data-overview-hunk]")].find(node=>node.dataset.overviewHunk==='+JSON.stringify(ids[1])+').scrollIntoView({block:"start"})');await settle();
      await quickToggle(true);await cdp.evaluate('window.__deferDecisions=true;window.__deferQuickAck=true');await quickKey('Tab');
      const message=(await quickSnapshot()).decisions.at(-1);assert.equal(message.hunkId,ids[1]);
      const before=await viewportSnapshot();await revealOpeningChange();await assertViewportPreserved(before);
      await quickResolve(message);await assertViewportPreserved(before);
      await quickAck(message);const view=await assertOpeningChange(ids[0],unified);
      assert.deepEqual(view.selected,[{id:ids[0],decision:'accepted'}]);assert.equal(view.decisions.length,1);
      const last=openingFixture();last.files[0].hunks.slice(0,2).forEach(h=>h.decision='ignored');
      await freshOpeningFixture(width,unified,last);await quickToggle(true);
      await cdp.evaluate('window.__deferDecisions=true;window.__deferQuickAck=true');await quickKey('Tab');
      const finalMessage=(await quickSnapshot()).decisions.at(-1),finalBefore=await viewportSnapshot();
      await revealOpeningChange();await quickResolve(finalMessage);await assertViewportPreserved(finalBefore);
      await quickAck(finalMessage);assert.equal((await openingSnapshot()).top,0,'A final decision also waits for its acknowledgement before reopening at the top');
    });
    await runTest(label+': a reopen after acknowledgement waits only for the remaining state',async()=>{
      const next=await freshOpeningFixture(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await cdp.evaluate('[...document.querySelectorAll("[data-overview-hunk]")].find(node=>node.dataset.overviewHunk==='+JSON.stringify(ids[1])+').scrollIntoView({block:"start"})');await settle();
      await quickToggle(true);await cdp.evaluate('window.__deferDecisions=true;window.__deferQuickAck=true');await quickKey('Tab');
      const message=(await quickSnapshot()).decisions.at(-1);assert.equal(message.hunkId,ids[1]);
      await quickAck(message);
      const before=await viewportSnapshot();await revealOpeningChange();await assertViewportPreserved(before);
      await quickResolve(message);const view=await assertOpeningChange(ids[0],unified);
      assert.deepEqual(view.selected,[{id:ids[0],decision:'accepted'}]);assert.equal(view.decisions.length,1);
    });
    await runTest(label+': resolved changes are skipped and completed requests open at the top',async()=>{
      const next=openingFixture(),ids=next.files[0].hunks.map(h=>h.id);next.files[0].hunks[0].decision='accepted';
      await freshOpeningFixture(width,unified,next);await assertOpeningChange(ids[1],unified);
      const closed=structuredClone(next);closed.files[0].hunks.forEach(h=>h.decision='ignored');closed.closed=true;closed.files[0].currentText=closed.files[0].before;
      await freshOpeningFixture(width,unified,closed);assert.equal((await openingSnapshot()).top,0);
      await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop=2000');await settle();
      await revealOpeningChange();assert.equal((await openingSnapshot()).top,0);assert.equal((await openingSnapshot()).decisions.length,0);
    });
  }
  await quickToggle(false);await resetFixture(width);if((await unifiedSnapshot()).unified)await toggleLayout();
}

async function runQuickReviewTests(width) {
  for(const unified of [false,true]) {
    const label=width+'px '+(unified?'unified':'side-by-side');
    await runTest(label+': Quick Review is a yellow toggle above aligned bulk actions and defaults off',async()=>{
      await resetQuick(width,unified);const view=await quickSnapshot();
      assert.equal(view.enabled,false);assert.equal(view.disabled,false);assert.equal(view.selected.length,0);assert.equal(view.bulk.length,2);
      assert.ok(view.toggle.bottom<=view.bulk[0].y+.6,'Quick Review sits above the bulk row');
      assert.ok(Math.abs(view.toggle.x-view.bulk[0].x)<.7,'Same left edge as Accept all');
      assert.ok(Math.abs(view.toggle.right-view.bulk[1].right)<.7,'Spans both bulk buttons');
      for(const badge of view.badges) {assert.ok(Math.abs(badge.height-view.bulk[0].height)<.7);assert.ok(Math.abs(badge.y-view.bulk[0].y)<.7,'Counters stay on lower bulk row');}
      if(!unified) {assert.ok(Math.abs(view.left.y-view.right.y)<.6);assert.ok(Math.abs(view.left.height-view.right.height)<.6,'Banner heights remain equal');}
      const prevented=await cdp.evaluate('(()=>{const event=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});document.body.dispatchEvent(event);return event.defaultPrevented;})()');
      assert.equal(prevented,false,'Off mode does not intercept ordinary keys');assert.equal((await quickSnapshot()).decisions.length,0);
      await screenshot('quick-review-'+width+'-'+(unified?'unified':'split')+'-off');
    });
    await runTest(label+': either arrow toggles only Accept and Ignore and Tab waits for acknowledged success',async()=>{
      const next=await resetQuick(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      const offColors=(await quickSnapshot()).colors;await quickToggle();let view=await quickSnapshot();
      assert.equal(view.colors.text,offColors.background,'On text uses the off background color');assert.equal(view.colors.background,offColors.text,'On background uses the off text color');assert.equal(view.colors.icon,view.colors.text);assert.equal(offColors.icon,offColors.text);assert.equal(view.colors.fill,view.colors.text,'Enabled bolt is filled');assert.equal(offColors.fill,offColors.text,'Disabled bolt is filled');
      assert.equal(view.enabled,true);assert.equal(view.selected.length,1);assert.equal(view.selected[0].id,ids[0]);assert.equal(view.selected[0].decision,'accepted');
      assert.equal(view.modeMessages.at(-1).enabled,true);
      for(const [key,wanted] of [['ArrowRight','ignored'],['ArrowRight','accepted'],['ArrowLeft','ignored'],['ArrowLeft','accepted']]) {
        await quickKey(key);view=await quickSnapshot();assert.equal(view.selected.length,1);assert.equal(view.selected[0].decision,wanted);
        assert.equal(view.focused.decision,wanted);assert.equal(view.selected[0].id,ids[0]);
      }
      await cdp.evaluate('window.__deferDecisions=true');await quickKey('Tab');view=await quickSnapshot();assert.equal(view.decisions.length,1);
      const sent=view.decisions[0];assert.equal(sent.hunkId,ids[0]);assert.equal(sent.decision,'accepted');assert.equal(typeof sent.quickDecisionId,'string');
      await quickKey('Tab');await quickKey('ArrowRight');
      await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",repeat:true,bubbles:true,cancelable:true}))');
      assert.equal((await quickSnapshot()).decisions.length,1,'Waiting and held Tab cannot submit twice');
      await quickResolve(sent);await quickKey('Tab');assert.equal((await quickSnapshot()).decisions.length,1,'State alone cannot authorize advancement');
      await cdp.evaluate('(()=>{const control=[...document.querySelectorAll("button[data-quick-decision=accepted]")].find(node=>node.dataset.hunk==='+JSON.stringify(ids[1])+');control.click();})()');
      assert.equal((await quickSnapshot()).decisions.length,1,'A mouse decision also waits for the first acknowledgement');
      await quickAck(sent);view=await quickSnapshot();assert.equal(view.selected[0].id,ids[1]);assert.equal(view.selected[0].decision,'accepted');assert.equal(view.focused.id,ids[1]);
      assert.ok(view.selected[0].rect.y>=view.scroll.rect.y-.7&&view.selected[0].rect.bottom<=view.scroll.rect.bottom+.7,'Next controls are visible');
      assert.ok(view.scroll.top<view.scroll.total-view.scroll.rect.height-50,'Advancement does not jump to the bottom');
      await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",repeat:true,bubbles:true,cancelable:true}))');
      assert.equal((await quickSnapshot()).decisions.length,1,'Held Tab cannot approve the newly focused item');
      await quickKey('ArrowRight');await quickKey('Tab');const ignored=(await quickSnapshot()).decisions.at(-1);assert.equal(ignored.decision,'ignored');
      await quickAck(ignored);assert.notEqual((await quickSnapshot()).selected[0]?.id,ids[2],'Ack alone waits for the state');
      await quickResolve(ignored);view=await quickSnapshot();assert.equal(view.selected[0].id,ids[2]);assert.equal(view.selected[0].decision,'accepted','Next item resets to Accept');
      await screenshot('quick-review-'+width+'-'+(unified?'unified':'split')+'-on');
    });

    await runTest(label+': advancing reveals the full next multiline block when it fits the viewport',async()=>{
      const next=await resetQuick(width,unified),filePath=next.files[0].path;
      const request=parseRequestDocument(JSON.stringify({path:filePath,request:[
        {line:5,before:'Original item 5.',after:'Revised item 5.',status:'pending'},
        {line:45,before:'Original item 45.',after:'New line one.\nNew line two.\nNew line three.',status:'pending'}
      ]}));
      const review=resolveRequest(request,next.files[0].before,next.files[0].before);
      next.files[0].hunks=review.hunks.map(hunk=>({...hunk,decision:'pending',inlineChanges:computeInlineChanges(hunk,40,filePath)}));
      await cdp.evaluate('window.__setReview('+JSON.stringify(next)+')');await settle();await quickToggle(true);await quickKey('Tab');await settle();
      const view=await quickSnapshot();assert.equal(view.selected[0].id,review.hunks[1].id);
      const block=await cdp.evaluate('(()=>{const node=[...document.querySelectorAll("[data-overview-hunk]")].find(node=>node.dataset.overviewHunk==='+JSON.stringify(review.hunks[1].id)+');const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height};})()');
      assert.ok(block.height<view.scroll.rect.height,'The complete next block fits');
      assert.ok(block.top>=view.scroll.rect.y-.7&&block.bottom<=view.scroll.rect.bottom+.7,'All proposed lines, not only the Accept button, must be visible');
    });

    await runTest(label+': errors preserve the item and selection, and mode exits after all decisions',async()=>{
      const next=await resetQuick(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await quickToggle(true);await quickKey('ArrowLeft');await cdp.evaluate('window.__deferDecisions=true');await quickKey('Tab');
      const failed=(await quickSnapshot()).decisions.at(-1);assert.equal(failed.decision,'ignored','Ignore was selected before the failed request');await quickAck({...failed,quickDecisionId:'obsolete'},true);
      assert.equal((await quickSnapshot()).selected[0]?.id,ids[0]);
      await quickAck(failed,false,'The source changed. Review again.');
      await cdp.evaluate('window.__setReview({...structuredClone(window.__review),error:"The source changed. Review again."})');await settle();
      let view=await quickSnapshot();assert.equal(view.selected[0].id,ids[0]);assert.equal(view.selected[0].decision,'ignored');assert.equal(view.decisions.length,1);
      await cdp.evaluate('(()=>{const next=structuredClone(window.__review);delete next.error;window.__setReview(next);window.__deferDecisions=false;})()');await settle();
      for(let i=0;i<ids.length;i++){await quickKey('Tab');await settle();}
      view=await quickSnapshot();assert.equal(view.enabled,false);assert.equal(view.selected.length,0);assert.equal(view.modeMessages.at(-1).enabled,false);
      assert.deepEqual(await cdp.evaluate('window.__review.files[0].hunks.map(h=>h.decision)'),['ignored','accepted','accepted','accepted']);assert.equal(view.decisions.length,5);
    });
    await runTest(label+': menus, explanations and direct editing suspend quick shortcuts',async()=>{
      const next=await resetQuick(width,unified),id=next.files[0].hunks[0].id;await quickToggle(true);await clickMore(id);
      assert.equal((await quickSnapshot()).menu,true);await quickKey('ArrowRight');await quickKey('Tab');assert.equal((await quickSnapshot()).decisions.length,0);assert.equal((await quickSnapshot()).enabled,true);
      if(!(await quickSnapshot()).menu)await clickMore(id);
      await quickKey('Escape');let view=await quickSnapshot();assert.equal(view.menu,false);assert.equal(view.enabled,true);assert.equal(view.selected[0].id,id);
      await clickWhy(id);assert.equal((await quickSnapshot()).why,true);await quickKey('ArrowRight');await quickKey('Tab');assert.equal((await quickSnapshot()).decisions.length,0);
      await quickKey('Escape');assert.equal((await quickSnapshot()).why,false);assert.equal((await quickSnapshot()).enabled,true);
      await openEdit(id);assert.ok(await editSnapshot());await quickKey('ArrowRight');await quickKey('Tab');assert.equal((await quickSnapshot()).decisions.length,0);
      assert.ok(await editSnapshot(),'Tab remains an editor key');await editorKey('Escape');assert.equal(await editSnapshot(),null);assert.equal((await quickSnapshot()).enabled,true);
      await quickKey('Escape');assert.equal((await quickSnapshot()).enabled,false);
    });
    await runTest(label+': visible activation, external changes, layout changes and reloads never approve implicitly',async()=>{
      const next=await resetQuick(width,unified),ids=next.files[0].hunks.map(h=>h.id);
      await cdp.evaluate('(()=>{const row=[...document.querySelectorAll("[data-overview-hunk]")].find(node=>node.dataset.overviewHunk==='+JSON.stringify(ids[2])+');row.scrollIntoView({block:"start"});})()');await settle();
      const before=(await quickSnapshot()).scroll.top;await quickToggle(true);let view=await quickSnapshot();
      assert.equal(view.selected[0].id,ids[2]);assert.ok(Math.abs(view.scroll.top-before)<=12,'Activation allows only the small focus visibility inset');
      await toggleLayout();view=await quickSnapshot();assert.equal(view.enabled,true);assert.equal(view.selected[0].id,ids[2]);await toggleLayout();
      if(!unified) {const selection=view.selected[0].decision;await splitKey('ArrowRight');assert.equal((await quickSnapshot()).selected[0].decision,selection,'Divider arrows retain their own function');}
      await cdp.evaluate('(()=>{const next=structuredClone(window.__review);next.files[0].hunks=next.files[0].hunks.filter(h=>h.id!=='+JSON.stringify(ids[2])+');next.revision+="-external";window.__setReview(next);})()');await settle();
      view=await quickSnapshot();assert.equal(view.decisions.length,0);assert.ok(!view.selected.some(item=>item.id===ids[2]));
      await reloadPreview(next);view=await quickSnapshot();assert.equal(view.enabled,false);assert.equal(view.selected.length,0);assert.equal(view.decisions.length,0);
      await quickToggle(true);await cdp.evaluate('window.__setReview({...structuredClone(window.__review),trusted:false})');await settle();
      view=await quickSnapshot();assert.equal(view.enabled,false);assert.equal(view.disabled,true);assert.equal(view.decisions.length,0);
    });
    await runTest(label+': completion dialogs own Tab navigation and never submit a quick decision',async()=>{
      await resetQuick(width,unified);await quickToggle(true);
      const prompt={type:'completionPrompt',completionId:'quick-prompt',revision:'quick-fixture',requestName:'quick-review.tex.rr'};
      await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(prompt)+'}))');await settle();
      assert.ok(await completionSnapshot());await quickKey('Tab');await quickKey('ArrowRight');assert.equal((await quickSnapshot()).decisions.length,0);
      await quickKey('Escape');const response=await cdp.evaluate('window.__messages.filter(m=>m.type==="resolveCompletion").at(-1)');
      assert.equal(response.deleteRequest,false);await completionAck(prompt,{success:true});await quickToggle(false);assert.equal((await quickSnapshot()).enabled,false);
    });
  }
  await quickToggle(false);await resetFixture(width);if((await unifiedSnapshot()).unified)await toggleLayout();
}

async function runEditorButtonTests(width) {
  await runTest(width+'px: editing keeps Accept, Ignore and Why in the same button slots and text metrics',async()=>{
    for(const unified of [false,true])for(const direct of [false,true]) {
      await resetFixture(width);if((await unifiedSnapshot()).unified!==unified)await toggleLayout();
      if(direct){await cdp.evaluate('window.__setReview('+JSON.stringify(singleLineFixture())+')');await settle();}
      const id=direct?'direct':'grow';
      const metrics=()=>cdp.evaluate(`(() => {const block=Array.from(document.querySelectorAll('[data-overview-hunk]')).find(node=>node.dataset.overviewHunk===${JSON.stringify(id)}),group=block.querySelector('.inline-actions'),gutter=group.parentElement;return {origin:group.getBoundingClientRect().x,gutterRight:gutter.getBoundingClientRect().right,buttons:Array.from(group.querySelectorAll('button'),button=>{const css=getComputedStyle(button),r=button.getBoundingClientRect();return {label:button.textContent,x:r.x,width:r.width,height:r.height,fontFamily:css.fontFamily,fontSize:css.fontSize,fontWeight:css.fontWeight,lineHeight:css.lineHeight,padding:css.padding,color:css.color,background:css.backgroundColor};})};})()`);
      const before=await metrics();await openEdit(id);const editing=await metrics();
      assert.equal(editing.origin,before.origin,'Editing preserves the action group origin');assert.equal(editing.gutterRight,before.gutterRight,'The reserved Why slot keeps the whole action rail unchanged');
      for(let index=0;index<2;index++) {
        assert.equal(editing.buttons[index].label,index?'Ignore':'Accept');
        const {label:oldLabel,...oldMetrics}=before.buttons[index],{label:newLabel,...newMetrics}=editing.buttons[index];
        assert.deepEqual(newMetrics,oldMetrics,'Editor and decision buttons share exact width, position, height, text metrics, padding, and colors');
        assert.equal(newMetrics.width,width<=650?41:43);assert.equal(newMetrics.height,18);
      }
      await editorKey('Enter',{ctrlKey:true});const saving=await metrics();
      assert.equal(saving.buttons[0].label,'Accept');assert.equal(saving.buttons[0].width,before.buttons[0].width,'The busy action cannot resize its slot');
      assert.equal(saving.buttons[1].x,before.buttons[1].x);
      const sent=await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').at(-1)");
      await editAck(sent,{success:false,error:'Test host leaves the draft open.'});await editorKey('Escape');
      if(unified)await toggleLayout();
    }
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
    const rail=document.querySelector('.action-gutter').getBoundingClientRect(), overview=document.querySelector('.change-scrollbar').getBoundingClientRect();
    return {role:separator.getAttribute('role'),orientation:separator.getAttribute('aria-orientation'),
      value:Number(separator.getAttribute('aria-valuenow')),min:Number(separator.getAttribute('aria-valuemin')),max:Number(separator.getAttribute('aria-valuemax')),
      x:box.x+box.width/2,y:Math.min(24,box.bottom-2),available:scroll.clientWidth,
      splitter:{x:box.x,right:box.right,width:box.width},overview:{x:overview.x,right:overview.right,width:overview.width},
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
  assert.equal(value.splitter.width,6,'The resize hitbox stays six pixels wide');
  assert.equal(value.overview.width,15,'The scroll rail stays fifteen pixels wide');
  assert.ok(Math.abs((value.overview.x+value.overview.right)/2-value.divider)<.6,'The scroll rail is centered on the column divider');
  assert.ok(Math.abs(value.splitter.right-value.overview.x)<.6,'Resize and scroll hitboxes are adjacent without overlap');
  assert.ok(Math.abs(value.left+value.right-value.available)<1.1,'Both panes fill the comparison width');
  assert.ok(value.headerFit.every(Boolean),'Status badges and action buttons remain within the right pane');
  for(const source of value.sourceWidths) {
    assert.ok(source.width>=79,'Minimum pane widths leave readable code beside the fixed rail');
    assert.ok(source.scrollWidth<=source.width+1,'Resizing never hides code horizontally');
  }
}
async function assertMatchingContextWraps() {
  const rows=await cdp.evaluate(`(() => {
    const data=[];
    for(const row of document.querySelectorAll('.diff-row')) {
      const left=row.querySelector('.code-side.left.context .code-text'),right=row.querySelector('.code-side.right.context .code-text');
      if(!left||!right||left.textContent!==right.textContent||left.textContent.length<12)continue;
      const measure=node=>{const box=node.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);return {width:node.closest('.code-source').getBoundingClientRect().width,fragments:Array.from(range.getClientRects(),r=>({x:r.x-box.x,y:r.y-box.y,width:r.width,height:r.height}))};};
      data.push({left:measure(left),right:measure(right)});
    }
    return data;
  })()`);
  assert.ok(rows.length>50,'Many identical unchanged rows exercise paired wrapping');
  for(const row of rows) {
    assert.ok(Math.abs(row.left.width-row.right.width)<.1,'Original and proposed source surfaces have exactly matching widths');
    assert.equal(row.left.fragments.length,row.right.fragments.length,'Identical context wraps into the same number of visual fragments');
    for(let index=0;index<row.left.fragments.length;index++)for(const key of ['x','y','width','height']) {
      assert.ok(Math.abs(row.left.fragments[index][key]-row.right.fragments[index][key])<.2,'Identical context has matching wrapped glyph '+key);
    }
  }
}
async function reloadPreview(stateOverride,messagesBeforeState=[]) {
  await cdp.evaluate('window.__reloadMarker=true');
  await cdp.send('Page.reload',{ignoreCache:true});
  const deadline=Date.now()+6000;
  while(Date.now()<deadline) {
    if(await cdp.evaluate("Boolean(!window.__reloadMarker&&window.__messages?.some(message=>message.type==='ready'))"))break;
    await delay(40);
  }
  for(const message of messagesBeforeState)await cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(message)+'}))');
  await cdp.evaluate(stateOverride ? "window.__setReview("+JSON.stringify(stateOverride)+")" : "window.__setReview(structuredClone(window.__fixture))"); await settle();
}
async function runSplitterTests(width) {
  await resetFixture(width); await resetSplit();
  await runTest(width+'px: dragging the central divider resizes every paired row and keeps the fixed action rail',async()=>{
    const before=await splitSnapshot(), text=await cdp.evaluate("JSON.stringify(window.__review)");
    const moved=await dragSplitter(.35);
    assertSplitGeometry(moved); assert.ok(moved.left<before.left-30); assert.ok(moved.right>before.right+30);
    assert.ok(Math.abs(moved.rail-before.rail)<.6,'The action rail retains its fixed width');
    assert.ok(Math.abs(moved.saved-moved.ratio)<.002); assert.equal(moved.dragging,false);
    assertAligned(await geometry()); await assertTextProjection(); await assertMatchingContextWraps();
    assert.equal(await cdp.evaluate("JSON.stringify(window.__review)"),text,'Pane resizing cannot alter review content or decisions');
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>['decide','editAndAccept','undo'].includes(message.type)).length"),0);
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
    assert.ok((newHeight-oldHeight)*(after.area.width-before.area.width)<0,'Draft height reflows inversely with the shared source width');
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

async function viewportSnapshot() {
  return cdp.evaluate(`(() => {
    const scroll=document.querySelector('[data-scroll-area]'); if(!scroll)return null;
    const top=scroll.getBoundingClientRect().top;
    const anchor=Array.from(scroll.querySelectorAll('[data-row-key]')).find(row=>row.getBoundingClientRect().bottom>top);
    return {top:scroll.scrollTop,key:anchor?.dataset.rowKey,offset:anchor?anchor.getBoundingClientRect().top-top:0,viewportTop:top,height:scroll.clientHeight};
  })()`);
}
async function assertViewportPreserved(before) {
  const current=await viewportSnapshot(); assert.ok(current);
  const anchor=await cdp.evaluate(`(() => {const scroll=document.querySelector('[data-scroll-area]'),row=Array.from(scroll.querySelectorAll('[data-row-key]')).find(node=>node.dataset.rowKey===${JSON.stringify(before.key)});return row?row.getBoundingClientRect().top-scroll.getBoundingClientRect().top:null;})()`);
  if(anchor!==null) assert.ok(Math.abs(anchor-before.offset)<1.1,'The same visible source row retains its viewport offset');
  else assert.ok(Math.abs(current.top-before.top)<1.1,'A removed anchor falls back to the previous scroll offset');
}
async function overviewSnapshot() {
  return cdp.evaluate(`(() => {
    const rail=document.querySelector('.change-scrollbar'),thumb=rail.querySelector('.change-scrollbar-thumb'),scroll=document.querySelector('[data-scroll-area]');
    const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    return {rail:rect(rail),thumb:rect(thumb),scroll:rect(scroll),top:scroll.scrollTop,max:scroll.scrollHeight-scroll.clientHeight,
      role:rail.getAttribute('role'),orientation:rail.getAttribute('aria-orientation'),value:Number(rail.getAttribute('aria-valuenow')),
      controls:rail.getAttribute('aria-controls'),scrollId:scroll.id,nativeWidth:scroll.offsetWidth-scroll.clientWidth,
      markers:Array.from(rail.querySelectorAll('.change-scrollbar-marker'),node=>({id:node.dataset.overviewTarget,kind:node.classList.contains('removed')?'removed':'added',color:getComputedStyle(node).backgroundColor,rect:rect(node)}))};
  })()`);
}
async function runGroupedRequestTests(width) {
  await resetFixture(width);
  await runTest(width+'px: multiline request entries remain atomic blocks with one action pair and exact editable drafts',async()=>{
    const baseline='Heading.\nDelete first.\nDelete second.\nMiddle.\n'+Array.from({length:105},(_,index)=>'Unchanged group context '+index+'\n').join('');
    const document=parseRequestDocument(JSON.stringify({path:fixture.files[0].path,request:[
      {line:2,before:'Delete first.\nDelete second.',after:null,status:'pending'},
      {line:4,before:null,after:'First addition.\n\nSecond addition.\n',status:'pending',reason:''},
      {line:4,before:'Middle.',after:'New middle.\nContinued.',status:'pending',reason:'Keep the paragraph together.'}
    ]}));
    const resolved=resolveRequest(document,baseline,baseline);
    assert.equal(resolved.hunks.length,3,'Production resolver emits one hunk per multiline entry');
    const state={...structuredClone(fixture),files:[{path:fixture.files[0].path,before:resolved.file.before,
      hunks:resolved.hunks.map(hunk=>{const preview={...hunk,after:hunk.displayAfter??hunk.after};return {...preview,
        decision:resolved.decisions[hunk.id],explanation:document.request[resolved.entryIndexByHunkId[hunk.id]].reason,
        inlineChanges:computeInlineChanges(preview, 40, fixture.files[0].path)};})}]};
    await cdp.evaluate('window.__setReview('+JSON.stringify(state)+')');await settle();
    const controls=id=>cdp.evaluate(`(() => {const block=Array.from(document.querySelectorAll('[data-overview-hunk]')).find(node=>node.dataset.overviewHunk===${JSON.stringify(id)});const why=block.querySelector('.why-toggle');return {accept:block.querySelectorAll('.button-accept').length,ignore:Array.from(block.querySelectorAll('button')).filter(button=>button.textContent==='Ignore').length,undo:Array.from(block.querySelectorAll('button')).filter(button=>button.textContent==='Undo').length,rows:block.querySelectorAll('.diff-row').length,height:block.getBoundingClientRect().height,why:why?{disabled:why.disabled,visibility:getComputedStyle(why).visibility,color:getComputedStyle(why).color,background:getComputedStyle(why).backgroundColor}:null};})()`);
    for(const hunk of state.files[0].hunks){const buttons=await controls(hunk.id);assert.equal(buttons.accept,1);assert.equal(buttons.ignore,1);assert.ok(buttons.rows>=2,'A multiline group has several source rows but one decision pair');if(!hunk.explanation){assert.equal(buttons.why.disabled,false);assert.equal(buttons.why.visibility,'visible');assert.notEqual(buttons.why.color,'rgba(0, 0, 0, 0)');}}
    await assertTextProjection();assertAligned(await geometry());await assertMatchingContextWraps();
    const inserted=state.files[0].hunks.find(hunk=>resolved.entryIndexByHunkId[hunk.id]===1);
    const beforeEdit=await controls(inserted.id);
    await openEdit(inserted.id,'click',2);
    assert.ok(Math.abs((await controls(inserted.id)).height-beforeEdit.height)<.6,'Opening a multiline insertion adds no extra blank visual row');
    const draft=await editSnapshot();assert.equal(draft.draft,document.request[1].after,'The complete multiline draft preserves its intentional terminal blank line');
    assertInlineEditor(draft,width);
    await editorKey('Enter',{ctrlKey:true});
    const saved=await cdp.evaluate("window.__messages.filter(message=>message.type==='editAndAccept').at(-1)");
    assert.equal(saved.draft,document.request[1].after,'Saving the full block does not strip its intentional terminal blank line');
    await editAck(saved,{success:false,error:'Test host retains this draft for cancellation.'});await editorKey('Escape');
    for(const hunk of state.files[0].hunks) {
      await clickDecision(hunk.id,'accept');
      const decisions=await cdp.evaluate('window.__review.files[0].hunks.map(hunk=>({id:hunk.id,decision:hunk.decision}))');
      assert.deepEqual(decisions,state.files[0].hunks.map(item=>({id:item.id,decision:item.id===hunk.id?'accepted':'pending'})),'Accept applies the complete selected group only');
      assert.equal((await controls(hunk.id)).undo,1);await assertTextProjection();assertAligned(await geometry());
      await clickUndo(hunk.id);const restored=await controls(hunk.id);assert.equal(restored.accept,1);assert.equal(restored.ignore,1);
      assert.equal(await cdp.evaluate("window.__review.files[0].hunks.every(hunk=>hunk.decision==='pending')"),true,'Undo restores exactly that grouped proposal');
      await assertTextProjection();assertAligned(await geometry());
    }
    await screenshot('comparison-'+width+'-multiline-groups');await resetFixture(width);
  });
}

async function runUnterminatedAppendTests(width) {
  await resetFixture(width);
  await runTest(width+'px: appending blank or trailing-blank blocks after an unterminated EOF preserves every editable row',async()=>{
    for(const after of ['', 'first\n']) {
      const baseline='tail';
      const document=parseRequestDocument(JSON.stringify({path:fixture.files[0].path,request:[{line:2,before:null,after,status:'pending'}]}));
      const resolved=resolveRequest(document,baseline,baseline), hunk=resolved.hunks[0];
      const preview={...hunk,after:hunk.displayAfter??hunk.after};
      const state={...structuredClone(fixture),files:[{path:fixture.files[0].path,before:baseline,hunks:[{...preview,decision:'pending',inlineChanges:computeInlineChanges(preview, 40, fixture.files[0].path)}]}]};
      await cdp.evaluate('window.__setReview('+JSON.stringify(state)+')');await settle();
      const block=()=>cdp.evaluate(`(() => {const group=Array.from(document.querySelectorAll('[data-overview-hunk]')).find(node=>node.dataset.overviewHunk===${JSON.stringify(hunk.id)});if(!group)return null;return {rows:group.querySelectorAll('.diff-row').length,accept:group.querySelectorAll('.button-accept').length,ignore:Array.from(group.querySelectorAll('button')).filter(node=>node.textContent==='Ignore').length,undo:Array.from(group.querySelectorAll('button')).filter(node=>node.textContent==='Undo').length,right:Array.from(group.querySelectorAll('.code-side.right[data-line] .code-text'),node=>node.textContent.replace(/\u200b/g,'')),numbers:Array.from(group.querySelectorAll('.code-side.right[data-line]'),node=>Number(node.dataset.line))};})()`);
      const projection=side=>cdp.evaluate(`Array.from(document.querySelectorAll('.code-side.${side}[data-line] .code-text'),node=>node.textContent.replace(/\u200b/g,''))`);
      let current=await block();assert.ok(current,'An empty appended logical line still has a visible review group');
      assert.equal(current.rows,hunk.newLines);assert.deepEqual(current.right,after.split('\n'));
      assert.deepEqual(current.numbers,after.split('\n').map((_,index)=>2+index));assert.equal(current.accept,1);assert.equal(current.ignore,1);
      assert.deepEqual(await projection('left'),baseline.split('\n'));
      assert.deepEqual(await projection('right'),resolved.file.after.split('\n'),'The entire preview contains each physical source line once');
      assert.equal(await cdp.evaluate("document.querySelector('.eof-side.right')?.textContent||''"),'','The appended physical newline removes the right-side missing-newline warning');
      await openEdit(hunk.id);
      assert.equal((await editSnapshot()).draft,after,'The EOF append editor preserves the exact logical block');
      assert.equal(await cdp.evaluate("document.querySelector('.pending-editor').classList.contains('added')"),true,'A blank inserted line remains an addition when focused');
      await editorKey('Escape');
      await clickDecision(hunk.id,'accept');current=await block();assert.equal(current.rows,hunk.newLines);assert.equal(current.undo,1);
      assert.deepEqual(current.right,after.split('\n'));
      assert.deepEqual(await projection('left'),resolved.file.after.split('\n'),'Accept shows every appended physical line once in the original');
      assert.deepEqual(await projection('right'),resolved.file.after.split('\n'));
      await clickUndo(hunk.id);assert.equal((await block()).accept,1);assert.deepEqual(await projection('right'),resolved.file.after.split('\n'));
      await clickDecision(hunk.id,'ignore');current=await block();assert.equal(current.undo,1);assert.deepEqual(current.right,[]);
      assert.deepEqual(await projection('left'),['tail']);assert.deepEqual(await projection('right'),['tail']);
      await clickUndo(hunk.id);assert.deepEqual((await block()).right,after.split('\n'));
      assert.deepEqual(await projection('right'),resolved.file.after.split('\n'));
    }
    await resetFixture(width);
  });
}

async function runNavigationTests(width) {
  await resetFixture(width);
  await runTest(width+'px: Accept and Undo preserve the visible source through busy and temporary empty states',async()=>{
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=700;window.__deferDecisions=true"); await settle();
    try {
      for(const undo of [false,true]) {
        const before=await viewportSnapshot(); assert.ok(before.top>0);
        await cdp.evaluate("window.__decisionRows=Array.from(document.querySelectorAll('.diff-row'));window.__decisionScroll=document.querySelector('[data-scroll-area]');window.__cachedContext=Array.from(document.querySelectorAll('[data-row-key]')).find(row=>row.querySelector('.code-side.left.context')&&row.getBoundingClientRect().top>window.__decisionScroll.getBoundingClientRect().top)");
        if(undo)await clickUndo('delete'); else await clickDecision('delete','accept');
        assert.equal(await cdp.evaluate("window.__decisionScroll===document.querySelector('[data-scroll-area]')&&window.__decisionRows.every((row,index)=>row===document.querySelectorAll('.diff-row')[index])"),true,'A decision click locks controls without replacing rows');
        await assertViewportPreserved(before);
        await cdp.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'busy',busy:true}}))"); await settle();
        await assertViewportPreserved(before);
        const next=await cdp.evaluate('structuredClone(window.__review)'); next.busy=false;
        next.files[0].hunks.find(hunk=>hunk.id==='delete').decision=undo?'pending':'accepted';
        await cdp.evaluate('window.__setReview('+JSON.stringify({...next,files:[],busy:true})+')');await settle();
        assert.equal(await viewportSnapshot(),null,'The intermediate empty state has no comparison surface');
        await cdp.evaluate('window.__setReview('+JSON.stringify(next)+')');await settle();
        await assertViewportPreserved(before); assertAligned(await geometry()); await assertTextProjection();
        assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('[data-row-key]')).find(row=>row.dataset.rowKey===window.__cachedContext.dataset.rowKey)===window.__cachedContext"),true,'An unaffected context row is reused after the final host state');
        assert.equal(await cdp.evaluate('document.activeElement.dataset.focusKey'),fixture.files[0].path+':delete:'+(undo?'accept':'undo'),'The final state restores focus to the acted-on hunk');
        assert.ok((await viewportSnapshot()).top>0,'The final state does not jump to the top');
      }
    } finally {await cdp.evaluate('window.__deferDecisions=false');}
    await resetFixture(width);
  });
  await runTest(width+'px: closing and reopening a review preserve the viewport when the header height changes',async()=>{
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=700");await settle();
    const before=await viewportSnapshot();
    await cdp.evaluate("window.__setReview({...window.__review,closed:true})");await settle();
    const closed=await viewportSnapshot(); assert.ok(closed.viewportTop>before.viewportTop,'The closed notice changes the comparison viewport height');
    await assertViewportPreserved(before);
    await cdp.evaluate("window.__setReview({...window.__review,closed:false})");await settle();
    await assertViewportPreserved(before); assert.equal((await viewportSnapshot()).viewportTop,before.viewportTop);
    await resetFixture(width);
  });
  await runTest(width+'px: the fifteen-pixel change rail locates pending edits and supports real pointer, wheel, and keyboard scrolling',async()=>{
    await cdp.evaluate("(() => {const scroll=document.querySelector('[data-scroll-area]');scroll.scrollTop=scroll.scrollHeight;})()");await settle();
    let snap=await overviewSnapshot();
    assert.equal(snap.rail.width,15);assert.equal(snap.role,'scrollbar');assert.equal(snap.orientation,'vertical');assert.equal(snap.controls,snap.scrollId);
    assert.equal(snap.nativeWidth,0,'The central rail replaces the native scrollbar');
    assert.ok(Math.abs(snap.rail.y-snap.scroll.y)<.6&&Math.abs(snap.rail.height-snap.scroll.height)<.6,'The rail follows the full comparison viewport');
    assert.deepEqual(snap.markers.map(marker=>marker.id+':'+marker.kind).sort(),['delete:removed','grow:added','grow:removed','insert:added','shrink:added','shrink:removed']);
    const rgb=color=>color.match(/[\d.]+/g).slice(0,3).map(Number);
    for(const marker of snap.markers){const [red,green]=rgb(marker.color);assert.ok(marker.kind==='removed'?red>green:green>red,'Removed/added markers use red/green colors');}
    const marker=snap.markers.find(item=>item.id==='shrink'&&item.kind==='added'), point={x:marker.rect.x+marker.rect.width/2,y:marker.rect.y+Math.min(1.5,marker.rect.height/2)};
    assert.equal(await cdp.evaluate('document.elementFromPoint('+point.x+','+point.y+').dataset.overviewTarget'),'shrink','The marker click targets an exposed marker outside the thumb');
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await settle();
    const targetOffset=await cdp.evaluate("document.querySelector('[data-overview-hunk=shrink]').getBoundingClientRect().top-document.querySelector('[data-scroll-area]').getBoundingClientRect().top");
    assert.ok(Math.abs(targetOffset-40)<1.1,'Clicking a marker brings its pending change into view');
    snap=await overviewSnapshot();assert.ok(Math.abs(snap.value-snap.top)<1.1);
    const start=await cdp.evaluate(`(() => {const thumb=document.querySelector('.change-scrollbar-thumb'),r=thumb.getBoundingClientRect();for(let fraction=.9;fraction>.05;fraction-=.1){const p={x:r.x+r.width/2,y:r.y+r.height*fraction};if(document.elementFromPoint(p.x,p.y)===thumb)return p;}throw new Error('Scrollbar thumb has no usable drag area');})()`);
    const target={x:start.x,y:Math.min(snap.rail.bottom-5,start.y+70)};
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...start});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...target});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...target});await settle();
    const dragged=await overviewSnapshot();assert.ok(dragged.top>snap.top+50,'Dragging the actual thumb scrolls the document');
    assert.ok(dragged.thumb.y>snap.thumb.y,'The thumb follows the new scroll offset');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:dragged.rail.x+dragged.rail.width/2,y:dragged.rail.y+dragged.rail.height/2,deltaX:0,deltaY:120});await settle();
    const wheeled=await overviewSnapshot();assert.ok(Math.abs(wheeled.top-Math.min(wheeled.max,dragged.top+120))<1.1,'Mouse wheel over the rail scrolls the comparison');
    await cdp.evaluate("document.querySelector('.change-scrollbar').focus({preventScroll:true})");
    await nativeEditorKey('Home');assert.equal((await overviewSnapshot()).top,0);
    await nativeEditorKey('ArrowDown');assert.equal((await overviewSnapshot()).top,22);
    await nativeEditorKey('PageDown');assert.ok((await overviewSnapshot()).top>200);
    await nativeEditorKey('End');const ended=await overviewSnapshot();assert.ok(Math.abs(ended.top-ended.max)<1.1);
    assert.equal(await cdp.evaluate("window.__messages.filter(message=>['decide','undo','editAndAccept'].includes(message.type)).length"),0,'Rail navigation cannot submit review decisions');
    await screenshot('comparison-'+width+'-change-scrollbar');
    await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=0");await settle();
    await clickDecision('grow','accept');
    assert.equal((await overviewSnapshot()).markers.some(item=>item.id==='grow'),false,'Resolving a hunk removes its pending markers');
    await clickUndo('grow');assert.equal((await overviewSnapshot()).markers.filter(item=>item.id==='grow').length,2);
    await resetFixture(width);
  });
}

async function toggleLayout() {
  await cdp.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'toggleLayout'}}))");await settle();
}
async function unifiedSnapshot() {
  return cdp.evaluate(`(() => {
    const visible=node=>Boolean(node&&node.getClientRects().length&&node.getBoundingClientRect().width>0);
    const rail=document.querySelector('.change-scrollbar').getBoundingClientRect(),scroll=document.querySelector('[data-scroll-area]').getBoundingClientRect();
    return {unified:document.querySelector('.review-app').classList.contains('layout-unified'),saved:window.__savedState.layout,
      dividerVisible:visible(document.querySelector('.pane-splitter')),rail:{width:rail.width,right:rail.right},scrollRight:scroll.right,
      leftContext:Array.from(document.querySelectorAll('.code-side.left.context .code-text')).filter(visible).length,
      rightContext:Array.from(document.querySelectorAll('.code-side.right.context .code-text')).filter(visible).length,
      hunks:Array.from(document.querySelectorAll('.hunk'),block=>({id:block.dataset.overviewHunk,
        sides:Array.from(block.querySelectorAll('.code-side.removed,.code-side.added')).filter(visible).map(node=>node.classList.contains('removed')?'removed':'added'),
        actions:Array.from(block.querySelectorAll('.inline-actions button')).filter(node=>visible(node)&&getComputedStyle(node).color!=='rgba(0, 0, 0, 0)').map(node=>node.textContent)}))};
  })()`);
}
async function runUnifiedTests(width) {
  await resetFixture(width);
  await runTest(width+'px: unified layout shows context once and keeps grouped deletion actions and the right-hand rail',async()=>{
    await toggleLayout();let value=await unifiedSnapshot();
    assert.equal(value.unified,true);assert.equal(value.saved,'unified');assert.equal(value.dividerVisible,false);
    assert.equal(value.rail.width,15);assert.ok(Math.abs(value.rail.right-value.scrollRight)<.6,'Unified scrollbar hugs the right edge');
    assert.equal(value.leftContext,0);assert.ok(value.rightContext>100,'Each unchanged context row is visible once');
    for(const hunk of fixture.files[0].hunks) {
      const rendered=value.hunks.find(item=>item.id===hunk.id);
      assert.deepEqual(rendered.sides,[...Array(hunk.oldLines).fill('removed'),...Array(hunk.newLines).fill('added')],'A unified block places removed lines before added lines');
      assert.equal(rendered.actions.filter(label=>label==='Accept').length,1);assert.equal(rendered.actions.filter(label=>label==='Ignore').length,1);
    }
    await clickDecision('delete','accept');value=await unifiedSnapshot();
    assert.deepEqual(value.hunks.find(item=>item.id==='delete').actions,['Undo'],'A resolved pure deletion retains visible Undo');
    await clickUndo('delete');assert.equal((await unifiedSnapshot()).hunks.find(item=>item.id==='delete').actions.filter(label=>label==='Accept').length,1);
    await screenshot('comparison-'+width+'-unified');
    await reloadPreview();value=await unifiedSnapshot();assert.equal(value.unified,true,'The selected layout survives preview reload');assert.equal(value.saved,'unified');
    await toggleLayout();assert.equal((await unifiedSnapshot()).unified,false);await resetFixture(width);
  });
  await runTest(width+'px: switching layout preserves an unsaved multiline draft, backward selection, and visible source anchor',async()=>{
    await openEdit('grow');const draft='Unsubmitted multiline draft.\nSecond line.\n';await writeDraft(draft);
    await cdp.evaluate("(() => {const area=document.querySelector('.pending-editor textarea');area.setSelectionRange(1,8,'backward');area.dispatchEvent(new Event('select'));document.querySelector('[data-scroll-area]').scrollTop=700;})()");await settle();
    const before=await viewportSnapshot();
    await toggleLayout();let edit=await editSnapshot();assert.equal(edit.draft,draft);assert.deepEqual(edit.selection,[1,8]);assert.equal(edit.direction,'backward');assert.equal(edit.focused,'edit:draft');
    await assertViewportPreserved(before);
    await toggleLayout();edit=await editSnapshot();assert.equal(edit.draft,draft);assert.deepEqual(edit.selection,[1,8]);assert.equal(edit.direction,'backward');
    await assertViewportPreserved(before);await editorKey('Escape');await resetFixture(width);
  });
}

async function runDefaultLayoutTests() {
  await resetFixture(1200);
  const fresh=async state=>{await cdp.evaluate("window.addEventListener('pagehide',()=>sessionStorage.setItem('rr-view-state','{}'),{once:true})");await reloadPreview(state);};
  await runTest('fresh previews honor configured layout and use unified when the setting is absent',async()=>{
    for(const configured of [undefined,'unified','sideBySide']) {
      const next=structuredClone(fixture);if(configured===undefined)delete next.defaultLayout;else next.defaultLayout=configured;
      await fresh(next);const current=await unifiedSnapshot();
      assert.equal(current.unified,configured!=='sideBySide');assert.equal(current.saved,configured==='sideBySide'?'sideBySide':'unified');
      if(configured===undefined){await cdp.evaluate("document.querySelector('[data-scroll-area]').scrollTop=0");await settle();await screenshot('comparison-default-unified-top');}
    }
  });
  await runTest('a preview layout toggle overrides later settings and remains selected after reload',async()=>{
    const configured=structuredClone(fixture);await fresh(configured);
    await toggleLayout();assert.equal((await unifiedSnapshot()).unified,true);
    await cdp.evaluate("window.__setReview({...window.__review,defaultLayout:'unified'})");await settle();
    await cdp.evaluate("window.__setReview({...window.__review,defaultLayout:'sideBySide'})");await settle();
    assert.equal((await unifiedSnapshot()).unified,true,'A settings refresh preserves the chosen preview layout');
    await reloadPreview(configured);assert.equal((await unifiedSnapshot()).unified,true,'Restored unified layout overrides configured side-by-side');
    await toggleLayout();const unifiedDefault={...configured,defaultLayout:'unified'};
    await cdp.evaluate('window.__setReview('+JSON.stringify(unifiedDefault)+')');await settle();
    assert.equal((await unifiedSnapshot()).unified,false);
    await reloadPreview(unifiedDefault);const restored=await unifiedSnapshot();
    assert.equal(restored.unified,false,'Restored side-by-side layout overrides configured unified');assert.equal(restored.saved,'sideBySide');
    await resetFixture(1200);
  });
}

async function runCreateRequestTests() {
  for(const width of [900,400]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    await cdp.evaluate('window.__createReloadMarker=true');
    await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/create'});
    const deadline=Date.now()+6000;let ready=false;
    while(Date.now()<deadline){if(await cdp.evaluate("Boolean(!window.__createReloadMarker&&window.__createMessages?.some(message=>message.command==='ready'))")){ready=true;break;}await delay(40);}
    assert.equal(ready,true,'The production creation form sends ready');
    const set=async fields=>{await cdp.evaluate('window.__setCreate('+JSON.stringify({type:'state',busy:false,selecting:false,...fields})+')');await settle();};
    const snapshot=()=>cdp.evaluate(`(() => {const ids=['select-original','select-proposed','create-request','cancel'];return {title:document.querySelector('h1').textContent,steps:document.querySelectorAll('.steps li').length,body:document.body.textContent,
      original:document.getElementById('original-path').textContent,proposed:document.getElementById('proposed-path').textContent,output:document.getElementById('output-path').textContent,
      revision:document.getElementById('original-revision').textContent,revisionHidden:document.getElementById('original-revision').hidden,gitNoticeHidden:document.getElementById('git-notice').hidden,
      error:document.getElementById('error-message').textContent,errorHidden:document.getElementById('error-message').hidden,
      buttons:Object.fromEntries(ids.map(id=>{const button=document.getElementById(id),r=button.getBoundingClientRect();return[id,{disabled:button.disabled,label:button.textContent,x:r.x,right:r.right,height:r.height,background:getComputedStyle(button).backgroundColor}];})),
      width:innerWidth,scrollWidth:document.documentElement.scrollWidth,injected:document.querySelectorAll('.path-display img,.path-display svg,.error img').length,xss:window.__xss,messages:window.__createMessages};})()`);
    const click=async id=>{const point=await cdp.evaluate(`(() => {const button=document.getElementById(${JSON.stringify(id)});button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await settle();};
    const selected={original:'C:/workspace/'+('long folder/').repeat(8)+'original <img src=x onerror="window.__xss=99">.tex',proposed:'C:/copies/modified & revised.tex',output:'C:/workspace/original.tex.rr'};
    await runTest(width+'px: the creation form explains the workflow and enables Create only after both native choices',async()=>{
      await set({});let view=await snapshot();assert.equal(view.title,'Create Revision Request');assert.equal(view.steps,3);assert.ok(view.body.includes('Both input files stay unchanged'));
      assert.equal(view.buttons['create-request'].disabled,true);await click('select-original');assert.deepEqual((await snapshot()).messages.at(-1),{command:'selectOriginal'});
      await set({original:selected.original,output:selected.output});view=await snapshot();assert.equal(view.buttons['create-request'].disabled,true);assert.equal(view.original,selected.original);
      await click('select-proposed');assert.deepEqual((await snapshot()).messages.at(-1),{command:'selectProposed'});
      await set(selected);view=await snapshot();assert.equal(view.buttons['create-request'].disabled,false);assert.equal(view.proposed,selected.proposed);assert.equal(view.output,selected.output);
      assert.equal(view.injected,0);assert.equal(view.xss,0);assert.ok(view.scrollWidth<=width,'Long selected paths wrap without horizontal overflow');
      for(const button of Object.values(view.buttons)){assert.ok(button.x>=0&&button.right<=width);assert.ok(button.height>=30);}
      await set({original:'C:/workspace/manuscript.tex',proposed:'C:/copies/manuscript-revised.tex',output:'C:/workspace/manuscript.tex.rr'});
      await cdp.evaluate('window.scrollTo(0,0)');await settle();await screenshot('create-request-'+width+'-ready');
    });
    await runTest(width+'px: blue file selectors and Git baseline details retain layout and escaped text',async()=>{
      await set(selected);
      let view=await snapshot();
      for(const id of ['select-original','select-proposed']) {
        assert.ok(['rgb(14, 99, 156)','rgb(17, 119, 187)'].includes(view.buttons[id].background),'File selectors use the primary blue theme color');
      }
      assert.equal(view.revisionHidden,true);assert.equal(view.gitNoticeHidden,true);
      const revision='a1b2c3d4 · 2026-11-12 · '+('Long commit description ').repeat(8)+'<img src=x onerror="window.__xss=97">';
      await set({...selected,proposed:selected.original,originalMode:'git',originalRevision:revision});
      view=await snapshot();assert.equal(view.revision,revision);assert.equal(view.revisionHidden,false);assert.equal(view.gitNoticeHidden,false);
      assert.equal(view.proposed,selected.original);assert.equal(view.buttons['create-request'].disabled,false);
      assert.equal(view.xss,0);assert.ok(view.scrollWidth<=width,'Long commit descriptions wrap within the creation form');
      assert.equal(await cdp.evaluate('document.querySelectorAll("#original-revision img").length'),0);
      await set({original:'C:/workspace/manuscript.tex',proposed:'C:/workspace/manuscript.tex',output:'C:/workspace/manuscript.tex.rr',originalMode:'git',originalRevision:'a1b2c3d4 · 2026-11-12 · Clarify the estimate'});
      await cdp.evaluate('window.scrollTo(0,0)');await settle();await screenshot('create-request-'+width+'-git');
      await set(selected);view=await snapshot();assert.equal(view.revisionHidden,true);assert.equal(view.gitNoticeHidden,true);
    });
    await runTest(width+'px: selecting and creating block duplicate commands while inline errors keep the form reusable',async()=>{
      for(const field of ['selecting','busy']) {
        await set({...selected,[field]:true});const before=await snapshot();assert.ok(Object.values(before.buttons).every(button=>button.disabled));
        if(field==='busy')assert.equal(before.buttons['create-request'].label,'Creating…');
        await cdp.evaluate("document.querySelectorAll('button').forEach(button=>button.click());document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        assert.equal((await snapshot()).messages.length,before.messages.length,'Blocked form emits no command');
      }
      const error='Request failed <img src=x onerror="window.__xss=98">.';await set({...selected,error});let view=await snapshot();
      assert.equal(view.error,error);assert.equal(view.errorHidden,false);assert.equal(view.original,selected.original);assert.equal(view.proposed,selected.proposed);assert.equal(view.buttons['create-request'].disabled,false);assert.equal(view.injected,0);assert.equal(view.xss,0);
      await click('create-request');assert.deepEqual((await snapshot()).messages.at(-1),{command:'create'},'Only the action is sent; paths stay host-owned');
      await set(selected);assert.equal((await snapshot()).errorHidden,true);
      await click('cancel');assert.deepEqual((await snapshot()).messages.at(-1),{command:'cancel'});
      await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");assert.deepEqual((await snapshot()).messages.at(-1),{command:'cancel'});
    });
  }
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
      await assertTextProjection(); await assertMatchingContextWraps(); await screenshot('comparison-' + width + '-initial');
      return { rows: measurements.rows.length, bannerHeight: measurements.banner.left.height, spacers: measurements.spacers };
    });
    await runTest(width + 'px: long code wraps before controls with aligned logical rows and no hidden final text', async () => {
      const prefix = '\tconst long_value = ' + 'long_token '.repeat(12) + 'UNBROKEN_' + 'x'.repeat(95);
      const beforeLine = prefix + ' ORIGINAL_ALPHA ORIGINAL_END\n';
      const afterLine = prefix + ' PROPOSED_ALPHA PROPOSED_END\n';
      const tail = Array.from({length: 105}, (_, index) => 'unchanged tail ' + index + '\n').join('');
      const longState = { ...structuredClone(fixture), files: [{path: fixture.files[0].path, before: beforeLine + tail,
        hunks: [{id: 'long', index: 0, start: 0, end: beforeLine.length, before: beforeLine, after: afterLine,
          oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, decision: 'pending', contextBefore: [], contextAfter: [],
          inlineChanges: computeInlineChanges({before: beforeLine, after: afterLine}, 40, fixture.files[0].path)}] }] };
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
            changed:Array.from(code.querySelectorAll('.inline-changed'),node=>node.textContent),
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
          assert.deepEqual(value.changed.map(text=>text.trim()),[side==='left'?'ORIGINAL_ALPHA ORIGINAL_END':'PROPOSED_ALPHA PROPOSED_END'],'Consecutive changed words and their separating space share one highlight');
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
    await runLanguageHighlightTests(width);
    await runProgrammingHighlightTests(width);
    await runEditorTests(width);
    await runMulticursorTests(width);
    await runEditorButtonTests(width);
    await runReviewActionTests(width);
    await runEditorDecisionTests(width);
    await runGroupedRequestTests(width);
    await runUnterminatedAppendTests(width);
    await runNavigationTests(width);
    await runUnifiedTests(width);
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
        assert.equal(row.first, true); assert.deepEqual(row.labels, ['Accept', 'Ignore', '⋯']);
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
      const actual = await cdp.evaluate(`({ xss: window.__xss, injected: Array.from(document.querySelectorAll('#app img, #app svg, #app script')).filter(node=>!node.matches('.quick-review-toggle > svg.quick-review-icon')).length,
        titleElements: document.querySelectorAll('.request-title').length, titleVisible: document.getElementById('app').textContent.includes(window.__fixture.title),
        descriptionVisible: document.getElementById('app').textContent.includes(window.__fixture.description),
        code: document.querySelector('.code-side.left .code-text').textContent })`);
      assert.equal(actual.xss, 0); assert.equal(actual.injected, 0); assert.equal(actual.titleElements, 0); assert.equal(actual.titleVisible, false, 'Request title stays metadata-only');
      assert.equal(actual.descriptionVisible, false, 'Description is metadata, with no banner disclosure');
      assert.ok(actual.code.includes('<img src=x onerror="window.__xss=1">'));
    });
    let inlineBaseline, inlineGeometry;
    await runTest(width + 'px: default inline rendering preserves language-aware LaTeX and Unicode highlights', async () => {
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
    await runTest(width + 'px: More actions remains visible with disabled Why for missing reasons', async () => {
      const originalTop=(await viewportSnapshot()).top;
      for (const id of ['delete','shrink']) {
        await cdp.evaluate('document.querySelector("[data-why-id='+id+']").scrollIntoView({block:"nearest"})');await settle();
        const before=await geometry(); await clickMore(id);
        const menu=await cdp.evaluate('(() => {const toggle=document.querySelector("[data-why-id='+id+']"),why=document.querySelector(".review-action-why"); return {text:toggle.textContent,disabled:toggle.disabled,width:toggle.getBoundingClientRect().width,whyDisabled:why.disabled,title:why.title};})()');
        assert.equal(menu.text,'⋯');assert.equal(menu.disabled,false);assert.ok(menu.width>0);assert.equal(menu.whyDisabled,true);assert.equal(menu.title,'No explanation provided');
        await assertNoLayoutShift(before);await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await settle();
      }
      await cdp.evaluate('document.querySelector("[data-scroll-area]").scrollTop='+originalTop);await settle();
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
      let beforeDecision, beforeDecisionViewport, pendingActions;
      await runTest(width + 'px: ' + action.decision + ' ' + action.id + ' preserves alignment and the intended projection', async () => {
        beforeDecision = await geometry(); beforeDecisionViewport=await viewportSnapshot(); pendingActions = await inspectHunkActions(action.id);
        await clickDecision(action.id, action.decision);
        const after = await geometry(); assertAligned(after); assert.deepEqual(after.spacers, action.spacers);
        await assertViewportPreserved(beforeDecisionViewport);
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
        const priorScroll = await viewportSnapshot();
        await clickUndo(action.id);
        const current = await cdp.evaluate('window.__review.files[0].hunks.map(hunk => ({ id: hunk.id, decision: hunk.decision }))');
        assert.deepEqual(current, priorDecisions.map(item => item.id === action.id ? { ...item, decision: 'pending' } : item), 'Undo changes only the selected decision');
        const undone = await geometry(); assertAligned(undone);
        assert.deepEqual(undone.spacers, beforeDecision.spacers, 'Undo restores the exact pending alignment');
        await assertViewportPreserved(priorScroll);
        await assertTextProjection();
        const restored = await inspectHunkActions(action.id);
        assert.deepEqual(restored.buttons, ['Accept', 'Ignore', '⋯']);
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
  const corePath = path.join(runDir, 'core.cjs'), requestPath = path.join(runDir, 'request.cjs'), createPath = path.join(runDir, 'create-view.cjs');
  await Promise.all([[corePath,'core.ts'],[requestPath,'request.ts'],[createPath,'createRequestView.ts']].map(([outfile,entry])=>
    require('esbuild').build({entryPoints:[path.join(root,'src',entry)],outfile,
      bundle:true,platform:'node',format:'cjs',external:['vscode'],logLevel:'silent'})));
  ({computeInlineChanges, computeFileInlineChanges} = require(corePath));
  ({parseRequestDocument,resolveRequest} = require(requestPath));
  const load = Module._load;
  Module._load = function(name,parent,main){return name==='vscode'?{Uri:{joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})}}:load.call(this,name,parent,main);};
  try { ({createRequestViewHtml} = require(createPath)); } finally { Module._load = load; }
  for (const hunk of fixture.files[0].hunks) hunk.inlineChanges = computeInlineChanges(hunk, 40, fixture.files[0].path);
  const url = await startServer();
  console.log('Browser: ' + executable); console.log('Artifacts: ' + runDir);
  await startBrowser(executable, url);
  if (process.env.RR_UI_TEST_GROUP === 'highlight') {
    for (const width of [1200, 620]) {await runLanguageHighlightTests(width);await runProgrammingHighlightTests(width);}
  } else if (process.env.RR_UI_TEST_GROUP === 'actions') {
    for (const width of [1200,620]) await runReviewActionTests(width);
  } else if (process.env.RR_UI_TEST_GROUP === 'navigation') {
    for (const width of [1200,620]) {await runOpenNavigationTests(width);await runNavigationTests(width);}
  } else if (process.env.RR_UI_TEST_GROUP === 'quick') {
    for (const width of [1200,620]) await runQuickReviewTests(width);
  } else if (process.env.RR_UI_TEST_GROUP === 'create') {
    await runCreateRequestTests();
  } else if (process.env.RR_UI_TEST_GROUP === 'multicursor') {
    for (const width of [1600, 620]) {await runMulticursorTests(width);await runEditorDecisionTests(width);}
  } else {
    await runDefaultLayoutTests();
    await runLayoutTests();
    for (const width of [1200,620]) {await runQuickReviewTests(width);await runOpenNavigationTests(width);}
    await runCreateRequestTests();
  }
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
