# Revision Request examples

Open the repository root as the VS Code workspace, then open one of the requests below. Every request uses a workspace-relative path beginning with `examples/` and starts with all entries pending.

| Request | Original lines | What to review |
| --- | ---: | --- |
| [inventory_report.py.rr](inventory_report.py.rr) | 64 | 10 replacements, 5 added lines, 2 deleted lines |
| [team-notes.md.rr](team-notes.md.rr) | 44 | 11 replacements, 6 added lines, 3 deleted lines |
| [blank-notes.md.rr](blank-notes.md.rr) | 0 | 0 replacements, 14 added lines, 0 deleted lines |
| [retired-notes.md.rr](retired-notes.md.rr) | 7 | 0 replacements, 0 added lines, 7 deleted lines |

The Python report is self-contained and can be run directly. The team-notes example includes long paragraphs for checking line wrapping. The blank-notes original is an actual zero-byte file; the retired-notes request clears every line but keeps the file.

Each `*.proposed.*` snapshot shows the result of accepting every entry. Each entry contains one line-level edit and a reason for the **Why** button; review the entries individually with **Accept** or **Ignore**.

**Accept** changes the original examples. To try them repeatedly, use a copy of the repository or restore only the example files and requests you changed.

The existing `manuscript.tex` and `manuscript.proposed.tex` are preserved as saved. They currently match, so they have no pending example request.
