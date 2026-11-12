import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CreateRequestViewOptions {
  extensionUri: vscode.Uri;
  defaultUri: vscode.Uri;
  create: (original: vscode.Uri, proposed: vscode.Uri, isCancelled: () => boolean) => Promise<vscode.Uri>;
}
let active: {panel: vscode.WebviewPanel; result: Promise<vscode.Uri | undefined>} | undefined;
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]!));

export function createRequestViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64url');
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'create-request.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'create-request.js'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${escape(style.toString())}"><title>Create Revision Request</title></head>
<body><main>
<h1>Create Revision Request</h1>
<p class="intro">Compare an original file with a separately edited copy to create a proposal for review.</p>
<ol class="steps"><li>Choose the original file in this workspace.</li><li>Choose the saved copy containing your edits.</li><li>Create a <code>.rr</code> file and review the changes before applying them.</li></ol>
<section aria-labelledby="original-label"><div class="field-heading"><h2 id="original-label">Original file</h2><button id="select-original" type="button">Select original</button></div>
<p class="hint">The existing file that the reviewer will apply changes to.</p>
<div class="path-display" id="original-path" aria-live="polite">No file selected</div></section>
<section aria-labelledby="proposed-label"><div class="field-heading"><h2 id="proposed-label">Modified copy</h2><button id="select-proposed" type="button">Select modified copy</button></div>
<p class="hint">A separate saved file containing the changes you want to propose.</p>
<div class="path-display" id="proposed-path" aria-live="polite">No file selected</div></section>
<section class="result" aria-labelledby="result-label"><h2 id="result-label">Request file</h2><div id="output-path" class="path-display" aria-live="polite">Choose an original to see where the request will be saved.</div>
<p class="hint">The request is saved beside the original as <code>original.ext.rr</code>. Existing requests are never overwritten.</p></section>
<p class="note">Both input files stay unchanged. Only <strong>Accept</strong> in the review applies a change to the original.</p>
<p id="error-message" class="error" role="alert" hidden></p>
<div class="actions"><button id="create-request" class="primary" type="button" disabled>Create Revision Request</button><button id="cancel" type="button">Cancel</button></div>
</main><script nonce="${nonce}" src="${escape(script.toString())}"></script></body></html>`;
}

/** Owns native selections, never accepting source paths supplied by the webview. */
export function showCreateRequestView(options: CreateRequestViewOptions): Promise<vscode.Uri | undefined> {
  if (active) { active.panel.reveal(); return active.result; }
  const panel = vscode.window.createWebviewPanel('revisionRequest.create', 'Create Revision Request', vscode.ViewColumn.Active,
    {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')]});
  let original: vscode.Uri | undefined, proposed: vscode.Uri | undefined;
  let busy = false, selecting = false, disposed = false, error: string | undefined;
  let resolve!: (uri: vscode.Uri | undefined) => void;
  const result = new Promise<vscode.Uri | undefined>(done => {resolve = done;});
  const entry = {panel, result}; active = entry;
  const state = () => {
    if (!disposed) void panel.webview.postMessage({type:'state', original:original?.fsPath, proposed:proposed?.fsPath,
      output:original ? original.fsPath + '.rr' : undefined, busy, selecting, error});
  };
  const messages = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (disposed || !message || typeof message !== 'object') return;
    const command = (message as {command?: unknown}).command;
    if (command === 'ready') { state(); return; }
    if (busy || selecting) return;
    if (command === 'cancel') { panel.dispose(); return; }
    if (command === 'selectOriginal' || command === 'selectProposed') {
      selecting = true; error = undefined; state();
      try {
        const isOriginal = command === 'selectOriginal';
        const picked = (await vscode.window.showOpenDialog({title: isOriginal ? 'Select the original file (before changes)' : 'Select the modified copy (after changes)',
          openLabel: isOriginal ? 'Select original' : 'Select modified copy', canSelectFiles:true, canSelectFolders:false, canSelectMany:false,
          defaultUri: isOriginal ? original ?? options.defaultUri : proposed ?? (original ? vscode.Uri.file(path.dirname(original.fsPath)) : options.defaultUri)}))?.[0];
        if (disposed || !picked) return;
        if (picked.scheme !== 'file') throw new Error('Choose a saved local file.');
        if (isOriginal && vscode.workspace.getWorkspaceFolder(picked)?.uri.scheme !== 'file') {
          throw new Error('Select an original file inside an open local workspace.');
        }
        if (isOriginal) original = picked; else proposed = picked;
      } catch (failure) { if (!disposed) error = failure instanceof Error ? failure.message : 'The file could not be selected.'; }
      finally { selecting = false; state(); }
      return;
    }
    if (command === 'create' && original && proposed) {
      busy = true; error = undefined; state();
      try {
        const created = await options.create(original, proposed, () => disposed);
        if (!disposed) { resolve(created); panel.dispose(); }
      } catch (failure) { if (!disposed) error = failure instanceof Error ? failure.message : 'The request could not be created.'; }
      finally { busy = false; state(); }
    }
  });
  panel.onDidDispose(() => {disposed = true; messages.dispose(); if (active === entry) active = undefined; resolve(undefined);});
  panel.webview.html = createRequestViewHtml(panel.webview, options.extensionUri);
  return result;
}
