# Revision Request examples

Open the repository root as the VS Code workspace, then open a request below. All entries start as pending.

| Request | Decisions | What to review |
| --- | ---: | --- |
| [inventory_report.py.rr](inventory_report.py.rr) | 13 | Runnable Python; a five-line calculation replaced at once; grouped totals, individual fixes, additions, and deletions |
| [team-notes.md.rr](team-notes.md.rr) | 13 | Long wrapped paragraphs, table edits, consecutive changed lines, and an appended block |
| [blank-notes.md.rr](blank-notes.md.rr) | 1 | One decision inserts a complete 14-line template into an empty file |
| [retired-notes.md.rr](retired-notes.md.rr) | 1 | One decision deletes all seven lines and keeps the file |
| [multiline-demo.tex.rr](multiline-demo.tex.rr) | 12 | Separate prose and math blocks, a complete equation per decision, a removed draft section, and small corrections |

Each entry has one **Accept / Ignore** decision. Use `\n` inside JSON strings for a block of consecutive changed lines; split edits whenever an unchanged line lies between them. Whole insertions and deletions can remain multiline blocks. See the [grouping rules](../docs/FORMAT.md#structure).

Some entries omit `reason`, while others use an empty string. Both are valid: **Why** is disabled inside the **⋯** menu, which remains available for supported language actions. Entries with explanations enable Why.

The preview opens automatically at the first pending change by default. Use **Toggle Comparison Layout** in the editor title to switch from the default unified view to side-by-side. The longer examples exercise wrapping, the 15px change scrollbar, and keeping your position after Accept, Ignore, or Undo.

Try **Quick Review** for arrow-key selection and Tab decisions, or click pending code to edit it directly. The **⋯** menu offers explanations and supported comment/color actions. [Review actions](../docs/REVIEW_ACTIONS.md) covers the controls; [Settings](../docs/SETTINGS.md) covers preview modes and shortcuts.

Each `*.proposed.*` file is the exact result of accepting every entry. The blank-notes original is a zero-byte file; accepting the retired-notes request clears its contents but keeps the file. The Python report runs without external packages.

**Accept changes the original example.** Use a disposable copy of this workspace if you want to repeat the review. Keep the pending request and original together when sharing an example.

The previously reviewed `manuscript.tex` and its matching proposed copy are preserved. Use `multiline-demo.tex.rr` for the new TeX example.
