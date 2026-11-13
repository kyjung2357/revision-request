# Settings

Open VS Code Settings and search for **Revision Request**. All keys below start with `revisionRequest.`.

| Setting | Default | Effect |
| --- | --- | --- |
| `previewOnOpen` | `true` | Open the preview once when an opened `.rr` document is first activated. Off opens JSON. **Open Preview** remains available; closing the preview does not reopen it automatically. **Open RR as JSON** always opens the source. |
| `defaultLayout` | `unified` | Initial comparison layout: `unified` shows removed text followed by added text; `sideBySide` shows two columns. The title-bar button switches views. A preview keeps its saved choice; this setting applies to new previews. |
| `acceptShortcut` | `ctrlEnter` | Accept the current edited block with Ctrl+Enter (also Cmd+Enter on macOS). Choose `altEnter`, `tab`, `shiftTab`, or `none` to change or disable it. Only applies inside the pending code editor; choosing Tab or Shift+Tab replaces its usual editor action. |
| `unchangedOpacity` | `20` | Opacity of unchanged code on the right, or in unified view: 0 hides it, 100 shows it fully. The left column, pending changes, and buttons stay fully visible. |
| `highlightChangedLines` | `true` | Tint pending rows red/green; off keeps stronger inline highlights. TeX files keep commands whole and include matching brackets around a changed single character or command. Padding-only edits mark only spaces; other bracketed contents use whitespace chunks. Python and JS/TS compare whole identifiers, numbers, and operators; strings and comments use words. JSON keeps property names whole. Markdown separates markup and uses the supported language inside labelled code fences. Other languages keep whitespace-based highlighting. Consecutive changed chunks include their intervening spaces. |
| `showOnlyChangedText` | `false` | Hide unchanged text within pending rows while preserving its space. Resolved rows return to normal context rendering; **Undo** restores pending highlights. |
| `autoDeleteCompleted` | `false` | Delete completed `.rr` files when no confirmation is shown, including after individual decisions; never delete the original. Off keeps the closed comparison and available Undo controls. Opening a completed or empty request does not trigger deletion. |
| `skipCompletedDeleteConfirmation` | `false` | When on, skip the completion question and use `autoDeleteCompleted`. When off, **Accept all / Ignore all** ask **Delete this .rr file?**: Yes deletes the request; No, X, or Escape keeps it. **Remember my choice** saves both settings; turn this option off to ask again. |
| `mcp.allowAgentDecisions` | `false` | Allow agents to Accept, Ignore, and Undo through MCP. User Settings only; human buttons are unaffected. See [MCP](MCP.md). |
