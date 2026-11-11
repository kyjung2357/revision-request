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
- `time`: creation time in ISO 8601 with a timezone. MCP and CLI add it automatically. For a hand-written request without `time`, the extension fills it from the request file's creation time when reviewed. Existing timestamps are preserved.
- `request`: an array of revision entries, each reviewed with Accept or Ignore. Use at most one replacement or deletion entry per original line; combine edits on the same line. An empty array is valid.
- `line`: required, **1-based line number in the original file when the request was created**. Accepting other entries does not change this number.
- `before`: the exact text to replace, or `null` to insert a line. The text must match exactly once within the specified line, including spaces and tabs. Include only enough context from that same line to identify the intended occurrence.
- `after`: the replacement text, preserving any unchanged context included in `before`, or `null` to delete the complete original line.
- `reason`: optional explanation for the entry's **Why** button. Missing or blank text disables Why.
- `status`: required; exactly `pending`, `ignored`, or `accepted`. Creation tools always write `pending`.

String values in `before` and `after` must contain text from **one line only**. Do not include CR or LF characters, including JSON `\n` or `\r` escapes that decode to line breaks. Other text on that line is preserved automatically.

Generated files use the property order shown above; JSON property order has no effect.

Accept, Ignore, and Undo save each entry's `status` in the `.rr` JSON. New entries start as `pending`. **Changing `status` by hand does not apply or undo changes to the original file.** Agents must not mark entries accepted or ignored to claim human review.

Before writing to the original, the extension checks that it matches the saved baseline and recorded decisions. Opening a request never silently repairs the original. A retained or imported request that cannot be verified cannot authorize source changes or establish completed review.

## Add or delete a line

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

To append, set `line` to the original line count plus one. An empty file uses line 1. Several insertions at the same line appear in their array order. To insert a blank line, use `before: null` and `after: ""`.

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

For deletion, `before` must contain the **entire original line**, including indentation but excluding its line ending. `after: ""` instead keeps that line and replaces the matched text with empty text. These operations change file content; they do not create or delete the target file itself.
