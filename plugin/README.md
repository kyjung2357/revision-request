# Revision Request plugin

Create `.rr` proposals from the current source, open them in the Revision Request VS Code preview, and check the user's review results. Proposed changes remain pending until reviewed. Ordinary direct-edit requests do not invoke this workflow.

This folder is a self-contained local plugin package with skills and a stdio MCP launcher. It connects to the existing VS Code extension; it does not bundle a second review engine.

## Requirements

- A local desktop plugin host with support for skills and stdio MCP.
- Node.js **22 or newer** on `PATH` for this plugin's launcher. No npm installation is needed.
- The [Revision Request VS Code extension](https://marketplace.visualstudio.com/items?itemName=kyjung2357.revision-request), enabled in an open, trusted local workspace.

The extension-generated adapter runs with VS Code's own runtime. That is separate from the Node prerequisite for this plugin's small launcher. Remote and virtual VS Code workspaces are unsupported. No model API key or hosted MCP server is needed.

## Install from this repository

The repository includes a local marketplace at `.agents/plugins/marketplace.json`, pointing to `./plugin`. In the desktop host's **Add marketplace** flow, select the repository root, then install **Revision Request** from that marketplace.

Installers may cache a copy of this folder. Use the installed plugin root when running the commands below. The root `plugin.json` and `mcp.json` follow the portable Agent Plugins format; `.codex-plugin/plugin.json` and `.mcp.json` provide compatibility metadata for Codex hosts.

Adding this repository as a local marketplace does not publish it to the public plugin directory.

## Connect the intended workspace

1. Open and trust the intended local workspace in VS Code with Revision Request enabled.
2. Run **Revision Request: Copy MCP Configuration**, select the intended workspace, and choose **Generic JSON**.
3. Save that copied JSON to a local file and import it:

   ```text
   node "<plugin-root>/scripts/configure.cjs" --from "<absolute-path-to-generated-json>"
   ```

   On Windows with **PowerShell 7 or newer**, you can import the copied JSON directly. In Windows PowerShell 5.1, save it as a UTF-8 file and use `--from` above so non-ASCII paths are preserved:

   ```powershell
   Get-Clipboard -Raw | node "<plugin-root>/scripts/configure.cjs" --stdin
   ```

4. Reconnect the plugin's `revision_request` MCP server and keep the VS Code window open. Ask the agent to call `rr_list_requests` to verify live workspace access. An empty list is a successful check.

The helper saves the validated generated configuration in `~/.revision-request/mcp.json`. It preserves the extension's command, arguments, environment, and selected workspace. The launcher starts that adapter over stdio without a shell. It does not search for workspaces or guess extension paths.

Use `--replace` when intentionally switching an existing saved connection to another workspace. Only one connection is selected at a time. To validate the saved configuration and referenced paths without executing it:

```text
node "<plugin-root>/scripts/configure.cjs" --check
```

A custom absolute config path can be supplied with `--config` to either script or through the launcher's `REVISION_REQUEST_MCP_CONFIG` environment variable. Configure and launch must use the same file.

The configuration helper does not install extensions or modify Codex settings. `--check` validates local configuration; `rr_get_format` checks only the adapter and works offline. Neither proves the VS Code bridge is connected.

## Diagnose and update

Run **Revision Request: Diagnose MCP Connection** in VS Code, or check the configured workspace from the plugin without needing MCP tools:

```text
node "<plugin-root>/scripts/launch-mcp.cjs" --diagnose
```

After connecting, the same workflow is available through `rr_diagnose`. It reports the bridge, selected workspace, versions, supported features, and a recovery step for failures. A successful local bridge check does not prove that the agent has discovered `rr_*` tools; call `rr_list_requests` from that agent to verify access.

The release process synchronizes this plugin's version, format guide, schema, and capability metadata with the extension. Installers keep cached copies, so updating the extension does not itself replace an installed plugin. If diagnostics reports a stale version or guide, update/reinstall the plugin through its host and reconnect; do not edit the cache. Keep the existing workspace configuration unless intentionally switching workspaces.

For repository development, run `npm run sync:plugin` to regenerate release files or `npm run check:plugin` to detect drift. Both VSIX builds and plugin packaging synchronize these files automatically. `docs/FORMAT.md`, `schemas/revision-request.schema.json`, `compatibility.json`, and the root `package.json` are the owning sources.

## Use it

> Use Revision Request to propose these changes and open the preview for my review.

The authoring skill reads the exact target and hash, creates a pending request, opens its preview, and reports the request for review. It can later check `rr_get_request_status` to distinguish accepted, ignored, pending, stale, and unavailable results. A missing `.rr` file is not evidence of acceptance.

Accept, Ignore, and Undo belong to the user by default. Agent decision tools require explicit authorization and the VS Code User setting `revisionRequest.mcp.allowAgentDecisions` already enabled. Plugin setup leaves that setting unchanged.

If connection setup is needed, run the plugin's setup workflow. It uses the configuration generated for the workspace you select. If the generated paths become obsolete, copy and import fresh Generic JSON. If two VS Code windows have the same workspace open, close the duplicate window.

For direct `.rr` authoring without a live connection, the skill includes the same format guide and JSON schema shipped with the extension. Live previews and review-status checks still require VS Code.

See the [MCP guide](https://github.com/kyjung2357/revision-request/blob/main/docs/MCP.md) and [format reference](https://github.com/kyjung2357/revision-request/blob/main/docs/FORMAT.md) for full extension details.

MIT licensed; see [LICENSE](LICENSE).
