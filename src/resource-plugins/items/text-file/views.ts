import type { JsonObject, ResourcePluginViews } from '../../types.ts';
import { lastPathPart } from '../../generated-title.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { emptyState, mountViewHeader, skeleton } from '../../view-header.ts';
import type { MountedTextEditor } from './editor.ts';
import { CloseQuestion } from './close-question.ts';
import { mountTextFileCard } from './map-card.ts';
import { OpenTextFiles } from './open-file.ts';
import { sourceOffsetOfPreviewText } from './preview-position.ts';
import { textFileSettings } from './settings.ts';

const SAVE_DELAY_MS = 600, CHECK_INTERVAL_MS = 2000;
/** A press that moves the pointer further than this before it ends selects text; it is not a click on it. */
const CLICK_MOVES_AT_MOST_PX = 4;
const openFiles = new OpenTextFiles();

/** One pane on a file on disk. Preview shows Markdown rendered and any other file read-only; Edit makes it
 * writable, and so does a click on the text of a rendered Markdown file, with the caret where the click was.
 * A change on disk is picked up while the item is open. With the Save automatically setting, edits are
 * saved a moment after typing stops, on ⌘S, on switching to Preview and when the item closes, at close over a
 * change on disk too; a close whose save does not reach the disk asks first. Without it only ⌘S saves, and a
 * close with unsaved edits asks first. Edits a view could not ask about are in the view the next time the item
 * is opened. CodeMirror is loaded when the first text file view mounts. */
export const textFileViews: ResourcePluginViews = {
  identity: resource => JSON.stringify([resource.data.path, resource.data.language]),
  mountNode: mountTextFileCard,
  mountDetail(container, resource, services) {
    const document = container.ownerDocument, window = document.defaultView!;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
      const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
    };
    const button = (label: string, run: () => void) => { const control = element('button', label); control.type = 'button'; control.onclick = run; return control; };
    const path = String(resource.data.path ?? ''), named = typeof resource.data.language === 'string' ? resource.data.language : undefined;
    const root = element('section', '', 'text-file-view');
    container.append(root);
    const header = mountViewHeader(document, services, root);

    let mode: 'edit' | 'preview' = services.viewState?.().mode === 'edit' ? 'edit' : 'preview';
    let tools: typeof import('./editor.ts') | undefined, editor: MountedTextEditor | undefined;
    let active = false, disposed = false, saveTimer: number | undefined, checkTimer: number | undefined, previewedText: string | undefined;
    // Nothing is written unasked before the setting is known.
    let saveAutomatically = false;

    const file = openFiles.open(resource.id, path,
      (actionId, input) => services.runAction('resource.action', { actionId, input: (input ?? {}) as JsonObject }),
      textReplaced => { if (!disposed) render(textReplaced); });
    const saveNow = () => { window.clearTimeout(saveTimer); saveTimer = undefined; void file.save().catch(() => {}); };
    const check = () => { void file.check().catch(() => {}); };

    /** Shows the file in `next` mode. With `caret`, the editor opens at that character of the text. */
    const show = (next: 'edit' | 'preview', caret?: number) => {
      mode = next;
      services.saveViewState?.({ mode: mode === 'edit' ? 'edit' : null });
      if (mode === 'preview' && saveAutomatically) saveNow();
      render(false);
      if (mode === 'edit') editor?.focus(caret);
    };
    const toggle = button('Edit', () => show(mode === 'edit' ? 'preview' : 'edit'));
    toggle.toggleAttribute('data-primary', true); toggle.hidden = true;
    const reveal = button('Reveal in Finder', () => { void services.revealFile?.(path).catch(() => {}); });
    reveal.hidden = true;
    header.actions.append(reveal, toggle);

    const changed = element('div', '', 'text-file-changed'), changedLine = element('span');
    changed.setAttribute('role', 'status'); changed.hidden = true;
    const decide = (decision: () => Promise<void>) => () => { void decision(); if (mode === 'edit') editor?.focus(); };
    changed.append(changedLine, button('Reload', decide(() => file.reload())), button('Keep mine', decide(() => file.keepMine())));

    const closePrompt = element('div', '', 'text-file-close-prompt'), closeQuestion = element('span');
    closePrompt.setAttribute('role', 'alertdialog'); closePrompt.toggleAttribute('data-owns-escape', true); closePrompt.hidden = true;
    const closing = new CloseQuestion(file, {
      show(question) { closeQuestion.textContent = question; closePrompt.setAttribute('aria-label', question); closePrompt.hidden = false; saveAndClose.focus(); },
      hide(agreed) { closePrompt.hidden = true; if (!agreed && !disposed && mode === 'edit') editor?.focus(); },
      busy(busy) { for (const control of closeButtons) control.disabled = busy; },
    });
    const saveAndClose = button('Save and close', () => closing.saveAndClose());
    const closeButtons = [button('Cancel', () => closing.cancel()), button('Close without saving', () => closing.closeWithoutSaving()), saveAndClose];
    closePrompt.append(closeQuestion, ...closeButtons);
    closePrompt.addEventListener('keydown', event => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); closing.cancel(); });

    const waiting = skeleton(document), blank = element('div', '', 'text-file-blank'), preview = element('div', '', 'text-file-preview markdown-content'), code = element('div', '', 'text-file-editor');
    // A click on the rendered text edits it there. A click on a link opens the link; a press that drags
    // selects text and a click with a modifier key extends the selection, so text can be copied from the preview.
    let pressed: { x: number; y: number } | undefined;
    preview.addEventListener('mousedown', event => { pressed = { x: event.clientX, y: event.clientY }; });
    preview.addEventListener('click', event => {
      const dragged = pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_MOVES_AT_MOST_PX;
      pressed = undefined;
      const withModifier = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
      if (event.button !== 0 || event.defaultPrevented || dragged || withModifier || (event.target as Element).closest('a[href], button, input, summary')) return;
      openedByClickAt = { x: event.clientX, y: event.clientY };
      const place = document.caretPositionFromPoint(event.clientX, event.clientY), clicked = place?.offsetNode;
      if (!place || clicked?.nodeType !== window.Node.TEXT_NODE || !preview.contains(clicked)) return show('edit');
      const before: string[] = [], texts = document.createTreeWalker(preview, window.NodeFilter.SHOW_TEXT);
      for (let text = texts.nextNode(); text && text !== clicked; text = texts.nextNode()) before.push(text.nodeValue ?? '');
      show('edit', sourceOffsetOfPreviewText(file.text, before, clicked.nodeValue ?? '', place.offset));
    });
    // The second press of a double click lands in the editor the first one opened, on other text than was
    // clicked. It is not a press on that text, so the caret stays where the first click put it.
    let openedByClickAt: { x: number; y: number } | undefined;
    code.addEventListener('mousedown', event => {
      const sameClick = event.detail > 1 && openedByClickAt && Math.hypot(event.clientX - openedByClickAt.x, event.clientY - openedByClickAt.y) <= CLICK_MOVES_AT_MOST_PX;
      if (sameClick) { event.preventDefault(); event.stopPropagation(); } else openedByClickAt = undefined;
    }, true);
    const body = element('div', '', 'text-file-body');
    body.append(waiting, blank, preview, code);
    root.append(closePrompt, changed, body);

    const render = (textReplaced: boolean) => {
      const language = tools?.textFileLanguage(path, named), rendered = Boolean(tools?.isMarkdown(language)) && mode === 'preview';
      const present = file.status === 'present' && Boolean(tools);
      header.update({
        status: file.status === 'missing' ? { label: 'File missing', tone: 'amber' } : file.status === 'refused' ? { label: file.refusal, tone: 'red' }
          : file.saveError ? { label: `Not saved: ${file.saveError}`, tone: 'red' } : undefined,
        meta: [path, tools ? language?.name ?? 'Plain text' : undefined, file.unsaved ? 'Unsaved' : undefined],
      });
      root.dataset.mode = mode; root.toggleAttribute('data-unsaved', file.unsaved);
      toggle.hidden = !present; toggle.textContent = mode === 'edit' ? 'Preview' : 'Edit';
      reveal.hidden = !services.revealFile || file.status === 'loading' || file.status === 'missing';
      changed.hidden = !file.changedOnDisk; changedLine.textContent = file.changedOnDisk?.state === 'missing' ? 'Deleted on disk' : 'Changed on disk';
      waiting.hidden = file.status !== 'loading' && Boolean(tools);
      blank.hidden = file.status !== 'missing' && file.status !== 'refused';
      if (!blank.hidden && (textReplaced || blank.dataset.status !== file.status + file.saveError)) {
        blank.dataset.status = file.status + file.saveError;
        blank.replaceChildren(emptyState(document, file.status === 'missing' ? 'File missing' : file.refusal, { detail: file.saveError ? `${path} · ${file.saveError}` : path }));
        if (file.status === 'missing') { const create = button('Create file', () => { void file.create(); }); create.className = 'btn'; create.dataset.size = 'sm'; blank.append(create); }
      }
      preview.hidden = !present || !rendered; code.hidden = !present || rendered;
      if (!present || !tools) return;
      if (!editor) editor = tools.mountTextEditor(code, { text: file.text, language, writable: mode === 'edit', onSave: saveNow,
        onEdit: text => { file.edit(text); if (file.unsaved !== root.hasAttribute('data-unsaved')) render(false); window.clearTimeout(saveTimer); saveTimer = saveAutomatically ? window.setTimeout(saveNow, SAVE_DELAY_MS) : undefined; } });
      else if (textReplaced) editor.setText(file.text);
      editor.setWritable(mode === 'edit');
      if (rendered && previewedText !== file.text) { previewedText = file.text; renderMarkdown(preview, file.text); void tools.highlightCodeBlocks(preview, file.text); }
    };

    render(false);
    void import('./editor.ts').then(loaded => { tools = loaded; if (!disposed) render(true); })
      .catch(error => { if (!disposed) header.update({ status: { label: `Editor did not load: ${(error as Error).message}`, tone: 'red' }, meta: [path] }); });

    const onFocus = () => { if (active) check(); }, onBlur = () => { if (saveTimer !== undefined) saveNow(); };
    window.addEventListener('focus', onFocus); window.addEventListener('blur', onBlur);
    const applySettings = (preferences: JsonObject) => {
      saveAutomatically = textFileSettings(preferences).saveAutomatically;
      if (!saveAutomatically) { window.clearTimeout(saveTimer); saveTimer = undefined; } else if (file.unsaved) saveNow();
    };
    const stopSettings = services.observePreferences?.(applySettings);
    if (!stopSettings) applySettings({});
    const saveOverDisk = () => { window.clearTimeout(saveTimer); saveTimer = undefined; return file.saveOverDisk().catch(() => {}); };
    return {
      update() {},
      setActive(next) {
        if (next === active) return;
        active = next; window.clearInterval(checkTimer); checkTimer = undefined;
        if (active) { check(); checkTimer = window.setInterval(check, CHECK_INTERVAL_MS); return; }
        closing.agree();
        if (saveAutomatically) void saveOverDisk();
      },
      confirmClose() {
        if (saveAutomatically) { window.clearTimeout(saveTimer); saveTimer = undefined; }
        return closing.confirmClose({ saveAutomatically, shown: () => active && !disposed });
      },
      dispose() {
        window.clearTimeout(saveTimer); disposed = true; closing.agree(); stopSettings?.();
        void openFiles.close(resource.id, path, file, saveAutomatically);
        window.clearInterval(checkTimer); window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur);
        editor?.dispose(); header.dispose(); root.remove();
      },
    };
  },
};
