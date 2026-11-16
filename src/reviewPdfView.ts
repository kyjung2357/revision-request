import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import * as path from 'node:path';
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));

/** Static viewer assets only; PDF bytes and validated review data arrive by message. */
export function createReviewPdfViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64url');
  const asset = (...parts: string[]) => escape(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString());
  const source = escape(webview.cspSource);
  const pdfRoot = existsSync(path.join(extensionUri.fsPath, 'dist', 'pdfjs', 'pdf.mjs')) ? 'dist' : '.codex-build';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${source} 'wasm-unsafe-eval'; worker-src ${source} blob:; style-src ${source} 'unsafe-inline'; font-src ${source} blob: data:; img-src ${source} blob: data:; connect-src ${source};">
<link rel="stylesheet" href="${asset('media','pdf-review.css')}"><title>PDF Review</title></head>
<body data-pdf-module="${asset(pdfRoot,'pdfjs','pdf.mjs')}" data-pdf-worker="${asset(pdfRoot,'pdfjs','pdf.worker.mjs')}" data-pdf-assets="${asset(pdfRoot,'pdfjs')}/">
<header class="viewer-toolbar"><span id="filename" class="filename">PDF review</span>
<div class="navigation"><button id="previous-page" type="button" title="Previous page" aria-label="Previous page">‹</button><input id="page-number" type="number" min="1" value="1" aria-label="Page number"><span id="page-count">/ —</span><button id="next-page" type="button" title="Next page" aria-label="Next page">›</button>
<button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">−</button><button id="zoom-fit" type="button" title="Fit page width">Fit width</button><button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button></div>
<span id="save-status" role="status" aria-live="polite">Loading PDF…</span></header>
<div id="error-bar" class="error-bar" hidden><span id="error-message" role="alert"></span><button id="retry-save" type="button" hidden>Retry save</button><button id="reload-pdf" type="button">Reload saved PDF</button></div>
<main id="pages" aria-label="PDF review pages" tabindex="-1"></main>
<div id="review-menu" class="review-menu" role="menu" hidden></div>
<section id="explanation" class="explanation" role="dialog" aria-label="Change explanation" hidden><div class="explanation-heading"><strong>Why</strong><button id="close-explanation" type="button" aria-label="Close explanation">×</button></div><p id="explanation-text"></p></section>
<script nonce="${nonce}" type="module" src="${asset('media','pdf-review.js')}"></script></body></html>`;
}
