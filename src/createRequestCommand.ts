import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequestFile } from './createRequestFile';
import { showCreateRequestView, revealCreateRequestView } from './createRequestView';
import type { GitOriginal } from './gitOriginal';

export interface CreateRequestResult { uri: vscode.Uri; fromGit: boolean }
let pendingCreation: Promise<CreateRequestResult | undefined> | undefined;

const samePath = (left: string, right: string) => path.relative(left, right) === '';

const sameCreatedFile = (left: import('node:fs').Stats, right: import('node:fs').Stats) =>
  left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
  left.birthtimeMs === right.birthtimeMs && left.mtimeMs === right.mtimeMs && left.size === right.size;

/** Only discard the new request if it is still the exact file captured after creation. */
async function rememberCreatedGitRequest(
  uri: vscode.Uri, original: GitOriginal, remember: (uri: vscode.Uri, original: GitOriginal) => Promise<void>,
): Promise<void> {
  const stat = await fs.lstat(uri.fsPath);
  const bytes = await fs.readFile(uri.fsPath);
  if (!sameCreatedFile(stat, await fs.lstat(uri.fsPath))) {
    throw new Error('The .rr file changed after creation. It was preserved; create the request again after checking it.');
  }
  try { await remember(uri, original); }
  catch (error) {
    let removed = false;
    try {
      const current = await fs.lstat(uri.fsPath);
      if (sameCreatedFile(stat, current) && bytes.equals(await fs.readFile(uri.fsPath)) &&
          sameCreatedFile(stat, await fs.lstat(uri.fsPath))) {
        await fs.unlink(uri.fsPath);
        removed = true;
      }
    } catch (cleanupError) {
      removed = (cleanupError as NodeJS.ErrnoException).code === 'ENOENT';
    }
    const reason = error instanceof Error ? error.message : 'The Git baseline could not be recorded.';
    throw new Error((removed
      ? 'The Git baseline could not be recorded, so the new .rr file was removed. '
      : 'The Git baseline could not be recorded. The .rr file already exists and was preserved because it changed or could not be safely removed. ') + reason);
  }
}


/** Show an explanation and explicit file choices before creating a reviewable request. */
export async function createRequestFromFiles(
  extensionUri: vscode.Uri,
  runExclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(),
  onGitCreated?: (uri: vscode.Uri, original: GitOriginal) => Promise<void>,
): Promise<CreateRequestResult | undefined> {
  if (pendingCreation) { revealCreateRequestView(); return undefined; }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  if (!folders.length) throw new Error('Open a local workspace folder before creating a revision request.');
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating a revision request.');
  const active = vscode.window.activeTextEditor?.document.uri;
  const defaultUri = active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active) && !active.path.endsWith('.rr')
    ? active : folders[0]!.uri;
  let fromGit = false;
  const pending = showCreateRequestView({extensionUri, defaultUri,
    create: async (original, proposed, isCancelled, gitOriginal) => {
      const uri = await createRequestFromSelection(original, proposed, runExclusive, isCancelled, gitOriginal, onGitCreated);
      fromGit = gitOriginal !== undefined;
      return uri;
    }}).then(uri => uri ? {uri, fromGit} : undefined);
  pendingCreation = pending;
  try { return await pending; } finally { if (pendingCreation === pending) pendingCreation = undefined; }
}

/** Commit only the chosen saved snapshots; the form never supplies arbitrary paths. */
export async function createRequestFromSelection(
  original: vscode.Uri, proposed: vscode.Uri,
  runExclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(),
  isCancelled: () => boolean = () => false,
  gitOriginal?: GitOriginal,
  onGitCreated?: (uri: vscode.Uri, original: GitOriginal) => Promise<void>,
): Promise<vscode.Uri> {
  const folder = vscode.workspace.getWorkspaceFolder(original);
  if (original.scheme !== 'file' || !folder || folder.uri.scheme !== 'file') {
    throw new Error('Select an original file inside an open local workspace.');
  }
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating a revision request.');
  if (proposed.scheme !== 'file') throw new Error('Select a local modified copy.');
  const output = original.fsPath + '.rr';
  const assertCurrent = () => {
    if (isCancelled()) throw new Error('Request creation was cancelled.');
    if (!vscode.workspace.isTrusted || vscode.workspace.getWorkspaceFolder(original)?.uri.toString() !== folder.uri.toString()) {
      throw new Error('The selected workspace changed. Create the request again.');
    }
  };
  const assertReady = async () => {
    assertCurrent();
    const inputs = await Promise.all([original.fsPath, proposed.fsPath].map(async name => ({
      real: await fs.realpath(name), stat: await fs.stat(name),
    })));
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const name = document.uri.fsPath;
      const real = await fs.realpath(name).catch(() => name);
      const stat = await fs.stat(name).catch(() => undefined);
      if (samePath(name, output) || inputs.some(input => samePath(real, input.real) ||
          (stat && stat.ino !== 0 && stat.ino === input.stat.ino && stat.dev === input.stat.dev))) {
        throw new Error('Save or discard unsaved edits in "' + path.basename(name) + '" before creating the request.');
      }
    }
    assertCurrent();
  };
  return runExclusive(async () => {
    const created = await createRequestFile({
      workspace: folder.uri.fsPath,
      original: path.relative(folder.uri.fsPath, original.fsPath).split(path.sep).join('/'),
      proposed: proposed.fsPath,
      gitOriginal,
      assertReady,
    });
    const uri = vscode.Uri.file(created);
    // Persist the authoring baseline before the review queue permits another action.
    if (gitOriginal && onGitCreated) await rememberCreatedGitRequest(uri, gitOriginal, onGitCreated);
    return uri;
  });
}
