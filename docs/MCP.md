# Connect an agent through MCP

Revision Request exposes a local MCP server so an agent can read an existing source file, submit a `.rr` proposal, open its preview, and check your review decisions. Creating a proposal leaves the target unchanged. The default workflow keeps Accept, Ignore, and Undo in the user's VS Code review UI.

This works with existing UTF-8 text files such as `.py`, `.ts`, `.md`, `.json`, and `.tex`. See the [format reference](FORMAT.md) and [JSON schema](../schemas/revision-request.schema.json).

## Connect a client

1. Open and trust the target local workspace in VS Code with Revision Request enabled.
2. Run **Revision Request: Copy MCP Configuration** from the Command Palette.
3. Choose the workspace if more than one is open, then select generic JSON or Codex TOML. Add the copied configuration to your MCP client's server settings in the format it accepts. Preserve the generated executable, arguments, environment, and workspace values instead of guessing an extension installation path.
4. Reload or reconnect that MCP server in your client. Call `rr_diagnose`, then `rr_get_format` to read the current instructions. The format tool works offline; call `rr_list_requests` to verify live workspace access. An empty list is a successful connection check.
5. Keep the relevant VS Code workspace window open for source reads, request creation, previews, and review status.

The bundled adapter communicates with the client over **stdio** and connects to the extension's **local VS Code bridge**. Its generated configuration uses VS Code's Node runtime with `ELECTRON_RUN_AS_NODE`, so a separate Node installation is not required. Revision Request does not need a model API key. Copying configuration does not edit your client's settings automatically.

The extension keeps a stable adapter copy in its global storage and refreshes it on activation, so the copied configuration does not depend on a versioned extension installation directory. The generated configuration pins the selected workspace URI. If two live VS Code windows have the same workspace open, close the extra window: the adapter rejects ambiguous instances instead of choosing one silently. An optional `--instance-id` can pin a specific bridge instance, but that instance changes on reload; the generated configuration uses the workspace instead.

The bundled format guide, schema, and examples remain available through MCP even when the VS Code bridge is unavailable. File and review tools require the live bridge and a trusted local workspace. Remote and virtual workspaces are not supported by this adapter.

## Diagnose a connection

Run **Revision Request: Diagnose MCP Connection** in VS Code, even when the agent has no `rr_*` tools. The read-only report shows the selected workspace, adapter installation, an authenticated bridge probe, extension version, supported format features, and the last reported agent/plugin versions. Each failed stage includes a next step. It does not change configuration or review decisions, and does not print bridge credentials.

A running bridge does not prove that the agent has loaded its tools. The report distinguishes a last observed initialization, tool-list request, or tool call from current tool exposure, which VS Code cannot inspect. No plugin metadata means **unknown**: a direct MCP setup may not use a plugin, and an older launcher cannot report its version.

When tools are available, call `rr_diagnose`, then `rr_get_format`. Both remain available when the bridge is offline; diagnostics reports the unavailable bridge and the format tool still returns its bundled guide. The current guide takes precedence over cached plugin instructions. Version differences, missing supported features, and different guide fingerprints appear as warnings. `.rr` files remain unversioned.

For a terminal check without starting a client session, append `--diagnose` to the generated adapter command. Plugin users can run `node scripts/launch-mcp.cjs --diagnose` from their plugin directory. This prints a JSON report once; it does not prove that the agent has discovered the tools. Missing configuration is reported by the launcher before the adapter can start.

The release build synchronizes the plugin manifests, format guide, schema, and capability metadata from the extension sources. `npm run package` produces both the VSIX and matching plugin ZIP. Update both installed components and reconnect the MCP client; replacing the VSIX alone does not refresh a cached plugin or an already-running adapter. Do not edit plugin cache directories by hand.

## The agent cannot approve by default

The VS Code User setting `revisionRequest.mcp.allowAgentDecisions` defaults to **false**. In this mode:

- `rr_decide` and `rr_undo` are absent from the available tool list.
- The server also rejects direct attempts to invoke those operations, including bulk Accept or Ignore. Hiding tools is not the only enforcement.
- The user can still Accept, Ignore, and Undo in the extension's UI.

Only an explicit **User-level** setting enables agent decisions. This is an application-scoped preference; a workspace's `.vscode/settings.json` cannot grant it:

```json
{ "revisionRequest.mcp.allowAgentDecisions": true }
```

Leave the setting off for human approval. If it is enabled, the MCP client may need to refresh its tool list or reconnect before displaying the optional tools. Turning it off removes permission even if a client still has a cached tool definition.

This setting governs **Revision Request's MCP decision tools**. It does not sandbox an agent's other filesystem tools or mouse/keyboard automation. Agents must not use those separate tools to bypass the user's review or simulate approval through Quick Review or other UI controls.

## Read, propose, and return immediately

A normal agent workflow is:

1. Call `rr_diagnose`, then read `rr://format` or call `rr_get_format` without arguments. Use these current instructions instead of an older cached guide.
2. Call `rr_read_target` with a workspace-relative path. It returns `path`, exact saved `content`, and its SHA-256 `hash`. Keep the text and hash together. Save or undo unsaved target edits first; reads and proposals refuse dirty targets.
3. Prepare `request` entries with original 1-based first-line numbers and exact `before`/`after` fragments or LF-separated blocks. Group only consecutive changed lines that form one independently reviewable change. Even one unchanged line, including a blank line, comment, or environment delimiter, requires separate entries. Keep matching context within changed lines; a shared purpose never overrides that boundary. See the [format and grouping rules](FORMAT.md#structure) for exact matching, multiline blocks, and LaTeX boundaries. Omit `reason` or use `""` when no explanation is needed.
4. Call `rr_create_request` using the returned hash as `expectedHash` and a fresh `clientRequestId` for this proposal.
5. Use the returned request ID with `rr_open_preview` when the user should see the review.
6. Report that the proposal is pending. Check `rr_get_request_status` later to learn what the user accepted or ignored.

Creation returns a pending request; it does not keep a tool call open waiting for the human. Poll status when needed instead of interpreting the initial response as approval or waiting indefinitely in a creation call.

For example, suppose `src/math.py` contains:

```python
def square(x):
    return x + x
```

First call `rr_read_target`:

```json
{ "path": "src/math.py" }
```

Pass that object to `rr_read_target`, then send this shape to `rr_create_request` with the actual returned hash:

```json
{
  "path": "src/math.py",
  "expectedHash": "<hash returned by rr_read_target>",
  "clientRequestId": "7426dddf-85b8-4d67-9f4d-4f5b555d263d",
  "request": [
    {
      "line": 2,
      "before": "x + x",
      "after": "x * x",
      "reason": "Multiplication computes the square for every input."
    }
  ]
}
```

The server validates that the target still matches `expectedHash`, resolves each snippet exactly, and creates the `.rr` file exclusively. It supplies the creation `time` and writes every entry with `status: "pending"`; these fields are not accepted from the MCP client. It does not write `after` into the target. MCP creates the request beside the target: `src/math.py` becomes `src/math.py.rr`. The filename preserves the full target basename and extension.

Each entry is one atomic decision on a fragment or consecutive block. `line` identifies its first original line and stays fixed after other decisions. First/last lines may be partial matches; all intervening lines must match completely. Consumed replacement/deletion line ranges cannot overlap. An insertion strictly inside another block is invalid, while start/end boundary insertions are allowed. The saved shape is `{path, time, request: [{line, before, after, reason?, status}]}`.

`before: null` inserts complete new lines from LF-separated `after` before the indicated original line; original line count plus one appends. Several insertions at one anchor follow array order. `after: null` deletes the complete original block, so `before` contains all of its lines with LF separators and no final physical line ending. An empty string means empty text or a blank line. Both values cannot be null. For example, `{line: 8, before: "total = price\nreturn total", after: "total = price * quantity\nreturn round(total, 2)"}` is one decision for two adjacent changed lines. Leave any following unchanged line outside the entry.

New entries must start pending. Agents must not write accepted/ignored JSON statuses to claim that a human reviewed the proposal. Status metadata alone never applies or undoes source changes; cached source verification also prevents mismatched states from being reported as completed review. Use the authorized review UI or, only when explicitly enabled, the MCP decision tools.

If the source changed, read it again and prepare a fresh proposal. Do not substitute a guessed hash or reuse an old snapshot. Retrying the **same `clientRequestId` with the same payload** is idempotent, including when the client lost the first response. Reusing that ID for a different payload is not a new proposal; use a new ID instead. An existing request file is not silently overwritten. Idempotency records share the bounded local request registry; this is not permanent retry history. If an old record has expired, inspect the current source and requests before submitting again.

## Create a request from two saved files

Use `rr_create_request_from_files` when a separately modified copy already exists. The server compares it with the original and groups changed runs into review entries. For `.tex`, `.ltx`, and `.latex` files, automatic grouping also separates recognizable prose/display-math/environment boundaries while keeping complete changed environment blocks together. Unchanged lines separate independent edits. The comparison is structural rather than a full TeX parser, so review the generated grouping. Explicit entries passed to `rr_create_request` retain the boundaries supplied by the caller. Use `rr_create_request` instead when the agent is supplying specific fragments or blocks directly.

1. Call `rr_read_target` for the original, then for the modified copy. Both must be saved UTF-8 files inside the connected workspace. Keep each returned `hash`.
2. Call `rr_create_request_from_files` with their workspace-relative paths, both hashes, and a fresh `clientRequestId`:

```json
{
  "path": "paper/section.tex",
  "proposedPath": "paper/section.proposed.tex",
  "expectedHash": "<hash returned for the original>",
  "expectedProposedHash": "<hash returned for the modified copy>",
  "clientRequestId": "eebfe318-07db-47bc-b170-cfbcc03ab96b"
}
```

An optional `reason` explains the generated changes; omit it when unnecessary. The server creates only `paper/section.tex.rr`, with pending entries and a creation time. It does not modify either input or overwrite an existing request. Dirty files, stale hashes, identical inputs, and paths outside the connected workspace are refused. Changes consisting only of line endings or the final newline cannot be represented and are also refused.

3. Call `rr_open_preview` with the returned `requestId` for human review, then use `rr_get_request_status` to check later decisions. Creation does not open the preview or accept any changes automatically.

Use the same `clientRequestId` and payload only when retrying the same operation. Read both files again and use a fresh ID when preparing a different proposal. Do not send `status` or `time`; the server supplies them.

The VS Code creation dialog also offers **Git commit** originals. This MCP tool compares two saved files; it does not accept a Git commit reference. See [creating a request from your own edits](../README.md#create-a-request-from-your-own-edits).

## Tools

Paths are relative to the connected workspace. Request IDs, revisions, hunk IDs, and hashes are returned values; do not infer them from filenames or line numbers.

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `rr_diagnose` | None | Reports the workspace connection, component versions, and format compatibility without changing files or decisions. |
| `rr_get_format` | None | Returns the guide, schema, and example, including when the VS Code bridge is offline. |
| `rr_read_target` | `path` | Reads an existing UTF-8 target and returns its content and hash. |
| `rr_create_request` | `path`, `expectedHash`, `clientRequestId`, `request: [{line, before, after, reason?}]` | Creates fragment/block changes with server-generated time and pending statuses. |
| `rr_create_request_from_files` | `path`, `proposedPath`, `expectedHash`, `expectedProposedHash`, `clientRequestId`; optional `reason` | Compares two saved workspace files and creates a pending request while preserving both inputs. |
| `rr_list_requests` | Optional `includeCompleted` (default `false`) | Lists existing requests; set true to also include retained completion receipts after cleanup. |
| `rr_get_request_status` | `requestId` | Retrieves the request's current review state or retained completion receipt. |
| `rr_open_preview` | `requestId` | Opens or reveals the preview at its first pending change, without making a decision. |
| `rr_decide` | `requestId`, `revision`, `decision`: `accepted` or `ignored`; optional `hunkId` | **Only when agent decisions are enabled.** Decides one hunk, or all pending hunks when `hunkId` is omitted. |
| `rr_undo` | `requestId`, `revision`, `hunkId` | **Only when agent decisions are enabled.** Returns one resolved hunk to pending through the same checks as UI Undo. |

Request discovery scans up to 1,000 `.rr` files and excludes dependency, Git metadata, and internal work folders. A live completed request can appear even without `includeCompleted`; that option adds stored completion receipts. Keep the returned request ID when creating a request, including one in an excluded folder.

Decision calls must use the current raw JSON revision returned by the server. Accept/Ignore/Undo save entry statuses in the JSON, so the revision changes but the MCP request ID remains stable. Automatic creation-time insertion also preserves the proposal identity. Editing proposal contents creates a different generation and requires a refreshed request ID. A changed proposal must be reviewed again. Accepted changes and accepted-block Undo also reject stale or unsaved target edits. Undo of an ignored block changes review metadata only.

## Open the human review

`rr_open_preview` explicitly opens or reveals the request, regardless of **Preview Mode**. It moves to the first pending change, or to the top when none remain. It does not enable Quick Review or make any decision. Use `rr_get_request_status` for status checks; repeatedly opening the preview would interrupt the user's position.

Automatic source opening offers **Always** (default), **Once**, and **Manual** modes. **Open RR as JSON** keeps the current JSON editing session open in every mode, and closing a preview does not immediately reopen it in a loop. Accept, Ignore, Undo, and ordinary refreshes retain the current position. See [Settings](SETTINGS.md).

The user can edit pending text directly, review with **Quick Review**, or use **⋯** for explanations and supported language actions. LaTeX macro setup proposes an import for review before color actions become available. These are VS Code UI features, not additional MCP tools. See [review actions](REVIEW_ACTIONS.md).

## Built-in resources

| Resource URI | Contents |
| --- | --- |
| `rr://format` | English request format and grouping guide. |
| `rr://schema` | Self-contained JSON schema. |

These are bundled local instructions. They do not require a model service, API key, or running VS Code bridge. `rr_get_format` is the tool alternative for clients that do not expose MCP resource browsing conveniently.

## Completion, deletion, and Undo

Both `revisionRequest.autoDeleteCompleted` and `revisionRequest.skipCompletedDeleteConfirmation` default to **false**. When a user finishes the remaining entries with **Accept all** or **Ignore all**, the preview asks whether to delete the `.rr` file. **Yes** deletes only the request, using the system Recycle Bin/Trash when available; **No**, close, or Escape keeps it. “Remember my choice and don’t ask again” stores the chosen deletion policy and skips future prompts. When confirmation is skipped, `autoDeleteCompleted` determines whether completed requests are kept or deleted. MCP decisions do not open this interactive confirmation; they follow the automatic-deletion setting.

A retained request with no pending entries shows **This revision request is closed.** In side-by-side view, the left shows the actual current file without change highlights, while the right keeps the recorded accepted/ignored results and badges. The selected comparison layout and available Undo controls remain usable.

MCP status retains a completion receipt so an agent can learn the final accepted/ignored result after cleanup. These are bounded local outcome records, not copies of the full source snapshots. Storage is limited to 256 receipts, so older results can expire.

Status includes the request ID and revision, pending/accepted/ignored counts, and individual hunk decisions. Its `status` is `pending`, `completed`, `stale`, or `unavailable`; a completed receipt can also report cleanup as `retained`, `deleted`, or `failed`. A completed review may contain ignored blocks, so completion is not the same as accepting everything.

**A missing `.rr` file is not proof of acceptance.** Use the status or completion receipt. A request can be removed or changed outside the review; an unavailable or unknown request must not be reported as accepted.

Per-block Undo requires the request to remain available. Keep it with **No** at the deletion prompt or leave automatic deletion off if you want completed requests and their Undo controls retained. Undo still validates the actual source before writing, including in a closed request. A completion receipt records the result; it is not a substitute for a live request that can still be undone. Native editor Undo is not guaranteed for the extension's exact filesystem writes.

## Connection and validation errors

If format resources work but file tools cannot connect, reopen and trust the intended local VS Code workspace and reconnect using its generated configuration. If a path is rejected, use a forward-slash path inside that workspace; absolute paths, traversal, and escaping symlinks are not accepted. Existing UTF-8 text targets are supported; binary files and creating, deleting, or renaming target files are outside this format.

Identical proposals are rejected as `NO_CHANGES`. Malformed UTF-8 or unpaired Unicode surrogates cannot be saved as exact source text. Use LF (`\n` in JSON) between logical lines in a block; CR is rejected. Do not copy a file's UTF-8 BOM or the block's final physical line ending into a fragment. The extension preserves saved line endings and the BOM separately.

If creation reports an existing output, inspect that request instead of overwriting it. If a decision tool is unavailable or denied, check the User-level agent-decision setting; workspace configuration cannot enable it.
