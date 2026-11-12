import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequestFile } from './createRequestFile';
import { showCreateRequestView } from './createRequestView';

const samePath = (left: string, right: string) => path.relative(left, right) === '';

/** Show an explanation and explicit file choices before creating a reviewable request. */
export async function createRequestFromFiles(
  extensionUri: vscode.Uri,
  runExclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(),
): Promise<vscode.Uri | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  if (!folders.length) throw new Error('Open a local workspace folder before creating a revision request.');
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating a revision request.');
  const active = vscode.window.activeTextEditor?.document.uri;
  const defaultUri = active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active) && !active.path.endsWith('.rr')
    ? active : folders[0]!.uri;
  return showCreateRequestView({extensionUri, defaultUri,
    create: (original, proposed, isCancelled) => createRequestFromSelection(original, proposed, runExclusive, isCancelled)});
}

/** Commit only the chosen saved snapshots; the form never supplies arbitrary paths. */
export async function createRequestFromSelection(
  original: vscode.Uri, proposed: vscode.Uri,
  runExclusive: <T>(action: () => Promise<T>) => Promise<T> = action => action(),
  isCancelled: () => boolean = () => false,
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
  const created = await runExclusive(() => createRequestFile({
    workspace: folder.uri.fsPath,
    original: path.relative(folder.uri.fsPath, original.fsPath).split(path.sep).join('/'),
    proposed: proposed.fsPath,
    assertReady,
  }));
  return vscode.Uri.file(created);
}
