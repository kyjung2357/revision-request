# The .rr format

A Revision Request is a UTF-8 JSON document with the `.rr` suffix. It stores an original snapshot and a proposed snapshot. Creating or opening it does not execute or apply the proposed source code.

The format supports existing UTF-8 text files such as `.py`, `.ts`, `.md`, `.json`, and `.tex`. It is not specific to LaTeX. See the [한국어 JSON 규격](FORMAT.ko.md), [MCP guide](MCP.md), and [JSON schema](../schemas/revision-request.schema.json).

## Filename

Use the complete target filename, including its extension, followed by `.rr`. For example, `manuscript.tex` uses `manuscript.tex.rr`; `manuscript.md` uses `manuscript.md.rr`. A request contains exactly one target file. The request may live beside that target or in another folder inside the same workspace, but its basename must match this rule.

## Complete example

Save this proposal for `src/math.py` as `math.py.rr` inside the same workspace:

```json
{
  "version": 1,
  "title": "Correct the square operation",
  "files": [
    {
      "path": "src/math.py",
      "before": "def square(x):\n    return x + x\n",
      "after": "def square(x):\n    return x * x\n",
      "reason": "Multiplication computes the square.",
      "explanations": [
        { "line": 2, "text": "Replace addition with multiplication." }
      ]
    }
  ]
}
```

The example assumes the original contains exactly that text, including the final LF. For another target, always read its actual current contents.

## Version 1

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | The number `1`. |
| `title` | Yes | Nonempty request-title metadata; not displayed in the preview banner. |
| `description` | No | Optional request-level metadata; not rendered as a banner explanation. |
| `files` | Yes | An array containing exactly one target-file proposal. |

The single item in `files` has:

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | Yes | Forward-slash path relative to the workspace folder that contains the `.rr` file. |
| `before` | Yes | Exact original file text. |
| `after` | Yes | Exact proposed file text. |
| `reason` | No | Default explanation for each change block. |
| `explanations` | No | Specific block explanations, matched by their first original line. |

The request is stored as readable JSON. An agent may write it directly or create it from a separate modified copy using the bundled CLI. The user does not need to generate a unified diff. By default, opening the request in Explorer opens one comparison preview tab with the original/current text on the left and the full proposed text with change controls on the right. The columns have equal-height file banners, corresponding rows aligned with blank spacers for additions and deletions, and shared vertical scrolling. Both columns are part of the `.rr` preview; opening a request does not automatically open a native target editor. Clicking the filename beneath **ORIGINAL** opens the actual editable target file. The preview tab is named `<original.ext>.rr — Preview`. Set `revisionRequest.previewOnOpen` to `false` for JSON-first opening, then use the editor-title **Open Preview** icon, file context menu, or **Revision Request: Open Preview** command. Selecting a request in the Requests sidebar opens its preview directly. Right-click a `.rr` file in Explorer for **Native diff** or **Open RR as JSON**; the preview has no top toolbar. **Open RR as JSON** always bypasses automatic preview. Source and preview remain separate, like Markdown and its rendered preview; Git and worktrees are not involved.

The right column renders unrelated, unchanged code at 20% opacity by default. **Revision Request: Unchanged Opacity** in VS Code Settings (`revisionRequest.unchangedOpacity`, range 0–100) controls this display only. At 0, its text is hidden while alignment rows remain; at 100, it is fully visible. Pending changes and their controls retain full opacity, and the left column is unaffected. The option lives only in extension settings, not in the preview or request JSON.

## Character highlights and display settings

The extension derives character-level differences from the exact snapshots; agents do not add highlight markup to `before` or `after`. Multiple separate changes on a line are highlighted individually. Accepted or ignored blocks use normal context rendering, and Undo restores the pending highlights.

Two independent VS Code extension settings control the display:

| Setting | Default | Effect |
| --- | --- | --- |
| `revisionRequest.highlightChangedLines` | `true` | Adds faint red/green backgrounds across pending changed rows. Turning this off leaves stronger changed-character backgrounds visible. |
| `revisionRequest.showOnlyChangedText` | `false` | When enabled, hides only common characters within pending changed rows using transparent foreground. Their width remains, preserving alignment. Changed characters and controls stay visible; unrelated context retains its existing opacity. |

These settings live only in extension options, not in preview controls or `.rr` JSON. They can be combined independently. Very large or expensive inline comparisons may conservatively highlight a whole paired line.

## Block explanations

Each pending change block has **Accept**, **Ignore**, and **Why** inline in the right gutter of its first changed code row. There is no separate control-only row. **Why** toggles an anchored explanation popover without shifting the source rows. Without explanation text, **Why** is disabled and visibly dim.

`reason` supplies the default explanation for every block. `explanations` overrides it for individual blocks:

```json
{
  "reason": "Improve the local differentiability statement.",
  "explanations": [
    { "line": 6, "text": "Only differentiability at the chosen point is needed." },
    { "line": 14, "text": "" }
  ]
}
```

These fields belong inside the single `files` item; this fragment is not a complete request.

`line` is the block's **first original line**, one-based, matching its computed `oldStart` exactly. For a pure insertion, use the original insertion position. A matching entry overrides `reason`; empty or whitespace-only text explicitly disables **Why** for that block. A missing entry falls back to `reason`. With neither a nonblank specific explanation nor a nonblank default, **Why** is disabled. `description` remains accepted request metadata, but is not shown in the banner or used as a block fallback. There is no banner **Why this change** control, and request-title metadata is not displayed there. The right banner contains **REVISION REQUEST**, decision counts, and file actions.

The array may contain at most 10,000 entries. Each `line` must be a unique positive safe integer (at most 9,007,199,254,740,991). Each `text` allows at most 50,000 UTF-8 bytes and must not contain NUL. Entries that do not match a computed block are unused; update line references when regenerating the proposal.

## Path resolution

Suppose the open workspace folder is:

```text
project/
  paper/section.tex
  proposals/section.tex.rr
```

The request uses `"path": "paper/section.tex"`, not a path relative to `proposals/`. Absolute paths, empty segments, . or .. segments, colons, backslashes, Windows reserved device names, trailing dots or spaces, and targets whose real paths escape the workspace are rejected. In a multi-root workspace, each request uses the workspace folder that contains it.

Only existing regular UTF-8 text files are supported in version 1. Creating a file, deleting a file, or renaming a file is not part of this format. To propose removing all contents, use an empty `after` string; the existing file remains present.

## Preserve text exactly

Keep all original content in `before`, including CRLF versus LF, a UTF-8 byte order mark if present, and whether the file ends with a newline. JSON escaping is expected: newlines appear as `\n` or `\r\n` in the saved JSON representation.

Use JSON string escaping for the underlying text:

| Underlying character | JSON string representation |
| --- | --- |
| LF newline | `\n` |
| CRLF newline | `\r\n` |
| Tab | `\t` |
| Double quote | `\"` |
| Backslash | `\\` |
| Existing leading UTF-8 BOM | `\uFEFF` at the start of the string. Preserve it only if present. |

For example, the JSON source line `{"enabled":true}` becomes `"{\"enabled\":true}\n"` inside a snapshot string. LaTeX `\alpha` becomes `"\\alpha"`. Do not add a final `\n` if the source has no final newline. Use a JSON serializer instead of concatenating strings when possible; JSON comments and trailing commas are invalid. Do not put colored review markup in the snapshots: the extension computes the visual differences.

### Pure insertion example

This complete request for `src/settings.ts` adds a line after the original first line and is saved as `settings.ts.rr`:

```json
{
  "version": 1,
  "title": "Add a retry limit",
  "files": [
    {
      "path": "src/settings.ts",
      "before": "export const enabled = true;\n",
      "after": "export const enabled = true;\nexport const retries = 3;\n",
      "explanations": [
        { "line": 2, "text": "Insert the retry limit after the original first line." }
      ]
    }
  ]
}
```

The insertion position is original line 2. Explanation anchors always refer to the original snapshot, even if earlier edits move lines in the proposal.

The extension compares the target with the expected state derived from this snapshot plus already accepted blocks. It refuses to apply to a different current state. If the target has changed outside this review, the preview displays a warning and the request snapshot, and Accept is blocked. This protects manual edits made after the proposal was created.

## Decisions

The extension computes stable change blocks from `before` and `after`. A block starts as pending.

- **Accepted:** its replacement text is included in the target, and the left comparison column updates to the accepted result.
- **Ignored:** its original text is retained; ignoring a block does not write to the target.
- **Pending:** its original text is retained until a decision is made.

Resolved blocks show an **Accepted** or **Ignored** badge aligned with the pending Accept button and an **Undo** button aligned with the pending Why button. They do not show Why. If the resolved block has no source lines (an accepted deletion or ignored insertion), a single paired blank row keeps Undo accessible without inventing line numbers.

**Undo** returns the selected block to pending while the request still exists. Undoing an accepted block restores only that block's original text, keeping other accepted blocks applied. Undoing an ignored block updates its decision without writing to the target. Other blocks and their decisions are preserved. Accepted-block Undo uses the same stale/dirty-target protection as Accept.

Accepting one block does not accept other blocks. Decisions are stored in VS Code's local workspace state and are not part of the portable request document. Copying a `.rr` file to another workspace does not carry local decisions with it.

Accepted content is written as exact UTF-8 bytes through the filesystem API, bypassing editor save participants such as format-on-save. Native editor Undo is not guaranteed for these writes. The extension's per-block Undo is separate from native editor Undo. Turn off `revisionRequest.autoDeleteCompleted` before finishing to retain the request, its Undo controls, and its `before` snapshot for comparison or recovery.

`revisionRequest.autoDeleteCompleted` defaults to `true`. After the last successful Accept or Ignore leaves no pending blocks, the request is deleted using the system Recycle Bin/Trash when available and its preview and clean JSON tabs close. The target file retains the accepted revisions; Ignore does not write to it. Setting this option to `false` retains completed requests and their per-block Undo controls. With the default enabled, finishing the review deletes/closes the request, so its Undo controls are no longer available. Opening a no-change request alone never triggers deletion.

Changing the request text starts a new review state. Generate a fresh `before` snapshot when revising a partially accepted proposal.

## Agent instructions

A useful prompt for an agent is:

> Prepare a Revision Request instead of editing the target. Read the current UTF-8 source, preserve its exact contents as `before`, place the intended revision in `after`, and save a version-1 request named after the full target filename plus `.rr` inside the workspace (for example, `section.tex.rr`). Put exactly one target in its `files` array. Use workspace-relative forward-slash target paths and provide a default block explanation in `reason`, adding specific `explanations` entries when useful. Do not modify the target file.

For revisions that need compilation or tests, create and validate a separate proposed copy before generating the request. Keep temporary files and build results in the repository's ignored `.codex-*` folders.

## Creating requests through MCP

MCP file tools require a trusted local workspace and reject unsaved target edits. `rr_read_target(path)` returns the exact saved `content` and its SHA-256 `hash`. Pass `path`, that hash as `expectedHash`, the complete `after`, and a fresh `clientRequestId` to `rr_create_request`. Optional `title`, `reason`, and `explanations` provide metadata; unlike direct JSON authoring, MCP may supply the required title if omitted. The server reads the exact `before` itself, checks the hash, and creates `<target-path>.rr` exclusively beside the target without writing the target. Retry the same payload with the same client request ID after a lost response; use a new ID for a different proposal. Retry identity is retained only while its bounded local registry record remains.

Creation returns pending without waiting for human review. Use `rr_get_request_status` to inspect counts and individual decisions later. Automatic deletion retains a local metadata completion receipt, with at most 256 receipts stored and no full-source snapshot copies. Older receipts may expire. Missing files do not prove acceptance, and completion may include ignored blocks.

Agent decision tools are disabled by default. Only the User-level application setting `revisionRequest.mcp.allowAgentDecisions` enables them; workspace settings cannot grant permission. The user's UI remains available. This setting governs this MCP server, not an agent's separate filesystem or automation tools.

MCP clients can read this guide at `rr://format/v1`, the Korean guide at `rr://format/v1/ko`, or the schema at `rr://schema/v1`. `rr_get_format` returns the guide, schema, and examples with optional `language` (`en` by default, or `ko`), even when the VS Code bridge is unavailable. See [MCP setup and full tool reference](MCP.md).

## Size limits

Version 1 accepts exactly one file proposal in a request document of at most 20 MiB. Each original or proposed snapshot is limited to 5 MiB of UTF-8 text. Titles are limited to 2,000 UTF-8 bytes; descriptions, reasons, and each block explanation to 50,000 UTF-8 bytes. Text containing NUL is rejected.
