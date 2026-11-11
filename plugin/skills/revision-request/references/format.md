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
- `line` is the 1-based first original line. Numbers stay fixed after other review decisions.
- `before` must match uniquely starting in that line and may span consecutive lines. First/last lines may be fragments; intervening lines are complete. `after` replaces only the matched block. Group related contiguous changes into one atomic entry by default; keep independent changes separate.
- LF (`\n` in JSON) separates logical lines; CR (`\r`), including CRLF, is rejected. Use LF even when the target uses CRLF; saved line endings and the BOM are preserved separately.
- `before: null` inserts complete LF-separated `after` lines before the original anchor. Original line count plus one appends; an empty file uses line 1. Multiple insertions at an anchor follow array order.
- `after: null` deletes the entire original block, so `before` must contain its full lines with LF separators and no final physical line ending. `after: ""` empties the matched text and retains a logical line.
- Replacement/deletion blocks cannot consume any of the same original lines. Combine changes that would overlap. Insertion strictly inside a consumed block is invalid; insertion at its start or immediately after it is allowed.
- `""` is empty text or a blank line. Both values cannot be null.
- `reason` is optional; omit it or use `""` unless it helps the reviewer. Blank or absent reasons leave Why disabled with its label hidden. Every new entry requires `status: "pending"`. Never write accepted/ignored statuses to simulate review.
- Recheck the saved target before writing the proposal, and create the request exclusively so an existing request is preserved. The format cannot create, delete, or rename target files.

Open the `.rr` in VS Code for review. An unverified imported request may be rejected as stale; regenerate from the current source rather than editing the source or status to force it through. File presence or disappearance does not establish the review result.

Optional full reference: [Revision Request format](https://github.com/kyjung2357/revision-request/blob/main/docs/FORMAT.md).
