# Revision Request format

## File extension

Each `.rr` file describes revisions to one existing UTF-8 text file. Name it by appending `.rr` to the complete original filename, including its extension: `main.py.rr`, `manuscript.tex.rr`, or `notes.md.rr`.

## Structure

```json
{
  "path": "src/main.py",
  "time": "2026-11-10T19:00:00-05:00",
  "request": [
    {
      "line": 2,
      "before": "x",
      "after": "y",
      "reason": "Use the selected variable.",
      "status": "pending"
    },
    {
      "line": 3,
      "before": "x + x",
      "after": "x * x",
      "reason": "Calculate the square by multiplication.",
      "status": "pending"
    }
  ]
}
```

- `path`: a relative path using `/`, based on the VS Code workspace folder containing the request. The same base applies even when the request is in a subfolder. The target file must already exist inside that workspace; files inside `.git` are not allowed.
- `time`: creation time in ISO 8601 with a timezone. Request creation tools add it automatically. For a hand-written request without `time`, the extension fills it from the request file's creation time when reviewed. Existing timestamps are preserved.
- `request`: an array of atomic revision entries, each reviewed with Accept or Ignore. Use the smallest independently reviewable change; consecutive lines alone are not a reason to merge entries. An empty array is valid.
- `line`: required, **1-based first line in the original file when the request was created**. Accepting other entries does not change this number.
- `before`: exact text to replace, or `null` to insert. It begins in the specified original line and may span consecutive lines separated by LF (`\n` in JSON). It must match uniquely, including spaces and tabs. The first and last lines may be fragments; intervening lines must be complete. Unmatched text before and after the block is preserved.
- `after`: replacement text or an LF-separated block, preserving unchanged text within the affected lines of `before`, or `null` to delete the complete original block.
- `reason`: optional explanation shown by **Why** in the entry's **⋯** menu. Omit it or use `""` when an explanation is unnecessary; Why is then disabled. The menu remains available for other supported actions.
- `status`: required; exactly `pending`, `ignored`, or `accepted`. Creation tools always write `pending`.

LF (`\n`) separates logical lines inside `before` and `after`; CR (`\r`) is rejected, including CRLF. Use LF in the request even when the saved file uses CRLF. The extension preserves saved line endings and the BOM separately. A non-null `before` with N LF separators consumes N + 1 consecutive original lines.

Replacement/deletion blocks cannot consume any of the same original lines, even when their text fragments differ. Combine related edits on those lines. An insertion strictly inside another block is invalid; insertion at its start or immediately after it is allowed. Multiple insertions at one anchor retain array order.

When authoring a request, build entries from the line-level diff. **An unchanged line is a hard boundary:** split whenever even one unchanged line lies between edits, including an unchanged blank line, comment, label, or environment delimiter. A shared purpose, rename, time interval, explanation, or enclosing environment is never an exception.

Consecutive changed lines can share one entry when they form one independently reviewable change. Isolated edits should use single-line entries. Keep matching context within the changed lines; do not add unchanged whole lines at the start, end, or between edits. The preview supplies surrounding context.

| Changed lines in the original | Entries |
| --- | --- |
| 10-11 changed, 12 unchanged, 13 changed | One for 10-11 and one for 13 |
| 10 and 21 changed; 11-20 unchanged, with the same rename on both changed lines | Separate entries for 10 and 21 |
| A completely new equation, including its new delimiters and blank lines | One multiline insertion |

Keep prose, display math, and neighboring LaTeX environments separate. In an existing environment, change only the affected lines; do not include unchanged `\begin`, `\end`, `\label`, or body lines to keep the environment together. A proposition and its proof are not one entry merely because they are related.

A completely inserted or deleted block may stay together because every included line is added or removed. Keep the delimiters and required nested environments of such a block together. This does not authorize combining separated edits inside an existing environment.

These are authoring rules for reviewable grouping. The reader preserves the entry boundaries supplied in a request. Each entry remains one decision in either preview layout; language-aware highlighting does not change the exact matching rules or split an entry.

For example, one decision can replace two adjacent changed lines without a reason:

```json
{"line": 8, "before": "total = price\nreturn total", "after": "total = price * quantity\nreturn round(total, 2)", "status": "pending"}
```

Generated files use the property order shown above; JSON property order has no effect.

Accept, Ignore, and Undo save each entry's `status` in the `.rr` JSON. New entries start as `pending`. **Changing `status` by hand does not apply or undo changes to the original file.** Agents must not mark entries accepted or ignored to claim human review.

Before writing to the original, the extension checks that it matches the saved baseline and recorded decisions. Opening a request never silently repairs the original. Reopening accepted multiline replacements, replacements with empty `after`, or deletions requires the saved baseline; the extension does not guess their original line endings. Proposals that would merge separate CR and LF separators are rejected. A retained or imported request that cannot be verified cannot authorize source changes or establish completed review.

## Add or delete lines

Use JSON `null` to distinguish an absent line from text. The string `""` means empty text or a blank line; it is not an insertion/deletion marker. `before: null` and `after: null` together are invalid.

Insert a complete new line **before original line 3**:

```json
{
  "line": 3,
  "before": null,
  "after": "validate()",
  "reason": "Validate before the next step.",
  "status": "pending"
}
```

To insert several consecutive lines as one decision, use an LF-separated `after`, such as `"validate()\nrun()"`. To append, set `line` to the original line count plus one. An empty file uses line 1. Several insertions at the same line appear in their array order. To insert a blank line, use `before: null` and `after: ""`.

Delete original line 4:

```json
{
  "line": 4,
  "before": "obsolete()",
  "after": null,
  "reason": "Remove the obsolete call.",
  "status": "pending"
}
```

For deletion, `before` must contain the **entire original block**, including indentation, with LF separators and without the final physical line ending. For example, `"obsolete()\ncleanup()"` deletes two complete lines in one decision. `after: ""` instead replaces the matched text with empty text and retains a logical line. These operations change file content; they do not create or delete the target file itself.
