import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** A local-only review surface. Request text is inserted by the client with textContent. */
export function getReviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, requestUri?: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.js'));
  const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(__dirname), 'review-highlight.js'));
  const escapes: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
  const attr = (value: string): string => value.replace(/[&"<>]/g, character => escapes[character] ?? character);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(webview.cspSource)}; script-src 'nonce-${nonce}';">
  <title>Revision Request</title>
  <link rel="stylesheet" href="${attr(styleUri.toString())}">
</head>
<body>
  <div id="app"${requestUri ? ` data-request-uri="${attr(requestUri.toString())}"` : ''}>
    <main class="initial-state" aria-live="polite">
      <div class="brand-mark" aria-hidden="true">rr</div>
      <h1>Opening revision request…</h1>
      <p>Your original files stay unchanged until you accept a revision.</p>
    </main>
  </div>
  <script nonce="${nonce}" src="${attr(highlightUri.toString())}"></script>
  <script nonce="${nonce}" src="${attr(scriptUri.toString())}"></script>
</body>
</html>`;
}

/** An old panel without a saved request location cannot safely be rebound. */
export function getReviewRestoreErrorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
<title>Reopen the revision request</title></head><body>
<h1>Reopen the revision request</h1>
<p>This preview's request location was not saved or is no longer in an open workspace.</p>
<p>Close this tab and open the .rr file from Explorer or the Requests view.</p>
</body></html>`;
}
