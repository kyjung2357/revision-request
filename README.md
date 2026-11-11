# Revision Request

Review proposed changes before they reach your files.

Revision Request adds a visual comparison preview for **`.rr` files**. By default, opening `manuscript.tex.rr` in Explorer opens one preview tab with the original/current text on the left and the proposed text on the right. Compare the highlighted changes, then **Accept** or **Ignore** each change block. Opening the source or preview and ignoring a block do not write to the target file.

Existing UTF-8 source files such as `.py`, `.ts`, `.md`, `.json`, and `.tex` use the same workflow. Revision Request is not limited to LaTeX.

This extension is a local review tool. Your agent creates the proposal; it does not need to move into another chat or generate a patch for you to copy.

## Start with your own files

1. Install Revision Request, or use **Extensions → Install from VSIX...** with a supplied package.
2. Open your project folder in VS Code. Your target must be an existing UTF-8 text file inside that workspace.
3. Ask your agent to create a request named after the complete target filename, such as `main.py.rr` for `main.py`, without editing the target. Use the [request format](docs/FORMAT.md), [한국어 JSON 규격](docs/FORMAT.ko.md), or [MCP connection guide](docs/MCP.md).
4. Open the `.rr` file in Explorer. Review the aligned comparison and choose **Accept** or **Ignore** for each block. Trust the workspace before applying decisions.

No repository clone, demo files, or command-line setup is needed to review a request. By default, the last decision deletes the completed request; disable **Revision Request: Auto Delete Completed** first if you want to retain it and its Undo controls.

## Try the repository demo

The demo and proposal-creation CLI are available in the [source repository](https://github.com/kyjung2357/revision-request). They are not installed as project files by the extension package.

1. Open this repository as a folder in VS Code with the extension enabled.
2. Open `examples/manuscript.tex.rr` in Explorer, or select it in **Revision Request → Requests**. Its comparison preview opens automatically.
3. In **manuscript.tex.rr — Preview**, compare the original/current text on the left with the full proposed text on the right. Added and removed text is highlighted; each change group has **Accept** and **Ignore** controls.
4. Choose **Accept** on one block and **Ignore** on the other. After the last decision, the completed `.rr` request is deleted using the system Recycle Bin/Trash when available, and its preview closes by default. Turn off **Revision Request: Auto Delete Completed** to keep completed requests.

The two comparison columns share vertical scrolling. Corresponding lines stay aligned, with blank spacer rows for additions and deletions and equal-height file banners. Both columns belong to this single `.rr` preview. Opening the request uses this preview only; clicking the filename beneath **ORIGINAL** opens the actual editable target file in a native editor. Right-click the `.rr` file in Explorer and choose **Native diff** to open the native comparison, or **Open RR as JSON** to inspect its stored source without triggering automatic preview. These actions live in the file context menu; the preview has no top toolbar. The preview does not depend on Git or a worktree.

Each pending block has **Accept**, **Ignore**, and **Why** inline at the right edge of its first changed row. **Why** opens the block explanation in a popover without shifting the aligned source rows. It is disabled and dim when no explanation is provided. After a decision, the same area shows **Accepted** or **Ignored** on the left and **Undo** on the right; resolved blocks do not show Why. Undo returns that block to pending while the `.rr` request remains available. There is no separate control row or banner explanation toggle.

Accept applies the chosen block to the target shown on the left. Undo on an accepted block restores that block's original text while preserving other accepted revisions. The extension writes the exact accepted UTF-8 content, bypassing format-on-save and other save participants. A red removed line and a green added line are review decorations, not commands inserted into your source.

The original demo is a small standalone LaTeX file. It does not reference or modify any research manuscript.

## Choose how requests open

`revisionRequest.previewOnOpen` is **true** by default, so opening a request from Explorer launches its visual preview.

Set it to **false** for a Markdown-style source-first workflow:

```json
{ "revisionRequest.previewOnOpen": false }
```

With this setting off, opening a `.rr` file shows JSON. Use the editor-title **Open Preview** icon, the file context menu, or **Revision Request: Open Preview** in the Command Palette to open its visual review. Selecting a request in the Requests sidebar still opens its preview directly. **Open RR as JSON** always opens the source without triggering preview, regardless of the setting.

`.rr` source files use the **Revision Request** language mode with JSON syntax highlighting, schema validation, completion, and formatting from VS Code's built-in JSON support. Their default Explorer icon is **RR**, with a red first R and green second R. Ordinary `.json` files keep their existing language and icon. The active file-icon theme controls whether language-default icons are displayed; the extension does not change your theme.

## Adjust unchanged text visibility

The right comparison column shows unrelated, unchanged code at **20% opacity** by default so pending changes stand out. Adjust **Revision Request: Unchanged Opacity** in VS Code Settings, or set `revisionRequest.unchangedOpacity` to any value from **0 to 100**:

```json
{ "revisionRequest.unchangedOpacity": 20 }
```

At 0, unchanged code is hidden while its rows keep the comparison aligned; at 100, it is fully visible. Pending changes and their buttons stay at full opacity. The left column is unaffected. This option is available in extension settings only.

## Choose how changed text is highlighted

Pending changes highlight the exact removed or inserted characters, including multiple separate changes on one line. Two independent extension settings control the surrounding display:

- **Revision Request: Highlight Changed Lines** (`revisionRequest.highlightChangedLines`, default **true**) adds a faint red/green background across changed rows. Turning it off keeps the stronger character highlights.
- **Revision Request: Show Only Changed Text** (`revisionRequest.showOnlyChangedText`, default **false**) makes common characters within pending changed rows transparent. Their space remains, so both columns stay aligned. Changed characters, buttons, and unrelated context stay visible according to their existing settings.

```json
{
  "revisionRequest.highlightChangedLines": true,
  "revisionRequest.showOnlyChangedText": false
}
```

These options are available only in VS Code extension settings. They do not edit the source or request. Accepted or ignored blocks return to normal context rendering; **Undo** restores their pending character highlights.

## Keep completed requests

`revisionRequest.autoDeleteCompleted` is **true** by default. After a successful Accept or Ignore leaves no pending blocks, the extension deletes the `.rr` request using the system Recycle Bin/Trash when available and closes its preview and clean JSON tabs. The original file keeps exactly the accepted revisions; ignored blocks do not change it.

To retain completed requests and their baseline snapshots, turn off **Revision Request: Auto Delete Completed** in VS Code Settings:

```json
{ "revisionRequest.autoDeleteCompleted": false }
```

Opening a request that already has no changes does not trigger deletion. This setting controls the `.rr` proposal only, not its target file. Keeping a completed request also keeps its per-block **Undo** controls available.

## Create a request

Ask your agent to create a `.rr` proposal with the current file text in `before` and its proposed text in `after`, without editing the original. The extension computes the differences.

Each request reviews exactly one target. Its name is the complete target filename plus `.rr`: `section.tex` → `section.tex.rr`, and `section.md` → `section.md.rr`. The `files` array contains exactly one item:

```json
{
  "version": 1,
  "title": "Clarify the definition",
  "description": "Optional request metadata.",
  "files": [
    {
      "path": "paper/section.tex",
      "before": "The exact original text.\n",
      "after": "The exact proposed text.\n",
      "reason": "Default explanation for each change block.",
      "explanations": [{ "line": 1, "text": "A specific explanation for this block." }]
    }
  ]
}
```

Paths are relative to the **VS Code workspace folder containing the request**, even when the `.rr` file is in a subfolder. Keep exact line endings and the final newline in both snapshots.

Use `reason` as the default explanation for each block and optional `explanations` entries for specific blocks. An entry matches the first original line of that block; an empty `text` disables its **Why** button. `title` is required request metadata and `description` is optional metadata; neither is displayed in the preview banner. The right banner shows the proposed-side label, decision counts, and file actions.

See the [English format reference](docs/FORMAT.md), [한국어 JSON 규격](docs/FORMAT.ko.md), and [JSON schema](schemas/revision-request.schema.json).

### Generate a request from a separate modified copy

The repository CLI can create the proposal for an agent or a script after installing the repository dependencies. It reads both files and leaves the original unchanged:

```sh
npm run request -- --workspace . --original paper/section.tex --proposed .codex-work/section.proposed.tex --title "Clarify the definition"
```

By default, this creates `paper/section.tex.rr` beside the original. Optional `--output proposals/section.tex.rr` can place it elsewhere inside the workspace, but the filename must remain `section.tex.rr` and its directory must already exist. The CLI refuses to overwrite an existing request, rejects a target outside the workspace, and reports identical files instead of producing an empty proposal. Run `npm run request -- --help` for all options.

## Connect an agent with MCP

Run **Revision Request: Copy MCP Configuration** in VS Code, choose the workspace and generic JSON or Codex TOML, and add the copied configuration to your MCP client. The bundled stdio adapter connects to the local VS Code extension using VS Code's Node runtime; no separate Node installation or model API key is required. Keep that trusted local workspace open. The command copies configuration without editing client settings.

An agent can read the current target and its hash with `rr_read_target`, create a proposal with `rr_create_request`, open its preview, and check `rr_get_request_status`. The server supplies the original snapshot, checks the hash, and creates only the `.rr` file. Creation returns pending immediately; the agent can check the human's decisions later. After automatic deletion, a bounded local completion receipt remains available; a missing request never means accepted.

**Agents cannot Accept, Ignore, or Undo through MCP by default.** The User-level application setting `revisionRequest.mcp.allowAgentDecisions` defaults to `false`; those tools are hidden and their operations are denied. Explicitly enabling it in User settings allows agent decisions. Workspace settings cannot enable it, and the user's review UI is unaffected. This setting does not restrict independent filesystem tools or mouse automation.

Agents can load the bundled guides and schema through `rr_get_format` (`language: "en"` or `"ko"`) or the resources `rr://format/v1`, `rr://format/v1/ko`, and `rr://schema/v1`, even without a live VS Code bridge. See [MCP connection, tool arguments, and review status](docs/MCP.md) for the full workflow.

## Review behavior

- **Accept** writes only the chosen pending change block to its target file, with exact byte persistence rather than a normal editor save. The left comparison column updates to reflect the accepted result.
- **Ignore** records your decision and leaves the target untouched.
- **Undo** returns a resolved block to pending. For an accepted block, it reverts only that block in the target; for an ignored block, it changes the decision only. Other blocks keep their current decisions.
- The per-block **Undo** button is available while the `.rr` exists. To use it after completing the review, turn off **Revision Request: Auto Delete Completed** before the last decision. Native editor Undo is not guaranteed for extension writes.
- File-level controls accept or ignore all remaining blocks in that file.
- Decisions are stored locally in VS Code's workspace state; the `.rr` document itself is not rewritten. By default, the last successful Accept or Ignore deletes the completed request using the system Recycle Bin/Trash when available and closes its preview and clean JSON tabs.
- Reopening a retained, unchanged proposal restores its decisions. A no-change request is not automatically deleted merely by opening it.
- Changing the proposal creates a new review. If its `before` snapshot no longer matches the target, acceptance is blocked.
- Unsaved target edits or changes made outside this review block acceptance and Undo of accepted changes. If the original has changed, the preview shows a warning and the request snapshot instead of presenting the stale comparison as current. Regenerate a request from the current target before trying again.
- A request must be inside an open workspace. Accepting changes requires workspace trust. Its targets must stay inside that same workspace.
- The initial version reviews **existing UTF-8 text files**. New-file creation, deletion, and binary files are not supported.

If another person or agent edits a target while you are reviewing it, Revision Request does not silently overwrite those edits.

## Develop

```sh
npm ci
npm run check
npm run build
npm test
```

Press **F5** to launch an Extension Development Host, then open the repository folder and `examples/manuscript.tex.rr` there. Its preview opens by default; use **Open Preview** if automatic preview is disabled. Use a disposable copy of the demo when testing Accept, since it intentionally changes the selected target.

Run `npm run test:extension` for the Extension Development Host checks. Run `npm run test:mcp` for authenticated bridge and bundled stdio adapter protocol checks. Run `npm run test:ui` for real browser layout checks using an installed Edge or Chrome, without additional downloads. Run `npm run package` to build `.codex-artifacts/revision-request-0.1.1.vsix`. Install that package from the Extensions view with **Install from VSIX...**, then open a `.rr` file. Its preview opens by default; **Open Preview** is available when automatic preview is disabled.

Temporary build, test, and packaged artifacts live under ignored `.codex-*` directories. See the [한국어 수동 배포 안내](docs/PUBLISHING.ko.md) for local packaging and Marketplace upload steps.

The current release was tested on **Windows with VS Code 1.145.3**. macOS, Linux, and the declared minimum VS Code 1.96 have not been tested.

## License

Revision Request is released under the [MIT License](LICENSE), which permits commercial reuse with its required notices. Bundled third-party components retain their respective licenses. The build generates `.codex-build/THIRD_PARTY_NOTICES.txt`, and the VSIX includes that file with their copyright and license notices. Keep those notices when redistributing the extension.

## Scope

The extension does not call an AI model, send proposals to a service, or publish changes. Creating a `.rr` request is separate from accepting it. The proposal contains source text, so share it only where you would share the underlying files.
