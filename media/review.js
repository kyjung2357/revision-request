/* global acquireVsCodeApi */
(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('app');
  const restored = vscode.getState() || {};
  let openWhy = typeof restored.openWhy === 'string' ? restored.openWhy : null;
  let openMenu = null;
  let menuSequence = 0;
  const dismissedErrors = new Set(Array.isArray(restored.dismissedErrors) ? restored.dismissedErrors.filter(message => typeof message === 'string') : []);
  const savedEdit = restored.editing;
  let editing = savedEdit && typeof savedEdit.filePath === 'string' && typeof savedEdit.hunkId === 'string'
    && typeof savedEdit.revision === 'string' && typeof savedEdit.draft === 'string'
    ? { ...savedEdit, saving: false, editId: null } : null;
  let editSequence = 0;
  let editHistory = { undo: [], redo: [] };
  let focusAfterEdit = null;
  let completion = null;
  let splitRatio = typeof restored.splitRatio === 'number' && Number.isFinite(restored.splitRatio) ? Math.max(0.05, Math.min(0.95, restored.splitRatio)) : 0.5;
  let splitDrag = null;
  let layout = restored.layout === 'unified' || restored.layout === 'sideBySide' ? restored.layout : null;
  let pendingLayoutToggle = false;
  let state = null;
  let awaitingDecision = false;
  let decisionFocus = null;
  let viewport = restored.viewport && Number.isFinite(restored.viewport.top) ? restored.viewport : {top: 0};
  // Opening a request always starts at its first pending change, not a saved scroll position.
  let firstChangeNavigationPending = true;
  let openingDecision = null;
  let openingChange = null;
  let viewRows = [];
  let overview = null;
  let scrollFrame = 0;
  let fontMetricKey = null;
  let contextRowCache = {path: null, before: null, rows: new Map()};


  // Session-local: reloading a preview never arms approval keys.
  let quickReview=false, quickSelection=null, quickPending=null, quickSequence=0;
  let pendingQuickMode=null, quickFocusRequested=false, quickScrollRequested=false, quickRendering=false;
  function quickCandidates() {
    return (state?.files || []).flatMap(file=>file.hunks.filter(hunk=>decisionOf(hunk)==='pending')
      .map(hunk=>({filePath:file.path,hunkId:hunk.id,index:hunk.index,oldStart:hunk.oldStart})));
  }
  function matchesQuickDecision(message, pending) {
    return Boolean(pending && message.quickDecisionId === pending.id && message.hunkId === pending.hunkId &&
      message.filePath === pending.filePath && message.decision === pending.decision);
  }
  function quickAllowed() {
    return Boolean(state?.trusted && !state.closed && quickCandidates().length && !state.files.some(file=>file.issue));
  }
  function quickPaused() {return Boolean(editing || openMenu || openWhy || completion || splitDrag);}
  function quickControl(selection=quickSelection) {
    return selection?root.querySelector('button[data-hunk="'+CSS.escape(selection.hunkId)+'"][data-quick-decision="'+selection.decision+'"]'):null;
  }
  function chooseVisibleQuickCandidate() {
    const candidates=quickCandidates(), scroll=root.querySelector('[data-scroll-area]');
    if (!scroll) return candidates[0];
    const visible=scroll.getBoundingClientRect();
    let nearest=null,distance=Infinity;
    const blocks=new Map(Array.from(root.querySelectorAll('[data-overview-hunk]'),node=>[node.dataset.overviewHunk,node]));
    for (const item of candidates) {
      const block=blocks.get(item.hunkId);
      if (!block) continue;
      const rect=block.getBoundingClientRect();
      if (rect.bottom>visible.top && rect.top<visible.bottom) return item;
      const gap=rect.top>=visible.bottom?rect.top-visible.bottom:visible.top-rect.bottom;
      if (gap<distance) {nearest=item;distance=gap;}
    }
    return nearest || candidates[0];
  }
  function setQuickReview(enabled) {
    if (!state) {pendingQuickMode=Boolean(enabled);return;}
    quickReview=Boolean(enabled && quickAllowed() && !editing && !completion && !state.busy && !awaitingDecision);
    post({type:'quickReviewState',enabled:quickReview});
    if (quickReview) {
      closeActionMenu();closeExplanation();
      const item=chooseVisibleQuickCandidate();
      quickSelection=item?{...item,decision:'accepted'}:null;
      quickFocusRequested=true;
      const scroll=root.querySelector('[data-scroll-area]');
      quickScrollRequested=!(openingChange?.hunkId===item?.hunkId && scroll && Math.abs(scroll.scrollTop-openingChange.top)<1);
      openingChange=null;
    } else {quickSelection=null;quickPending=null;quickFocusRequested=false;quickScrollRequested=false;}
    render();
  }
  function updateQuickPresentation() {
    root.querySelector('.review-app')?.classList.toggle('quick-review-active',quickReview);
    root.querySelector('.review-app')?.classList.toggle('quick-review-suspended',quickPaused());
    const selected=quickReview && !quickPaused()?quickControl():null;
    for (const node of root.querySelectorAll('.quick-review-selected')) {
      if (node!==selected) {node.classList.remove('quick-review-selected');node.removeAttribute('aria-current');}
    }
    if (selected) {selected.classList.add('quick-review-selected');selected.setAttribute('aria-current','true');}
    for (const control of root.querySelectorAll('.quick-review-toggle')) {
      control.setAttribute('aria-pressed',String(quickReview));control.classList.toggle('is-active',quickReview);
      control.setAttribute('aria-label',quickReview?'Disable Quick Review':'Enable Quick Review');
      control.title=quickReview?'Disable Quick Review (Escape)':'Enable Quick Review: Left/Right switches Accept and Ignore; Tab confirms';
    }
  }
  function focusQuickSelection(scrollIntoView=false) {
    updateQuickPresentation();
    if (!quickReview || quickPaused() || state?.busy || awaitingDecision) return;
    const control=quickControl();if (!control || control.disabled) return;
    if (scrollIntoView) {
      const scroll=root.querySelector('[data-scroll-area]');
      if (scroll) {
        const view=scroll.getBoundingClientRect(),controlRect=control.getBoundingClientRect();
        const block=control.closest('[data-overview-hunk]'),blockRect=block?.getBoundingClientRect();
        if (blockRect && blockRect.height<=view.height-16) {
          if (blockRect.top<view.top+8) scroll.scrollTop+=blockRect.top-view.top-8;
          else if (blockRect.bottom>view.bottom-8) scroll.scrollTop+=blockRect.bottom-view.bottom+8;
        } else if (blockRect && blockRect.height>view.height-16) {
          // A large unified hunk cannot show both versions at once; begin at its proposed action row.
          scroll.scrollTop+=controlRect.top-view.top-8;
        } else {
          if (controlRect.top<view.top+8) scroll.scrollTop+=controlRect.top-view.top-8;
          else if (controlRect.bottom>view.bottom-8) scroll.scrollTop+=controlRect.bottom-view.bottom+8;
        }
        onComparisonScroll();
      }
    }
    control.focus({preventScroll:true});quickFocusRequested=false;quickScrollRequested=false;
  }
  function reconcileQuickReview() {
    if (!quickReview) return;
    if (!quickAllowed()) {
      quickReview=false;quickSelection=null;quickPending=null;quickFocusRequested=false;quickScrollRequested=false;
      post({type:'quickReviewState',enabled:false});return;
    }
    const candidates=quickCandidates();
    if (quickPending) {
      if (quickPending.success!==true) return;
      const resolved=(state.files || []).flatMap(file=>file.hunks).find(hunk=>hunk.id===quickPending.hunkId);
      if (resolved && decisionOf(resolved)==='pending') return;
      if (!resolved && state.revision===quickPending.revision) return;
      const order=quickPending.order,at=order.indexOf(quickPending.hunkId),byId=new Map(candidates.map(item=>[item.hunkId,item]));
      const next=order.slice(at+1).concat(order.slice(0,at)).map(id=>byId.get(id)).find(Boolean) ||
        candidates.find(item=>item.index>=quickPending.index) || candidates[0];
      quickSelection=next?{...next,decision:'accepted'}:null;quickPending=null;
      quickFocusRequested=true;quickScrollRequested=true;return;
    }
    if (!candidates.some(item=>item.hunkId===quickSelection?.hunkId && item.filePath===quickSelection?.filePath)) {
      const next=candidates.find(item=>item.index>=(quickSelection?.index ?? 0)) || candidates[0];
      quickSelection=next?{...next,decision:'accepted'}:null;
      // External edits may reconcile selection, but never execute or force scrolling.
    }
  }
  function quickReviewButton(disabled) {
    const control=button('','button button-secondary quick-review-toggle',()=>setQuickReview(!quickReview),
      {disabled,key:'quick-review',label:quickReview?'Disable Quick Review':'Enable Quick Review'});
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('viewBox','0 0 16 16');icon.setAttribute('aria-hidden','true');icon.classList.add('quick-review-icon');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M9.5 1.5 3.5 9h4l-1 5.5 6-7.5h-4l1-5.5Z');
    icon.append(path);control.append(icon,element('span','','Quick Review'));
    control.setAttribute('aria-pressed',String(quickReview));return control;
  }

  function saveViewState() { vscode.setState({ requestUri: root.dataset.requestUri || restored.requestUri, openWhy, splitRatio, ...(layout ? {layout} : {}), viewport, dismissedErrors: [...dismissedErrors], editing: editing ? { ...editing, saving: false, editId: null } : null }); }
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
    if (!state || state.busy || awaitingDecision || quickPending || editing) return;
    message.revision = state.revision;
    if (quickReview && message.type==='decide') {
      const item=quickCandidates().find(candidate=>candidate.hunkId===message.hunkId && candidate.filePath===message.filePath);
      if (!item) return;
      quickSelection={...item,decision:message.decision};
      quickPending={...item,decision:message.decision,revision:state.revision,success:null,
        order:quickCandidates().map(candidate=>candidate.hunkId),id:'quick-'+Date.now()+'-'+(++quickSequence)};
      message.quickDecisionId=quickPending.id;updateQuickPresentation();
    }
    awaitingDecision = true;
    dismissedErrors.clear();
    if (message.type === 'decideFile' || message.hunkId === openWhy) openWhy = null;
    closeActionMenu();
    saveViewState();
    lockReviewControls();
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
      for (const segment of segments) {
        const span = element('span', segment.changed ? 'inline-changed' : 'inline-common');
        // Keep glyph painting independent of the highlight's fractional padding.
        if (segment.changed) span.append(element('span', 'inline-glyph', segment.text));
        else span.textContent = segment.text;
        code.append(span);
      }
      if (!content) code.append(document.createTextNode('\u200b'));
    } else code.textContent = content || '\u200b';
    source.append(code);
    cell.append(number, marker, source);
    if (side === 'right') cell.append(element('span', 'action-gutter'));
    return cell;
  }
  function hunkControls(file, hunk, decision, busy, editor = false) {
    const actions = element('div', 'inline-actions');
    const key = editor ? 'edit' : file.path + ':' + hunk.id;
    if (decision === 'pending') {
      actions.append(
        button('Accept', 'button button-accept button-inline',
          editor ? submitEditor : () => decide({ type: 'decide', filePath: file.path, hunkId: hunk.id, decision: 'accepted' }),
          { disabled: busy || !state.trusted || Boolean(file.issue), key: key + ':accept', hunk: hunk.id,
            label: 'Accept change ' + (hunk.index + 1), title: file.issue || (editor ? 'Apply this edited change to the original file' + editorShortcutHint() : 'Apply this change to the original file') }),
        button('Ignore', 'button button-secondary button-inline',
          editor ? ignoreEditor : () => decide({ type: 'decide', filePath: file.path, hunkId: hunk.id, decision: 'ignored' }),
          { disabled: busy || !state.trusted, key: key + ':ignore', hunk: hunk.id,
            label: 'Ignore change ' + (hunk.index + 1), title: editor ? 'Discard the draft and ignore this change' : 'Keep the original content for this change' })
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
    if (!editor) {
      for (const [index, decision] of ['accepted','ignored'].entries()) {
        const control=actions.children[index];control.dataset.quickDecision=decision;
        control.addEventListener('focus',()=>{
          if (!quickReview || quickPending || quickPaused() || quickRendering) return;
          quickSelection={filePath:file.path,hunkId:hunk.id,index:hunk.index,oldStart:hunk.oldStart,decision};
          updateQuickPresentation();
        });
      }
    }
    const more = button('⋯', 'button button-ghost button-inline why-toggle review-menu-toggle', event => {
      event.stopPropagation(); toggleActionMenu(file, hunk);
    }, { disabled: busy || (editor ? editing.saving : Boolean(editing)), key: key + ':why', hunk: hunk.id,
      label: 'More actions for change ' + (hunk.index + 1), title: 'More actions' });
    more.dataset.whyId = hunk.id;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(openMenu?.hunkId === hunk.id));
    more.setAttribute('aria-controls', 'rr-actions');
    more.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!openMenu) toggleActionMenu(file, hunk); focusMenuItem(event.key === 'ArrowUp'); }
    });
    actions.append(more);
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
    editing.selectionDirection = textarea.selectionDirection;
    editing.scrollTop = textarea.scrollTop;
    editing.scrollLeft = textarea.scrollLeft;
  }
  function staleEditor() {
    if (!editing || !state || state.revision !== editing.revision) return true;
    const file = state.files.find(item => item.path === editing.filePath);
    return !file || !file.hunks.some(hunk => hunk.id === editing.hunkId && decisionOf(hunk) === 'pending');
  }
  function openEditor(file, hunk, rowIndex, columnOffset = 0, directInput = null) {
    if (editing) { root.querySelector('.pending-editor textarea')?.focus({ preventScroll: true }); return; }
    if (!state || state.busy || awaitingDecision || quickPending || !state.trusted || decisionOf(hunk) !== 'pending') return;
    if (quickReview && quickSelection?.hunkId!==hunk.id) quickSelection={filePath:file.path,hunkId:hunk.id,index:hunk.index,oldStart:hunk.oldStart,decision:'accepted'};
    const draft = hunk.draftAfter ?? hunk.after.replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
    const offset = draft.split('\n').slice(0, rowIndex).reduce((sum, line) => sum + line.length + 1, 0) + columnOffset;
    openWhy = null; closeActionMenu();
    editHistory = { undo: [], redo: [] };
    editing = { filePath: file.path, hunkId: hunk.id, revision: state.revision, draft,
      hadProposedLine: hunk.newLines > 0, rightStart: Number(directInput?.closest('.code-side').dataset.proposedLine) || hunk.oldStart,
      index: hunk.index, oldStart: hunk.oldStart, original: hunk.before, anchorIndex: rowIndex,
      selectionStart: Math.min(offset, draft.length), selectionEnd: Math.min(offset, draft.length),
      scrollTop: 0, scrollLeft: 0, saving: false, editId: null, error: null };
    if (directInput) {
      // Keep the native textarea and browser selection alive on the first click.
      const cell = directInput.closest('.code-side');
      cell.classList.add('pending-editor');
      cell.setAttribute('aria-label', 'Edit proposed change ' + (hunk.index + 1));
      cell.closest('.hunk').classList.add('hunk-editing');
      cell.closest('.diff-row').classList.add('editing-row');
      directInput.dataset.focusKey = 'edit:draft';
      root.querySelector('.why-popover')?.remove();
      cell.querySelector('.action-gutter').replaceChildren(editorActions());
      for (const control of root.querySelectorAll('.inline-actions button,.file-actions button')) {
        if (!control.dataset.focusKey?.startsWith('edit:')) control.disabled = true;
      }
      for (const input of root.querySelectorAll('.direct-editor-input')) {
        if (input !== directInput) input.readOnly = true;
      }
      captureEditor(); saveViewState(); sizeEditor(); updateQuickPresentation();
      return;
    }
    saveViewState(); render();
    root.querySelector('.pending-editor textarea')?.focus({ preventScroll: true });
  }
  function cancelEditor() {
    if (!editing || editing.saving) return;
    const previous = editing; editing = null;
    editHistory = { undo: [], redo: [] };
    saveViewState(); render();
    if (quickReview) focusQuickSelection();
    else (editorAnchor(previous) || root.querySelector('.filename-link'))?.focus({ preventScroll: true });
  }
  function editorAcceptSetting() {
    const value = state?.acceptShortcut;
    return ['ctrlEnter','altEnter','tab','shiftTab','none'].includes(value) ? value : 'ctrlEnter';
  }
  function editorShortcutHint() {
    const labels = {ctrlEnter:'Ctrl/Cmd+Enter',altEnter:'Alt+Enter',tab:'Tab',shiftTab:'Shift+Tab'};
    const label = labels[editorAcceptSetting()];
    return label ? ' (' + label + ')' : '';
  }
  function matchesEditorAcceptShortcut(event) {
    const key = editorAcceptSetting();
    if (key === 'ctrlEnter') return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
    if (key === 'altEnter') return event.key === 'Enter' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (key === 'tab' || key === 'shiftTab') return event.key === 'Tab' && event.shiftKey === (key === 'shiftTab') && !event.ctrlKey && !event.metaKey && !event.altKey;
    return false;
  }
  function ignoreEditor() { submitEditorDecision('ignoreEdited'); }
  function submitEditor() { submitEditorDecision('editAndAccept'); }
  function submitEditorDecision(type) {
    if (!editing || editing.saving || !state || state.busy || awaitingDecision || !state.trusted) return;
    captureEditor();
    if (staleEditor() || (type === 'editAndAccept' && state.files.find(file => file.path === editing.filePath)?.issue)) { render(); return; }
    editing.saving = true; editing.error = null;
    editing.editId = 'edit-' + Date.now() + '-' + (++editSequence);
    dismissedErrors.clear(); openWhy = null; closeActionMenu(); saveViewState();
    const message = {type, filePath:editing.filePath, hunkId:editing.hunkId,
      ...(type === 'editAndAccept' ? {draft:editing.draft} : {}), revision:editing.revision, editId:editing.editId};
    render(); post(message);
  }
  function editorActions() {
    const file = state.files.find(item => item.path === editing.filePath) || {path:editing.filePath};
    const hunk = file.hunks?.find(item => item.id === editing.hunkId) || {id:editing.hunkId,index:editing.index};
    const actions = hunkControls(file,hunk,'pending',editing.saving || state.busy || awaitingDecision || staleEditor(),true);
    actions.classList.add('pending-editor-actions');
    actions.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEditor(); }
    });
    return actions;
  }
  function editorSelections(area) {
    const primary = {start: area.selectionStart, end: area.selectionEnd, direction: area.selectionDirection};
    const length = area.value.length, ranges = [primary];
    for (const item of editing?.secondarySelections || []) {
      if (Number.isInteger(item.start) && Number.isInteger(item.end)) ranges.push({
        start: Math.max(0, Math.min(length, item.start)), end: Math.max(0, Math.min(length, item.end)), direction: item.direction || 'none'});
    }
    // Overlapping selections are one edit, including duplicate Alt-clicks.
    const sorted = ranges.map((item, index) => ({...item, primary: index === 0})).sort((a,b) => a.start-b.start || a.end-b.end);
    const merged = [];
    for (const range of sorted) {
      const last = merged.at(-1);
      if (last && (range.start < last.end || (range.start === last.start && range.end === last.end))) {
        last.end = Math.max(last.end, range.end); last.primary ||= range.primary;
      } else merged.push(range);
    }
    const first = merged.find(item => item.primary);
    return [first, ...merged.filter(item => item !== first)].map(({start,end,direction}) => ({start,end,direction}));
  }
  function setEditorSelections(area, selections) {
    const [primary, ...secondary] = selections;
    area.setSelectionRange(primary.start, primary.end, primary.direction || 'none');
    editing.secondarySelections = secondary;
  }
  function editorSnapshot(area) { return {value: area.value, selections: editorSelections(area)}; }
  function recordEditorUndo(snapshot) {
    editHistory.undo.push(snapshot); editHistory.redo = [];
    let size = editHistory.undo.reduce((sum,item) => sum+item.value.length, 0);
    while (editHistory.undo.length > 1 && (size > 5 * 1024 * 1024 || editHistory.undo.length > 100)) size -= editHistory.undo.shift().value.length;
  }
  function updateEditor(area) {
    captureEditor(); saveViewState(); sizeEditor();
  }
  function editorUndo(area, redo) {
    const from = redo ? editHistory.redo : editHistory.undo, to = redo ? editHistory.undo : editHistory.redo;
    const next = from.pop(); if (!next) return;
    to.push(editorSnapshot(area)); area.value = next.value; setEditorSelections(area, next.selections); updateEditor(area);
  }
  function adjacentTextOffset(text, position, forward, word = false) {
    const segments = new Intl.Segmenter(undefined, {granularity: word ? 'word' : 'grapheme'}).segment(text);
    if (forward) {
      for (const segment of segments) if (segment.index + segment.segment.length > position && (!word || segment.isWordLike || /\S/u.test(segment.segment))) return segment.index+segment.segment.length;
      return text.length;
    }
    let offset = 0;
    for (const segment of segments) {
      if (segment.index >= position) break;
      if (!word || segment.isWordLike || /\S/u.test(segment.segment)) offset = segment.index;
    }
    return offset;
  }
  function applyEditorInput(area, inputType, inserted = '') {
    if (area.readOnly) return;
    const before = editorSnapshot(area), text = area.value;
    const operations = before.selections.map((selection,index) => {
      let {start,end} = selection;
      if (start === end && /Backward$/.test(inputType)) start = adjacentTextOffset(text,start,false,inputType.includes('Word'));
      if (start === end && /Forward$/.test(inputType)) end = adjacentTextOffset(text,end,true,inputType.includes('Word'));
      return {start,end,index};
    }).sort((a,b) => a.start-b.start || a.end-b.end);
    // Deletion ranges can meet after expansion; merge them before replacing.
    const merged = [];
    for (const operation of operations) {
      const previous = merged.at(-1);
      if (previous && operation.start < previous.end) {previous.end = Math.max(previous.end,operation.end); previous.indices.push(operation.index);}
      else merged.push({...operation,indices:[operation.index]});
    }
    let result = '', previousEnd = 0;
    const selections = [];
    for (const operation of merged) {
      result += text.slice(previousEnd,operation.start) + inserted;
      for (const index of operation.indices) selections[index] = {start:result.length,end:result.length,direction:'none'};
      previousEnd = operation.end;
    }
    result += text.slice(previousEnd);
    if (result !== text) recordEditorUndo(before);
    area.value = result; setEditorSelections(area,selections);
    setEditorSelections(area,editorSelections(area)); updateEditor(area);
  }
  function mirrorRange(area, start, end = start) {
    const mirror = area.parentElement.querySelector('.code-text'), walker = document.createTreeWalker(mirror,NodeFilter.SHOW_TEXT);
    const range = document.createRange(); let offset = 0, first = false, last;
    while (walker.nextNode()) {
      const node = walker.currentNode, length = node.textContent.length; last = node;
      if (!first && start <= offset+length) {range.setStart(node,Math.max(0,start-offset)); first = true;}
      if (first && end <= offset+length) {range.setEnd(node,Math.max(0,end-offset)); return range;}
      offset += length;
    }
    if (!last) return null;
    if (!first) range.setStart(last,last.textContent.length);
    range.setEnd(last,last.textContent.length); return range;
  }
  function caretRectangle(area, position) {
    const rect = mirrorRange(area,position)?.getClientRects()[0];
    if (rect && rect.height) return rect;
    const previous = mirrorRange(area,Math.max(0,position-1),position)?.getBoundingClientRect();
    return previous && {x:previous.right,y:previous.y,width:0,height:previous.height};
  }
  function editorOffsetAtPoint(area, x, y) {
    const mirror = area.parentElement.querySelector('.code-text');
    const previous = area.style.pointerEvents; area.style.pointerEvents = 'none';
    const caret = document.caretRangeFromPoint?.(x,y); area.style.pointerEvents = previous;
    if (!caret || !mirror.contains(caret.startContainer)) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(mirror); prefix.setEnd(caret.startContainer,caret.startOffset);
    return Math.min(area.value.length,prefix.toString().length);
  }
  function drawEditorSelections(area) {
    if (!area || !editing || area.dataset.hunk !== editing.hunkId) return;
    let layer = area.parentElement.querySelector('.editor-extra-selections');
    if (!layer) {layer = element('span','editor-extra-selections'); layer.setAttribute('aria-hidden','true'); area.parentElement.append(layer);}
    layer.replaceChildren();
    const selections = editorSelections(area); area.dataset.cursorCount = String(selections.length);
    area.setAttribute('aria-description',selections.length > 1 ? selections.length+' cursors. Escape returns to one cursor.' : 'Alt+click to add a cursor within this change.');
    if (area.dataset.composing === 'true') return;
    const origin = area.parentElement.getBoundingClientRect();
    for (const selection of selections.slice(1)) {
      const rects = selection.start === selection.end ? [caretRectangle(area,selection.start)] : [...(mirrorRange(area,selection.start,selection.end)?.getClientRects() || [])];
      for (const rect of rects) {
        if (!rect?.height) continue;
        const marker = element('span',selection.start === selection.end ? 'editor-extra-caret' : 'editor-extra-selection');
        marker.style.left = (rect.x-origin.x)+'px'; marker.style.top = (rect.y-origin.y)+'px';
        marker.style.height = rect.height+'px'; if (selection.start !== selection.end) marker.style.width = rect.width+'px';
        layer.append(marker);
      }
    }
  }
  function moveEditorSelections(area, event) {
    const text = area.value, word = event.ctrlKey || event.altKey;
    const selections = editorSelections(area).map(selection => {
      const backward = selection.direction === 'backward';
      const anchor = backward ? selection.end : selection.start, head = backward ? selection.start : selection.end;
      let position = head;
      if (!event.shiftKey && selection.start !== selection.end && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) position = event.key === 'ArrowLeft' ? selection.start : selection.end;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') position = adjacentTextOffset(text,head,event.key === 'ArrowRight',word);
      else if (event.key === 'Home') position = event.ctrlKey || event.metaKey ? 0 : head === 0 ? 0 : text.lastIndexOf('\n',head-1)+1;
      else if (event.key === 'End') {const end = text.indexOf('\n',head); position = event.ctrlKey || event.metaKey || end === -1 ? text.length : end;}
      else {
        const rect = caretRectangle(area,head), direction = event.key === 'ArrowUp' ? -1 : 1;
        const lineHeight = parseFloat(getComputedStyle(area).lineHeight);
        position = rect ? editorOffsetAtPoint(area,rect.x+0.1,rect.y+rect.height/2+direction*lineHeight) : null;
        if (position === null) position = direction < 0 ? 0 : text.length;
      }
      return event.shiftKey ? {start:Math.min(anchor,position),end:Math.max(anchor,position),direction:position<anchor?'backward':'forward'} : {start:position,end:position,direction:'none'};
    });
    setEditorSelections(area,selections); setEditorSelections(area,editorSelections(area)); updateEditor(area);
  }
  function editorInput(value, hunkId, index) {
    const textarea = element('textarea', 'pending-editor-textarea');
    textarea.value = value; textarea.wrap = 'soft'; textarea.spellcheck = false; textarea.rows = 1;
    textarea.dataset.hunk = hunkId;
    textarea.setAttribute('aria-label', 'Proposed text for change ' + (index + 1));
    textarea.setAttribute('autocapitalize', 'off'); textarea.setAttribute('autocomplete', 'off');
    textarea.title = 'Alt+click to add a cursor within this change';
    let pendingInput = null, composition = null;
    const active = () => editing && editing.hunkId === hunkId;
    textarea.addEventListener('pointerdown', event => {
      if (!active() || textarea.readOnly || event.button !== 0 || composition) return;
      if (event.altKey) {
        const offset = editorOffsetAtPoint(textarea,event.clientX,event.clientY);
        if (offset === null) return;
        event.preventDefault(); textarea.focus({preventScroll:true});
        const previous = editorSelections(textarea);
        setEditorSelections(textarea,[{start:offset,end:offset,direction:'none'},...previous]);
        setEditorSelections(textarea,editorSelections(textarea)); updateEditor(textarea);
      } else { editing.secondarySelections = []; drawEditorSelections(textarea); }
    });
    for (const event of ['select', 'click', 'keyup', 'scroll']) textarea.addEventListener(event, () => {
      if (!active()) return;
      captureEditor(); saveViewState(); drawEditorSelections(textarea);
    });
    textarea.addEventListener('beforeinput', event => {
      if (!active() || textarea.readOnly || composition || event.isComposing) return;
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault(); editorUndo(textarea,event.inputType === 'historyRedo'); return;
      }
      if (editorSelections(textarea).length > 1 && !event.cancelable) editing.secondarySelections = [];
      if (editorSelections(textarea).length > 1 && event.cancelable) {
        const inputType = event.inputType;
        if (inputType === 'insertText' || inputType === 'insertReplacementText') {
          event.preventDefault(); applyEditorInput(textarea,inputType,event.data || ''); return;
        }
        if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
          event.preventDefault(); applyEditorInput(textarea,inputType,'\n'); return;
        }
        if (/^delete(Content|Word)(Backward|Forward)$/.test(inputType)) {
          event.preventDefault(); applyEditorInput(textarea,inputType); return;
        }
        // Unsupported native edits must never leave secondary offsets stale.
        editing.secondarySelections = [];
      }
      pendingInput = editorSnapshot(textarea);
    });
    textarea.addEventListener('input', () => {
      if (!active()) return;
      if (!composition && pendingInput && pendingInput.value !== textarea.value) recordEditorUndo(pendingInput);
      pendingInput = null; updateEditor(textarea);
    });
    textarea.addEventListener('paste', event => {
      if (!active() || textarea.readOnly || composition || editorSelections(textarea).length < 2 || !event.clipboardData) return;
      event.preventDefault(); applyEditorInput(textarea,'insertFromPaste',event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));
    });
    for (const kind of ['copy','cut']) textarea.addEventListener(kind,event => {
      if (!active() || composition || editorSelections(textarea).length < 2 || !event.clipboardData || (kind === 'cut' && textarea.readOnly)) return;
      const ranges = editorSelections(textarea).filter(range => range.start !== range.end).sort((a,b)=>a.start-b.start);
      if (!ranges.length) return;
      event.preventDefault(); event.clipboardData.setData('text/plain',ranges.map(range=>textarea.value.slice(range.start,range.end)).join('\n'));
      if (kind === 'cut') applyEditorInput(textarea,'deleteByCut');
    });
    textarea.addEventListener('compositionstart', () => {
      if (!active() || textarea.readOnly) return;
      composition = editorSnapshot(textarea); textarea.dataset.composing = 'true'; pendingInput = null; drawEditorSelections(textarea);
    });
    textarea.addEventListener('compositionend', () => {
      if (!active() || !composition) return;
      const original = composition; composition = null; delete textarea.dataset.composing;
      if (textarea.value === original.value) {setEditorSelections(textarea,original.selections); updateEditor(textarea); return;}
      const primary = original.selections[0], prefix = original.value.slice(0,primary.start), suffix = original.value.slice(primary.end);
      if (original.selections.length > 1 && textarea.value.startsWith(prefix) && textarea.value.endsWith(suffix) && textarea.value.length >= prefix.length+suffix.length) {
        const inserted = textarea.value.slice(prefix.length,textarea.value.length-suffix.length);
        textarea.value = original.value; setEditorSelections(textarea,original.selections);
        applyEditorInput(textarea,'insertText',inserted);
      } else {
        if (original.value !== textarea.value) recordEditorUndo(original);
        // Some IMEs replace surrounding text. Keep that native result safely.
        if (original.selections.length > 1) editing.secondarySelections = [];
        updateEditor(textarea);
      }
    });
    textarea.addEventListener('keydown', event => {
      if (!active() || event.isComposing || event.keyCode === 229 || composition) return;
      const multiple = editorSelections(textarea).length > 1;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (multiple) {editing.secondarySelections = []; updateEditor(textarea);} else cancelEditor();
      } else if (matchesEditorAcceptShortcut(event)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) submitEditor(); }
      else if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z','y'].includes(event.key.toLowerCase()) && !textarea.readOnly) {
        event.preventDefault(); event.stopPropagation(); editorUndo(textarea,event.key.toLowerCase() === 'y' || event.shiftKey);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {editing.secondarySelections = []; drawEditorSelections(textarea);}
      else if (multiple && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        event.preventDefault(); moveEditorSelections(textarea,event);
      } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !textarea.readOnly) {
        event.preventDefault(); applyEditorInput(textarea,'insertText','\t');
      }
    });
    return textarea;
  }
  function sizeEditor() {
    const textarea = root.querySelector('.pending-editor textarea');
    if (!textarea) return;
    // The ordinary code surface determines height; the input adds no box or row.
    const mirror = textarea.parentElement.querySelector('.code-text');
    if (!mirror) return;
    if (textarea.dataset.mirrorValue !== textarea.value) {
      mirror.textContent = textarea.value + (!textarea.value || /\n$/.test(textarea.value) ? '\u200b' : '');
      textarea.dataset.mirrorValue = textarea.value;
    }
    const cell = textarea.closest('.code-side');
    const hasProposed = editing?.hadProposedLine !== false || textarea.value.length > 0;
    cell.classList.toggle('added', hasProposed); cell.classList.toggle('empty', !hasProposed);
    cell.querySelector('.line-marker').textContent = hasProposed ? '+' : ' ';
    cell.querySelector('.line-number').textContent = hasProposed ? (editing.rightStart || editing.oldStart || '') : '';
    textarea.style.height = mirror.getBoundingClientRect().height + 'px';
    drawEditorSelections(textarea);
    refreshOverview();
  }
  function renderEditorRow(leftText, leftStart, rightStart, inlineChanges) {
    const row = element('div', 'diff-row editing-row');
    row.dataset.pair = 'code';
    row.dataset.hunkRow = editing.hunkId;
    row.dataset.rowKey = 'hunk:' + editing.hunkId + ':0';
    const original = element('div', 'editing-original');
    const originalLines = sourceLines(leftText);
    originalLines.forEach((line, index) => original.append(codeSide('left', 'removed', leftStart + index, line, inlineChanges?.[index]?.before)));
    if (!originalLines.length) original.append(codeSide('left', 'empty', null, ''));
    const hasProposed = editing.hadProposedLine !== false || editing.draft.length > 0;
    const editor = element('section', 'code-side right pending-editor ' + (hasProposed ? 'added' : 'empty'));
    editing.rightStart = rightStart || editing.oldStart;
    editor.dataset.hunkId = editing.hunkId;
    editor.setAttribute('aria-label', 'Edit proposed change ' + (editing.index + 1));
    const number = element('span', 'line-number', hasProposed ? editing.rightStart : '');
    const marker = element('span', 'line-marker', hasProposed ? '+' : ' ');
    number.setAttribute('aria-hidden', 'true'); marker.setAttribute('aria-hidden', 'true');
    const content = element('div', 'code-source pending-editor-content');
    const mirror = element('span', 'code-text', editing.draft + (!editing.draft || /\n$/.test(editing.draft) ? '\u200b' : ''));
    mirror.setAttribute('aria-hidden', 'true');
    const textarea = editorInput(editing.draft, editing.hunkId, editing.index);
    textarea.readOnly = Boolean(editing.saving); textarea.dataset.focusKey = 'edit:draft';
    textarea.dataset.mirrorValue = editing.draft;
    content.append(mirror, textarea);
    const stale = staleEditor();
    const error = stale ? 'The request changed. Your draft is kept; press Escape to cancel and reopen the change before accepting.' : editing.error;
    if (error) { const notice = element('p', 'pending-editor-error', error); notice.setAttribute('role', 'alert'); content.append(notice); }
    const gutter = element('span', 'action-gutter');
    gutter.append(editorActions()); editor.append(number, marker, content, gutter); row.append(original, editor);
    textarea.setSelectionRange(Math.min(editing.selectionStart || 0, textarea.value.length), Math.min(editing.selectionEnd || 0, textarea.value.length), editing.selectionDirection || 'none');
    return row;
  }
  function clickedColumn(source, event) {
    // Keep the first caret near the actual click, including wrapped fragments.
    const caret = typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    if (!caret || !source.contains(caret.startContainer)) return 0;
    const prefix = document.createRange(); prefix.selectNodeContents(source); prefix.setEnd(caret.startContainer, caret.startOffset);
    return prefix.toString().replace(/\u200b/g, '').length;
  }
  function updateContextLineNumber(cell, number) {
    const text = number === null ? '' : String(number);
    if ((cell.dataset.line || '') === text) return;
    if (number === null) delete cell.dataset.line;
    else cell.dataset.line = text;
    cell.firstElementChild.textContent = text;
  }
  function appendPairs(container, leftText, rightText, pending, cursor, controls) {
    const left = sourceLines(leftText);
    const right = sourceLines(rightText);
    const length = Math.max(left.length, right.length, controls && controls.decision !== 'pending' ? 1 : 0);
    for (let index = 0; index < length; index += 1) {
      const rowKey = controls ? 'hunk:' + controls.hunk.id + ':' + index : 'context:' + cursor.offset + ':' + index;
      const proposedLine = cursor.right;
      const hasLeft = index < left.length;
      const hasRight = index < right.length;
      const leftNumber = hasLeft ? cursor.left++ : null;
      const rightNumber = hasRight ? cursor.right++ : null;
      const cached = !controls && cursor.reusableContextRows?.get(rowKey);
      if (cached && cached.leftText === (hasLeft ? left[index] : '') && cached.rightText === (hasRight ? right[index] : '')) {
        updateContextLineNumber(cached.original, leftNumber);
        updateContextLineNumber(cached.proposed, rightNumber);
        cursor.contextRows.set(rowKey, cached);
        container.append(cached.row);
        continue;
      }
      const row = element('div', 'diff-row');
      row.dataset.pair = 'code';
      row.dataset.rowKey = rowKey;
      const inline = pending && controls && Array.isArray(controls.hunk.inlineChanges)
        ? controls.hunk.inlineChanges[index] : undefined;
      const original = codeSide('left', hasLeft ? pending ? 'removed' : 'context' : 'empty',
        leftNumber, hasLeft ? left[index] : '', inline && inline.before);
      const proposed = codeSide('right', hasRight ? pending ? 'added' : 'context' : 'empty',
        rightNumber, hasRight ? right[index] : '', inline && inline.after);
      if (pending && controls) {
        proposed.dataset.proposedLine = String(proposedLine);
        const source = proposed.querySelector('.code-source');
        source.tabIndex = index === 0 ? 0 : -1;
        source.classList.add('editable-source'); source.dataset.editHunk = controls.hunk.id; source.dataset.editRow = String(index);
        source.title = 'Click, Enter, or F2 to edit this proposed change in place';
        source.setAttribute('aria-disabled', String(controls.busy || !state.trusted));
        if (index === 0) {
          source.tabIndex = 0; source.dataset.focusKey = controls.file.path + ':' + controls.hunk.id + ':edit'; source.dataset.hunk = controls.hunk.id;
          source.setAttribute('role', 'button'); source.setAttribute('aria-label', 'Edit proposed text for change ' + (controls.hunk.index + 1));
        }
        let directInput = null;
        if (left.length <= 1 && right.length <= 1) {
          // Keep a single-row block's native text control present before focus,
          // with highlighted code painted underneath.
          const draft = controls.hunk.draftAfter ?? controls.hunk.after.replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
          directInput = editorInput(draft, controls.hunk.id, controls.hunk.index);
          directInput.classList.add('direct-editor-input');
          directInput.dataset.mirrorValue = draft;
          directInput.dataset.focusKey = controls.file.path + ':' + controls.hunk.id + ':input';
          directInput.readOnly = controls.busy || !state.trusted;
          directInput.tabIndex = directInput.readOnly ? -1 : 0;
          source.tabIndex = -1; source.removeAttribute('role');
          source.querySelector('.code-text').setAttribute('aria-hidden', 'true');
          directInput.addEventListener('focus', () => {
            if (!directInput.readOnly && !editing) openEditor(controls.file, controls.hunk, index, directInput.selectionStart, directInput);
          });
          source.append(directInput);
        }
        source.addEventListener('click', event => {
          if (event.target === directInput) return;
          const column = clickedColumn(source, event); event.preventDefault();
          if (directInput) {
            directInput.focus({preventScroll: true}); directInput.setSelectionRange(column, column);
            captureEditor(); saveViewState();
          } else openEditor(controls.file, controls.hunk, index, column);
        });
        source.addEventListener('keydown', event => {
          if (event.target === directInput) return;
          if (event.key === 'Enter' || event.key === 'F2' || event.key === ' ') {
            event.preventDefault();
            if (directInput) directInput.focus({preventScroll: true});
            else openEditor(controls.file, controls.hunk, index);
          }
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
      if (!controls && cursor.contextRows) cursor.contextRows.set(rowKey, {
        row, original, proposed, leftText: hasLeft ? left[index] : '', rightText: hasRight ? right[index] : ''
      });
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
  function unifiedPendingBlock(block, file, hunk) {
    const removed = [], added = [];
    const pairs = Array.from(block.children);
    const hasAdded = pairs.some(row => row.children[1]?.classList.contains('added'));
    const firstProposed = pairs[0]?.children[1];
    for (const pair of pairs) {
      const original = pair.children[0], proposed = pair.children[1];
      const hasOriginal = original?.classList.contains('removed');
      const wrap = (cell, after) => {
        const row = element('div', 'diff-row unified-row'); row.dataset.pair = 'code';
        row.dataset.rowKey = pair.dataset.rowKey + (after && hasOriginal ? ':after' : '');
        if (cell.dataset.hunkId) row.dataset.hunkRow = cell.dataset.hunkId;
        row.append(cell); return row;
      };
      if (hasOriginal) removed.push(wrap(original, false));
      if (proposed?.classList.contains('added')) added.push(wrap(proposed, true));
    }
    if (!hasAdded && removed.length) {
      const original = removed[0].firstElementChild;
      const gutter = firstProposed?.querySelector('.action-gutter');
      if (gutter) original.append(gutter);
      original.dataset.hunkId = hunk.id; original.tabIndex = -1;
      removed[0].dataset.hunkRow = hunk.id;
      // A deletion has no proposed row to click. Its removed text opens the
      // same in-place draft editor, initially containing the empty proposal.
      const source = original.querySelector('.code-source');
      source.classList.add('editable-source'); source.tabIndex = 0;
      source.dataset.editHunk = hunk.id; source.dataset.editRow = '0';
      source.dataset.focusKey = file.path + ':' + hunk.id + ':edit'; source.dataset.hunk = hunk.id;
      source.setAttribute('role', 'button'); source.setAttribute('aria-label', 'Edit proposed text for change ' + (hunk.index + 1));
      source.setAttribute('aria-disabled', String(Boolean(state.busy || awaitingDecision || !state.trusted)));
      source.title = 'Click, Enter, or F2 to edit this proposed deletion in place';
      source.addEventListener('click', () => openEditor(file, hunk, 0));
      source.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === 'F2' || event.key === ' ') {
          event.preventDefault(); openEditor(file, hunk, 0);
        }
      });
    }
    block.replaceChildren(...removed, ...added);
  }
  function unifiedClosedDocument(documentView) {
    for (const row of documentView.querySelectorAll('.diff-row')) {
      const original = row.children[0], proposed = row.children[1];
      if (!original || !proposed) continue;
      const gutter = proposed.querySelector('.action-gutter');
      if (gutter) original.append(gutter);
      if (proposed.dataset.hunkId) { original.dataset.hunkId = proposed.dataset.hunkId; original.tabIndex = -1; }
      row.classList.add('unified-row'); row.replaceChildren(original);
    }
  }
  function renderDocument(file, busy) {
    const before = typeof file.before === 'string' ? file.before : '';
    const reusable = state.closed !== true && contextRowCache.path === file.path && contextRowCache.before === before
      ? contextRowCache : null;
    const documentView = reusable?.documentView || element('div', 'paired-document');
    const rows = [];
    const output = {append: (...nodes) => rows.push(...nodes)};
    documentView.setAttribute('role', 'region');
    documentView.setAttribute('aria-label', 'Aligned original and proposed file');
    const hunks = [...file.hunks].sort((a, b) => a.start - b.start || a.index - b.index);
    // Context rows have no editable controls or closures. Reuse their DOM while
    // rebuilding hunks so every action and input keeps the current host state.
    const contextRows = state.closed === true ? null : new Map();
    const reusableContextRows = contextRows && reusable ? reusable.rows : null;
    const cursor = { offset: 0, left: 1, right: 1, contextRows, reusableContextRows };
    let projectedLeft = '';
    let projectedRight = '';
    for (const hunk of hunks) {
      const unchanged = before.slice(cursor.offset, hunk.start);
      appendPairs(output, unchanged, unchanged, false, cursor);
      projectedLeft += unchanged;
      projectedRight += unchanged;
      const decision = decisionOf(hunk);
      // draftAfter includes logical blank rows even when an EOF insertion has
      // no trailing physical separator in displayAfter.
      const proposedRows = typeof hunk.draftAfter === 'string' && hunk.newLines > 0 ? hunk.draftAfter + '\n' : hunk.after;
      const physicalAfter = hunk.displayAfter === undefined ? hunk.after : '\n' + hunk.after;
      const leftText = decision === 'accepted' ? proposedRows : hunk.before;
      const rightText = decision === 'ignored' ? hunk.before : proposedRows;
      const block = element('section', 'hunk hunk-' + decision);
      block.dataset.overviewHunk = hunk.id;
      block.dataset.removed = String(decision === 'pending' && sourceLines(hunk.before).length > 0);
      block.dataset.added = String(decision === 'pending' && sourceLines(hunk.after).length > 0);
      block.setAttribute('aria-label', 'Change ' + (hunk.index + 1) + ', ' + decision);
      if (editing && decision === 'pending' && editing.filePath === file.path && editing.hunkId === hunk.id) {
        block.classList.add('hunk-editing');
        block.append(renderEditorRow(leftText, cursor.left, cursor.right, hunk.inlineChanges));
        cursor.left += sourceLines(leftText).length; cursor.right += sourceLines(rightText).length;
        output.append(block);
      } else if (appendPairs(block, leftText, rightText, decision === 'pending', cursor, {file, hunk, decision, busy})) {
        if (layout === 'unified' && decision === 'pending') unifiedPendingBlock(block, file, hunk);
        output.append(block);
      }
      projectedLeft += decision === 'accepted' ? physicalAfter : hunk.before;
      projectedRight += decision === 'ignored' ? hunk.before : physicalAfter;
      cursor.offset = hunk.end;
    }
    const tail = before.slice(cursor.offset);
    appendPairs(output, tail, tail, false, cursor);
    projectedLeft += tail;
    projectedRight += tail;
    const leftEnds = !projectedLeft || /[\r\n]$/.test(projectedLeft);
    const rightEnds = !projectedRight || /[\r\n]$/.test(projectedRight);
    const leftNeedsRow = cursor.left <= projectedLeft.replace(/\r\n|\r/g, '\n').split('\n').length;
    const rightNeedsRow = cursor.right <= projectedRight.replace(/\r\n|\r/g, '\n').split('\n').length;
    if (leftNeedsRow || rightNeedsRow) {
      const row = element('div', 'diff-row');
      row.dataset.pair = 'code';
      row.append(
        codeSide('left', leftNeedsRow ? 'context' : 'empty', leftNeedsRow ? cursor.left : null, ''),
        codeSide('right', rightNeedsRow ? 'context' : 'empty', rightNeedsRow ? cursor.right : null, '')
      );
      output.append(row);
    }
    if ((!leftEnds && projectedLeft) || (!rightEnds && projectedRight)) {
      const eof = element('div', 'diff-pair eof-row');
      eof.append(element('div', 'eof-side left', leftEnds ? '' : 'No newline at end of file'),
        element('div', 'eof-side right', rightEnds ? '' : 'No newline at end of file'));
      output.append(eof);
    }
    // Leave unchanged rows attached. Moving every row to a fresh container
    // forces Chromium to lay out the whole document even when its text is stable.
    const retained = new Set(rows);
    for (const child of Array.from(documentView.children)) if (!retained.has(child)) child.remove();
    let next = documentView.firstChild;
    for (const row of rows) {
      if (row === next) next = next.nextSibling;
      else documentView.insertBefore(row, next);
    }
    contextRowCache = {path: file.path, before, rows: contextRows || new Map(), documentView: contextRows ? documentView : null};
    if (state.closed === true && typeof file.currentText === 'string') {
      showClosedCurrent(documentView, file.currentText);
      if (layout === 'unified') unifiedClosedDocument(documentView);
    }
    if (layout === 'unified') {
      for (const note of documentView.querySelectorAll('.eof-row')) {
        const chosen = state.closed === true ? note.children[0] : Array.from(note.children).find(node => node.classList.contains('right') && node.textContent) || Array.from(note.children).find(node => node.textContent);
        if (chosen) { note.replaceChildren(chosen); note.classList.add('unified-row'); }
      }
    }
    return documentView;
  }

  const fallbackActions = [
    {id:'comment',label:'Comment out changed lines'},
    {id:'markRemoved',label:'Mark removed text in red'},
    {id:'markAdded',label:'Mark added text in blue'}
  ];
  function actionMenuAnchor() { return openMenu ? whyAnchor(openMenu.hunkId) : null; }
  function closeActionMenu(focusAnchor = false) {
    const anchor = actionMenuAnchor(); openMenu = null;
    root.querySelector('.review-action-menu')?.remove();
    if (anchor) { anchor.setAttribute('aria-expanded','false'); if (focusAnchor) anchor.focus({preventScroll:true}); }
    updateQuickPresentation();
    if (focusAnchor && quickReview && !editing && !openWhy) focusQuickSelection();
  }
  function focusMenuItem(last = false) {
    const items = Array.from(root.querySelectorAll('.review-action-menu [role="menuitem"]:not(:disabled)'));
    (last ? items.at(-1) : items[0])?.focus({preventScroll:true});
  }
  function toggleActionMenu(file, hunk) {
    if (openMenu?.hunkId === hunk.id) { closeActionMenu(true); return; }
    captureEditor(); closeExplanation(); closeActionMenu();
    const requestId = 'menu-' + Date.now() + '-' + (++menuSequence);
    const draft = editing?.draft ?? hunk.draftAfter ?? hunk.after.replace(/\r\n|\r/g,'\n').replace(/\n$/,'');
    openMenu = {filePath:file.path,hunkId:hunk.id,revision:state.revision,requestId,loading:true,actions:hunk.reviewActions};
    render(); focusMenuItem();
    post({type:'reviewActions',filePath:file.path,hunkId:hunk.id,revision:state.revision,draft,editId:requestId});
  }
  function transformDraft(file, hunk, action) {
    if (!state || state.busy || awaitingDecision || quickPending || !state.trusted) return;
    closeActionMenu(); closeExplanation();
    if (!editing) openEditor(file,hunk,0);
    if (!editing || editing.saving || staleEditor()) return;
    captureEditor();
    const area = root.querySelector('.pending-editor textarea');
    editing.transformSnapshot = area ? editorSnapshot(area) : {value:editing.draft,selections:[{start:0,end:0,direction:'none'}]};
    editing.saving = true; editing.error = null;
    editing.editId = 'transform-' + Date.now() + '-' + (++editSequence);
    const message = {type:'transformDraft',filePath:editing.filePath,hunkId:editing.hunkId,
      revision:editing.revision,draft:editing.draft,action,editId:editing.editId};
    saveViewState(); render(); post(message);
  }
  function renderActionMenu(app, file) {
    if (!openMenu || !file) return;
    const hunk = file.hunks.find(item => item.id === openMenu.hunkId);
    if (!hunk || decisionOf(hunk) !== 'pending' || openMenu.revision !== state.revision || !actionMenuAnchor()) { closeActionMenu(); return; }
    const menu = element('section','review-action-menu');
    menu.id = 'rr-actions'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','Change actions');
    const hasReason = typeof hunk.explanation === 'string' && Boolean(hunk.explanation.trim());
    const why = button('Why','review-menu-item review-action-why',() => {
      const id = hunk.id; closeActionMenu(); openWhy = id; saveViewState(); render();
      root.querySelector('.why-popover')?.focus({preventScroll:true});
    },{disabled:!hasReason,label:'Why',key:'menu:why',title:hasReason?'Show the explanation for this change':'No explanation provided'});
    why.setAttribute('role','menuitem'); menu.append(why);
    for (const fallback of fallbackActions) {
      const item = openMenu.actions?.find(action => action.id === fallback.id) || {...fallback,enabled:false,reason:'This action is unavailable for this change.'};
      const reason = openMenu.loading ? 'Checking this draft…' : !state.trusted ? 'Trust this workspace to edit proposals.' : openMenu.error || item.reason;
      const enabled = !openMenu.loading && !openMenu.error && item.enabled === true && state.trusted && !state.busy && !awaitingDecision;
      const control = button('', 'review-menu-item',()=>transformDraft(file,hunk,item.id),
        {disabled:!enabled,label:item.label || fallback.label,key:'menu:'+item.id,title:reason});
      control.dataset.reviewAction = item.id; control.setAttribute('role','menuitem');
      control.append(element('span','review-menu-label',item.label || fallback.label));
      if (!enabled && reason) control.append(element('span','review-menu-reason',reason));
      menu.append(control);
    }
    if (/\.(tex|ltx)$/i.test(file.path)) {
      const setup = button('Set up LaTeX review macros…','review-menu-item review-menu-setup',()=>{
        closeActionMenu(true); post({type:'setupReviewMacros',filePath:file.path});
      },{disabled:Boolean(editing) || !state.trusted || state.busy || awaitingDecision,label:'Set up LaTeX review macros',key:'menu:setup',
        title:editing?'Finish or discard the draft before setting up macros':'Prepare review macros for this project'});
      setup.setAttribute('role','menuitem'); menu.append(setup);
    }
    menu.addEventListener('keydown',event=>{
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();closeActionMenu(true);return;}
      if (event.key === 'Tab') {event.stopPropagation();closeActionMenu();return;}
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault(); const index = items.indexOf(document.activeElement);
      const next = event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next]?.focus({preventScroll:true});
    });
    app.append(menu);
  }
  function positionActionMenu() {
    const anchor = actionMenuAnchor(), menu = root.querySelector('.review-action-menu'), scroll = root.querySelector('[data-scroll-area]');
    if (!anchor || !menu || !scroll) return;
    const rect = anchor.getBoundingClientRect(), visible = scroll.getBoundingClientRect();
    if (rect.bottom <= visible.top || rect.top >= visible.bottom) {closeActionMenu();return;}
    const width = Math.min(320,window.innerWidth-16);
    menu.style.width = width+'px'; menu.style.maxHeight = Math.max(60,window.innerHeight-16)+'px';
    menu.style.left = Math.max(8,Math.min(window.innerWidth-width-8,rect.right-width))+'px';
    const height = menu.offsetHeight, below = window.innerHeight-rect.bottom-8;
    menu.style.top = Math.max(8,Math.min(window.innerHeight-height-8,below>=height || rect.top<height+8?rect.bottom+5:rect.top-height-5))+'px';
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
    updateQuickPresentation();
    if (focusAnchor && quickReview && !editing && !openMenu) focusQuickSelection();
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
  function lockReviewControls() {
    const active = document.activeElement;
    if (active?.matches('.inline-actions button,.file-actions button')) {
      decisionFocus = {key: active.dataset.focusKey, hunk: active.dataset.hunk};
    }
    root.querySelector('.review-app')?.setAttribute('aria-busy', 'true');
    for (const control of root.querySelectorAll('.inline-actions button,.file-actions button,.quick-review-toggle')) control.disabled = true;
    for (const input of root.querySelectorAll('.pending-editor-textarea')) input.readOnly = true;
    closeExplanation();
  }
  function captureViewport() {
    const scroll = root.querySelector('[data-scroll-area]');
    if (!scroll || !viewRows.length) return; // Keep the last position through transient empty states.
    const top = scroll.getBoundingClientRect().top;
    let lo = 0, hi = viewRows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (viewRows[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
      else hi = mid;
    }
    const anchor = viewRows[lo];
    viewport = {top: scroll.scrollTop, key: anchor?.dataset.rowKey,
      offset: anchor ? anchor.getBoundingClientRect().top - top : 0};
  }
  function restoreViewport() {
    const scroll = root.querySelector('[data-scroll-area]');
    if (!scroll) return;
    const anchor = viewport.key && (viewRows.find(row => row.dataset.rowKey === viewport.key)
      || viewRows.find(row => row.dataset.rowKey === viewport.key.replace(/:after$/, '')));
    scroll.scrollTop = anchor
      ? scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - viewport.offset
      : viewport.top;
    updateOverviewThumb();
  }
  function revealFirstChange() {
    if (!firstChangeNavigationPending || !state || state.busy || awaitingDecision || quickPending || openingDecision ||
        editing?.saving || completion) return;
    const scroll = root.querySelector('[data-scroll-area]');
    if (!scroll) return;
    const block = scroll.querySelector('.hunk-pending');
    // In unified view the first removed row can be far above the Accept button.
    const row = block?.querySelector('.diff-row') || block;
    scroll.scrollTop = row
      ? scroll.scrollTop + row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 8
      : 0;
    const focused = document.activeElement;
    const focusedBlock = focused?.closest?.('.hunk');
    if (focusedBlock && scroll.contains(focused)) {
      const focusedRect = focused.getBoundingClientRect(), visible = scroll.getBoundingClientRect();
      if (focusedBlock !== block || focusedRect.bottom <= visible.top || focusedRect.top >= visible.bottom) {
        // Keep unsaved drafts, but never leave an old, hidden approval target armed.
        scroll.tabIndex = -1;
        scroll.focus({preventScroll: true});
        decisionFocus = null;
      }
    }
    firstChangeNavigationPending = false;
    openingChange = block ? {hunkId: block.dataset.overviewHunk, top: scroll.scrollTop} : null;
    if (quickReview) {
      const item = quickCandidates().find(candidate => candidate.hunkId === block?.dataset.overviewHunk);
      quickSelection = item ? {...item, decision: 'accepted'} : null;
      quickFocusRequested = Boolean(item);
      quickScrollRequested = false;
    }
    captureViewport();
    updateOverviewThumb();
  }
  function onComparisonScroll() {
    updateOverviewThumb(); positionExplanation(); positionActionMenu();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0; captureViewport(); saveViewState();
    });
  }
  function updateOverviewThumb() {
    if (!overview) return;
    const {scroll, rail, thumb} = overview;
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const height = rail.clientHeight;
    const thumbHeight = Math.min(height, Math.max(24, height * scroll.clientHeight / Math.max(1, scroll.scrollHeight)));
    overview.travel = Math.max(0, height - thumbHeight);
    overview.max = max;
    thumb.hidden = max === 0;
    thumb.style.height = thumbHeight + 'px';
    thumb.style.transform = 'translateY(' + (max ? scroll.scrollTop / max * overview.travel : 0) + 'px)';
    rail.setAttribute('aria-valuemax', String(Math.round(max)));
    rail.setAttribute('aria-valuenow', String(Math.round(scroll.scrollTop)));
  }
  function refreshOverview() {
    if (!overview || !overview.rail.isConnected) return;
    const {app, scroll, rail, markers} = overview;
    const rect = scroll.getBoundingClientRect();
    rail.style.top = rect.top - app.getBoundingClientRect().top + 'px';
    rail.style.height = scroll.clientHeight + 'px';
    const scale = rail.clientHeight / Math.max(1, scroll.scrollHeight);
    const blocks = new Map();
    for (const {block} of markers) if (!blocks.has(block)) blocks.set(block, block.getBoundingClientRect());
    const maxTop = Math.max(0, rail.clientHeight - 3);
    for (const {node, block} of markers) {
      const blockRect = blocks.get(block);
      node.style.top = Math.min(Math.max(0, (blockRect.top - rect.top + scroll.scrollTop) * scale), maxTop) + 'px';
      node.style.height = Math.max(3, blockRect.height * scale) + 'px';
    }
    updateOverviewThumb();
  }
  function renderOverview(app) {
    const scroll = app.querySelector('[data-scroll-area]');
    if (!scroll) return;
    scroll.id = 'rr-comparison-scroll';
    const rail = element('div', 'change-scrollbar');
    rail.tabIndex = completion ? -1 : 0; rail.dataset.focusKey = 'pane:scrollbar';
    rail.setAttribute('role', 'scrollbar'); rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-controls', scroll.id); rail.setAttribute('aria-valuemin', '0');
    rail.setAttribute('aria-label', 'Scroll comparison; red and green markers locate pending changes');
    rail.title = 'Scroll comparison. Click a red or green marker to jump to that change.';
    const thumb = element('div', 'change-scrollbar-thumb');
    rail.append(thumb);
    const markers = [];
    for (const block of scroll.querySelectorAll('.hunk-pending')) {
      for (const kind of ['removed', 'added']) {
        if (block.dataset[kind] !== 'true') continue;
        const node = element('div', 'change-scrollbar-marker ' + kind);
        node.dataset.overviewTarget = block.dataset.overviewHunk;
        node.title = block.getAttribute('aria-label');
        node.addEventListener('pointerdown', event => {
          if (completion || event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          const draftFocus = document.activeElement?.matches('.pending-editor textarea') ? document.activeElement : null;
          scroll.scrollTop += block.getBoundingClientRect().top - scroll.getBoundingClientRect().top - Math.min(40, scroll.clientHeight / 4);
          (draftFocus || rail).focus({preventScroll: true}); onComparisonScroll();
        });
        markers.push({node, block}); rail.append(node);
      }
    }
    overview = {app, scroll, rail, thumb, markers, max: 0, travel: 0};
    let drag = null;
    rail.addEventListener('pointerdown', event => {
      if (completion || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const draftFocus = document.activeElement?.matches('.pending-editor textarea') ? document.activeElement : null;
      rail.focus({preventScroll: true});
      if (event.target !== thumb) {
        const position = event.clientY - rail.getBoundingClientRect().top - thumb.clientHeight / 2;
        scroll.scrollTop = overview.travel ? position / overview.travel * overview.max : 0;
        updateOverviewThumb();
      }
      drag = {id: event.pointerId, y: event.clientY, top: scroll.scrollTop, draftFocus};
      rail.setPointerCapture(event.pointerId);
    });
    rail.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId || !overview.travel) return;
      scroll.scrollTop = drag.top + (event.clientY - drag.y) / overview.travel * overview.max;
      updateOverviewThumb();
    });
    const endDrag = event => {
      if (!drag || drag.id !== event.pointerId) return;
      const draftFocus = drag.draftFocus;
      drag = null;
      if (draftFocus?.isConnected) draftFocus.focus({preventScroll: true});
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      captureViewport(); saveViewState();
    };
    rail.addEventListener('pointerup', endDrag); rail.addEventListener('pointercancel', endDrag);
    rail.addEventListener('lostpointercapture', () => { drag = null; });
    rail.addEventListener('wheel', event => {
      if (completion) return;
      event.preventDefault();
      scroll.scrollTop += event.deltaY * (event.deltaMode === 1 ? 22 : event.deltaMode === 2 ? scroll.clientHeight : 1);
    }, {passive: false});
    rail.addEventListener('keydown', event => {
      if (completion) return;
      let next = scroll.scrollTop;
      if (event.key === 'ArrowUp') next -= 22;
      else if (event.key === 'ArrowDown') next += 22;
      else if (event.key === 'PageUp') next -= scroll.clientHeight * .9;
      else if (event.key === 'PageDown') next += scroll.clientHeight * .9;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = scroll.scrollHeight;
      else return;
      event.preventDefault(); scroll.scrollTop = next; onComparisonScroll();
    });
    app.append(rail);
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
    let minimumLeft = Math.max(160, gutter + 80 + 15);
    let minimumRight = Math.max(gutter + actions + 80 + 8, summaryWidth + actions);
    // Tiny windows cannot satisfy both ideals. Retain both panes proportionally.
    if (minimumLeft + minimumRight > available) {
      const scale = available / (minimumLeft + minimumRight);
      minimumLeft *= scale; minimumRight *= scale;
    }
    return { app, available, min: minimumLeft / available, max: 1 - minimumRight / available };
  }
  function applySplit() {
    if (layout === 'unified') {
      const comparison = root.querySelector('[data-scroll-area]'), app = root.querySelector('.review-app');
      if (!comparison || !app) return;
      const css = getComputedStyle(app);
      const gutter = parseFloat(css.getPropertyValue('--rr-gutter')) || 66;
      const actions = parseFloat(css.getPropertyValue('--rr-action-gutter')) || 152;
      root.style.setProperty('--rr-code-width', Math.max(0, comparison.clientWidth - 15 - gutter - actions) + 'px');
      sizeEditor(); positionExplanation(); positionActionMenu(); refreshOverview();
      return;
    }
    const metrics = splitMetrics();
    if (!metrics) return;
    const ratio = Math.max(metrics.min, Math.min(metrics.max, splitRatio));
    root.style.setProperty('--rr-left-width', (ratio * 100) + '%');
    root.style.setProperty('--rr-divider-left', (metrics.available * ratio) + 'px');
    // Both code surfaces wrap at exactly the same width, even after resizing.
    const css = getComputedStyle(root);
    const gutter = parseFloat(css.getPropertyValue('--rr-gutter')) || 66;
    const actions = parseFloat(css.getPropertyValue('--rr-action-gutter')) || 152;
    const leftCode = metrics.available * ratio - gutter - 15;
    const rightCode = metrics.available * (1 - ratio) - gutter - actions - 8;
    root.style.setProperty('--rr-code-width', Math.max(0, Math.min(leftCode, rightCode)) + 'px');
    const separator = root.querySelector('.pane-splitter');
    if (separator) {
      separator.setAttribute('aria-valuemin', String(Math.round(metrics.min * 100)));
      separator.setAttribute('aria-valuemax', String(Math.round(metrics.max * 100)));
      separator.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      separator.setAttribute('aria-valuetext', 'Original ' + Math.round(ratio * 100) + '%, Revision ' + Math.round((1 - ratio) * 100) + '%');
    }
    sizeEditor(); positionExplanation(); positionActionMenu(); refreshOverview();
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
    const documentView = root.querySelector('.paired-document');
    if (documentView) {
      const style = getComputedStyle(documentView);
      const key = [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight].join('|');
      if (key !== fontMetricKey) {
        const probe = element('span', 'inline-metric-probe', 'M');
        documentView.append(probe);
        const fontHeight = probe.getBoundingClientRect().height;
        probe.remove();
        root.style.setProperty('--rr-inline-padding', Math.max(0, (parseFloat(style.lineHeight) - fontHeight) / 2) + 'px');
        fontMetricKey = key;
      }
    }
    applySplit();
  }
  function reconcileChildren(parent, nodes) {
    const keep = new Set(nodes);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
    let next = parent.firstElementChild;
    for (const node of nodes) {
      if (node === next) next = next.nextElementSibling;
      else parent.insertBefore(node, next);
    }
  }
  function render() {
    if (!state) return;
    quickRendering=true;
    endSplitDrag(false, false);
    captureEditor();
    captureViewport();
    overview = null;
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset : {};
    const activeKey = active.focusKey || decisionFocus?.key;
    const activeHunk = active.hunk || active.hunkId || decisionFocus?.hunk;
    const files = Array.isArray(state.files) ? state.files : [];
    const file = files[0];
    const closed = state.closed === true;
    const totals = counts(file ? file.hunks : []);
    reconcileQuickReview();
    const busy = Boolean(state.busy || awaitingDecision || quickPending || editing || completion);
    const rawOpacity = typeof state.unchangedOpacity === 'number' && Number.isFinite(state.unchangedOpacity) ? state.unchangedOpacity : 20;
    root.style.setProperty('--rr-context-opacity', String(Math.min(100, Math.max(0, rawOpacity)) / 100));
    const app = root.querySelector('.review-app') || element('div', 'review-app');
    const appChildren = [];
    app.classList.toggle('is-closed', closed);
    app.classList.toggle('layout-unified', layout === 'unified');
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
      original.append(element('p', 'eyebrow', file.issue && !(closed && typeof file.currentText === 'string') ? 'REQUEST SNAPSHOT' : layout === 'unified' ? 'FILE' : 'ORIGINAL'), filename);
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
        const stack=element('div','file-action-stack');
        stack.append(quickReviewButton(busy || !quickAllowed()),actions);
        summaryRow.append(stack);
      }
      proposed.append(summaryRow);
      header.append(original, proposed);
      appChildren.push(header);
    }
    if (!state.trusted) appChildren.push(banner('Trust this workspace to accept or ignore changes. You can still inspect this request.', 'info'));
    if (closed && file) appChildren.push(banner('This revision request is closed.', 'info'));
    if (state.error && !dismissedErrors.has(state.error)) appChildren.push(banner(state.error));
    if (file) {
      if (!closed && file.issue && file.issue !== state.error && !dismissedErrors.has(file.issue)) appChildren.push(banner(file.issue));
      let content = app.querySelector('[data-scroll-area]');
      if (!content) {
        content = element('main', 'comparison-scroll'); content.dataset.scrollArea = 'true';
        content.addEventListener('scroll', onComparisonScroll, {passive: true});
      }
      content.setAttribute('aria-label', 'Original and proposed content of ' + file.path);
      const documentView = renderDocument(file, busy);
      reconcileChildren(content, file.hunks.length ? [documentView] : [element('p', 'unchanged-note', 'No changes proposed.'), documentView]);
      appChildren.push(content);
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
      appChildren.push(empty);
    }
    reconcileChildren(app, appChildren);
    if (editing && !app.querySelector('.pending-editor')) {
      // An external edit can remove the active hunk or even the request. Keep
      // its unsaved draft visible in flow instead of silently discarding it.
      let content = app.querySelector('[data-scroll-area]');
      if (!content) {
        content = element('main', 'comparison-scroll'); content.dataset.scrollArea = 'true';
        app.querySelector('.empty-state')?.remove(); app.append(content);
        content.addEventListener('scroll', onComparisonScroll, {passive: true});
      }
      const fallback = element('section', 'paired-document pending-editor-fallback');
      fallback.setAttribute('aria-label', 'Unsaved proposal draft');
      fallback.append(renderEditorRow(file ? '' : editing.original || '', editing.oldStart || 1, editing.oldStart || 1));
      content.prepend(fallback);
    }
    if (file) {
      if (layout === 'sideBySide') renderSplitter(app);
      renderOverview(app);
    }
    if (root.firstElementChild !== app) root.replaceChildren(app);
    viewRows = Array.from(root.querySelectorAll('[data-row-key]'));
    renderExplanation(app, file); renderActionMenu(app, file); renderCompletion(app);
    updateLayout(); restoreViewport();
    let replacement = activeKey
      ? Array.from(root.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === activeKey && !node.disabled)
      : null;
    if (!replacement && activeHunk) {
      replacement = Array.from(root.querySelectorAll('button[data-hunk]')).find(node => node.dataset.hunk === activeHunk && !node.disabled)
        || Array.from(root.querySelectorAll('[data-hunk-id]')).find(node => node.dataset.hunkId === activeHunk);
    }
    if (replacement) { replacement.focus({ preventScroll: true }); decisionFocus = null; }
    const completionDialog = root.querySelector('.completion-dialog');
    if (completionDialog && !completionDialog.contains(document.activeElement)) {
      (root.querySelector('[data-focus-key="completion:no"]:not(:disabled)') || completionDialog).focus({preventScroll: true});
    }
    if (focusAfterEdit && (!focusAfterEdit.revision || state.revision === focusAfterEdit.revision)) {
      const focusFile = files.find(item => item.path === focusAfterEdit.filePath);
      const pending = focusFile?.hunks.filter(hunk => decisionOf(hunk) === 'pending') || [];
      const hunk = pending.find(item => item.oldStart === focusAfterEdit.oldStart) || pending.find(item => item.index === focusAfterEdit.index) || pending[0];
      const source = hunk ? editorAnchor({hunkId: hunk.id, anchorIndex: 0}) : null;
      if (quickReview && hunk) {
        quickSelection={filePath:focusFile.path,hunkId:hunk.id,index:hunk.index,oldStart:hunk.oldStart,decision:'accepted'};
        quickFocusRequested=true;quickScrollRequested=true;
      } else (source || root.querySelector('.filename-link'))?.focus({preventScroll:true});
      focusAfterEdit = null;
    }
    revealFirstChange();
    quickRendering=false;
    updateQuickPresentation();
    if (quickFocusRequested) focusQuickSelection(quickScrollRequested);
    saveViewState();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'revealFirstChange') {
      firstChangeNavigationPending = true;
      if (quickPending && quickPending.success !== true) openingDecision = quickPending;
      if (state) render();
      return;
    }
    if (message.type === 'toggleQuickReview') {
      setQuickReview(typeof message.enabled==='boolean'?message.enabled:!quickReview);return;
    }
    if (message.type === 'quickDecisionResult') {
      const openingResult = matchesQuickDecision(message, openingDecision);
      if (openingResult) openingDecision = null;
      if (!matchesQuickDecision(message, quickPending)) {
        if (openingResult) render();
        return;
      }
      if (message.success===true) quickPending.success=true;
      else {quickPending=null;quickFocusRequested=true;quickScrollRequested=false;}
      render();return;
    }
    if (message.type === 'toggleLayout') {
      if (!layout) { pendingLayoutToggle = !pendingLayoutToggle; return; }
      captureEditor(); captureViewport();
      layout = layout === 'unified' ? 'sideBySide' : 'unified';
      saveViewState(); render();
      return;
    }
    if (message.type === 'busy') {
      if (state && message.busy === true) { state.busy = true; closeActionMenu(); lockReviewControls(); }
      return;
    }
    if (message.type === 'completionPrompt') {
      if (typeof message.completionId !== 'string' || typeof message.revision !== 'string') return;
      if (completion?.completionId === message.completionId) return;
      completion = {completionId: message.completionId, revision: message.revision,
        requestName: typeof message.requestName === 'string' ? message.requestName : 'Revision request',
        resolving: false, rememberChoice: false, error: null};
      openWhy = null; closeActionMenu(); saveViewState(); render();
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
    if (message.type === 'reviewActionsResult') {
      if (!openMenu || message.editId !== openMenu.requestId) return;
      openMenu.loading = false; openMenu.actions = Array.isArray(message.reviewActions) ? message.reviewActions : [];
      openMenu.error = typeof message.error === 'string' ? message.error : null;
      render(); focusMenuItem(); return;
    }
    if (message.type === 'transformResult') {
      if (!editing || !editing.saving || message.editId !== editing.editId) return;
      captureEditor();
      if (typeof message.draft === 'string' && !message.error) {
        const previous = editing.transformSnapshot;
        if (previous && previous.value !== message.draft) recordEditorUndo(previous);
        editing.draft = message.draft; editing.secondarySelections = [];
        editing.selectionStart = editing.selectionEnd = Math.min(editing.selectionStart || 0,message.draft.length);
        editing.error = null;
        const area = root.querySelector('.pending-editor textarea');
        if (area) {area.value=editing.draft;area.setSelectionRange(editing.selectionStart,editing.selectionEnd);}
      } else editing.error = typeof message.error === 'string' ? message.error : 'The action could not be applied. Your draft is kept.';
      editing.saving = false; editing.editId = null; delete editing.transformSnapshot;
      saveViewState(); render(); root.querySelector('.pending-editor textarea')?.focus({preventScroll:true}); return;
    }

    if (message.type === 'editResult') {
      if (!editing || !editing.saving || message.editId !== editing.editId || message.filePath !== editing.filePath || message.hunkId !== editing.hunkId) return;
      captureEditor();
      if (message.success === true) {
        focusAfterEdit = {filePath: editing.filePath, oldStart: editing.oldStart, index: editing.index, revision: message.revision};
        editing = null;
      } else { editing.saving = false; editing.editId = null; editing.error = typeof message.error === 'string' ? message.error : 'The review decision could not be applied. Your draft is kept.'; }
      saveViewState(); render();
      if (editing) root.querySelector('.pending-editor textarea')?.focus({preventScroll: true});
      return;
    }
    if (message.type !== 'state') return;
    if (!layout) {
      layout = message.defaultLayout === 'sideBySide' ? 'sideBySide' : 'unified';
      if (pendingLayoutToggle) layout = layout === 'unified' ? 'sideBySide' : 'unified';
      pendingLayoutToggle = false;
    }
    if (state && (message.revision !== state.revision || message.requestName !== state.requestName || (message.busy && !state.busy))) dismissedErrors.clear();
    if (state && message.error && message.error !== state.error) dismissedErrors.delete(message.error);
    const activeErrors = new Set([message.error, ...(Array.isArray(message.files) ? message.files.map(file => file.issue) : [])]);
    for (const error of dismissedErrors) if (!activeErrors.has(error)) dismissedErrors.delete(error);
    state = message;
    saveViewState();
    awaitingDecision = false;
    render();
    if (pendingQuickMode!==null) {const enabled=pendingQuickMode;pendingQuickMode=null;setQuickReview(enabled);}
  });
  window.addEventListener('pointerdown', event => {
    if (openMenu && !event.target?.closest?.('.review-action-menu,.review-menu-toggle')) closeActionMenu();
    if (!openWhy) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('.why-popover, .why-toggle')) return;
    closeExplanation();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openMenu) { event.preventDefault(); event.stopPropagation(); closeActionMenu(true); return; }
    if (event.key === 'Escape' && splitDrag) { event.preventDefault(); endSplitDrag(true); return; }
    if (event.key === 'Escape' && completion) { event.preventDefault(); resolveCompletion(false, false); return; }
    if (event.key === 'Escape' && openWhy) {
      event.preventDefault();
      closeExplanation(true);
      return;
    }
    if (!quickReview || event.defaultPrevented || event.isComposing || event.keyCode===229 || quickPaused()) return;
    if (event.target?.closest?.('textarea,input,select,[contenteditable="true"],.pane-splitter,.change-scrollbar')) return;
    if (event.key==='Escape') {event.preventDefault();setQuickReview(false);return;}
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['ArrowLeft','ArrowRight','Tab'].includes(event.key)) return;
    event.preventDefault();
    if (event.repeat || state?.busy || awaitingDecision || quickPending) return;
    reconcileQuickReview();if (!quickReview || !quickSelection) return;
    if (event.key==='ArrowLeft' || event.key==='ArrowRight') {
      quickSelection.decision=quickSelection.decision==='accepted'?'ignored':'accepted';
      focusQuickSelection();return;
    }
    const control=quickControl();
    if (control && !control.disabled) decide({type:'decide',filePath:quickSelection.filePath,hunkId:quickSelection.hunkId,decision:quickSelection.decision});
  });
  window.addEventListener('blur', () => endSplitDrag(true, false));
  window.addEventListener('pagehide', () => { endSplitDrag(false, false); captureEditor(); captureViewport(); saveViewState(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateLayout).observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fontMetricKey = null; updateLayout(); });
  post({type:'quickReviewState',enabled:false,initial:true});
  post({ type: 'ready' });
})();
