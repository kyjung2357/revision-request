# PDF review

A LaTeX request can be shared as a standalone `.tex.rr.pdf`. The PDF contains rendered removed text in red with strikethrough, added text in blue, and controls for its pending changes. The receiver does not need the original TeX project or Revision Request to read it.

## Generate, review, and return

1. Open the original `.tex.rr` in a trusted local VS Code workspace. Save the original and request, then click **Generate PDF from RR**. Confirm **Build PDF** only if you trust the source and proposed LaTeX; generation runs local compilation tools. The extension builds a separate review copy and writes the companion beside the request. Neither the original nor its decisions change.
2. Send the `.tex.rr.pdf` to the reviewer. In a PDF app that supports editable AcroForms, choose **Accept** or **Ignore** for each change, then save and return the PDF. Save the filled document itself; printing to PDF or flattening it removes the information needed for import.
3. Replace your companion with the returned file, then click **Import review from PDF**. Opening the `.rr` or detecting a changed PDF only checks whether the companion exists; it never imports decisions automatically. Approved, ignored, and pending PDF counts appear only after explicit import and remain separate from the source review.
4. After every PDF entry has a decision, click **Apply reviewed changes**. Approved entries are applied to the original and ignored entries keep their original text. The extension saves the corresponding `.rr` statuses together and offers the usual completion cleanup. Reopening or importing the same result does not apply it again.

During generation, the **Generate PDF from RR** button shows a spinner. The toolbar reports the current stage and elapsed time, then shows whether the PDF was created, cancelled, or failed. It stays visible while LaTeX is compiling; generation does not have a reliable percentage estimate.

You can also check **Generate a review PDF** in **Create Revision Request**. The option starts unchecked and disabled; selecting a saved workspace original with a `.tex`, `.ltx`, or `.latex` extension enables it. Git-commit originals remain disabled. Creation saves the `.rr` first, then runs the same PDF build and trust confirmation. A cancelled or failed PDF build leaves the request available in its preview.

Only entries that were pending at export receive PDF controls. The PDF is compiled from the current saved original: already accepted edits appear as ordinary text, and ignored edits retain the original wording. Only pending proposals receive red/blue comparison markup. Previously accepted or ignored entries keep their existing decisions; the printed change numbers retain their positions in the original request array. The **⋯** menu contains **Why** and **Accept all up to here**; the latter accepts still-pending entries through that change and preserves existing choices. This menu requires PDF JavaScript support. The explanation is also supplied as a PDF note/tooltip for viewers without the menu.

## Viewer support

| Environment | Behavior |
| --- | --- |
| Windows / macOS VS Code | Generate, import, and apply reviews using the locally installed LaTeX tools. This implementation has been tested on Windows; macOS has not been device-tested. |
| VS Code LaTeX Workshop PDF viewer | Accept/Ignore fields work independently of scripts. This viewer disables PDF JavaScript, so the **⋯** menu does not run; use the standard PDF note beside the change for its explanation. **Accept all up to here** requires a viewer that supports PDF JavaScript. |
| Desktop PDF apps | Accept/Ignore use standard AcroForm fields. The app must preserve filled fields and embedded attachments when saving. JavaScript support is additionally required for the **⋯** menu. |
| Android / iPhone / iPad | The PDF can be read normally. Decision editing depends on the PDF app's form-and-save support; the complete menu is not guaranteed. These devices have not been tested. |
| Overleaf internal preview | Read the rendered red/blue comparison. Uploaded PDFs are rendered to canvases, and the compiled-PDF viewer explicitly disables form input. Accept/Ignore and saving decisions inside that viewer are not supported. Use a form-enabled PDF app for decisions. |

Overleaf does not generate this review PDF. Its current [uploaded-PDF renderer](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/file-view/components/file-view-pdf.tsx) and [viewer settings](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts) explain the interaction limitation. Live Overleaf testing has not been completed.

## Generation requirements

Install a LaTeX distribution with **latexdiff**, its Perl runtime, and the project's compiler on PATH. The generator supports pdfLaTeX, XeLaTeX, and LuaLaTeX root directives; bibliography processing also requires BibTeX or Biber when used. No tools or TeX packages are downloaded automatically.

The generator copies needed project files into temporary storage, runs [latexdiff](https://github.com/ftilmann/latexdiff) with its locally generated preamble and math-display adjustments, and compiles the review copy. Existing manuscript macros and input paths are not rewritten in the original project. Shell escape is disabled, best-effort engine file restrictions are requested for the child process, and both sides use the original project’s frozen dependencies. Proposals that introduce file-loading commands, executable TeX primitives, or macro definitions must use source review instead. These checks do not make TeX an operating-system sandbox: existing macros can still execute complex code and read local files. Native file restrictions must not be relied on for confinement. Root directives and literal input dependencies are resolved; complex dynamic input paths or unsupported TeX constructs can prevent generation.

Preamble, macro-definition, comment-only, whitespace-only, and label-only changes need source review. Separate entries that share a physical source line must be merged before PDF generation. Every exported entry must have a verifiable position in the compiled PDF; missing or ambiguous positions stop generation. Compilation errors and unresolved references are reported. This is a rendered comparison, not a mathematical correctness check.

## Keep the export and source together

Keep the exporting workspace and original `.rr`. The extension records the exported request, source fingerprint, and entry identities locally. The returned PDF must match that export exactly; modified proposals, later source changes, conflicting local decisions, missing fields, and flattened PDFs cannot authorize application. Ordinary local source tracking does not silently rebase a returned PDF onto a changed original.

**Generate PDF from RR** and **Import review from PDF** remain separate buttons, regardless of which file was edited most recently. Generate rebuilds the PDF from the current pending entries and asks before replacing an existing companion and its saved choices. Import is disabled when no PDF exists. A replaced or regenerated PDF invalidates the imported result; import it again before applying. Restarting VS Code also requires a fresh import. A file that arrives or changes during generation is protected, and import errors leave ordinary source review available.

Companion PDFs are limited to 50 MiB. Generation also bounds copied dependencies, compiler output, and execution time. PDF parsing runs in a separate worker with time, heap, decompression, and object-tree limits. PDF scripts are never executed while importing; only the embedded request and field values are read. Export removes inherited scripts, external actions, attachments, and forms before adding the review controls. Internal document links are retained.

The returned PDF is not a digital signature. Its fields do not prove who made the decisions, and the manifest checks do not authenticate the visible page content. Use a trusted return channel and apply only reviews you trust. See the [security review](SECURITY_REVIEW.md) for verified protections and remaining limits.
