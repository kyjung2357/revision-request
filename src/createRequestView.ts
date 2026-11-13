import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { listGitFileHistory, type GitOriginal } from './gitOriginal';

export interface CreateRequestViewOptions {
  extensionUri: vscode.Uri;
  defaultUri: vscode.Uri;
  create: (original: vscode.Uri, proposed: vscode.Uri, isCancelled: () => boolean, gitOriginal?: GitOriginal) => Promise<vscode.Uri>;
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
<p class="intro">Compare a saved file or a Git commit with a modified copy to create a proposal for review.</p>
<ol class="steps"><li>Choose a workspace file or its version from a Git commit.</li><li>Choose the saved copy containing your edits.</li><li>Create a <code>.rr</code> file and review the changes before applying them.</li></ol>
<section aria-labelledby="original-label"><div class="field-heading"><h2 id="original-label">Original file</h2><button id="select-original" class="primary" type="button">Select original</button></div>
<p class="hint">The existing file that the reviewer will apply changes to.</p>
<div class="path-display" id="original-path" aria-live="polite">No file selected</div>
<p id="original-revision" class="hint revision" hidden></p></section>
<section aria-labelledby="proposed-label"><div class="field-heading"><h2 id="proposed-label">Modified copy</h2><button id="select-proposed" class="primary" type="button">Select modified copy</button></div>
<p class="hint">The saved file containing the changes you want to propose. With a Git original, this defaults to the current file.</p>
<div class="path-display" id="proposed-path" aria-live="polite">No file selected</div></section>
<section class="result" aria-labelledby="result-label"><h2 id="result-label">Request file</h2><div id="output-path" class="path-display" aria-live="polite">Choose an original to see where the request will be saved.</div>
<p class="hint">The request is saved beside the original as <code>original.ext.rr</code>. Existing requests are never overwritten.</p></section>
<p class="note">Both input files stay unchanged. Only <strong>Accept</strong> in the review applies a change to the original.</p>
<p id="git-notice" class="note" hidden>This request uses the selected commit as its baseline. Share it with someone reviewing that version; your current file may already contain the changes.</p>
<p id="error-message" class="error" role="alert" hidden></p>
<div class="actions"><button id="create-request" class="primary" type="button" disabled>Create Revision Request</button><button id="cancel" type="button">Cancel</button></div>
</main><script nonce="${nonce}" src="${escape(script.toString())}"></script></body></html>`;
}

export function revealCreateRequestView(): void { active?.panel.reveal(); }

/** Owns native selections, never accepting source paths supplied by the webview. */
export function showCreateRequestView(options: CreateRequestViewOptions): Promise<vscode.Uri | undefined> {
  if (active) { active.panel.reveal(); return active.result; }
  const panel = vscode.window.createWebviewPanel('revisionRequest.create', 'Create Revision Request', vscode.ViewColumn.Active,
    {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')]});
  let original: vscode.Uri | undefined, proposed: vscode.Uri | undefined;
  let gitOriginal: GitOriginal | undefined;
  let busy = false, selecting = false, disposed = false, error: string | undefined;
  let resolve!: (uri: vscode.Uri | undefined) => void;
  const result = new Promise<vscode.Uri | undefined>(done => {resolve = done;});
  const entry = {panel, result}; active = entry;
  const state = () => {
    if (!disposed) void panel.webview.postMessage({type:'state', original:original?.fsPath, proposed:proposed?.fsPath,
      output:original ? original.fsPath + '.rr' : undefined,
      originalMode: gitOriginal ? 'git' : 'workspace',
      originalRevision: gitOriginal ? [gitOriginal.commit.slice(0, 8), gitOriginal.date, gitOriginal.subject].filter(Boolean).join(' · ') : undefined,
      busy, selecting, error});
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
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before selecting request files.');
        const mode = isOriginal ? await vscode.window.showQuickPick([
          {label: 'Workspace file', description: 'Use the current saved original', mode: 'workspace' as const},
          {label: 'Git commit', description: 'Use an earlier committed version of a file', mode: 'git' as const},
        ], {title: 'Select original', placeHolder: 'Choose the comparison baseline', ignoreFocusOut: true}) : undefined;
        if (disposed || (isOriginal && !mode)) return;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before selecting request files.');
        const picked = (await vscode.window.showOpenDialog({title: isOriginal
          ? mode?.mode === 'git' ? 'Select the file whose Git history you want to compare' : 'Select the original file (before changes)'
          : 'Select the modified copy (after changes)',
          openLabel: isOriginal ? 'Select original' : 'Select modified copy', canSelectFiles:true, canSelectFolders:false, canSelectMany:false,
          defaultUri: isOriginal ? original ?? options.defaultUri : proposed ?? (original ? vscode.Uri.file(path.dirname(original.fsPath)) : options.defaultUri)}))?.[0];
        if (disposed || !picked) return;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before selecting request files.');
        if (picked.scheme !== 'file') throw new Error('Choose a saved local file.');
        const folder = vscode.workspace.getWorkspaceFolder(picked);
        if (isOriginal && folder?.uri.scheme !== 'file') {
          throw new Error('Select an original file inside an open local workspace.');
        }
        if (!isOriginal) {proposed = picked; return;}
        let selectedCommit: GitOriginal | undefined;
        if (mode?.mode === 'git') {
          const history = await listGitFileHistory(folder!.uri.fsPath, picked.fsPath);
          if (disposed) return;
          if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before reading Git history.');
          if (!history.length) throw new Error('No commits were found for this file at its current path on the current branch.');
          const choices = history.map(revision => ({label: revision.subject || '(No commit message)',
            description: revision.commit.slice(0, 8) + ' · ' + revision.date, revision}));
          const choice = await vscode.window.showQuickPick(choices, {title: 'Select original commit',
            placeHolder: 'Recent commits for ' + path.basename(picked.fsPath) + ' on the current branch',
            matchOnDescription: true, ignoreFocusOut: true});
          if (disposed || !choice) return;
          if (!choices.includes(choice)) throw new Error('Select a commit from this file’s history.');
          selectedCommit = choice.revision;
        }
        if (!vscode.workspace.isTrusted || vscode.workspace.getWorkspaceFolder(picked)?.uri.toString() !== folder!.uri.toString()) {
          throw new Error('The selected workspace changed. Select the original again.');
        }
        // Replace all baseline fields only after every native selection succeeds.
        if (selectedCommit) proposed = picked;
        else if (gitOriginal && proposed?.toString() === original?.toString()) proposed = undefined;
        original = picked; gitOriginal = selectedCommit;
      } catch (failure) { if (!disposed) error = failure instanceof Error ? failure.message : 'The file could not be selected.'; }
      finally { selecting = false; state(); }
      return;
    }
    if (command === 'create' && original && proposed) {
      busy = true; error = undefined; state();
      try {
        const created = await options.create(original, proposed, () => disposed, gitOriginal);
        if (!disposed) { resolve(created); panel.dispose(); }
      } catch (failure) { if (!disposed) error = failure instanceof Error ? failure.message : 'The request could not be created.'; }
      finally { busy = false; state(); }
    }
  });
  panel.onDidDispose(() => {disposed = true; messages.dispose(); if (active === entry) active = undefined; resolve(undefined);});
  panel.webview.html = createRequestViewHtml(panel.webview, options.extensionUri);
  return result;
}
