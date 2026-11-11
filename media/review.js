/* global acquireVsCodeApi */
(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('app');
  const restored = vscode.getState() || {};
  let openWhy = typeof restored.openWhy === 'string' ? restored.openWhy : null;
  const dismissedErrors = new Set(Array.isArray(restored.dismissedErrors) ? restored.dismissedErrors.filter(message => typeof message === 'string') : []);
  const savedEdit = restored.editing;
  let editing = savedEdit && typeof savedEdit.filePath === 'string' && typeof savedEdit.hunkId === 'string'
    && typeof savedEdit.revision === 'string' && typeof savedEdit.draft === 'string'
    ? { ...savedEdit, saving: false, editId: null } : null;
  let editSequence = 0;
  let focusAfterEdit = null;
  let completion = null;
  let splitRatio = typeof restored.splitRatio === 'number' && Number.isFinite(restored.splitRatio) ? Math.max(0.05, Math.min(0.95, restored.splitRatio)) : 0.5;
  let splitDrag = null;
  let state = null;
  let awaitingDecision = false;

  function saveViewState() { vscode.setState({ openWhy, splitRatio, dismissedErrors: [...dismissedErrors], editing: editing ? { ...editing, saving: false, editId: null } : null }); }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function button(text, className, onClick, options = {}) {
    const node = element('button', className, text);
    node.type = 'button';
    node.disabled = Boolean(options.disabled);
    if (options.title) node.title = options.title;
    if (options.label) node.setAttribute('aria-label', options.label);
    if (options.key) node.dataset.focusKey = options.key;
    if (options.hunk) node.dataset.hunk = options.hunk;
    node.addEventListener('click', onClick);
    return node;
  }
  function post(message) { vscode.postMessage(message); }
  function decide(message) {
    if (!state || state.busy || awaitingDecision || editing) return;
    message.revision = state.revision;
    awaitingDecision = true;
    dismissedErrors.clear();
    if (message.type === 'decideFile' || message.hunkId === openWhy) openWhy = null;
    saveViewState();
    render();
    post(message);
  }
  function decisionOf(hunk) {
    return hunk.decision === 'accepted' || hunk.decision === 'ignored' ? hunk.decision : 'pending';
  }
  function counts(hunks) {
    const result = { pending: 0, accepted: 0, ignored: 0 };
    for (const hunk of hunks) result[decisionOf(hunk)] += 1;
    return result;
  }
  function badge(text, kind) { return element('span', 'badge ' + kind, text); }
  function banner(message, kind = 'error') {
    const node = element('div', 'notice notice-' + kind);
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.append(element('span', 'notice-symbol', kind === 'error' ? '!' : 'i'), element('p', '', message));
    if (kind === 'error') node.append(button('', 'button button-ghost why-close notice-close', () => {
      dismissedErrors.add(message);
      saveViewState();
      render();
      (root.querySelector('.notice-close') || root.querySelector('.filename-link'))?.focus({ preventScroll: true });
    }, {key: 'dismiss:' + message, label: 'Dismiss error message', title: 'Dismiss this message'}));
    return node;
  }
  function sourceLines(value) {
    if (!value) return [];
    const lines = value.replace(/\r\n|\r/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  function codeSide(side, kind, lineNumber, content, inlineChanges) {
    const cell = element('div', 'code-side ' + side + ' ' + kind);
    if (lineNumber !== null) cell.dataset.line = String(lineNumber);
    const number = element('span', 'line-number', lineNumber === null ? '' : lineNumber);
    const marker = element('span', 'line-marker', kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ');
    number.setAttribute('aria-hidden', 'true');
    marker.setAttribute('aria-hidden', 'true');
    const source = element('span', 'code-source');
    const code = element('span', 'code-text');
    if (kind === 'added' || kind === 'removed') {
      const valid = Array.isArray(inlineChanges)
        && inlineChanges.every(segment => segment && typeof segment.text === 'string' && typeof segment.changed === 'boolean')
        && inlineChanges.map(segment => segment.text).join('') === content;
      const segments = valid ? inlineChanges : [{ text: content, changed: true }];
      for (const segment of segments) code.append(element('span', segment.changed ? 'inline-changed' : 'inline-common', segment.text));
      if (!content) code.append(document.createTextNode('\u200b'));
    } else code.textContent = content || '\u200b';
    source.append(code);
    cell.append(number, marker, source);
    if (side === 'right') cell.append(element('span', 'action-gutter'));
    return cell;
  }
  function hunkControls(file, hunk, decision, busy) {
    const actions = element('div', 'inline-actions');
    const key = file.path + ':' + hunk.id;
    if (decision === 'pending') {
      actions.append(
        button('Accept', 'button button-accept button-inline',
          () => decide({ type: 'decide', filePath: file.path, hunkId: hunk.id, decision: 'accepted' }),
          { disabled: busy || !state.trusted || Boolean(file.issue), key: key + ':accept', hunk: hunk.id,
            label: 'Accept change ' + (hunk.index + 1), title: file.issue || 'Apply this change to the original file' }),
        button('Ignore', 'button button-secondary button-inline',
          () => decide({ type: 'decide', filePath: file.path, hunkId: hunk.id, decision: 'ignored' }),
          { disabled: busy || !state.trusted, key: key + ':ignore', hunk: hunk.id,
            label: 'Ignore change ' + (hunk.index + 1), title: 'Keep the original content for this change' })
      );
    } else {
      actions.append(badge(decision === 'accepted' ? '✓ Accepted' : 'Ignored', decision),
        button('Undo', 'button button-secondary button-inline',
          () => decide({ type: 'undo', filePath: file.path, hunkId: hunk.id }),
          { disabled: busy || !state.trusted || (decision === 'accepted' && Boolean(file.issue)),
            key: key + ':undo', hunk: hunk.id, label: 'Undo ' + decision + ' change ' + (hunk.index + 1),
            title: decision === 'accepted' && file.issue ? file.issue : 'Restore this change to pending review' }));
      return actions;
    }
    const hasExplanation = typeof hunk.explanation === 'string' && hunk.explanation.trim().length > 0;
    const why = button('Why', 'button button-ghost button-inline why-toggle', event => {
      event.stopPropagation();
      openWhy = openWhy === hunk.id ? null : hunk.id;
      saveViewState();
      render();
      if (openWhy) root.querySelector('.why-popover')?.focus({ preventScroll: true });
    }, { disabled: !hasExplanation || Boolean(editing), key: key + ':why', hunk: hunk.id,
      label: 'Why change ' + (hunk.index + 1),
      title: hasExplanation ? 'Show the explanation for this change' : 'No explanation provided' });
    why.dataset.whyId = hunk.id;
    why.setAttribute('aria-expanded', String(hasExplanation && openWhy === hunk.id));
    why.setAttribute('aria-controls', 'rr-explanation');
    actions.append(why);
    return actions;
  }
  function editorAnchor(edit) {
    const sources = Array.from(root.querySelectorAll('[data-edit-hunk]')).filter(node => node.dataset.editHunk === edit.hunkId);
    return sources.find(node => Number(node.dataset.editRow) === edit.anchorIndex) || sources[0];
  }
  function captureEditor() {
    const textarea = root.querySelector('.pending-editor textarea');
    if (!editing || !textarea) return;
    editing.draft = textarea.value;
    editing.selectionStart = textarea.selectionStart;
    editing.selectionEnd = textarea.selectionEnd;
    editing.scrollTop = textarea.scrollTop;
    editing.scrollLeft = textarea.scrollLeft;
  }
  function staleEditor() {
    if (!editing || !state || state.revision !== editing.revision) return true;
    const file = state.files.find(item => item.path === editing.filePath);
    return !file || !file.hunks.some(hunk => hunk.id === editing.hunkId && decisionOf(hunk) === 'pending');
  }
  function openEditor(file, hunk, rowIndex, columnOffset = 0) {
    if (editing) { root.querySelector('.pending-editor textarea')?.focus({ preventScroll: true }); return; }
    if (!state || state.busy || awaitingDecision || !state.trusted || decisionOf(hunk) !== 'pending') return;
    const draft = hunk.after.replace(/\r\n|\r/g, '\n');
    const offset = draft.split('\n').slice(0, rowIndex).reduce((sum, line) => sum + line.length + 1, 0) + columnOffset;
    openWhy = null;
    editing = { filePath: file.path, hunkId: hunk.id, revision: state.revision, draft,
      index: hunk.index, oldStart: hunk.oldStart, original: hunk.before, anchorIndex: rowIndex,
      selectionStart: Math.min(offset, draft.length), selectionEnd: Math.min(offset, draft.length),
      scrollTop: 0, scrollLeft: 0, saving: false, editId: null, error: null };
    saveViewState(); render();
    root.querySelector('.pending-editor textarea')?.focus({ preventScroll: true });
  }
  function cancelEditor() {
    if (!editing || editing.saving) return;
    const previous = editing; editing = null;
    saveViewState(); render();
    (editorAnchor(previous) || root.querySelector('.filename-link'))?.focus({ preventScroll: true });
  }
  function submitEditor() {
    if (!editing || editing.saving || !state || state.busy || awaitingDecision || !state.trusted) return;
    captureEditor();
    if (staleEditor()) { render(); return; }
    editing.saving = true; editing.error = null;
    editing.editId = 'edit-' + Date.now() + '-' + (++editSequence);
    dismissedErrors.clear(); saveViewState();
    const message = { type: 'editPending', filePath: editing.filePath, hunkId: editing.hunkId,
      draft: editing.draft, revision: editing.revision, editId: editing.editId };
    render(); post(message);
  }
  function sizeEditor() {
    const textarea = root.querySelector('.pending-editor textarea');
    if (!textarea) return;
    // Grow within the normal document flow; the paired original stretches with it.
    const scroll = root.querySelector('[data-scroll-area]');
    const previousTop = scroll?.scrollTop;
    textarea.style.height = '0px';
    textarea.style.height = textarea.scrollHeight + 'px';
    if (scroll && previousTop !== undefined) scroll.scrollTop = previousTop;
  }
  function renderEditorRow(leftText, leftStart, rightStart, inlineChanges) {
    const row = element('div', 'diff-row editing-row');
    row.dataset.pair = 'code';
    row.dataset.hunkRow = editing.hunkId;
    const original = element('div', 'editing-original');
    const originalLines = sourceLines(leftText);
    originalLines.forEach((line, index) => original.append(codeSide('left', 'removed', leftStart + index, line, inlineChanges?.[index]?.before)));
    if (!originalLines.length) original.append(codeSide('left', 'empty', null, ''));
    const editor = element('section', 'code-side right added pending-editor');
    editor.dataset.hunkId = editing.hunkId;
    editor.setAttribute('aria-label', 'Edit proposed change ' + (editing.index + 1));
    const number = element('span', 'line-number', rightStart || editing.oldStart || '');
    const marker = element('span', 'line-marker', '+');
    number.setAttribute('aria-hidden', 'true'); marker.setAttribute('aria-hidden', 'true');
    const content = element('div', 'pending-editor-content');
    const textarea = element('textarea', 'pending-editor-textarea');
    textarea.value = editing.draft; textarea.wrap = 'soft'; textarea.spellcheck = false; textarea.rows = 1;
    textarea.readOnly = Boolean(editing.saving); textarea.dataset.focusKey = 'edit:draft'; textarea.dataset.hunk = editing.hunkId;
    textarea.setAttribute('aria-label', 'Proposed text for change ' + (editing.index + 1));
    textarea.setAttribute('autocapitalize', 'off'); textarea.setAttribute('autocomplete', 'off');
    for (const event of ['input', 'select', 'click', 'keyup', 'scroll']) textarea.addEventListener(event, () => {
      captureEditor(); saveViewState();
      if (event === 'input') sizeEditor();
    });
    editor.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEditor(); }
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); submitEditor(); }
      else if (event.target === textarea && event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !textarea.readOnly) {
        event.preventDefault(); textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
        captureEditor(); saveViewState(); sizeEditor();
      }
    });
    content.append(textarea);
    const stale = staleEditor();
    const error = stale ? 'The request changed. Your draft is kept; cancel and reopen the change before saving.' : editing.error;
    if (error) { const notice = element('p', 'pending-editor-error', error); notice.setAttribute('role', 'alert'); content.append(notice); }
    const gutter = element('span', 'action-gutter');
    const actions = element('div', 'inline-actions pending-editor-actions');
    actions.append(button(editing.saving ? 'Saving…' : 'Save', 'button button-accept button-inline', submitEditor,
      {key: 'edit:save', disabled: editing.saving || state.busy || !state.trusted || stale, title: 'Save the proposal to the .rr request (Ctrl/Cmd+Enter)'}),
      button('Cancel', 'button button-secondary button-inline', cancelEditor, {key: 'edit:cancel', disabled: editing.saving}));
    gutter.append(actions); editor.append(number, marker, content, gutter); row.append(original, editor);
    textarea.setSelectionRange(Math.min(editing.selectionStart || 0, textarea.value.length), Math.min(editing.selectionEnd || 0, textarea.value.length));
    return row;
  }
  function clickedColumn(source, event) {
    // Keep the first caret near the actual click, including wrapped fragments.
    const caret = typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    if (!caret || !source.contains(caret.startContainer)) return 0;
    const prefix = document.createRange(); prefix.selectNodeContents(source); prefix.setEnd(caret.startContainer, caret.startOffset);
    return prefix.toString().replace(/\u200b/g, '').length;
  }
  function appendPairs(container, leftText, rightText, pending, cursor, controls) {
    const left = sourceLines(leftText);
    const right = sourceLines(rightText);
    const length = Math.max(left.length, right.length, controls && controls.decision !== 'pending' ? 1 : 0);
    for (let index = 0; index < length; index += 1) {
      const row = element('div', 'diff-row');
      row.dataset.pair = 'code';
      const hasLeft = index < left.length;
      const hasRight = index < right.length;
      const inline = pending && controls && Array.isArray(controls.hunk.inlineChanges)
        ? controls.hunk.inlineChanges[index] : undefined;
      const original = codeSide('left', hasLeft ? pending ? 'removed' : 'context' : 'empty',
        hasLeft ? cursor.left++ : null, hasLeft ? left[index] : '', inline && inline.before);
      const proposed = codeSide('right', hasRight ? pending ? 'added' : 'context' : 'empty',
        hasRight ? cursor.right++ : null, hasRight ? right[index] : '', inline && inline.after);
      if (pending && controls) {
        const source = proposed.querySelector('.code-source');
        source.tabIndex = index === 0 ? 0 : -1;
        source.classList.add('editable-source'); source.dataset.editHunk = controls.hunk.id; source.dataset.editRow = String(index);
        source.title = 'Click, Enter, or F2 to edit this proposed change in place';
        source.setAttribute('aria-disabled', String(controls.busy || !state.trusted));
        if (index === 0) {
          source.tabIndex = 0; source.dataset.focusKey = controls.file.path + ':' + controls.hunk.id + ':edit'; source.dataset.hunk = controls.hunk.id;
          source.setAttribute('role', 'button'); source.setAttribute('aria-label', 'Edit proposed text for change ' + (controls.hunk.index + 1));
        }
        source.addEventListener('click', event => { const column = clickedColumn(source, event); event.preventDefault(); openEditor(controls.file, controls.hunk, index, column); });
        source.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === 'F2' || event.key === ' ') { event.preventDefault(); openEditor(controls.file, controls.hunk, index); }
        });
      }
      if (index === 0 && controls) {
        row.dataset.hunkRow = controls.hunk.id;
        proposed.dataset.hunkId = controls.hunk.id;
        proposed.tabIndex = -1;
        proposed.querySelector('.action-gutter').append(
          hunkControls(controls.file, controls.hunk, controls.decision, controls.busy));
      }
      row.append(original, proposed);
      container.append(row);
    }
    return length;
  }
  function showClosedCurrent(documentView, currentText) {
    // Closed review results stay on the right. The left is the real saved file,
    // so external lines are shown exactly once even when its length has changed.
    const currentLines = currentText.replace(/\r\n|\r/g, '\n').split('\n');
    let maximumRightLine = 0;
    for (const row of documentView.querySelectorAll('.diff-row[data-pair="code"]')) {
      const right = row.children[1];
      const number = Number(right?.dataset.line);
      maximumRightLine = Math.max(maximumRightLine, Number.isFinite(number) ? number : 0);
      const exists = Number.isInteger(number) && number >= 1 && number <= currentLines.length;
      row.children[0].replaceWith(codeSide('left', 'context', exists ? number : null, exists ? currentLines[number - 1] : ''));
    }
    const eof = documentView.querySelector('.eof-row');
    for (let index = maximumRightLine; index < currentLines.length; index++) {
      const row = element('div', 'diff-row'); row.dataset.pair = 'code';
      row.append(codeSide('left', 'context', index + 1, currentLines[index]), codeSide('right', 'context', null, ''));
      documentView.insertBefore(row, eof);
    }
    const noNewline = currentText && !/[\r\n]$/.test(currentText);
    if (eof) eof.children[0].textContent = noNewline ? 'No newline at end of file' : '';
    else if (noNewline) {
      const note = element('div', 'diff-pair eof-row');
      note.append(element('div', 'eof-side left', 'No newline at end of file'), element('div', 'eof-side right', ''));
      documentView.append(note);
    }
  }
  function renderDocument(file, busy) {
    const documentView = element('div', 'paired-document');
    documentView.setAttribute('role', 'region');
    documentView.setAttribute('aria-label', 'Aligned original and proposed file');
    const before = typeof file.before === 'string' ? file.before : '';
    const hunks = [...file.hunks].sort((a, b) => a.start - b.start || a.index - b.index);
    const cursor = { offset: 0, left: 1, right: 1 };
    let projectedLeft = '';
    let projectedRight = '';
    for (const hunk of hunks) {
      const unchanged = before.slice(cursor.offset, hunk.start);
      appendPairs(documentView, unchanged, unchanged, false, cursor);
      projectedLeft += unchanged;
      projectedRight += unchanged;
      const decision = decisionOf(hunk);
      const leftText = decision === 'accepted' ? hunk.after : hunk.before;
      const rightText = decision === 'ignored' ? hunk.before : hunk.after;
      const block = element('section', 'hunk hunk-' + decision);
      block.setAttribute('aria-label', 'Change ' + (hunk.index + 1) + ', ' + decision);
      if (editing && decision === 'pending' && editing.filePath === file.path && editing.hunkId === hunk.id) {
        block.classList.add('hunk-editing');
        block.append(renderEditorRow(leftText, cursor.left, cursor.right, hunk.inlineChanges));
        cursor.left += sourceLines(leftText).length; cursor.right += sourceLines(rightText).length;
        documentView.append(block);
      } else if (appendPairs(block, leftText, rightText, decision === 'pending', cursor, {file, hunk, decision, busy})) {
        documentView.append(block);
      }
      projectedLeft += leftText;
      projectedRight += rightText;
      cursor.offset = hunk.end;
    }
    const tail = before.slice(cursor.offset);
    appendPairs(documentView, tail, tail, false, cursor);
    projectedLeft += tail;
    projectedRight += tail;
    const leftEnds = !projectedLeft || /[\r\n]$/.test(projectedLeft);
    const rightEnds = !projectedRight || /[\r\n]$/.test(projectedRight);
    if (leftEnds || rightEnds) {
      const row = element('div', 'diff-row');
      row.dataset.pair = 'code';
      row.append(
        codeSide('left', leftEnds ? 'context' : 'empty', leftEnds ? cursor.left : null, ''),
        codeSide('right', rightEnds ? 'context' : 'empty', rightEnds ? cursor.right : null, '')
      );
      documentView.append(row);
    }
    if ((!leftEnds && projectedLeft) || (!rightEnds && projectedRight)) {
      const eof = element('div', 'diff-pair eof-row');
      eof.append(element('div', 'eof-side left', leftEnds ? '' : 'No newline at end of file'),
        element('div', 'eof-side right', rightEnds ? '' : 'No newline at end of file'));
      documentView.append(eof);
    }
    if (state.closed === true && typeof file.currentText === 'string') showClosedCurrent(documentView, file.currentText);
    return documentView;
  }
  function whyAnchor(id) {
    return Array.from(root.querySelectorAll('[data-why-id]')).find(node => node.dataset.whyId === id);
  }
  function closeExplanation(focusAnchor = false) {
    const previous = openWhy;
    openWhy = null;
    saveViewState();
    const popover = root.querySelector('.why-popover');
    if (popover) popover.remove();
    const anchor = previous ? whyAnchor(previous) : null;
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      if (focusAnchor) anchor.focus({ preventScroll: true });
    }
  }
  function renderExplanation(app, file) {
    if (!openWhy || !file) return;
    const hunk = file.hunks.find(item => item.id === openWhy);
    const anchor = whyAnchor(openWhy);
    if (!hunk || typeof hunk.explanation !== 'string' || !hunk.explanation.trim() || !anchor) {
      openWhy = null;
      saveViewState();
      return;
    }
    const popover = element('section', 'why-popover');
    popover.id = 'rr-explanation';
    popover.tabIndex = -1;
    popover.dataset.focusKey = 'explanation';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Explanation for change ' + (hunk.index + 1));
    popover.setAttribute('aria-modal', 'false');
    const heading = element('div', 'why-popover-heading');
    heading.append(element('strong', '', 'Why'),
      button('', 'button button-ghost why-close', () => closeExplanation(true),
        { label: 'Close explanation', key: 'close:why', title: 'Close explanation (Escape)' }));
    popover.append(heading, element('p', 'explanation-copy', hunk.explanation));
    app.append(popover);
  }
  function positionExplanation() {
    if (!openWhy) return;
    const anchor = whyAnchor(openWhy);
    const popover = root.querySelector('.why-popover');
    const scroll = root.querySelector('[data-scroll-area]');
    if (!anchor || !popover || !scroll) return;
    const rect = anchor.getBoundingClientRect();
    const visible = scroll.getBoundingClientRect();
    if (rect.bottom <= visible.top || rect.top >= visible.bottom) {
      closeExplanation();
      return;
    }
    const width = Math.min(380, Math.max(190, window.innerWidth / 2 - 22));
    popover.style.width = width + 'px';
    popover.style.maxHeight = Math.min(260, Math.max(90, window.innerHeight - 24)) + 'px';
    popover.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)) + 'px';
    const height = popover.offsetHeight;
    const below = window.innerHeight - rect.bottom - 8;
    const top = below >= height || rect.top < height + 8
      ? Math.min(rect.bottom + 5, window.innerHeight - height - 8)
      : rect.top - height - 5;
    popover.style.top = Math.max(8, top) + 'px';
  }
  function resolveCompletion(deleteRequest, rememberChoice = completion?.rememberChoice === true) {
    if (!completion || completion.resolving) return;
    if (deleteRequest && (!state || state.busy || state.revision !== completion.revision)) return;
    const message = {type: 'resolveCompletion', completionId: completion.completionId, revision: completion.revision,
      deleteRequest, rememberChoice};
    completion.resolving = true; completion.error = null;
    render(); post(message);
  }
  function renderCompletion(app) {
    if (!completion) return;
    const overlay = element('div', 'completion-overlay');
    const dialog = element('section', 'completion-dialog');
    dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rr-completion-title');
    const heading = element('div', 'completion-heading');
    const title = element('h2', '', 'Delete this .rr file?'); title.id = 'rr-completion-title';
    heading.append(title, button('', 'button button-ghost why-close', () => resolveCompletion(false, false),
      {key: 'completion:close', disabled: completion.resolving, label: 'Keep this request and close', title: 'Keep this request (Escape)'}));
    dialog.append(heading, element('p', 'completion-request-name', completion.requestName));
    const stale = !state || state.revision !== completion.revision;
    const error = stale ? 'The request changed. Keep it and review its current contents before deleting.' : completion.error;
    if (error) { const notice = element('p', 'completion-error', error); notice.setAttribute('role', 'alert'); dialog.append(notice); }
    const footer = element('div', 'completion-footer');
    const label = element('label', 'completion-remember');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = completion.rememberChoice === true;
    checkbox.disabled = completion.resolving; checkbox.dataset.focusKey = 'completion:remember';
    checkbox.addEventListener('change', () => { completion.rememberChoice = checkbox.checked; });
    label.append(checkbox, element('span', '', 'Remember my choice and don’t ask again'));
    const actions = element('div', 'completion-actions');
    actions.append(button('Yes', 'button button-accept', () => resolveCompletion(true),
      {key: 'completion:yes', disabled: completion.resolving || stale || state.busy}),
      button('No', 'button button-secondary', () => resolveCompletion(false),
        {key: 'completion:no', disabled: completion.resolving}));
    footer.append(label, actions); dialog.append(footer); overlay.append(dialog); app.append(overlay);
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const targets = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
      if (!targets.length) { event.preventDefault(); return; }
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }
  function splitMetrics() {
    const comparison = root.querySelector('[data-scroll-area]');
    const app = root.querySelector('.review-app');
    if (!comparison || !app) return null;
    const available = comparison.clientWidth;
    if (available <= 0) return null;
    const css = getComputedStyle(root);
    const gutter = parseFloat(css.getPropertyValue('--rr-gutter')) || 66;
    const actions = parseFloat(css.getPropertyValue('--rr-action-gutter')) || 152;
    const summary = root.querySelector('.summary');
    let summaryWidth = 0;
    if (summary) {
      const style = getComputedStyle(summary);
      const badges = Array.from(summary.children);
      summaryWidth = badges.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
        + (parseFloat(style.columnGap) || 0) * Math.max(0, badges.length - 1)
        + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    }
    let minimumLeft = Math.max(160, gutter + 80);
    let minimumRight = Math.max(gutter + actions + 80, summaryWidth + actions);
    // Tiny windows cannot satisfy both ideals. Retain both panes proportionally.
    if (minimumLeft + minimumRight > available) {
      const scale = available / (minimumLeft + minimumRight);
      minimumLeft *= scale; minimumRight *= scale;
    }
    return { app, available, min: minimumLeft / available, max: 1 - minimumRight / available };
  }
  function applySplit() {
    const metrics = splitMetrics();
    if (!metrics) return;
    const ratio = Math.max(metrics.min, Math.min(metrics.max, splitRatio));
    root.style.setProperty('--rr-left-width', (ratio * 100) + '%');
    root.style.setProperty('--rr-divider-left', (metrics.available * ratio) + 'px');
    const separator = root.querySelector('.pane-splitter');
    if (separator) {
      separator.setAttribute('aria-valuemin', String(Math.round(metrics.min * 100)));
      separator.setAttribute('aria-valuemax', String(Math.round(metrics.max * 100)));
      separator.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      separator.setAttribute('aria-valuetext', 'Original ' + Math.round(ratio * 100) + '%, Revision ' + Math.round((1 - ratio) * 100) + '%');
    }
    sizeEditor(); positionExplanation();
  }
  function setSplitRatio(value, persist = true) {
    const metrics = splitMetrics();
    if (!metrics || !Number.isFinite(value)) return;
    if (persist) captureEditor();
    splitRatio = Math.max(metrics.min, Math.min(metrics.max, value));
    applySplit(); if (persist) saveViewState();
  }
  function endSplitDrag(cancelled = false, restoreFocus = true) {
    const drag = splitDrag;
    if (!drag) return;
    splitDrag = null;
    drag.app.classList.remove('resizing-panes');
    if (drag.node.hasPointerCapture?.(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
    if (cancelled) { splitRatio = drag.initialRatio; applySplit(); }
    saveViewState();
    if (restoreFocus && drag.previousFocus?.isConnected) {
      drag.previousFocus.focus({preventScroll: true});
    }
  }
  function renderSplitter(app) {
    const separator = element('div', 'pane-splitter');
    separator.tabIndex = completion ? -1 : 0; separator.dataset.focusKey = 'pane:splitter';
    separator.setAttribute('role', 'separator'); separator.setAttribute('aria-orientation', 'vertical');
    separator.setAttribute('aria-label', 'Resize original and revision panes');
    separator.setAttribute('aria-disabled', String(Boolean(completion)));
    separator.title = 'Drag to resize panes. Arrow keys adjust; double-click resets.';
    separator.addEventListener('pointerdown', event => {
      if (completion || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); captureEditor();
      const previousFocus = document.activeElement;
      separator.focus({preventScroll: true});
      splitDrag = {pointerId: event.pointerId, node: separator, app, initialRatio: splitRatio,
        previousFocus: previousFocus?.matches('.pending-editor textarea') ? previousFocus : separator};
      separator.setPointerCapture(event.pointerId);
      app.classList.add('resizing-panes');
    });
    separator.addEventListener('pointermove', event => {
      if (!splitDrag || splitDrag.pointerId !== event.pointerId) return;
      const metrics = splitMetrics();
      if (metrics) setSplitRatio((event.clientX - metrics.app.getBoundingClientRect().left) / metrics.available, false);
    });
    separator.addEventListener('pointerup', event => {
      if (splitDrag?.pointerId === event.pointerId) endSplitDrag();
    });
    separator.addEventListener('pointercancel', event => {
      if (splitDrag?.pointerId === event.pointerId) endSplitDrag(true);
    });
    separator.addEventListener('lostpointercapture', event => {
      if (splitDrag?.pointerId === event.pointerId) endSplitDrag(false, false);
    });
    separator.addEventListener('dblclick', event => {
      if (completion) return;
      event.preventDefault(); setSplitRatio(0.5);
    });
    separator.addEventListener('keydown', event => {
      if (completion) return;
      const metrics = splitMetrics(); if (!metrics) return;
      const current = Math.max(metrics.min, Math.min(metrics.max, splitRatio));
      const step = event.shiftKey ? 0.1 : 0.02;
      let next;
      if (event.key === 'ArrowLeft') next = current - step;
      else if (event.key === 'ArrowRight') next = current + step;
      else if (event.key === 'Home') next = metrics.min;
      else if (event.key === 'End') next = metrics.max;
      else if (event.key === 'Enter') next = 0.5;
      else return;
      event.preventDefault(); setSplitRatio(next);
    });
    app.append(separator);
  }
  function updateLayout() {
    const comparison = root.querySelector('[data-scroll-area]');
    if (comparison) root.style.setProperty('--rr-scrollbar-width', Math.max(0, comparison.offsetWidth - comparison.clientWidth) + 'px');
    const documentView = root.querySelector('.paired-document');
    if (documentView) {
      // Inline box height depends on the chosen editor font. Pad only to its
      // visual line box, so cloned highlights never spill onto the next wrap.
      const probe = element('span', 'inline-metric-probe', 'M');
      documentView.append(probe);
      const fontHeight = probe.getBoundingClientRect().height;
      const lineHeight = parseFloat(getComputedStyle(documentView).lineHeight);
      probe.remove();
      root.style.setProperty('--rr-inline-padding', Math.max(0, (lineHeight - fontHeight) / 2) + 'px');
    }
    applySplit();
  }
  function render() {
    if (!state) return;
    endSplitDrag(false, false);
    captureEditor();
    const previousScroll = root.querySelector('[data-scroll-area]');
    const scrollTop = previousScroll ? previousScroll.scrollTop : 0;
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset : {};
    const activeKey = active.focusKey;
    const activeHunk = active.hunk || active.hunkId;
    const files = Array.isArray(state.files) ? state.files : [];
    const file = files[0];
    const closed = state.closed === true;
    const totals = counts(file ? file.hunks : []);
    const busy = Boolean(state.busy || awaitingDecision || editing || completion);
    const rawOpacity = typeof state.unchangedOpacity === 'number' && Number.isFinite(state.unchangedOpacity) ? state.unchangedOpacity : 20;
    root.style.setProperty('--rr-context-opacity', String(Math.min(100, Math.max(0, rawOpacity)) / 100));
    const app = element('div', 'review-app');
    app.classList.toggle('is-closed', closed);
    app.classList.toggle('highlight-changed-lines', state.highlightChangedLines !== false);
    app.classList.toggle('show-only-changed-text', state.showOnlyChangedText === true);
    app.setAttribute('aria-busy', String(Boolean(state.busy || awaitingDecision || (editing && editing.saving) || (completion && completion.resolving))));
    if (file) {
      const header = element('div', 'comparison-header diff-pair');
      const original = element('section', 'pane-banner left');
      const filename = element('h1', 'pane-filename');
      filename.append(button(file.path, 'filename-link',
        () => post({ type: 'openTarget', filePath: file.path }),
        { key: file.path + ':original', title: 'Open original file' }));
      original.append(element('p', 'eyebrow', file.issue && !(closed && typeof file.currentText === 'string') ? 'REQUEST SNAPSHOT' : 'ORIGINAL'), filename);
      const proposed = element('section', 'pane-banner right');
      proposed.append(element('p', 'eyebrow', 'REVISION REQUEST'));
      const summaryRow = element('div', 'summary-row');
      const summary = element('div', 'summary');
      summary.setAttribute('role', 'status');
      summary.setAttribute('aria-live', 'polite');
      summary.append(badge(totals.pending + ' pending', 'pending'), badge(totals.accepted + ' accepted', 'accepted'), badge(totals.ignored + ' ignored', 'ignored'));
      summaryRow.append(summary);
      if (file.hunks.length) {
        const actions = element('div', 'file-actions');
        actions.append(
          button('Accept all', 'button button-accept button-inline',
            () => decide({ type: 'decideFile', filePath: file.path, decision: 'accepted' }),
            { disabled: busy || !state.trusted || Boolean(file.issue) || !totals.pending, key: file.path + ':acceptFile', title: 'Apply all pending changes to the original' }),
          button('Ignore all', 'button button-secondary button-inline',
            () => decide({ type: 'decideFile', filePath: file.path, decision: 'ignored' }),
            { disabled: busy || !state.trusted || !totals.pending, key: file.path + ':ignoreFile' })
        );
        summaryRow.append(actions);
      }
      proposed.append(summaryRow);
      header.append(original, proposed);
      app.append(header);
    }
    if (!state.trusted) app.append(banner('Trust this workspace to accept or ignore changes. You can still inspect this request.', 'info'));
    if (closed && file) app.append(banner('This revision request is closed.', 'info'));
    if (state.error && !dismissedErrors.has(state.error)) app.append(banner(state.error));
    if (file) {
      if (!closed && file.issue && file.issue !== state.error && !dismissedErrors.has(file.issue)) app.append(banner(file.issue));
      const content = element('main', 'comparison-scroll');
      content.dataset.scrollArea = 'true';
      content.setAttribute('aria-label', 'Original and proposed content of ' + file.path);
      content.addEventListener('scroll', positionExplanation);
      if (!file.hunks.length) content.append(element('p', 'unchanged-note', 'No changes proposed.'));
      content.append(renderDocument(file, busy));
      app.append(content);
    } else {
      const empty = element('main', 'empty-state');
      empty.append(element('span', 'empty-symbol', closed ? '✓' : state.error ? '!' : '≋'),
        element('h2', '', closed ? 'This revision request is closed.' : state.error ? 'This request could not be opened' : 'No file to review'),
        element('p', '', closed ? 'Open the .rr source to inspect this completed request.' : state.error ? 'Open the .rr source to check the request format.' : 'Add the original and proposed content to this request.'),
        button('Open RR as JSON', 'button button-secondary', () => post({ type: 'openSource' }), { key: 'empty:source' }),
        button('Delete this RR', 'button button-secondary', () => {
          if (state.busy || awaitingDecision) return;
          awaitingDecision = true; dismissedErrors.clear(); saveViewState(); render(); post({type: 'deleteRequest'});
        }, {key: 'empty:delete-request', disabled: state.busy || awaitingDecision,
          title: 'Delete this .rr request; the original file stays unchanged'}));
      app.append(empty);
    }
    if (editing && !app.querySelector('.pending-editor')) {
      // An external edit can remove the active hunk or even the request. Keep
      // its unsaved draft visible in flow instead of silently discarding it.
      let content = app.querySelector('[data-scroll-area]');
      if (!content) {
        content = element('main', 'comparison-scroll'); content.dataset.scrollArea = 'true';
        app.querySelector('.empty-state')?.remove(); app.append(content);
      }
      const fallback = element('section', 'paired-document pending-editor-fallback');
      fallback.setAttribute('aria-label', 'Unsaved proposal draft');
      fallback.append(renderEditorRow(file ? '' : editing.original || '', editing.oldStart || 1, editing.oldStart || 1));
      content.prepend(fallback);
    }
    if (file) renderSplitter(app);
    root.replaceChildren(app);
    const currentScroll = root.querySelector('[data-scroll-area]');
    if (currentScroll) currentScroll.scrollTop = scrollTop;
    renderExplanation(app, file); sizeEditor(); renderCompletion(app);
    let replacement = activeKey
      ? Array.from(root.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === activeKey && !node.disabled)
      : null;
    if (!replacement && activeHunk) {
      replacement = Array.from(root.querySelectorAll('button[data-hunk]')).find(node => node.dataset.hunk === activeHunk && !node.disabled)
        || Array.from(root.querySelectorAll('[data-hunk-id]')).find(node => node.dataset.hunkId === activeHunk);
    }
    if (replacement) replacement.focus({ preventScroll: true });
    const completionDialog = root.querySelector('.completion-dialog');
    if (completionDialog && !completionDialog.contains(document.activeElement)) {
      (root.querySelector('[data-focus-key="completion:no"]:not(:disabled)') || completionDialog).focus({preventScroll: true});
    }
    if (focusAfterEdit && (!focusAfterEdit.revision || state.revision === focusAfterEdit.revision)) {
      const focusFile = files.find(item => item.path === focusAfterEdit.filePath);
      const pending = focusFile?.hunks.filter(hunk => decisionOf(hunk) === 'pending') || [];
      const hunk = pending.find(item => item.oldStart === focusAfterEdit.oldStart) || pending.find(item => item.index === focusAfterEdit.index) || pending[0];
      const source = hunk ? editorAnchor({hunkId: hunk.id, anchorIndex: 0}) : null;
      (source || root.querySelector('.filename-link'))?.focus({preventScroll: true}); focusAfterEdit = null;
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(updateLayout);
    else updateLayout();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'completionPrompt') {
      if (typeof message.completionId !== 'string' || typeof message.revision !== 'string') return;
      if (completion?.completionId === message.completionId) return;
      completion = {completionId: message.completionId, revision: message.revision,
        requestName: typeof message.requestName === 'string' ? message.requestName : 'Revision request',
        resolving: false, rememberChoice: false, error: null};
      openWhy = null; saveViewState(); render();
      root.querySelector('[data-focus-key="completion:no"]')?.focus({preventScroll: true});
      return;
    }
    if (message.type === 'completionResult') {
      if (!completion || message.completionId !== completion.completionId || message.revision !== completion.revision) return;
      if (message.success === true) completion = null;
      else { completion.resolving = false; completion.error = typeof message.error === 'string' ? message.error : 'The request could not be deleted. It has been kept.'; }
      render();
      (root.querySelector('[data-focus-key="completion:no"]') || root.querySelector('.filename-link') || root.querySelector('[data-focus-key="empty:source"]'))?.focus({preventScroll: true});
      return;
    }
    if (message.type === 'editResult') {
      if (!editing || !editing.saving || message.editId !== editing.editId || message.filePath !== editing.filePath || message.hunkId !== editing.hunkId) return;
      captureEditor();
      if (message.success === true) {
        focusAfterEdit = {filePath: editing.filePath, oldStart: editing.oldStart, index: editing.index, revision: message.revision};
        editing = null;
      } else { editing.saving = false; editing.editId = null; editing.error = typeof message.error === 'string' ? message.error : 'The proposal could not be saved. Your draft is kept.'; }
      saveViewState(); render();
      if (editing) root.querySelector('.pending-editor textarea')?.focus({preventScroll: true});
      return;
    }
    if (message.type !== 'state') return;
    if (state && (message.revision !== state.revision || message.requestName !== state.requestName || (message.busy && !state.busy))) dismissedErrors.clear();
    if (state && message.error && message.error !== state.error) dismissedErrors.delete(message.error);
    const activeErrors = new Set([message.error, ...(Array.isArray(message.files) ? message.files.map(file => file.issue) : [])]);
    for (const error of dismissedErrors) if (!activeErrors.has(error)) dismissedErrors.delete(error);
    state = message;
    saveViewState();
    awaitingDecision = false;
    render();
  });
  window.addEventListener('pointerdown', event => {
    if (!openWhy) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('.why-popover, .why-toggle')) return;
    closeExplanation();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && splitDrag) { event.preventDefault(); endSplitDrag(true); return; }
    if (event.key === 'Escape' && completion) { event.preventDefault(); resolveCompletion(false, false); return; }
    if (event.key === 'Escape' && openWhy) {
      event.preventDefault();
      closeExplanation(true);
    }
  });
  window.addEventListener('blur', () => endSplitDrag(true, false));
  window.addEventListener('pagehide', () => endSplitDrag(false, false));
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateLayout).observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateLayout);
  post({ type: 'ready' });
})();
