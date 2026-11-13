# Review actions

## Comparison and navigation

The preview defaults to unified view, with removed text followed by proposed text. Use **Toggle Comparison Layout** in the preview title bar for side-by-side columns. Long lines wrap before the action buttons; side-by-side rows stay aligned. Set the initial layout in [Settings](SETTINGS.md).

Opening a request or using **Open Preview** moves to its first pending change, starting with the removed rows in unified view. A request with none pending starts at the top. Ordinary Accept, Ignore, Undo, and refreshes preserve your place. Reopening preserves an unsaved draft but does not leave a hidden editor or old decision button focused.

The 15px scrollbar marks pending changes in red and green. Click a marker to jump to it, or drag its thumb to scroll. In side-by-side view, drag the divider immediately left of the scrollbar to resize the columns; double-click it to restore equal widths. Both code areas keep the same wrapping width.

## Edit a pending proposal

Click proposed code to edit it in place, in either layout. Multiline blocks remain one decision. **Alt+click** adds cursors within that block for simultaneous typing, deletion, and pasting.

| Control | Result |
| --- | --- |
| **Accept** | Apply and save the current edited proposal to the original, with no separate Save step. |
| **Ctrl+Enter** / **Cmd+Enter** | Accept from the editor. Change or disable this with `revisionRequest.acceptShortcut` in [Settings](SETTINGS.md). |
| **Ignore** | Discard the draft and ignore that proposal without changing the original. |
| **Escape** | Return multiple cursors to one; with one cursor, discard the draft. |
| Editor undo shortcut | Undo typing or a menu transformation within the draft. |

Accepted or ignored entries must first be returned to pending with **Undo** before editing. Accepting text restored to the original removes that proposal entry without changing the original.

## Change menu

Open **⋯** beside a pending change. **Why** shows its explanation without moving the comparison rows. Missing or blank explanations disable Why; the menu remains available for other actions.

The remaining actions transform the pending proposed text in either layout. They save neither the request nor the original until **Accept**. You can edit the result, discard it with Escape, or undo the transformation within the draft.

| File type | Comment out changed lines | Red removal / blue addition |
| --- | --- | --- |
| LaTeX | `%` line comments | `\reviewdel` / `\reviewdelmath` and `\reviewadd` |
| Python | `#` line comments | Unavailable |
| JavaScript/TypeScript, C/C++, C#, Java, Go, Rust, Swift, Kotlin, JSONC | `//` line comments | Unavailable |
| Markdown | HTML comments in plain-text contexts | Unavailable |
| JSON and unsupported file types | Unavailable | Unavailable |

Unavailable actions remain in the menu with an explanation. Commenting operates on the proposed block's complete lines. Strings, incomplete syntax, and unsupported contexts can disable it. These actions do not check whether the resulting program still runs correctly.

## LaTeX markup

Red removal keeps the removed text, with a strikethrough, beside its replacement. Blue addition marks the new text. Apply both actions when you want both forms of markup:

```tex
The value is \reviewdel{old}\reviewadd{new}.
```

Unchanged content stays unwrapped. Text deletions use `\reviewdel`, math deletions use `\reviewdelmath`, and additions use `\reviewadd`. These actions check TeX syntax separately from the preview's word highlighting. Unsupported command arguments, incomplete groups, environment changes, and alignment separators can disable them.

The project must load the review macros before color actions are available. Existing working macro inputs are reused without changing their paths.

If needed, choose **Set up LaTeX review macros…** from the menu, or **Revision Request: Set up LaTeX Review Macros** from the Command Palette with the request open. Finish or discard an active draft first.

Setup identifies the root document, shows the proposed setup, and copies the bundled `review-macro.tex` beside it if needed. It adds `\input{review-macro.tex}` as a **pending proposal**. Accept that import before using color actions. If the root is a separate file, its own `.rr` review opens. Existing macro files and conflicting definitions are never overwritten. The shared macros load `amsmath`, `xcolor`, and `ulem` with `normalem`.

## Quick Review

Use **Quick Review** above **Accept all / Ignore all**, or the lightning button beside **Requests** in the sidebar. If there is no selected request preview, the sidebar lets you choose one. There is no additional Quick Review button in the editor title bar.

Quick Review starts off when a preview is created or reloaded. While off, the button has a bright yellow outline, text, and filled lightning shape on a dark yellow background; switching it on reverses those colors.

| Key | Action |
| --- | --- |
| **Left** or **Right arrow** | Toggle between Accept and Ignore; both arrows cycle between those two choices. The **⋯** menu is excluded. |
| **Tab** | Execute the selected decision. After it succeeds, select Accept on the next pending change and scroll when needed. |
| **Escape** | Close an open menu or explanation first; otherwise turn Quick Review off. |

Enabling the mode selects Accept for the first visible or nearest pending block. Opening a request through the sidebar starts at the first pending change. Toggling the current preview does not reset it to the beginning.

Mouse review remains available. Keys pause while a menu, explanation, confirmation, or code editor is active; editing uses its configured Accept shortcut. A decision must finish before another can run. A failed decision keeps the same selection, and finishing all pending changes turns the mode off.
