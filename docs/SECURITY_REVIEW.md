# Local security review

Reviewed on 2026-11-15 against the working source for 0.2.2. This report covers hostile revision requests and returned review PDFs, with focused checks of file writes, PDF parsing/export, and local LaTeX generation. It is not a certification or a full audit of VS Code, TeX, or PDF viewers. Reproductions used disposable files, never private source files.

## Findings and changes

| Finding | Impact before the fix | Change |
| --- | --- | --- |
| Hard-linked source and request files (high) | A workspace file could share an inode with an outside file. Accept changed the outside source; opening a linked request could write its timestamp to the outside file. Both were reproduced. | Reject source and request files whose link count is not one before review writes. Existing real-path containment and revision checks remain in place. |
| Proposal-controlled TeX file access (high) | A proposal containing a parent-path input command read a harmless outside-workspace sentinel and included it in the generated PDF, despite disabled shell escape. | Freeze dependencies from the original project; reject new resource-loading commands, executable primitives, and macro definitions in edited lines; limit file reads; restrict child-process configuration and shell escape. Require explicit trust before every build and recheck files after the dialog. This reduces exposure but is not an OS sandbox. |
| Inherited active PDF content (high) | TeX-generated PDFs could carry scripts, launch actions, external links, embedded attachments, and unrelated forms into the shared review. | Remove inherited active content and foreign forms/attachments before adding the fixed review controls. Preserve ordinary internal document links. Imported scripts are never executed. |
| Unbounded PDF work (high availability impact) | A small compressed object stream could allocate excessive memory during parsing, before attachment validation. Cyclic page/form/destination trees could also exhaust recursion. | Run all PDF parsing in a separate worker with time and heap limits; bound decoder allocations and graph traversals; reject malformed trees. Limit active/queued workers. Missing workers fail closed. |
| PDF file growth or replacement during reading (medium) | A file could change after its size check but before an unbounded read. | Read through a bounded file handle and verify file identity and location before/after the read. Explicit import and application reread the bytes. |
| Build dependency advisories | The build/package dependency tree contained esbuild and minimatch advisories. This repository does not use esbuild's development server. | Updated esbuild to 0.28.2 and scoped vsce's minimatch override to 11.0.1. The lockfile is updated; npm audit reports zero known advisories. |

The decompression issue is also described in the [pdf-lib upstream report](https://github.com/Hopding/pdf-lib/issues/1777). The dependency advisories are [esbuild](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) and [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249). Zero audit advisories does not mean the code has no vulnerabilities.

## Enforced PDF limits

- Input/output PDF: 50 MiB; manifest: 22 MiB; pending entries: 10,000; pages: 2,000.
- Worker: one active and at most four queued operations; 15-second read/anchor deadline, 30-second create deadline; 256 MiB old-generation and 32 MiB young-generation heap limits.
- Decoding: 32 MiB per decoded stream and 256 MiB cumulative decoder buffer allocations per operation. These limits supplement V8 heap limits, which do not cover all ArrayBuffer memory. The decoder hook checks the pinned pdf-lib implementation and fails closed if unsupported.
- Attachment, form, page, and destination trees have depth/node limits and reject cycles.

## Verification

Regression coverage includes compressed object/manifest bombs, graph cycles, inherited PDF actions and attachments, altered manifests/fields, hard-linked source/request files, replacement/growth during PDF reads, cancelled compilation, and files or trust changing while the build prompt is open. Ordinary generated reviews, saved choices, explicit application, and restart/idempotence remain covered.

Final results on Windows:

| Check | Result |
| --- | --- |
| npm test | 450 passed, 9 optional native-LaTeX cases skipped, 0 failed across both phases. |
| Real compiler suite (RR_TEST_LATEX=1) | 16/16 passed, including the optional compiler cases. |
| Real VS Code 1.146.0 Extension Host | 49/49 passed, including bundled worker creation, saved PDF import, explicit application, and repeat-import protection. |
| MCP authenticated bridge/stdio protocol | 6/6 passed. |
| TypeScript and production build | Passed; pdf-lib appears only in the dedicated PDF worker bundle. |
| Distribution file-list check | Worker included, source/development dependencies excluded, worker dependencies included in license notices. No VSIX created. |
| npm audit | 0 known advisories. |
| git diff --check | Passed. |

The first native run exposed a missing worker beside the *test harness* bundle; the test runner now copies the built worker next to that bundle. Production and packaged paths already place the worker beside the extension. The corrected native run passed.

## Remaining trust boundaries

1. **TeX remains executable local code.** Trusted baseline macros and installed packages can expose capabilities under arbitrary names. Command checks, disabled shell escape, best-effort process-local engine restrictions, and time limits do not replace a container or VM. A local MiKTeX baseline primitive-read check still accessed a harmless outside sentinel, so input confinement is not claimed for MiKTeX either. TeX Live 2026 also no longer treats openin_any as a read-confinement mechanism; see the [upstream change](https://tug.tug.org/pipermail/tex-live-commits/2026-January/035883.html). Build only source/proposals you trust. A fully hostile compilation service requires OS isolation.
2. **PDF choices are unsigned.** The local export record binds the request and source, but it cannot prove reviewer identity or authenticate visible PDF page content. Anyone able to edit the returned PDF can set its fields. Use a trusted return channel. Opening a request or receiving a PDF never applies decisions by itself. The explicit **Import review from PDF** action now applies saved choices after checking the export, current source, and request, including partial reviews.
3. **A hostile process running as the same OS user is outside this isolation model.** Static hardlink/path aliases are rejected, but the existing source-write transaction is not a defense against every last-instant path swap by another same-user process. Protect local workspace and extension storage permissions.
4. **Third-party runtimes still matter.** Keep the TeX distribution, VS Code, and PDF app updated. The worker is a resource boundary, not a permission sandbox for arbitrary code execution. PDF redline appearance is not a mathematical correctness guarantee.
5. Runtime verification here is on Windows. macOS, Linux, Android, iOS, and live Overleaf interactions were not retested as part of this audit.

No VSIX release was packaged, installed, or published during this security review.
