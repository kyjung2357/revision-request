import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewState } from '../src/extension';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BridgeMethod, McpStatus } from '../src/mcpTypes';

interface ExtensionApi {
  getReadyCount(): number;
  getMcpConfiguration(workspaceUri?: vscode.Uri): Promise<{json: {mcpServers: {revision_request: {command: string; args: string[]; env: Record<string, string>}}}; instanceId: string}>;
  mcpHandler(method: BridgeMethod, args: Record<string, unknown>, workspaceUri: string): Promise<unknown>;
  testRunExclusive<T>(action: () => Promise<T>): Promise<T>;
  getState(uri: vscode.Uri): Promise<ReviewState>;
  decide(uri: vscode.Uri, file: string, hunk: string | undefined,
    decision: 'accepted' | 'ignored', revision: string): Promise<void>;
  undo(uri: vscode.Uri, file: string, hunk: string, revision: string): Promise<void>;
}

interface Fixture {
  request: vscode.Uri;
  target: vscode.Uri;
  relative: string;
  before: string;
  after: string;
}

export async function run(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, 'An isolated fixture workspace must be open.');
  const extension = vscode.extensions.getExtension<ExtensionApi>('kyjung2357.revision-request');
  assert.ok(extension, 'The actual development extension must be registered.');
  const api = await extension.activate();
  assert.equal(typeof api.getState, 'function');
  assert.equal(typeof api.decide, 'function');
  assert.equal(typeof api.undo, 'function');
  assert.equal(vscode.workspace.isTrusted, true, 'The isolated test workspace must be trusted.');
  const outcomes: { name: string; passed: boolean; error?: string }[] = [];

  async function fixture(name: string, before: string, after: string, extension = '.tex'): Promise<Fixture> {
    const relative = name + extension;
    const target = vscode.Uri.joinPath(workspace!, relative);
    const request = vscode.Uri.joinPath(workspace!, relative + '.rr');
    await vscode.workspace.fs.writeFile(target, Buffer.from(before, 'utf8'));
    await vscode.workspace.fs.writeFile(request, Buffer.from(JSON.stringify({
      version: 1,
      title: name,
      files: [{ path: relative, before, after }],
    }, null, 2), 'utf8'));
    return { request, target, relative, before, after };
  }
  const bytes = async (uri: vscode.Uri) => Buffer.from(await vscode.workspace.fs.readFile(uri));
  async function ready(item: Fixture) {
    const state = await api.getState(item.request);
    assert.equal(state.error, undefined, state.error);
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0]!.issue, undefined, state.files[0]!.issue);
    return state;
  }
  async function check(name: string, test: () => Promise<void>) {
    try {
      await test();
      outcomes.push({name, passed: true});
      console.log('PASS ' + name);
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      outcomes.push({name, passed: false, error: detail});
      console.error('FAIL ' + name + '\n' + detail);
    }
  }

  await check('RR language keeps JSON schema, completion and formatting without changing ordinary JSON or icon theme', async () => {
    const iconThemeBefore = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
    const language = extension.packageJSON.contributes.languages.find((item: {id: string}) => item.id === 'revision-request');
    assert.ok(language.extensions.includes('.rr'));
    assert.equal(language.icon.light, './media/rr-file-icon.svg');
    assert.equal(language.icon.dark, './media/rr-file-icon.svg');
    assert.ok(extension.packageJSON.extensionDependencies.includes('vscode.json-language-features'));
    assert.ok(vscode.extensions.getExtension('vscode.json-language-features')?.isActive,
      'The real built-in JSON extension must be active as a dependency.');
    const schemaUri = vscode.Uri.joinPath(workspace!, 'schema-check.tex.rr');
    const schemaText = JSON.stringify({
      version: 2, title: 'Schema check',
      files: [{path: 'schema-check.tex', before: 'before', after: 'after'}],
    });
    await vscode.workspace.fs.writeFile(schemaUri, Buffer.from(schemaText));
    const document = await vscode.workspace.openTextDocument(schemaUri);
    assert.equal(document.languageId, 'revision-request');
    await vscode.window.showTextDocument(document, {preview: false});
    const versionPosition = document.positionAt(schemaText.indexOf(':2') + 1);
    const diagnosticDeadline = Date.now() + 20000;
    const versionDiagnostics = () => vscode.languages.getDiagnostics(schemaUri)
      .filter(diagnostic => diagnostic.range.contains(versionPosition) && diagnostic.severity <= vscode.DiagnosticSeverity.Warning);
    while (versionDiagnostics().length === 0 && Date.now() < diagnosticDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(versionDiagnostics().some(diagnostic => /1/.test(diagnostic.message)),
      'The bundled RR schema must reject version 2 through the built-in JSON language server. Diagnostics: ' +
      JSON.stringify(vscode.languages.getDiagnostics(schemaUri).map(diagnostic => ({message: diagnostic.message, range: diagnostic.range}))));
    const formatting = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider', schemaUri, {tabSize: 2, insertSpaces: true});
    assert.ok(formatting?.length, 'The built-in JSON formatter must also register for RR documents.');
    let formatted = schemaText;
    for (const edit of [...formatting!].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
      formatted = formatted.slice(0, document.offsetAt(edit.range.start)) + edit.newText +
        formatted.slice(document.offsetAt(edit.range.end));
    }
    assert.ok(formatted.includes('\n'));
    assert.deepEqual(JSON.parse(formatted), JSON.parse(schemaText));
    assert.deepEqual(await bytes(schemaUri), Buffer.from(schemaText), 'Requesting formatting must not save source bytes.');

    const completionUri = vscode.Uri.joinPath(workspace!, 'completion-check.tex.rr');
    await vscode.workspace.fs.writeFile(completionUri, Buffer.from('{\n  \n}\n'));
    assert.equal((await vscode.workspace.openTextDocument(completionUri)).languageId, 'revision-request');
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', completionUri, new vscode.Position(1, 2));
    const labels = completion?.items.map(item => typeof item.label === 'string' ? item.label : item.label.label) ?? [];
    assert.ok(labels.some(label => label.includes('version')), 'RR schema properties must appear in completion.');
    assert.ok(labels.some(label => label.includes('files')));

    const ordinaryUri = vscode.Uri.joinPath(workspace!, 'ordinary.json');
    await vscode.workspace.fs.writeFile(ordinaryUri, Buffer.from('{"ordinary":true}'));
    assert.equal((await vscode.workspace.openTextDocument(ordinaryUri)).languageId, 'json');
    const ordinaryFormatting = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider', ordinaryUri, {tabSize: 2, insertSpaces: true});
    assert.ok(ordinaryFormatting?.length, 'Ordinary JSON formatting must remain available.');
    assert.equal(vscode.workspace.getConfiguration('workbench').get('iconTheme'), iconThemeBefore,
      'Registering an RR language icon must not switch the active file-icon theme.');
  });

  await check('Opening RR JSON source and its in-place comparison then ignoring changes never writes the target', async () => {
    const item = await fixture('preview-ignore', 'alpha\r\nbeta\r\ngamma', 'ALPHA\r\nbeta\r\nGAMMA');
    const original = await bytes(item.target);
    const sourceBefore = await bytes(item.request);
    const readyBefore = api.getReadyCount();
    await vscode.commands.executeCommand('vscode.open', item.request);
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === item.request.toString())),
      'The .rr file must open as ordinary JSON source.');
    const reviewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const groupsBefore = vscode.window.tabGroups.all.length;
    await vscode.commands.executeCommand('revisionRequest.openPreview', item.request);
    const readyDeadline = Date.now() + 10000;
    while (api.getReadyCount() <= readyBefore && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(api.getReadyCount() > readyBefore, 'The real webview script must load and send its ready handshake.');
    const activePreview = () => {
      const group = vscode.window.tabGroups.activeTabGroup;
      return group.viewColumn === reviewColumn &&
        group.activeTab?.input instanceof vscode.TabInputWebview &&
        group.activeTab.label === path.basename(item.request.fsPath) + ' — Preview';
    };
    const layoutDeadline = Date.now() + 5000;
    while (!activePreview() && Date.now() < layoutDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(activePreview(), 'The live side-by-side preview must open in the current editor column.');
    assert.equal(vscode.window.tabGroups.all.length, groupsBefore,
      'Preview must not split the native editor layout.');
    assert.equal(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === item.target.toString())), false,
      'The comparison displays both texts inside its panel; it must not automatically open the native target.');
    let state = await ready(item);
    assert.equal(state.files[0]!.hunks.length, 2);
    assert.deepEqual(await bytes(item.target), original);
    await api.decide(item.request, item.relative, state.files[0]!.hunks[0]!.id, 'ignored', state.revision);
    state = await ready(item);
    assert.equal(state.files[0]!.hunks[0]!.decision, 'ignored');
    assert.equal(state.files[0]!.hunks[1]!.decision, 'pending');
    const contextActions = extension.packageJSON.contributes.menus['explorer/context'] as {command: string; when: string}[];
    for (const command of ['revisionRequest.openDiff', 'revisionRequest.openSource']) {
      assert.ok(contextActions.some(action => action.command === command && action.when === 'resourceExtname == .rr'),
        command + ' must be available from the .rr Explorer context menu.');
    }
    await vscode.commands.executeCommand('revisionRequest.openDiff', item.request);
    const diffDeadline = Date.now() + 5000;
    while (!(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff) && Date.now() < diffDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const diff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(diff instanceof vscode.TabInputTextDiff, 'Native diff must open a genuine VS Code comparison.');
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), item.before);
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), 'alpha\r\nbeta\r\nGAMMA',
      'The comparison must include pending edits while excluding the ignored first change.');
    assert.deepEqual(await bytes(item.target), original);
    await api.decide(item.request, item.relative, undefined, 'ignored', state.revision);
    assert.deepEqual(await bytes(item.target), original);
    assert.deepEqual(await bytes(item.request), sourceBefore, 'Decisions must not rewrite the .rr proposal.');
  });

  await check('Partial approvals change only selected groups, in either order', async () => {
    const item = await fixture('partial-accept',
      'one\ntwo\nthree\nfour\nfive\n',
      'ONE\nextra\ntwo\nthree\nfour\nFIVE\n');
    let state = await ready(item);
    const hunks = state.files[0]!.hunks;
    assert.equal(hunks.length, 2);
    await api.decide(item.request, item.relative, hunks[1]!.id, 'accepted', state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from('one\ntwo\nthree\nfour\nFIVE\n'));
    state = await ready(item);
    assert.equal(state.files[0]!.hunks[0]!.decision, 'pending');
    assert.equal(state.files[0]!.hunks[1]!.decision, 'accepted');
    await api.decide(item.request, item.relative, hunks[0]!.id, 'accepted', state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
    state = await ready(item);
    assert.ok(state.files[0]!.hunks.every(hunk => hunk.decision === 'accepted'));
    await assert.rejects(api.decide(item.request, item.relative, hunks[0]!.id, 'accepted', state.revision),
      /no pending changes/i);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
  });

  await check('An independently edited original is refused and never overwritten', async () => {
    const item = await fixture('stale-target', 'original\n', 'proposal\n');
    const state = await ready(item);
    const intervening = Buffer.from('user edit after proposal\n');
    await vscode.workspace.fs.writeFile(item.target, intervening);
    await assert.rejects(api.decide(item.request, item.relative, undefined, 'accepted', state.revision),
      /original has changed/i);
    assert.deepEqual(await bytes(item.target), intervening);
    const blocked = await api.getState(item.request);
    assert.match(blocked.files[0]!.issue ?? '', /original has changed/i);
    assert.equal(blocked.files[0]!.hunks[0]!.decision, 'pending');
  });

  await check('A dirty unsaved target editor is refused and its disk content stays unchanged', async () => {
    const item = await fixture('dirty-editor', 'saved original\n', 'proposal\n');
    const state = await ready(item);
    const document = await vscode.workspace.openTextDocument(item.target);
    const editor = await vscode.window.showTextDocument(document);
    try {
      const edited = await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved '));
      assert.equal(edited, true);
      assert.equal(document.isDirty, true);
      await assert.rejects(api.decide(item.request, item.relative, undefined, 'accepted', state.revision),
        /unsaved edits/i);
      assert.equal(document.getText(), 'unsaved saved original\n');
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    } finally {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    assert.equal(document.isDirty, false);
  });

  await check('A changed .rr revision invalidates an approval from the old comparison', async () => {
    const item = await fixture('stale-request', 'saved original\n', 'proposal\n');
    const old = await ready(item);
    const requestDocument = await vscode.workspace.openTextDocument(item.request);
    const request = JSON.parse(requestDocument.getText());
    request.files[0].after = 'a different proposal\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(item.request, new vscode.Range(new vscode.Position(0, 0),
      requestDocument.positionAt(requestDocument.getText().length)), JSON.stringify(request, null, 2));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await requestDocument.save(), true);
    const fresh = await ready(item);
    assert.notEqual(fresh.revision, old.revision);
    await assert.rejects(api.decide(item.request, item.relative, undefined, 'accepted', old.revision),
      /request changed/i);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    assert.ok(fresh.files[0]!.hunks.every(hunk => hunk.decision === 'pending'));
  });

  await check('Accepting preserves UTF-8 BOM, CRLF, Unicode and absence of a final newline', async () => {
    const item = await fixture('bom-crlf',
      '\uFEFF첫째 😀\r\nold\r\nlast',
      '\uFEFF첫째 😀\r\nnew\r\nlast');
    const state = await ready(item);
    const original = await bytes(item.target);
    assert.deepEqual(original.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    await api.decide(item.request, item.relative, undefined, 'accepted', state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after, 'utf8'));
    assert.equal((await ready(item)).files[0]!.hunks[0]!.decision, 'accepted');
  });

  await check('Approval bypasses save-time formatting, trimming and final-newline insertion', async () => {
    const item = await fixture('save-participants', 'before  \r\nlast  ', 'after  \r\nlast  ');
    const state = await ready(item);
    const document = await vscode.workspace.openTextDocument(item.target);
    const files = vscode.workspace.getConfiguration('files', item.target);
    const editor = vscode.workspace.getConfiguration('editor', item.target);
    const previous = {
      final: files.inspect<boolean>('insertFinalNewline')?.workspaceFolderValue,
      trim: files.inspect<boolean>('trimTrailingWhitespace')?.workspaceFolderValue,
      format: editor.inspect<boolean>('formatOnSave')?.workspaceFolderValue,
      formatter: editor.inspect<string>('defaultFormatter')?.workspaceFolderValue,
    };
    let formattingCalls = 0;
    const formatter = vscode.languages.registerDocumentFormattingEditProvider({
      scheme: 'file', language: document.languageId, pattern: '**/save-participants.tex',
    }, {
      provideDocumentFormattingEdits() {
        formattingCalls++;
        return [vscode.TextEdit.insert(new vscode.Position(0, 0), 'UNAPPROVED FORMATTER EDIT\r\n')];
      },
    });
    try {
      await files.update('insertFinalNewline', true, vscode.ConfigurationTarget.WorkspaceFolder);
      await files.update('trimTrailingWhitespace', true, vscode.ConfigurationTarget.WorkspaceFolder);
      await editor.update('formatOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
      await editor.update('defaultFormatter', 'kyjung2357.revision-request', vscode.ConfigurationTarget.WorkspaceFolder);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider', item.target, {tabSize: 2, insertSpaces: true});
      assert.ok(edits?.some(edit => edit.newText.includes('UNAPPROVED FORMATTER EDIT')),
        'The deliberately mutating formatter must actually be registered.');
      formattingCalls = 0;
      await api.decide(item.request, item.relative, undefined, 'accepted', state.revision);
      assert.equal(formattingCalls, 0, 'Approval must not invoke a save-time formatter.');
      assert.deepEqual(await bytes(item.target), Buffer.from(item.after),
        'Only the reviewed text may be saved, including its trailing spaces and missing final newline.');
      assert.equal((await ready(item)).files[0]!.hunks[0]!.decision, 'accepted');
      await api.undo(item.request, item.relative, state.files[0]!.hunks[0]!.id, state.revision);
      assert.equal(formattingCalls, 0, 'Undo must not invoke save-time formatters either.');
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before),
        'Undo must preserve original trailing whitespace and absent final newline.');
      assert.equal((await ready(item)).files[0]!.hunks[0]!.decision, 'pending');
    } finally {
      formatter.dispose();
      await files.update('insertFinalNewline', previous.final, vscode.ConfigurationTarget.WorkspaceFolder);
      await files.update('trimTrailingWhitespace', previous.trim, vscode.ConfigurationTarget.WorkspaceFolder);
      await editor.update('formatOnSave', previous.format, vscode.ConfigurationTarget.WorkspaceFolder);
      await editor.update('defaultFormatter', previous.formatter, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });
  await check('No-op proposals have no actionable groups and never write the target', async () => {
    const item = await fixture('no-op', 'unchanged\r\n', 'unchanged\r\n');
    const original = await bytes(item.target);
    const state = await ready(item);
    assert.equal(state.files[0]!.hunks.length, 0);
    await assert.rejects(api.decide(item.request, item.relative, undefined, 'accepted', state.revision),
      /no pending changes/i);
    await assert.rejects(api.decide(item.request, item.relative, undefined, 'ignored', state.revision),
      /no pending changes/i);
    assert.deepEqual(await bytes(item.target), original);
  });

  await check('Concurrent approvals are serialized without losing another accepted group', async () => {
    const item = await fixture('concurrent',
      'first\nmiddle\nlast\n', 'FIRST\nmiddle\nLAST\n');
    const state = await ready(item);
    const hunks = state.files[0]!.hunks;
    assert.equal(hunks.length, 2);
    await Promise.all([
      api.decide(item.request, item.relative, hunks[0]!.id, 'accepted', state.revision),
      api.decide(item.request, item.relative, hunks[1]!.id, 'accepted', state.revision),
    ]);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
    assert.ok((await ready(item)).files[0]!.hunks.every(hunk => hunk.decision === 'accepted'));
  });

  await check('An open clean editor reloads the exact result after rapid partial approvals', async () => {
    const item = await fixture('open-editor-reload',
      'first\r\nmiddle\r\nlast', 'FIRST\r\nextra\r\nmiddle\r\nLAST');
    const state = await ready(item);
    const document = await vscode.workspace.openTextDocument(item.target);
    await vscode.window.showTextDocument(document);
    assert.equal(document.isDirty, false);
    assert.equal(document.getText(), item.before);
    const hunks = state.files[0]!.hunks;
    assert.equal(hunks.length, 2);
    await api.decide(item.request, item.relative, hunks[0]!.id, 'accepted', state.revision);
    await api.decide(item.request, item.relative, hunks[1]!.id, 'accepted', state.revision);
    const deadline = Date.now() + 5000;
    while (document.getText() !== item.after && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
    assert.equal(document.getText(), item.after, 'The visible source must reload filesystem approvals.');
    assert.equal(document.isDirty, false, 'Applying approved bytes must not leave an unsaved buffer.');
    assert.ok((await ready(item)).files[0]!.hunks.every(hunk => hunk.decision === 'accepted'));
  });
  await check('A request with the wrong target-derived filename cannot be reviewed or applied', async () => {
    const item = await fixture('filename-check', 'original\n', 'proposal\n');
    const valid = await ready(item);
    const wrong = vscode.Uri.joinPath(workspace!, 'incorrect-name.rr');
    await vscode.workspace.fs.writeFile(wrong, await bytes(item.request));
    const invalid = await api.getState(wrong);
    assert.ok(invalid.error, 'A mismatched request filename must be rejected.');
    assert.match(invalid.error, /filename-check\.tex\.rr/i);
    await assert.rejects(api.decide(wrong, item.relative, undefined, 'accepted', valid.revision),
      /filename-check\.tex\.rr/i);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
  });

  await check('Same-basename .tex and .md files keep separate requests and decisions', async () => {
    const tex = await fixture('same-name', 'tex original\n', 'tex proposal\n', '.tex');
    const markdown = await fixture('same-name', 'markdown original\n', 'markdown proposal\n', '.md');
    assert.equal(path.basename(tex.request.fsPath), 'same-name.tex.rr');
    assert.equal(path.basename(markdown.request.fsPath), 'same-name.md.rr');
    const texState = await ready(tex);
    const markdownState = await ready(markdown);
    await api.decide(tex.request, tex.relative, undefined, 'accepted', texState.revision);
    assert.deepEqual(await bytes(tex.target), Buffer.from(tex.after));
    assert.deepEqual(await bytes(markdown.target), Buffer.from(markdown.before));
    assert.equal((await ready(markdown)).files[0]!.hunks[0]!.decision, 'pending');
    await api.decide(markdown.request, markdown.relative, undefined, 'ignored', markdownState.revision);
    assert.deepEqual(await bytes(markdown.target), Buffer.from(markdown.before));
    assert.equal((await ready(tex)).files[0]!.hunks[0]!.decision, 'accepted');
  });
  await check('Explorer-style opening can auto-preview, while View Source keeps raw JSON accessible', async () => {
    const item = await fixture('auto-preview', 'original\n', 'proposal\n');
    const config = vscode.workspace.getConfiguration('revisionRequest', item.request);
    const previous = config.inspect<boolean>('previewOnOpen')?.workspaceValue;
    try {
      await config.update('previewOnOpen', true, vscode.ConfigurationTarget.Workspace);
      const beforeReady = api.getReadyCount();
      const reviewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const groupsBefore = vscode.window.tabGroups.all.length;
      await vscode.commands.executeCommand('vscode.open', item.request, {preview: false});
      const deadline = Date.now() + 10000;
      while (api.getReadyCount() <= beforeReady && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(api.getReadyCount() > beforeReady, 'Opening .rr with auto-preview enabled must load its preview.');
      const activeGroup = vscode.window.tabGroups.activeTabGroup;
      assert.equal(activeGroup.viewColumn, reviewColumn, 'Automatic preview must stay in the current column.');
      assert.ok(activeGroup.activeTab?.input instanceof vscode.TabInputWebview);
      assert.equal(activeGroup.activeTab.label, path.basename(item.request.fsPath) + ' — Preview');
      assert.equal(vscode.window.tabGroups.all.length, groupsBefore);
      assert.equal(vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === item.target.toString())), false);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
      const count = api.getReadyCount();
      await vscode.commands.executeCommand('revisionRequest.openSource', item.request);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), item.request.toString(),
        'View Source must keep the JSON editor active even when auto-preview is enabled.');
      assert.equal(api.getReadyCount(), count, 'View Source must not trigger a second automatic preview.');
    } finally {
      await config.update('previewOnOpen', previous, vscode.ConfigurationTarget.Workspace);
    }
  });
  await check('Display settings update opacity and intraline options without changing source or decisions', async () => {
    const item = await fixture('opacity-setting', 'unchanged\nx = 2; y = 3;\n', 'unchanged\nx = 1; y = 4;\n');
    const config = vscode.workspace.getConfiguration('revisionRequest', item.request);
    const previous = config.inspect<number>('unchangedOpacity')?.workspaceValue;
    const previousHighlight = config.inspect<boolean>('highlightChangedLines')?.workspaceValue;
    const previousOnly = config.inspect<boolean>('showOnlyChangedText')?.workspaceValue;
    try {
      await config.update('unchangedOpacity', undefined, vscode.ConfigurationTarget.Workspace);
      await config.update('highlightChangedLines', undefined, vscode.ConfigurationTarget.Workspace);
      await config.update('showOnlyChangedText', undefined, vscode.ConfigurationTarget.Workspace);
      const defaults = await ready(item);
      assert.equal(defaults.unchangedOpacity, 20);
      assert.equal(defaults.highlightChangedLines, true);
      assert.equal(defaults.showOnlyChangedText, false);
      assert.equal(config.inspect<boolean>('highlightChangedLines')?.defaultValue, true);
      assert.equal(config.inspect<boolean>('showOnlyChangedText')?.defaultValue, false);
      const hunk = defaults.files[0]!.hunks[0]!;
      assert.deepEqual(hunk.inlineChanges![0]!.before.filter(segment => segment.changed).map(segment => segment.text), ['2', '3']);
      assert.deepEqual(hunk.inlineChanges![0]!.after.filter(segment => segment.changed).map(segment => segment.text), ['1', '4']);
      assert.ok(hunk.inlineChanges![0]!.before.some(segment => !segment.changed && segment.text === '; y = '));
      await config.update('unchangedOpacity', 0, vscode.ConfigurationTarget.Workspace);
      await config.update('highlightChangedLines', false, vscode.ConfigurationTarget.Workspace);
      await config.update('showOnlyChangedText', true, vscode.ConfigurationTarget.Workspace);
      const changed = await ready(item);
      assert.equal(changed.unchangedOpacity, 0);
      assert.equal(changed.highlightChangedLines, false);
      assert.equal(changed.showOnlyChangedText, true);
      assert.equal(changed.files[0]!.hunks[0]!.id, hunk.id);
      assert.equal(changed.files[0]!.hunks[0]!.decision, 'pending');
      assert.deepEqual(changed.files[0]!.hunks[0]!.inlineChanges, hunk.inlineChanges);
      await config.update('unchangedOpacity', 100, vscode.ConfigurationTarget.Workspace);
      await config.update('highlightChangedLines', true, vscode.ConfigurationTarget.Workspace);
      await config.update('showOnlyChangedText', false, vscode.ConfigurationTarget.Workspace);
      const restored = await ready(item);
      assert.equal(restored.unchangedOpacity, 100);
      assert.equal(restored.highlightChangedLines, true);
      assert.equal(restored.showOnlyChangedText, false);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before),
        'Display preferences must never change source file bytes.');
    } finally {
      await config.update('unchangedOpacity', previous, vscode.ConfigurationTarget.Workspace);
      await config.update('highlightChangedLines', previousHighlight, vscode.ConfigurationTarget.Workspace);
      await config.update('showOnlyChangedText', previousOnly, vscode.ConfigurationTarget.Workspace);
    }
  });
  await check('Automatic deletion defaults on, preserves partial requests, and removes final accepted requests', async () => {
    const config = vscode.workspace.getConfiguration('revisionRequest');
    assert.equal(config.inspect<boolean>('autoDeleteCompleted')?.defaultValue, true);
    const previous = config.inspect<boolean>('autoDeleteCompleted')?.workspaceValue;
    const previousPreview = config.inspect<boolean>('previewOnOpen')?.workspaceValue;
    try {
      await config.update('autoDeleteCompleted', true, vscode.ConfigurationTarget.Workspace);
      await config.update('previewOnOpen', true, vscode.ConfigurationTarget.Workspace);
      const item = await fixture('delete-after-accept', 'first\nmiddle\nlast\n', 'FIRST\nmiddle\nLAST\n');
      const readyBefore = api.getReadyCount();
      await vscode.commands.executeCommand('vscode.open', item.request);
      const readyDeadline = Date.now() + 10000;
      while (api.getReadyCount() <= readyBefore && Date.now() < readyDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(api.getReadyCount() > readyBefore, 'Automatic preview must be live before testing completion cleanup.');
      const matchingTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === item.request.toString()) ||
        (tab.input instanceof vscode.TabInputWebview && tab.label === path.basename(item.request.fsPath) + ' — Preview'));
      assert.ok(matchingTabs().some(tab => tab.input instanceof vscode.TabInputText), 'The JSON source tab must be open.');
      assert.ok(matchingTabs().some(tab => tab.input instanceof vscode.TabInputWebview), 'The Preview tab must be open.');
      const state = await ready(item);
      const hunks = state.files[0]!.hunks;
      assert.equal(hunks.length, 2);
      await api.decide(item.request, item.relative, hunks[0]!.id, 'accepted', state.revision);
      assert.equal((await fs.stat(item.request.fsPath)).isFile(), true, 'A partially reviewed request must remain.');
      assert.deepEqual(await bytes(item.target), Buffer.from('FIRST\nmiddle\nlast\n'));
      const readyBeforeFinal = api.getReadyCount();
      await api.decide(item.request, item.relative, hunks[1]!.id, 'accepted', state.revision);
      await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
      assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
      const closedDeadline = Date.now() + 5000;
      while (matchingTabs().length > 0 && Date.now() < closedDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(matchingTabs().length, 0, 'Completion must close both the Preview and clean JSON source tabs.');
      assert.equal(api.getReadyCount(), readyBeforeFinal, 'Closing a completed preview must not reopen an error preview for the deleted request.');
    } finally {
      await config.update('previewOnOpen', previousPreview, vscode.ConfigurationTarget.Workspace);
      await config.update('autoDeleteCompleted', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  await check('Ignoring the final pending group deletes the request without changing original bytes', async () => {
    const config = vscode.workspace.getConfiguration('revisionRequest');
    const previous = config.inspect<boolean>('autoDeleteCompleted')?.workspaceValue;
    const previousPreview = config.inspect<boolean>('previewOnOpen')?.workspaceValue;
    try {
      await config.update('autoDeleteCompleted', true, vscode.ConfigurationTarget.Workspace);
      await config.update('previewOnOpen', true, vscode.ConfigurationTarget.Workspace);
      const item = await fixture('delete-after-ignore', 'first\nmiddle\nlast\n', 'FIRST\nmiddle\nLAST\n');
      const requestBytes = await bytes(item.request);
      const readyBefore = api.getReadyCount();
      await vscode.commands.executeCommand('vscode.open', item.request);
      const readyDeadline = Date.now() + 10000;
      while (api.getReadyCount() <= readyBefore && Date.now() < readyDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(api.getReadyCount() > readyBefore, 'The original request must have a live preview before final Ignore.');
      const state = await ready(item);
      await api.decide(item.request, item.relative, state.files[0]!.hunks[0]!.id, 'ignored', state.revision);
      assert.equal((await fs.stat(item.request.fsPath)).isFile(), true);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
      await api.decide(item.request, item.relative, undefined, 'ignored', state.revision);
      await assert.rejects(fs.stat(item.request.fsPath), {code: 'ENOENT'});
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
      await vscode.workspace.fs.writeFile(item.request, requestBytes);
      const recreated = await ready(item);
      assert.ok(recreated.files[0]!.hunks.every(hunk => hunk.decision === 'pending'),
        'Recreating the same proposal at the same path must start a fresh review after completion.');
      const readyAfterDelete = api.getReadyCount();
      await vscode.commands.executeCommand('vscode.open', item.request);
      const reopenedDeadline = Date.now() + 10000;
      while (api.getReadyCount() <= readyAfterDelete && Date.now() < reopenedDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(api.getReadyCount() > readyAfterDelete, 'Opening the recreated .rr must automatically start a fresh Preview.');
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(activeTab?.input instanceof vscode.TabInputWebview);
      assert.equal(activeTab.label, path.basename(item.request.fsPath) + ' — Preview');
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    } finally {
      await config.update('previewOnOpen', previousPreview, vscode.ConfigurationTarget.Workspace);
      await config.update('autoDeleteCompleted', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  await check('Disabling automatic deletion retains a fully reviewed request', async () => {
    const config = vscode.workspace.getConfiguration('revisionRequest');
    const previous = config.inspect<boolean>('autoDeleteCompleted')?.workspaceValue;
    try {
      await config.update('autoDeleteCompleted', false, vscode.ConfigurationTarget.Workspace);
      const item = await fixture('retain-completed', 'old\n', 'new\n');
      const state = await ready(item);
      const requestBytes = await bytes(item.request);
      await api.decide(item.request, item.relative, undefined, 'accepted', state.revision);
      assert.deepEqual(await bytes(item.request), requestBytes);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
      assert.equal((await ready(item)).files[0]!.hunks[0]!.decision, 'accepted');
    } finally {
      await config.update('autoDeleteCompleted', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  await check('Opening a no-op request never deletes it even when completion deletion is enabled', async () => {
    const config = vscode.workspace.getConfiguration('revisionRequest');
    const previous = config.inspect<boolean>('autoDeleteCompleted')?.workspaceValue;
    try {
      await config.update('autoDeleteCompleted', true, vscode.ConfigurationTarget.Workspace);
      const item = await fixture('retain-no-op', 'same\r\n', 'same\r\n');
      const requestBytes = await bytes(item.request);
      const state = await ready(item);
      assert.equal(state.files[0]!.hunks.length, 0);
      assert.deepEqual(await bytes(item.request), requestBytes);
      await assert.rejects(api.decide(item.request, item.relative, undefined, 'ignored', state.revision),
        /no pending changes/i);
      assert.deepEqual(await bytes(item.request), requestBytes);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    } finally {
      await config.update('autoDeleteCompleted', previous, vscode.ConfigurationTarget.Workspace);
    }
  });
  await check('Explanation metadata maps to original hunk lines with fallback and explicit empty suppression', async () => {
    const item = await fixture('explanations',
      'first\ncontext\nthird\ncontext\nfifth\n',
      'FIRST\ncontext\nTHIRD\ncontext\nFIFTH\n');
    const request = JSON.parse((await bytes(item.request)).toString('utf8'));
    request.files[0].reason = 'General reason.';
    request.files[0].explanations = [
      {line: 1, text: 'Specific first-block explanation.'},
      {line: 5, text: ''},
      {line: 99, text: 'Unmatched metadata must not attach to a different block.'},
    ];
    await vscode.workspace.fs.writeFile(item.request, Buffer.from(JSON.stringify(request)));
    const state = await ready(item);
    assert.deepEqual(state.files[0]!.hunks.map(hunk => [hunk.oldStart, hunk.explanation]), [
      [1, 'Specific first-block explanation.'], [3, 'General reason.'], [5, ''],
    ]);
    const absent = await fixture('no-explanation', 'old\n', 'new\n');
    assert.equal((await ready(absent)).files[0]!.hunks[0]!.explanation, undefined);
    const insertion = await fixture('insertion-explanation', 'tail\n', 'inserted\ntail\n');
    const insertionRequest = JSON.parse((await bytes(insertion.request)).toString('utf8'));
    insertionRequest.files[0].explanations = [{line: 1, text: 'An explanation for a pure insertion.'}];
    await vscode.workspace.fs.writeFile(insertion.request, Buffer.from(JSON.stringify(insertionRequest)));
    const inserted = (await ready(insertion)).files[0]!.hunks[0]!;
    assert.equal(inserted.oldLines, 0);
    assert.equal(inserted.explanation, 'An explanation for a pure insertion.');
    assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    assert.deepEqual(await bytes(absent.target), Buffer.from(absent.before));
    assert.deepEqual(await bytes(insertion.target), Buffer.from(insertion.before));
  });
  await check('Undo restores only one accepted group and serializes with other approvals', async () => {
    const item = await fixture('undo-partial',
      'one\nmiddle-a\nthree\nmiddle-b\nfive\n',
      'ONE\nextra\nmiddle-a\nTHREE\nmiddle-b\nFIVE\n');
    const state = await ready(item);
    const [first, middle, last] = state.files[0]!.hunks;
    assert.equal(state.files[0]!.hunks.length, 3);
    await api.decide(item.request, item.relative, last!.id, 'accepted', state.revision);
    await api.decide(item.request, item.relative, first!.id, 'accepted', state.revision);
    await api.undo(item.request, item.relative, first!.id, state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from('one\nmiddle-a\nthree\nmiddle-b\nFIVE\n'));
    assert.deepEqual((await ready(item)).files[0]!.hunks.map(hunk => hunk.decision), ['pending', 'pending', 'accepted']);
    await assert.rejects(api.undo(item.request, item.relative, first!.id, state.revision), /still pending/i);
    await api.decide(item.request, item.relative, first!.id, 'accepted', state.revision);
    await api.undo(item.request, item.relative, first!.id, state.revision);
    await api.decide(item.request, item.relative, first!.id, 'ignored', state.revision);
    await Promise.all([
      api.undo(item.request, item.relative, last!.id, state.revision),
      api.decide(item.request, item.relative, middle!.id, 'accepted', state.revision),
    ]);
    assert.deepEqual(await bytes(item.target), Buffer.from('one\nmiddle-a\nTHREE\nmiddle-b\nfive\n'));
    assert.deepEqual((await ready(item)).files[0]!.hunks.map(hunk => hunk.decision), ['ignored', 'accepted', 'pending']);
  });

  await check('Undoing Ignore restores a pending proposal without touching the original', async () => {
    const item = await fixture('undo-ignore', 'before\n', 'after\n');
    const state = await ready(item);
    const hunk = state.files[0]!.hunks[0]!;
    const original = await bytes(item.target);
    await api.decide(item.request, item.relative, hunk.id, 'ignored', state.revision);
    await assert.rejects(api.undo(item.request, item.relative, '', state.revision), /specific change/i);
    await assert.rejects(api.undo(item.request, item.relative, 'unknown-hunk', state.revision), /unknown change/i);
    await api.undo(item.request, item.relative, hunk.id, state.revision);
    assert.deepEqual(await bytes(item.target), original);
    assert.equal((await ready(item)).files[0]!.hunks[0]!.decision, 'pending');
    await assert.rejects(api.undo(item.request, item.relative, hunk.id, state.revision), /still pending/i);
    await api.decide(item.request, item.relative, hunk.id, 'accepted', state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.after));
    const insertion = await fixture('undo-ignored-insertion', '', 'inserted\n');
    const insertionState = await ready(insertion);
    const inserted = insertionState.files[0]!.hunks[0]!;
    assert.equal(inserted.oldLines, 0);
    await api.decide(insertion.request, insertion.relative, inserted.id, 'ignored', insertionState.revision);
    await api.undo(insertion.request, insertion.relative, inserted.id, insertionState.revision);
    assert.deepEqual(await bytes(insertion.target), Buffer.alloc(0));
    assert.equal((await ready(insertion)).files[0]!.hunks[0]!.decision, 'pending');
  });

  await check('Undo refuses changed originals, unsaved target edits and stale request revisions', async () => {
    const stale = await fixture('undo-stale-target', 'before\n', 'after\n');
    const staleState = await ready(stale);
    const staleHunk = staleState.files[0]!.hunks[0]!;
    await api.decide(stale.request, stale.relative, staleHunk.id, 'accepted', staleState.revision);
    const userText = Buffer.from('independent user edit\n');
    await vscode.workspace.fs.writeFile(stale.target, userText);
    await assert.rejects(api.undo(stale.request, stale.relative, staleHunk.id, staleState.revision), /original has changed/i);
    assert.deepEqual(await bytes(stale.target), userText);
    assert.equal((await api.getState(stale.request)).files[0]!.hunks[0]!.decision, 'accepted');

    const dirty = await fixture('undo-dirty-target', 'before\n', 'after\n');
    const dirtyState = await ready(dirty);
    const dirtyHunk = dirtyState.files[0]!.hunks[0]!;
    await api.decide(dirty.request, dirty.relative, dirtyHunk.id, 'accepted', dirtyState.revision);
    const document = await vscode.workspace.openTextDocument(dirty.target);
    const editor = await vscode.window.showTextDocument(document);
    try {
      assert.equal(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved ')), true);
      assert.equal(document.isDirty, true);
      await assert.rejects(api.undo(dirty.request, dirty.relative, dirtyHunk.id, dirtyState.revision), /unsaved edits/i);
      assert.equal(document.getText(), 'unsaved after\n');
      assert.deepEqual(await bytes(dirty.target), Buffer.from(dirty.after));
      assert.equal((await api.getState(dirty.request)).files[0]!.hunks[0]!.decision, 'accepted');
    } finally {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }

    const changed = await fixture('undo-stale-request', 'before\n', 'after\n');
    const changedState = await ready(changed);
    const changedHunk = changedState.files[0]!.hunks[0]!;
    await api.decide(changed.request, changed.relative, changedHunk.id, 'accepted', changedState.revision);
    const requestDocument = await vscode.workspace.openTextDocument(changed.request);
    const request = JSON.parse(requestDocument.getText());
    request.title = 'A changed request after approval';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(changed.request, new vscode.Range(new vscode.Position(0, 0),
      requestDocument.positionAt(requestDocument.getText().length)), JSON.stringify(request));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await requestDocument.save(), true);
    await assert.rejects(api.undo(changed.request, changed.relative, changedHunk.id, changedState.revision), /request changed/i);
    assert.deepEqual(await bytes(changed.target), Buffer.from(changed.after));
  });

  await check('Undo preserves BOM, CRLF, Unicode and exact EOF while retaining other accepted text', async () => {
    const item = await fixture('undo-bom-crlf',
      '\uFEFF첫째 😀\r\nold  \r\ncontext\r\nlast',
      '\uFEFF첫째 😀\r\nnew  \r\ncontext\r\nLAST');
    const state = await ready(item);
    const [first, last] = state.files[0]!.hunks;
    assert.equal(state.files[0]!.hunks.length, 2);
    await api.decide(item.request, item.relative, undefined, 'accepted', state.revision);
    await api.undo(item.request, item.relative, first!.id, state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from('\uFEFF첫째 😀\r\nold  \r\ncontext\r\nLAST'));
    await api.undo(item.request, item.relative, last!.id, state.revision);
    assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    assert.deepEqual((await bytes(item.target)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.ok((await ready(item)).files[0]!.hunks.every(hunk => hunk.decision === 'pending'));
    const deletion = await fixture('undo-accepted-deletion', 'remove all\r\n', '');
    const deletionState = await ready(deletion);
    const deleted = deletionState.files[0]!.hunks[0]!;
    assert.equal(deleted.newLines, 0);
    await api.decide(deletion.request, deletion.relative, deleted.id, 'accepted', deletionState.revision);
    assert.deepEqual(await bytes(deletion.target), Buffer.alloc(0));
    await api.undo(deletion.request, deletion.relative, deleted.id, deletionState.revision);
    assert.deepEqual(await bytes(deletion.target), Buffer.from(deletion.before));
    assert.equal((await ready(deletion)).files[0]!.hunks[0]!.decision, 'pending');
  });
  async function withMcpClient(action: (client: Client) => Promise<void>) {
    const configuration = await api.getMcpConfiguration(workspace);
    assert.ok(configuration.instanceId);
    const launch = configuration.json.mcpServers.revision_request;
    const transport = new StdioClientTransport({ ...launch, stderr: 'pipe' });
    let errors = '';
    transport.stderr?.on('data', chunk => { errors += String(chunk); });
    const client = new Client({ name: 'revision-request-host-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      await action(client);
    } catch (error) {
      if (errors) console.error('MCP adapter stderr: ' + errors);
      throw error;
    } finally { await client.close(); }
  }
  async function tool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    if (result.structuredContent) return result.structuredContent as T;
    const texts = (result.content as {type: string; text?: string}[]).filter(item => item.type === 'text').map(item => item.text || '');
    return JSON.parse(texts.join('\n')) as T;
  }
  async function toolRefused(client: Client, name: string, args: Record<string, unknown>, pattern?: RegExp) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name + ' must refuse the action');
    if (pattern) assert.match(JSON.stringify(result.content), pattern);
  }
  async function mcpTarget(name: string, before = 'first\ncontext\nlast\n') {
    const relative = name + '.tex'; const target = vscode.Uri.joinPath(workspace!, relative);
    await vscode.workspace.fs.writeFile(target, Buffer.from(before));
    return { relative, target, before };
  }
  async function propose(client: Client, item: Awaited<ReturnType<typeof mcpTarget>>, after = 'FIRST\ncontext\nLAST\n') {
    const read = await tool<{path: string; content: string; hash: string}>(client, 'rr_read_target', {path: item.relative});
    assert.equal(read.content, item.before); assert.equal(read.hash, createHash('sha256').update(Buffer.from(item.before)).digest('hex'));
    const args = {path: item.relative, expectedHash: read.hash, after, clientRequestId: randomUUID(), title: 'MCP fixture'};
    const status = await tool<McpStatus>(client, 'rr_create_request', args);
    return {status, args, request: vscode.Uri.joinPath(workspace!, status.requestPath)};
  }
  const agentConfig = vscode.workspace.getConfiguration('revisionRequest');
  const agentDenied = /agent decisions are disabled|allowAgentDecisions|AGENT_DECISIONS_DISABLED/i;

  await check('MCP defaults hide decision tools and both cached SDK calls and direct bridge calls are denied', async () => {
    assert.equal(agentConfig.inspect<boolean>('mcp.allowAgentDecisions')?.defaultValue, false);
    const previousGlobal = agentConfig.inspect<boolean>('mcp.allowAgentDecisions')?.globalValue;
    const settingsUri = vscode.Uri.joinPath(workspace!, '.vscode', 'settings.json');
    const previousSettings = await bytes(settingsUri);
    await agentConfig.update('mcp.allowAgentDecisions', false, vscode.ConfigurationTarget.Global);
    try {
      // Bypass Settings UI scope validation as a repository-controlled settings file could.
      const workspaceSettings = JSON.parse(previousSettings.toString('utf8'));
      workspaceSettings['revisionRequest.mcp.allowAgentDecisions'] = true;
      await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(workspaceSettings, null, 2)));
      assert.equal(JSON.parse((await bytes(settingsUri)).toString('utf8'))['revisionRequest.mcp.allowAgentDecisions'], true);
      const capabilities = await api.mcpHandler('capabilities', {}, workspace!.toString()) as {allowAgentDecisions: boolean};
      assert.equal(capabilities.allowAgentDecisions, false, 'A repository-supplied workspace override must never enable decisions');
      await withMcpClient(async client => {
        const names = (await client.listTools()).tools.map(item => item.name);
        for (const name of ['rr_read_target', 'rr_create_request', 'rr_get_request_status', 'rr_open_preview', 'rr_get_format']) assert.ok(names.includes(name));
        assert.equal(names.includes('rr_decide'), false); assert.equal(names.includes('rr_undo'), false);
        const format = await client.callTool({name: 'rr_get_format', arguments: {language: 'ko'}});
        assert.notEqual(format.isError, true); assert.match(JSON.stringify(format.content), /[가-힣]/);
        const item = await mcpTarget('mcp-default'); const made = await propose(client, item);
        const args = {requestId: made.status.requestId, revision: made.status.revision, hunkId: made.status.hunks[0]!.id};
        for (const decision of ['accepted', 'ignored']) {
          await toolRefused(client, 'rr_decide', {...args, decision}, agentDenied);
          await assert.rejects(api.mcpHandler('decide', {...args, decision}, workspace!.toString()), agentDenied);
        }
        await toolRefused(client, 'rr_undo', args, agentDenied);
        await assert.rejects(api.mcpHandler('undo', args, workspace!.toString()), agentDenied);
        assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
        assert.ok((await api.getState(made.request)).files[0]!.hunks.every(hunk => hunk.decision === 'pending'));
      });
    } finally {
      await vscode.workspace.fs.writeFile(settingsUri, previousSettings);
      await agentConfig.update('mcp.allowAgentDecisions', previousGlobal, vscode.ConfigurationTarget.Global);
    }
  });

  await check('MCP creation is byte-safe and retry-idempotent while stale hashes, existing requests, paths and dirty sources are refused', async () => {
    await withMcpClient(async client => {
      const item = await mcpTarget('mcp-create', '\uFEFFfirst\r\ncontext\r\nlast');
      const made = await propose(client, item, '\uFEFFFIRST\r\ncontext\r\nLAST');
      const originalRequest = await bytes(made.request);
      const again = await tool<McpStatus>(client, 'rr_create_request', made.args);
      assert.equal(again.requestId, made.status.requestId); assert.deepEqual(await bytes(made.request), originalRequest);
      await toolRefused(client, 'rr_create_request', {...made.args, clientRequestId: randomUUID()}, /exist|request/i);
      await toolRefused(client, 'rr_create_request', {...made.args, after: 'A different retry'}, /id|retry|request/i);
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before)); assert.deepEqual(await bytes(made.request), originalRequest);
      for (const invalidPath of ['../escape.tex', '/absolute.tex', 'nested/../escape.tex']) {
        await toolRefused(client, 'rr_read_target', {path: invalidPath}, /path|relative|workspace|travers/i);
        await toolRefused(client, 'rr_create_request', {...made.args, path: invalidPath, clientRequestId: randomUUID()}, /path|relative|workspace|travers/i);
      }
      const stale = await mcpTarget('mcp-stale');
      const read = await tool<{hash: string}>(client, 'rr_read_target', {path: stale.relative});
      const manual = 'Manually changed since reading\n'; await vscode.workspace.fs.writeFile(stale.target, Buffer.from(manual));
      await toolRefused(client, 'rr_create_request', {path: stale.relative, expectedHash: read.hash, after: 'new', clientRequestId: randomUUID()}, /changed|hash|stale/i);
      assert.deepEqual(await bytes(stale.target), Buffer.from(manual));
      await assert.rejects(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(workspace!, stale.relative + '.rr')));
      const dirty = await mcpTarget('mcp-dirty');
      const clean = await tool<{hash: string}>(client, 'rr_read_target', {path: dirty.relative});
      const document = await vscode.workspace.openTextDocument(dirty.target);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit(); edit.insert(dirty.target, new vscode.Position(0, 0), 'Unsaved\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(document.isDirty, true);
      try {
        await toolRefused(client, 'rr_read_target', {path: dirty.relative}, /unsaved|dirty/i);
        await toolRefused(client, 'rr_create_request', {path: dirty.relative, expectedHash: clean.hash, after: 'new', clientRequestId: randomUUID()}, /unsaved|dirty/i);
        assert.deepEqual(await bytes(dirty.target), Buffer.from(dirty.before));
        assert.ok(document.getText().startsWith('Unsaved'));
      } finally { await vscode.commands.executeCommand('workbench.action.files.revert'); }
    });
  });

  await check('Real MCP adapter reads and creates a proposal then tracks native decisions through completed-request deletion', async () => {
    const previous = agentConfig.inspect<boolean>('autoDeleteCompleted')?.workspaceValue;
    await agentConfig.update('autoDeleteCompleted', true, vscode.ConfigurationTarget.Workspace);
    try {
      await withMcpClient(async client => {
        const item = await mcpTarget('mcp-completion'); const made = await propose(client, item);
        assert.equal(made.status.status, 'pending'); assert.equal(made.status.pending, 2);
        assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
        const listed = await tool<{requests: McpStatus[]}>(client, 'rr_list_requests');
        assert.ok(listed.requests.some(request => request.requestId === made.status.requestId));
        const readyBefore = api.getReadyCount(); await tool<McpStatus>(client, 'rr_open_preview', {requestId: made.status.requestId});
        const deadline = Date.now() + 10000;
        while (api.getReadyCount() <= readyBefore && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(api.getReadyCount() > readyBefore, 'MCP open_preview must open the actual webview');
        await api.decide(made.request, item.relative, made.status.hunks[0]!.id, 'accepted', made.status.revision);
        const afterAccepted = Buffer.from('FIRST\ncontext\nlast\n'); assert.deepEqual(await bytes(item.target), afterAccepted);
        const partial = await tool<McpStatus>(client, 'rr_get_request_status', {requestId: made.status.requestId});
        assert.equal(partial.accepted, 1); assert.equal(partial.pending, 1);
        await api.decide(made.request, item.relative, made.status.hunks[1]!.id, 'ignored', made.status.revision);
        const complete = await tool<McpStatus>(client, 'rr_get_request_status', {requestId: made.status.requestId});
        assert.equal(complete.status, 'completed'); assert.equal(complete.cleanup, 'deleted');
        assert.equal(complete.accepted, 1); assert.equal(complete.ignored, 1); assert.equal(complete.pending, 0);
        const retained = await tool<{requests: McpStatus[]}>(client, 'rr_list_requests', {includeCompleted: true});
        assert.ok(retained.requests.some(request => request.requestId === complete.requestId && request.status === 'completed'));
        await assert.rejects(async () => vscode.workspace.fs.stat(made.request)); assert.deepEqual(await bytes(item.target), afterAccepted);
        const replay = await tool<McpStatus>(client, 'rr_create_request', made.args);
        assert.equal(replay.requestId, complete.requestId); assert.equal(replay.status, 'completed');
        await assert.rejects(async () => vscode.workspace.fs.stat(made.request), 'A retry must not recreate a completed request');
      });
    } finally { await agentConfig.update('autoDeleteCompleted', previous, vscode.ConfigurationTarget.Workspace); }
  });

  await check('MCP distinguishes a manually missing request from completed review receipts', async () => {
    await withMcpClient(async client => {
      const item = await mcpTarget('mcp-missing'); const made = await propose(client, item);
      await vscode.workspace.fs.delete(made.request, {useTrash: false});
      const missing = await tool<McpStatus>(client, 'rr_get_request_status', {requestId: made.status.requestId});
      assert.equal(missing.status, 'unavailable'); assert.notEqual(missing.cleanup, 'deleted');
      assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
    });
  });

  await check('Only user-level permission enables agent decisions and revocation blocks cached calls without blocking native decisions', async () => {
    const previous = agentConfig.inspect<boolean>('mcp.allowAgentDecisions')?.globalValue;
    try {
      await agentConfig.update('mcp.allowAgentDecisions', false, vscode.ConfigurationTarget.Global);
      await withMcpClient(async client => {
        assert.equal((await client.listTools()).tools.some(tool => tool.name === 'rr_decide'), false);
        const item = await mcpTarget('mcp-permission'); const made = await propose(client, item);
        const args = {requestId: made.status.requestId, revision: made.status.revision, hunkId: made.status.hunks[0]!.id};
        await agentConfig.update('mcp.allowAgentDecisions', true, vscode.ConfigurationTarget.Global);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        assert.ok(names.includes('rr_decide')); assert.ok(names.includes('rr_undo'));
        await tool<McpStatus>(client, 'rr_decide', {...args, decision: 'accepted'});
        assert.deepEqual(await bytes(item.target), Buffer.from('FIRST\ncontext\nlast\n'));
        await tool<McpStatus>(client, 'rr_undo', args); assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
        await tool<McpStatus>(client, 'rr_decide', {...args, decision: 'ignored'});
        assert.deepEqual(await bytes(item.target), Buffer.from(item.before)); await tool<McpStatus>(client, 'rr_undo', args);
        await agentConfig.update('mcp.allowAgentDecisions', false, vscode.ConfigurationTarget.Global);
        await toolRefused(client, 'rr_decide', {...args, decision: 'accepted'}, agentDenied);
        await toolRefused(client, 'rr_undo', args, agentDenied);
        await assert.rejects(api.mcpHandler('decide', {...args, decision: 'ignored'}, workspace!.toString()), agentDenied);
        await api.decide(made.request, item.relative, made.status.hunks[0]!.id, 'ignored', made.status.revision);
        assert.equal((await api.getState(made.request)).files[0]!.hunks[0]!.decision, 'ignored');
        await api.undo(made.request, item.relative, made.status.hunks[0]!.id, made.status.revision);
        assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
        assert.equal((await api.getState(made.request)).files[0]!.hunks[0]!.decision, 'pending');
      });
    } finally { await agentConfig.update('mcp.allowAgentDecisions', previous, vscode.ConfigurationTarget.Global); }
  });

  await check('Queued agent work is refused after permission is revoked before it can mutate the source', async () => {
    assert.equal(typeof api.testRunExclusive, 'function', 'The barrier exists only in the real Test extension mode');
    const previous = agentConfig.inspect<boolean>('mcp.allowAgentDecisions')?.globalValue;
    let release: (() => void) | undefined;
    try {
      await agentConfig.update('mcp.allowAgentDecisions', true, vscode.ConfigurationTarget.Global);
      await withMcpClient(async client => {
        const item = await mcpTarget('mcp-queued'); const made = await propose(client, item);
        let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
        const held = api.testRunExclusive(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
        await enteredPromise;
        const queued = api.mcpHandler('decide', {requestId: made.status.requestId, revision: made.status.revision,
          hunkId: made.status.hunks[0]!.id, decision: 'accepted'}, workspace!.toString());
        const refusal = assert.rejects(queued, agentDenied);
        await new Promise(resolve => setTimeout(resolve, 50));
        await agentConfig.update('mcp.allowAgentDecisions', false, vscode.ConfigurationTarget.Global);
        release!(); release = undefined; await held; await refusal;
        assert.deepEqual(await bytes(item.target), Buffer.from(item.before));
        assert.ok((await api.getState(made.request)).files[0]!.hunks.every(hunk => hunk.decision === 'pending'));
      });
    } finally { release?.(); await agentConfig.update('mcp.allowAgentDecisions', previous, vscode.ConfigurationTarget.Global); }
  });
  const result = {
    vscodeVersion: vscode.version,
    extensionVersion: extension.packageJSON.version,
    workspace: workspace.fsPath,
    passed: outcomes.filter(test => test.passed).length,
    failed: outcomes.filter(test => !test.passed).length,
    tests: outcomes,
  };
  const report = process.env.RR_TEST_REPORT || path.join(workspace.fsPath, 'results.json');
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({passed: result.passed, failed: result.failed, vscodeVersion: result.vscodeVersion}));
  if (result.failed) throw new Error(result.failed + ' real Extension Host test(s) failed. See ' + report);
  if (process.env.RR_PREVIEW === '1') {
    await vscode.workspace.getConfiguration('revisionRequest').update('autoDeleteCompleted', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ['workbench.action.editorLayoutSingle', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar']) {
      if (commands.has(command)) await vscode.commands.executeCommand(command);
    }
    const demoBefore = "\\section{A sample argument}\nLet \\(x > 0\\).\nWe use the following estimate:\n\\[\n  f(x) \\leq 2x.\n\\]\n\nThe argument applies to positive values of \\(x\\).\nThe equality case follows from the definition.\n\n\\section{Conclusion}\nThis proves the claim for \\(x > 0\\).\n";
    const demoAfter = "\\section{A sample argument}\nLet \\(x \\geq 0\\).\nWe use the following estimate:\n\\[\n  f(x) \\leq x.\n\\]\n\nThe argument applies to nonnegative values of \\(x\\).\nThe equality case follows from the definition.\n\n\\section{Conclusion}\nThis proves the claim for \\(x \\geq 0\\).\n";
    const demo = await fixture('visual-preview', demoBefore, demoAfter);
    const requestDocument = await vscode.workspace.openTextDocument(demo.request);
    const proposal = JSON.parse(requestDocument.getText());
    proposal.title = 'Review the estimate and its boundary case';
    proposal.description = 'A demonstration request. Accept only the changes you agree with; Ignore leaves the original text untouched.';
    proposal.files[0].reason = 'Keep the conclusion consistent with the revised domain.';
    proposal.files[0].explanations = [
      {line: 2, text: 'The boundary value x = 0 satisfies the same assumptions, so include it in the domain.'},
      {line: 5, text: 'The sharper estimate uses coefficient 1. This comment belongs only to this change.'},
      {line: 8, text: ''},
    ];
    const requestEdit = new vscode.WorkspaceEdit();
    requestEdit.replace(demo.request, new vscode.Range(new vscode.Position(0, 0),
      requestDocument.positionAt(requestDocument.getText().length)), JSON.stringify(proposal, null, 2));
    await vscode.workspace.applyEdit(requestEdit);
    await requestDocument.save();
    const beforeReady = api.getReadyCount();
    await vscode.commands.executeCommand('vscode.open', demo.request);
    await vscode.commands.executeCommand('revisionRequest.openPreview', demo.request);
    const deadline = Date.now() + 10000;
    while (api.getReadyCount() <= beforeReady && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(api.getReadyCount() > beforeReady, 'The preview webview must be running.');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const stopFile = path.join(workspace.fsPath, '.rr-preview-done');
    const holdMs = 600000;
    console.log('RR_PREVIEW_READY ' + JSON.stringify({
      workspace: workspace.fsPath, request: demo.request.fsPath, target: demo.target.fsPath,
      readyCount: api.getReadyCount(), holdMs, stopFile,
    }));
    const previewDeadline = Date.now() + holdMs;
    while (Date.now() < previewDeadline) {
      if (await fs.stat(stopFile).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
