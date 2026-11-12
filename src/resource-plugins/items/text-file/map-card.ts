import type { JsonObject, MountedResourceView, ResourceRecord, ResourceViewServices } from '../../types.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import type { FileCheck, FileExcerpt } from './connector.ts';
import { stampOf } from './open-file.ts';

const CHECK_INTERVAL_MS = 5000;

/** The start of the file on the item's map card: Markdown rendered, any other file as its first lines in the
 * colours of its language. The text comes from the `excerpt` action and is held only in this view. While the
 * window is visible the card asks `stat` every five seconds and reads again when the file changed. The
 * grammars are loaded when the first card mounts. */
export function mountTextFileCard(container: HTMLElement, resource: ResourceRecord, services: ResourceViewServices): MountedResourceView {
  const document = container.ownerDocument, window = document.defaultView!;
  const path = String(resource.data.path ?? ''), named = typeof resource.data.language === 'string' ? resource.data.language : undefined;
  const root = document.createElement('div');
  root.className = 'text-file-card';
  container.append(root);
  const tools = Promise.all([import('./language.ts'), import('./highlight.ts')]);
  const run = (actionId: 'stat' | 'excerpt') => services.runAction('resource.action', { actionId, input: {} as JsonObject });
  let shownStamp: string | undefined, reading = false, disposed = false;

  const show = async (excerpt: FileExcerpt) => {
    if (excerpt.state !== 'present') {
      shownStamp = stampOf(excerpt); root.dataset.state = excerpt.state;
      root.textContent = excerpt.state === 'missing' ? 'File missing' : excerpt.reason;
      return;
    }
    const [{ textFileLanguage, isMarkdown }, { codeRuns, highlightCodeBlocks, runNodes }] = await tools;
    const language = textFileLanguage(path, named);
    const runs = language && !isMarkdown(language) ? await codeRuns(excerpt.text, language).catch(() => undefined) : undefined;
    if (disposed) return;
    shownStamp = stampOf(excerpt); root.dataset.state = 'present';
    if (isMarkdown(language)) {
      const rendered = document.createElement('div');
      rendered.className = 'markdown-content';
      renderMarkdown(rendered, excerpt.text);
      root.replaceChildren(rendered);
      void highlightCodeBlocks(rendered, excerpt.text);
      return;
    }
    const block = document.createElement('pre'), code = document.createElement('code');
    code.append(...(runs ? runNodes(document, runs) : [excerpt.text]));
    block.append(code);
    root.replaceChildren(block);
  };

  const refresh = async () => {
    if (reading || disposed) return;
    reading = true;
    try {
      if (shownStamp !== undefined && stampOf(await run('stat') as FileCheck) === shownStamp) return;
      const excerpt = await run('excerpt') as FileExcerpt;
      if (!disposed) await show(excerpt);
    } catch { /* The card keeps what it shows; the next check asks again. */ } finally { reading = false; }
  };

  void refresh();
  const checkTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, CHECK_INTERVAL_MS);
  const onFocus = () => { void refresh(); };
  window.addEventListener('focus', onFocus);
  return {
    update() { void refresh(); },
    dispose() { disposed = true; window.clearInterval(checkTimer); window.removeEventListener('focus', onFocus); root.remove(); },
  };
}
