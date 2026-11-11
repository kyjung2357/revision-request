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
  let state = null;
  let awaitingDecision = false;
  let leftScroll = 0;
  let rightScroll = 0;

  function saveViewState() { vscode.setState({ openWhy, dismissedErrors: [...dismissedErrors], editing: editing ? { ...editing, saving: false, editId: null } : null }); }
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
  function openEditor(file, hunk, rowIndex) {
    if (editing) { root.querySelector('.pending-editor textarea')?.focus({ preventScroll: true }); return; }
    if (!state || state.busy || awaitingDecision || !state.trusted || decisionOf(hunk) !== 'pending') return;
    const draft = hunk.after.replace(/\r\n|\r/g, '\n');
    const offset = draft.split('\n').slice(0, rowIndex).reduce((sum, line) => sum + line.length + 1, 0);
    openWhy = null;
    editing = { filePath: file.path, hunkId: hunk.id, revision: state.revision, draft,
      index: hunk.index, oldStart: hunk.oldStart, anchorIndex: rowIndex,
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
  function positionEditor() {
    if (!editing) return;
    const popup = root.querySelector('.pending-editor');
    const scroll = root.querySelector('[data-scroll-area]');
    if (!popup || !scroll) return;
    const source = editorAnchor(editing);
    const visible = scroll.getBoundingClientRect();
    const anchor = source ? source.getBoundingClientRect() : {right: innerWidth - 8, bottom: visible.top, top: visible.top};
    const width = Math.min(640, Math.max(280, innerWidth / 2 - 24), innerWidth - 16);
    popup.style.width = width + 'px'; popup.style.maxHeight = Math.max(180, innerHeight - 24) + 'px';
    popup.style.left = Math.max(8, innerWidth - width - 12) + 'px';
    const height = popup.offsetHeight;
    const below = anchor.bottom >= visible.top && anchor.top < visible.bottom ? anchor.bottom + 6 : visible.top + 6;
    const top = below + height <= innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6);
    popup.style.top = Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
  }
  function renderEditor(app) {
    if (!editing) return;
    const popup = element('section', 'pending-editor');
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-modal', 'false'); popup.setAttribute('aria-label', 'Edit proposed change');
    popup.append(element('strong', 'pending-editor-heading', 'Edit proposed change'));
    const textarea = element('textarea', 'pending-editor-textarea');
    textarea.value = editing.draft; textarea.wrap = 'off'; textarea.spellcheck = false;
    textarea.rows = Math.min(12, Math.max(4, editing.draft.split('\n').length));
    textarea.readOnly = Boolean(editing.saving); textarea.dataset.focusKey = 'edit:draft'; textarea.dataset.hunk = editing.hunkId;
    textarea.setAttribute('aria-label', 'Proposed text for change ' + (editing.index + 1));
    textarea.setAttribute('autocapitalize', 'off'); textarea.setAttribute('autocomplete', 'off');
    for (const event of ['input', 'select', 'click', 'keyup', 'scroll']) textarea.addEventListener(event, () => { captureEditor(); saveViewState(); });
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEditor(); }
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); submitEditor(); }
    });
    popup.append(textarea);
    const stale = staleEditor();
    const error = stale ? 'The request changed. Your draft is kept; cancel and reopen the change before saving.' : editing.error;
    if (error) { const notice = element('p', 'pending-editor-error', error); notice.setAttribute('role', 'alert'); popup.append(notice); }
    const actions = element('div', 'pending-editor-actions');
    actions.append(button('Cancel', 'button button-secondary', cancelEditor, {key: 'edit:cancel', disabled: editing.saving}),
      button(editing.saving ? 'Saving…' : 'Save', 'button button-accept', submitEditor,
        {key: 'edit:save', disabled: editing.saving || state.busy || !state.trusted || stale, title: 'Save the proposal to the .rr request (Ctrl/Cmd+Enter)'}));
    popup.append(actions); app.append(popup);
    textarea.setSelectionRange(Math.min(editing.selectionStart || 0, textarea.value.length), Math.min(editing.selectionEnd || 0, textarea.value.length));
    textarea.scrollTop = editing.scrollTop || 0; textarea.scrollLeft = editing.scrollLeft || 0;
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
        source.title = 'Double-click, Enter, or F2 to edit this proposed change';
        source.setAttribute('aria-haspopup', 'dialog'); source.setAttribute('aria-disabled', String(controls.busy || !state.trusted));
        if (index === 0) {
          source.tabIndex = 0; source.dataset.focusKey = controls.file.path + ':' + controls.hunk.id + ':edit'; source.dataset.hunk = controls.hunk.id;
          source.setAttribute('role', 'button'); source.setAttribute('aria-label', 'Edit proposed text for change ' + (controls.hunk.index + 1));
        }
        source.addEventListener('dblclick', event => { event.preventDefault(); openEditor(controls.file, controls.hunk, index); });
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
      if (appendPairs(block, leftText, rightText, decision === 'pending', cursor, {file, hunk, decision, busy})) {
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
  function syncHorizontalScroll(side, scroller) {
    if (side === 'left') leftScroll = scroller.scrollLeft;
    else rightScroll = scroller.scrollLeft;
    root.style.setProperty('--rr-' + side + '-scroll', -scroller.scrollLeft + 'px');
  }
  function scrollCodeHorizontally(event) {
    if (event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const cell = target && typeof target.closest === 'function' ? target.closest('.code-side') : null;
    if (!cell) return;
    // A horizontal trackpad gesture or Shift+wheel moves only the hovered pane.
    // Leave ordinary vertical wheel input to the shared comparison scroller.
    if (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const delta = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
    if (!delta) return;
    const side = cell.classList.contains('left') ? 'left' : 'right';
    const scroller = root.querySelector('[data-horizontal="' + side + '"]');
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    const scale = event.deltaMode === 1 ? parseFloat(getComputedStyle(cell).lineHeight) || 22
      : event.deltaMode === 2 ? scroller.clientWidth : 1;
    event.preventDefault();
    scroller.scrollLeft += delta * scale;
    syncHorizontalScroll(side, scroller);
  }
  function horizontalBars() {
    const bars = element('div', 'horizontal-bars diff-pair');
    for (const side of ['left', 'right']) {
      const slot = element('div', 'horizontal-slot ' + side);
      const scroller = element('div', 'horizontal-scroller');
      scroller.dataset.horizontal = side;
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', 'Scroll ' + (side === 'left' ? 'original' : 'proposed') + ' horizontally');
      scroller.append(element('div', 'horizontal-track'));
      scroller.title = 'Scroll ' + (side === 'left' ? 'original' : 'proposed') + ' horizontally (Shift+wheel or trackpad)';
      scroller.addEventListener('scroll', () => syncHorizontalScroll(side, scroller));
      slot.append(scroller);
      bars.append(slot);
    }
    return bars;
  }
  function updateHorizontalTracks() {
    const comparison = root.querySelector('[data-scroll-area]');
    if (comparison) root.style.setProperty('--rr-scrollbar-width', Math.max(0, comparison.offsetWidth - comparison.clientWidth) + 'px');
    for (const side of ['left', 'right']) {
      const scroller = root.querySelector('[data-horizontal="' + side + '"]');
      if (!scroller) continue;
      let width = scroller.clientWidth;
      for (const code of root.querySelectorAll('.code-side.' + side + ' .code-text')) width = Math.max(width, code.scrollWidth + 12);
      scroller.querySelector('.horizontal-track').style.width = width + 'px';
      scroller.scrollLeft = side === 'left' ? leftScroll : rightScroll;
      const actual = scroller.scrollLeft;
      if (side === 'left') leftScroll = actual;
      else rightScroll = actual;
      root.style.setProperty('--rr-' + side + '-scroll', -actual + 'px');
    }
    positionExplanation(); positionEditor();
  }
  function render() {
    if (!state) return;
    captureEditor();
    const previousScroll = root.querySelector('[data-scroll-area]');
    const scrollTop = previousScroll ? previousScroll.scrollTop : 0;
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset : {};
    const activeKey = active.focusKey;
    const activeHunk = active.hunk || active.hunkId;
    const files = Array.isArray(state.files) ? state.files : [];
    const file = files[0];
    const totals = counts(file ? file.hunks : []);
    const busy = Boolean(state.busy || awaitingDecision || editing);
    const rawOpacity = typeof state.unchangedOpacity === 'number' && Number.isFinite(state.unchangedOpacity) ? state.unchangedOpacity : 20;
    root.style.setProperty('--rr-context-opacity', String(Math.min(100, Math.max(0, rawOpacity)) / 100));
    root.style.setProperty('--rr-left-scroll', -leftScroll + 'px');
    root.style.setProperty('--rr-right-scroll', -rightScroll + 'px');
    const app = element('div', 'review-app');
    app.classList.toggle('highlight-changed-lines', state.highlightChangedLines !== false);
    app.classList.toggle('show-only-changed-text', state.showOnlyChangedText === true);
    app.setAttribute('aria-busy', String(Boolean(state.busy || awaitingDecision || (editing && editing.saving))));
    if (file) {
      const header = element('div', 'comparison-header diff-pair');
      const original = element('section', 'pane-banner left');
      const filename = element('h1', 'pane-filename');
      filename.append(button(file.path, 'filename-link',
        () => post({ type: 'openTarget', filePath: file.path }),
        { key: file.path + ':original', title: 'Open original file' }));
      original.append(element('p', 'eyebrow', file.issue ? 'REQUEST SNAPSHOT' : 'ORIGINAL'), filename);
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
    if (state.error && !dismissedErrors.has(state.error)) app.append(banner(state.error));
    if (file) {
      if (file.issue && file.issue !== state.error && !dismissedErrors.has(file.issue)) app.append(banner(file.issue));
      const content = element('main', 'comparison-scroll');
      content.dataset.scrollArea = 'true';
      content.setAttribute('aria-label', 'Original and proposed content of ' + file.path);
      content.addEventListener('scroll', () => { positionExplanation(); positionEditor(); });
      content.addEventListener('wheel', scrollCodeHorizontally, { passive: false });
      if (!file.hunks.length) content.append(element('p', 'unchanged-note', 'No changes proposed.'));
      content.append(renderDocument(file, busy));
      app.append(content, horizontalBars());
    } else {
      const empty = element('main', 'empty-state');
      empty.append(element('span', 'empty-symbol', state.error ? '!' : '≋'),
        element('h2', '', state.error ? 'This request could not be opened' : 'No file to review'),
        element('p', '', state.error ? 'Open the .rr source to check the request format.' : 'Add the original and proposed content to this request.'),
        button('Open RR as JSON', 'button button-secondary', () => post({ type: 'openSource' }), { key: 'empty:source' }));
      app.append(empty);
    }
    root.replaceChildren(app);
    const currentScroll = root.querySelector('[data-scroll-area]');
    if (currentScroll) currentScroll.scrollTop = scrollTop;
    renderExplanation(app, file); renderEditor(app);
    let replacement = activeKey
      ? Array.from(root.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === activeKey && !node.disabled)
      : null;
    if (!replacement && activeHunk) {
      replacement = Array.from(root.querySelectorAll('button[data-hunk]')).find(node => node.dataset.hunk === activeHunk && !node.disabled)
        || Array.from(root.querySelectorAll('[data-hunk-id]')).find(node => node.dataset.hunkId === activeHunk);
    }
    if (replacement) replacement.focus({ preventScroll: true });
    if (focusAfterEdit && (!focusAfterEdit.revision || state.revision === focusAfterEdit.revision)) {
      const focusFile = files.find(item => item.path === focusAfterEdit.filePath);
      const pending = focusFile?.hunks.filter(hunk => decisionOf(hunk) === 'pending') || [];
      const hunk = pending.find(item => item.oldStart === focusAfterEdit.oldStart) || pending.find(item => item.index === focusAfterEdit.index) || pending[0];
      const source = hunk ? editorAnchor({hunkId: hunk.id, anchorIndex: 0}) : null;
      (source || root.querySelector('.filename-link'))?.focus({preventScroll: true}); focusAfterEdit = null;
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(updateHorizontalTracks);
    else updateHorizontalTracks();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;
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
    if (event.key === 'Escape' && openWhy) {
      event.preventDefault();
      closeExplanation(true);
    }
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateHorizontalTracks).observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateHorizontalTracks);
  post({ type: 'ready' });
})();
