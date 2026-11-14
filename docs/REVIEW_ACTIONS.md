# Review actions

## Comparison and navigation

The preview defaults to unified view, with removed text followed by proposed text. Use **Toggle Comparison Layout** in the preview title bar for side-by-side columns. Long lines wrap before the action buttons; side-by-side rows stay aligned. Set the initial layout in [Settings](SETTINGS.md).

Opening a request or using **Open Preview** moves to its first pending change, starting with the removed rows in unified view. A request with none pending starts at the top. Ordinary Accept, Ignore, Undo, and refreshes preserve your place. Reopening preserves an unsaved draft but does not leave a hidden editor or old decision button focused.

The 15px scrollbar marks pending changes in red and green. Click a marker to jump to it, or drag its thumb to scroll. In side-by-side view, drag the divider immediately left of the scrollbar to resize the columns; double-click it to restore equal widths. Both code areas keep the same wrapping width.

**Go to original** on the first removed row opens the actual source file and places the cursor at the start of that change. Earlier accepted changes and tracked manual insertions and deletions are included when locating the current line. The button works in both layouts and while editing a proposal; it does not apply or discard the draft. Insertions without original rows have no navigation button. Unsaved source edits must be saved or undone first; navigation is unavailable for a conflicting or unverifiable entry.

## Edit the original during review

Once the extension has verified a local review, you can edit the original directly and save it. Changes outside pending blocks are adopted automatically: gray context updates, remaining proposals follow shifted lines, and later Accept operations preserve your manual edits. The request's original line numbers and proposal text stay in the JSON; current positions and the last verified source are stored in VS Code's local review state and checked again when reopening.

| Manual source edit | Review behavior |
| --- | --- |
| Unrelated gray text, or lines added/deleted before a proposal | Adopt the saved edit and update current positions. |
| An accepted or ignored area | Keep the manual text and its decision badge; disable Undo for that entry. |
| A pending original block, its insertion anchor, or an ambiguous location | Mark that entry as conflicting. Accept, proposal editing, Keep original as comments, and Go to original are unavailable for it. Other entries remain reviewable. |

The complete original block of a pending entry is protected, including common characters without stronger highlights. Manually typing the proposed result does not mark the entry Accepted. Ignore can discard a conflicting proposal without changing your current source. Accept all is unavailable while any pending conflict remains; Ignore all still discards all pending proposals. Quick Review stops at a conflict instead of silently skipping or deciding it. Conflicts remain pending and do not trigger completion cleanup.

Unsaved original edits pause application until saved or undone. Source changes also invalidate older review actions; the extension checks the latest source again immediately before writing. A prior local review record is required for automatic tracking. A newly received request still uses exact line and fragment validation, and a mismatch is not automatically relocated.

## Edit a pending proposal

Click proposed code to edit it in place, in either layout. Multiline blocks remain one decision. **Alt+click** adds cursors within that block for simultaneous typing, deletion, and pasting. Changes stay highlighted while editing. As you type, both the original and proposed highlights update against the current draft using the same language-specific rules as the preview.

| Control | Result |
| --- | --- |
| **Accept** | Apply and save the current edited proposal to the original, with no separate Save step. |
| **Ctrl+Enter** / **Cmd+Enter** | Accept from the editor. Change or disable this with `revisionRequest.acceptShortcut` in [Settings](SETTINGS.md). |
| **Ignore** | Discard the draft and ignore that proposal without changing the original. |
| **Escape** | Return multiple cursors to one; with one cursor, discard the draft. |
| Editor undo shortcut | Undo typing or a menu transformation within the draft. |

Accepted or ignored entries must first be returned to pending with **Undo** before editing. Accepting text restored to the original removes that proposal entry without changing the original.

By default, **Accept** or **Ignore** that finishes the last pending change asks **Delete this .rr file?**. This also applies to edited proposals, Quick Review, and **Accept all / Ignore all**. Opening a completed or empty request, Undo, and failed decisions do not trigger this question. See [completion settings](SETTINGS.md) to remember a choice or skip the question.

## Change menu

Open **⋯** beside a pending change. The menu contains **Show change explanation** and **Keep original as comments**.

**Show change explanation** shows the explanation without moving the comparison rows; the popover heading remains **Why**. Missing or blank explanations disable this item.

**Keep original as comments** preserves the original complete lines as comments before the active proposed text. For a change within a line, it keeps the whole original line, including unchanged text around the changed fragment. It uses the current draft for the proposed text, so edits you have already made remain active. For a deletion, it keeps only the commented original lines. A pure insertion has no original lines to preserve, so this action is disabled.

For example, replacing `old` with `new` in a LaTeX sentence produces:

```tex
% The value is old.
The value is new.
```

The action edits the pending draft in either layout. It saves neither the request nor the original until **Accept**. You can edit the result, discard the draft with Escape, or undo the transformation with the editor undo shortcut.

| File type | Comment syntax |
| --- | --- |
| LaTeX | `%` line comments |
| Python | `#` line comments |
| JavaScript/TypeScript, C/C++, C#, Java, Go, Rust, Swift, Kotlin, JSONC | `//` line comments |
| Markdown | HTML comments in safe plain-text contexts |
| Strict JSON and unsupported file types | Unavailable |

Unsupported or unsafe contexts disable the action and provide an explanation. Strings, incomplete syntax, and Markdown contexts that cannot safely contain HTML comments can prevent it. The action does not check whether the resulting program still runs correctly.

## Quick Review

In unified view, **Quick Review** sits immediately left of **Accept all** in the same action row. In side-by-side view, status indicators sit below the **ORIGINAL** filename on the left; on the same baseline in the right column, **Quick Review** sits at the left and **Accept all / Ignore all** at the right. You can also use the lightning button beside **Requests** in the sidebar. If there is no selected request preview, the sidebar lets you choose one. There is no additional Quick Review button in the editor title bar.

Quick Review starts off when a preview is created or reloaded. While off, the button has yellow text and a filled lightning shape on a dark yellow background, without a border; switching it on reverses the foreground and background colors.

| Key | Action |
| --- | --- |
| **Left** or **Right arrow** | Toggle between Accept and Ignore; both arrows cycle between those two choices. The **⋯** menu is excluded. |
| **Tab** | Execute the selected decision. After it succeeds, select Accept on the next pending change and center that block in the viewport. For a block taller than the viewport, center its proposed action row. Scrolling stops at the file boundaries. |
| **Escape** | Close an open menu or explanation first; otherwise turn Quick Review off. |

Enabling the mode selects Accept for the first visible or nearest pending block. Opening a request through the sidebar starts at the first pending change. Toggling the current preview does not reset it to the beginning.

Mouse review remains available. Quick Review pauses on a conflicting item; use its Ignore action or review another item explicitly. Keys pause while a menu, explanation, confirmation, or code editor is active; editing uses its configured Accept shortcut. A decision must finish before another can run. A failed decision keeps the same selection, and finishing all pending changes turns the mode off.
