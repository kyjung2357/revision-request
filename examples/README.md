# Revision Request examples

Open the repository root as the VS Code workspace, then open a request below. All entries start as pending.

| Request | Decisions | What to review |
| --- | ---: | --- |
| [inventory_report.py.rr](inventory_report.py.rr) | 13 | Runnable Python; a five-line calculation replaced at once; grouped totals, individual fixes, additions, and deletions |
| [team-notes.md.rr](team-notes.md.rr) | 13 | Long wrapped paragraphs, table edits, related lines reviewed together, and an appended block |
| [blank-notes.md.rr](blank-notes.md.rr) | 1 | One decision inserts a complete 14-line template into an empty file |
| [retired-notes.md.rr](retired-notes.md.rr) | 1 | One decision deletes all seven lines and keeps the file |
| [multiline-demo.tex.rr](multiline-demo.tex.rr) | 6 | An equation block, a worked calculation, a removed draft section, and small independent corrections |

Related lines are grouped with `\n` inside JSON strings, so a whole block has one **Accept / Ignore** choice. Independent edits remain separate. Some entries omit `reason`, while others use an empty string; both leave the Why button invisible without changing the button alignment. Entries with an explanation still show **Why**.

The preview starts in unified mode by default. Use **Toggle Comparison Layout** in the editor title to compare the same request side by side. The longer examples also exercise wrapping, scroll markers, and keeping your position after Accept or Undo.

Each `*.proposed.*` file is the exact result of accepting every entry. The blank-notes original is a zero-byte file; accepting the retired-notes request clears its contents but keeps the file. The Python report runs without external packages.

**Accept changes the original example.** Use a disposable copy of this workspace if you want to repeat the review. Keep the pending request and original together when sharing an example.

The previously reviewed `manuscript.tex` and its matching proposed copy are preserved. Use `multiline-demo.tex.rr` for the new TeX example.
