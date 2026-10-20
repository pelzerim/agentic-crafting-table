import { formatWhen, whenDate } from './format-when.ts';
import type { ResourceIndicator } from './indicators.ts';
import type { ResourceViewServices } from './types.ts';
import { pixelGlyphElement } from './pixel-glyphs.ts';

export type ChipTone = ResourceIndicator['tone'];
/** `pending` marks an expected state the provider has not confirmed: “Merged · confirming”. */
export interface ViewChip { label: string; tone?: ChipTone; pending?: boolean }
/** What a plugin supplies for the host-rendered frame bar: status, one meta line, the provider link. */
export interface ViewHeaderData {
  status?: ViewChip;
  meta?: readonly (string | false | null | undefined)[];
  link?: { url: string; provider: string };
}
export interface Freshness { observedAt?: string; stale?: boolean; error?: string; provider: string }

export function freshnessCopy(value: Freshness, now = Date.now()) {
  const date = whenDate(value.observedAt);
  if (!date) return { text: value.stale ? 'Saved copy' : '', title: value.error ?? '', stale: Boolean(value.stale) };
  if (value.stale) return { text: `Saved copy · ${formatWhen(date, 'stamp', now)}`, title: value.error || `Saved ${formatWhen(date, 'full', now)}`, stale: true };
  return { text: `Read ${formatWhen(date, 'relative', now)}`, title: `Read from ${value.provider} ${formatWhen(date, 'full', now)}`, stale: false };
}

export function staleNotice(value: Freshness, now = Date.now()) {
  const date = whenDate(value.observedAt), reason = value.error?.trim() || 'Refresh is unavailable.';
  return `Couldn’t refresh from ${value.provider}. ${/[.!?]$/.test(reason) ? reason : `${reason}.`}${date ? ` You’re reading the copy saved at ${formatWhen(date, 'stamp', now)}.` : ''}`;
}

export function statusChip(document: Document, chip?: ViewChip, element: HTMLElement = document.createElement('span')) {
  element.classList.add('view-chip');
  element.textContent = chip?.pending ? `${chip.label} · confirming` : chip?.label ?? '';
  element.dataset.tone = chip?.tone ?? 'neutral';
  element.toggleAttribute('data-pending', Boolean(chip?.label && chip.pending));
  element.hidden = !chip?.label;
  return element;
}

export function timeElement(document: Document, at: string | number | undefined, mode: Parameters<typeof formatWhen>[1] = 'relative') {
  const time = document.createElement('time'), date = whenDate(at);
  if (date) { time.dateTime = date.toISOString(); time.title = formatWhen(date, 'full'); time.textContent = formatWhen(date, mode); }
  return time;
}

/** "Read 2 min ago" or an amber "Saved copy · 14:02"; the relative text keeps itself current. */
export function freshnessStamp(document: Document) {
  const element = document.createElement('time'); element.className = 'view-freshness';
  let value: Freshness | undefined, reading = false;
  const paint = () => {
    if (!value) { element.textContent = reading ? 'Reading…' : ''; element.hidden = !reading; element.removeAttribute('data-stale'); return; }
    const copy = freshnessCopy(value), date = whenDate(value.observedAt);
    element.textContent = copy.text; element.title = copy.title; element.hidden = !copy.text;
    element.toggleAttribute('data-stale', copy.stale);
    if (date) element.dateTime = date.toISOString(); else element.removeAttribute('datetime');
  };
  const timer = document.defaultView?.setInterval(paint, 30_000);
  paint();
  return { element, update(next?: Freshness) { value = next; paint(); }, reading(next: boolean) { reading = next; paint(); }, dispose() { document.defaultView?.clearInterval(timer); } };
}

/** A muted, centred block for an empty body, with an optional way out. */
export function emptyState(document: Document, line: string, options: { detail?: string; action?: { label: string; url: string } } = {}) {
  const block = document.createElement('div'), glyph = document.createElement('span'), heading = document.createElement('p');
  block.className = 'view-empty'; glyph.className = 'view-empty-glyph'; glyph.setAttribute('aria-hidden', 'true');
  heading.className = 'view-empty-line'; heading.textContent = line; block.append(glyph, heading);
  if (options.detail) { const detail = document.createElement('p'); detail.className = 'view-empty-detail'; detail.textContent = options.detail; block.append(detail); }
  if (options.action) { const link = document.createElement('a'); link.className = 'view-link-out'; link.href = options.action.url; link.textContent = options.action.label; link.target = '_blank'; link.rel = 'noopener noreferrer'; block.append(link); }
  return block;
}

/** Three pixel lines standing in for the body until the first read arrives. */
export function skeleton(document: Document) {
  const block = document.createElement('div'); block.className = 'view-skeleton'; block.setAttribute('aria-hidden', 'true');
  for (let line = 0; line < 3; line++) block.append(document.createElement('i'));
  return block;
}

/** Secondary header actions that no longer fit in `row` move behind a "More actions" button. A
 * collapsed action stays in place, invisible under that button, so a menu it opens anchors there.
 * With `always`, every action lives in that one menu: the primary one is marked, a disabled one
 * says why, and a rule separates actions whose `data-menu-group` differs. */
function overflowActions(document: Document, actions: HTMLElement, more: HTMLButtonElement, row: HTMLElement, always?: string) {
  const window = document.defaultView;
  let collapsed: HTMLElement[] = [], frame = 0, menu: HTMLElement | undefined;
  const label = (control: HTMLElement) => control.getAttribute('aria-label') || control.textContent?.trim() || '';
  const close = (focus = false) => {
    if (!menu) return;
    menu.remove(); menu = undefined; more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true);
    if (focus) more.focus();
  };
  const outside = (event: Event) => { if (!menu?.contains(event.target as Node) && !more.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => {
    if (!menu) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const open = () => {
    const list = document.createElement('div'); list.className = 'resource-choice-menu view-more-menu'; list.setAttribute('role', 'menu'); list.setAttribute('aria-label', always ?? 'More actions');
    let group: string | undefined;
    for (const control of collapsed) {
      if (always && list.childElementCount && control.dataset.menuGroup !== group) { const rule = document.createElement('div'); rule.className = 'view-menu-rule'; rule.setAttribute('role', 'separator'); list.append(rule); }
      group = control.dataset.menuGroup;
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = label(control); item.setAttribute('aria-label', label(control));
      if (always) { item.toggleAttribute('data-primary', control.hasAttribute('data-primary') && !control.matches(':disabled')); if (control.matches(':disabled') && control.title) { const why = document.createElement('small'); why.textContent = control.title; item.append(why); } }
      item.disabled = control.matches(':disabled'); item.toggleAttribute('data-menu', control.hasAttribute('aria-haspopup'));
      item.onclick = () => { close(); control.click(); };
      list.append(item);
    }
    menu = list; document.body.append(list); more.setAttribute('aria-expanded', 'true');
    const rect = more.getBoundingClientRect(), width = document.documentElement.clientWidth;
    list.style.left = `${Math.max(8, Math.min(rect.right - list.offsetWidth, width - list.offsetWidth - 8))}px`; list.style.top = `${rect.bottom + 5}px`;
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  more.onclick = () => { if (menu) close(); else open(); };
  const overflows = () => row.scrollWidth > row.clientWidth + 1;
  const fit = () => {
    frame = 0;
    const before = collapsed.map(label).join('\n');
    for (const control of collapsed) control.removeAttribute('data-view-overflow');
    collapsed = []; more.hidden = true; row.removeAttribute('data-view-tight');
    if (always) {
      collapsed = [...actions.querySelectorAll<HTMLElement>('button, a[href]')].filter(control => control.checkVisibility());
      for (const control of collapsed) control.setAttribute('data-view-overflow', '');
      more.hidden = !collapsed.length; row.toggleAttribute('data-view-tight', row.isConnected && overflows());
    } else if (row.isConnected && overflows()) {
      const candidates = [...actions.querySelectorAll<HTMLElement>('button, a[href]')]
        .filter(control => !control.hasAttribute('data-primary') && control.checkVisibility()).reverse();
      for (const control of candidates) {
        control.setAttribute('data-view-overflow', ''); collapsed.unshift(control); more.hidden = false;
        if (!overflows()) break;
      }
      row.toggleAttribute('data-view-tight', overflows());
    }
    if (collapsed.map(label).join('\n') !== before) close();
    if (always) more.toggleAttribute('data-primary', collapsed.some(control => control.hasAttribute('data-primary') && !control.matches(':disabled')));
  };
  const schedule = () => { if (!frame && window) frame = window.requestAnimationFrame(fit); };
  const resized = window?.ResizeObserver ? new window.ResizeObserver(schedule) : undefined;
  resized?.observe(row);
  const changed = window?.MutationObserver ? new window.MutationObserver(schedule) : undefined;
  changed?.observe(actions, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'data-primary', 'class'] });
  schedule();
  return { dispose() { close(); resized?.disconnect(); changed?.disconnect(); if (frame) window?.cancelAnimationFrame(frame); } };
}

/** The host-owned header, written into the expanded frame's title bar or at the top of `fallback`
 * when there is no frame. Its controls (actions · ⋯ · ↗ · ↻) share the title row; its status
 * (chip · meta · freshness) is a second row under it. `menu` names a single menu button that
 * holds every action instead of a row of buttons. */
export function mountViewHeader(document: Document, services: Pick<ResourceViewServices, 'frameToolbar' | 'openUrl'>, fallback: HTMLElement, options: { chip?: HTMLElement; onRefresh?: () => void; menu?: string } = {}) {
  const element = document.createElement('div'), status = document.createElement('div'), tools = document.createElement('div');
  const meta = document.createElement('span'), actions = document.createElement('span'), way = document.createElement('span'), more = document.createElement('button');
  const chip = options.chip ?? statusChip(document), open = document.createElement('a'), refresh = document.createElement('button'), freshness = freshnessStamp(document);
  chip.classList.add('view-chip'); element.className = 'view-header'; status.className = 'view-header-status'; tools.className = 'view-header-tools';
  meta.className = 'view-meta'; actions.className = 'view-actions'; way.className = 'view-way-out';
  more.type = 'button'; more.className = 'view-more';
  if (options.menu) { more.classList.add('view-menu'); more.textContent = options.menu; more.setAttribute('aria-label', options.menu); element.dataset.menu = ''; }
  else { more.append(pixelGlyphElement(document, 'more')); more.setAttribute('aria-label', 'More actions'); more.title = 'More actions'; }
  more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.hidden = true;
  open.className = 'view-open'; open.textContent = '↗'; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.hidden = true;
  open.onclick = event => { if (services.openUrl) { event.preventDefault(); event.stopPropagation(); services.openUrl(open.href); } };
  refresh.type = 'button'; refresh.className = 'view-refresh'; refresh.append(pixelGlyphElement(document, 'refresh')); refresh.setAttribute('aria-label', 'Refresh'); refresh.hidden = !options.onRefresh;
  refresh.onclick = () => options.onRefresh?.();
  way.append(open, refresh); status.append(chip, meta, freshness.element); tools.append(actions, more, way); element.append(status, tools);
  const frame = services.frameToolbar?.();
  if (frame) { element.classList.add('in-frame'); frame.append(element); } else fallback.prepend(element);
  const overflow = frame?.parentElement || options.menu ? overflowActions(document, actions, more, frame?.parentElement ?? element, options.menu) : undefined;
  return {
    element, chip, meta, actions, refresh,
    update(data: ViewHeaderData) {
      if (!options.chip) statusChip(document, data.status, chip);
      const parts = (data.meta ?? []).filter((part): part is string => typeof part === 'string' && part.length > 0);
      meta.textContent = parts.join(' · '); meta.title = meta.textContent; meta.hidden = !parts.length;
      open.hidden = !data.link;
      if (data.link) { open.href = data.link.url; open.title = `Open in ${data.link.provider}`; open.setAttribute('aria-label', `Open in ${data.link.provider}`); }
    },
    freshness(value?: Freshness) {
      freshness.update(value);
      const copy = value ? freshnessCopy(value) : undefined;
      refresh.title = copy?.text ? `Refresh · ${copy.text.replace(/^Read /, 'read ')}` : 'Refresh';
    },
    busy(value: boolean) { refresh.disabled = value; element.toggleAttribute('data-busy', value); freshness.reading(value); },
    dispose() { overflow?.dispose(); freshness.dispose(); element.remove(); },
  };
}
export type ViewHeader = ReturnType<typeof mountViewHeader>;
