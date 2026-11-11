# Direct .rr authoring

Use this reference when writing a request without MCP. If MCP is available, prefer its current `rr_get_format` output and creation tool.

A request proposes changes to one existing UTF-8 text file inside the intended VS Code workspace. Put it beside the target and append `.rr` to the complete name: `src/math.py` becomes `src/math.py.rr`. The `path` is relative to the workspace folder containing the request, uses `/`, and must not escape that folder or target `.git`.

For a saved target whose original line 2 is `    return x + x`:

```json
{
  "path": "src/math.py",
  "request": [
    {
      "line": 2,
      "before": "x + x",
      "after": "x * x",
      "reason": "Compute the square by multiplication.",
      "status": "pending"
    }
  ]
}
```

The optional top-level `time` is an ISO 8601 creation timestamp with timezone. If omitted in a hand-written file, the extension fills it from the request's creation time.

- Read the exact current saved target before authoring. Preserve indentation, tabs, and unchanged context.
- `line` is 1-based in that original snapshot. Numbers stay fixed after other review decisions.
- `before` must match exactly once within that line. `after` replaces only the matched text. Combine replacements/deletions on the same line into one entry.
- Every string is single-line: no CR/LF, including decoded `\n` or `\r`. Do not embed a BOM or line-ending characters.
- `before: null` inserts a complete `after` line before the original anchor. Original line count plus one appends; an empty file uses line 1. Multiple insertions at an anchor follow array order.
- `after: null` deletes the entire original line, so `before` must contain all its text. `after: ""` only empties the matched fragment.
- `""` is empty text or a blank line. Both values cannot be null.
- `reason` is optional. Every new entry requires `status: "pending"`. Never write accepted/ignored statuses to simulate review.
- Recheck the saved target before writing the proposal, and create the request exclusively so an existing request is preserved. The format cannot create, delete, or rename target files.

Open the `.rr` in VS Code for review. An unverified imported request may be rejected as stale; regenerate from the current source rather than editing the source or status to force it through. File presence or disappearance does not establish the review result.

Optional full reference: [Revision Request format](https://github.com/kyjung2357/revision-request/blob/main/docs/FORMAT.md).
