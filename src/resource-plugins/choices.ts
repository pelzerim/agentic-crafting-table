import type { ChoiceConfirm, ChoiceSource, JsonObject, ResourceChoices, ResourceViewServices } from './types.ts';
type Services = Pick<ResourceViewServices, 'runAction'>;
const bounded = (value: unknown, max: number, optional = false) => optional && value === undefined || typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
function validConfirm(confirm: ChoiceConfirm | undefined, context: JsonObject) {
  if (confirm === undefined) return true;
  if (!confirm || typeof confirm !== 'object' || !bounded(confirm.prompt, 500) || !bounded(confirm.action, 60) || !bounded(confirm.note, 300, true)) return false;
  const text = confirm.text;
  return text === undefined || Boolean(text) && typeof text === 'object' && typeof text.field === 'string' && /^[a-z][A-Za-z0-9]{0,39}$/.test(text.field) && !['value', 'requestId', ...Object.keys(context)].includes(text.field)
    && bounded(text.label, 80) && bounded(text.placeholder, 200, true) && Number.isSafeInteger(text.maxLength) && text.maxLength >= 1 && text.maxLength <= 60_000;
}
export async function loadResourceChoices(services: Services, actionId: string, runtime?: string): Promise<ResourceChoices> {
  const value = await (runtime ? services.runAction(runtime, { operation: actionId }) : services.runAction('resource.action', { actionId, input: {} })) as unknown as ResourceChoices;
  if (!value || typeof value.current !== 'string' || !value.context || typeof value.context !== 'object' || Array.isArray(value.context) || !Array.isArray(value.options) || !value.options.length || value.options.length > 250 || value.options.some(option => !option || typeof option.id !== 'string' || !option.id || typeof option.label !== 'string' || !option.label.trim())) throw new Error('Status options are unavailable. Try opening the menu again.');
  if (new Set(value.options.map(option => option.id)).size !== value.options.length || value.current && !value.options.some(option => option.id === value.current) || value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 500)
    || value.options.some(option => !validConfirm(option.confirm, value.context))) throw new Error('Status options are inconsistent. Reopen the menu.');
  return value;
}
/** `text` is what the person typed into the option's confirmation field, if it has one. */
export function choiceInput(choices: ResourceChoices, value: string, text?: string): JsonObject {
  const option = choices.options.find(option => option.id === value && !option.disabled);
  if (!option) throw new Error('This choice is unavailable. Reopen the menu.');
  const field = option.confirm?.text;
  if (field && text && text.length > field.maxLength) throw new Error(`${field.label} can be at most ${field.maxLength.toLocaleString('en-US')} characters.`);
  return { ...choices.context, value, ...(field && text?.trim() ? { [field.field]: text } : {}), requestId: crypto.randomUUID() };
}

/** Small anchored menu for plugin views. Local choices use the same service
 * actions as the map/MCP; unmounting never retries or cancels a remote write.
 * `only` narrows the menu to one option: one with a confirmation opens straight into it.
 * A trigger collapsed into a header menu is invisible, so the menu anchors at and returns focus to that menu's button.
 * `choose` receives the picked option's input instead of applying it, for a caller that asks something else first.
 * `reportLoad` also reports a failure to load the choices, not only one to apply them.
 * `first` applies the first available option at once, without a menu, unless the choices warn about blockers. */
export function openResourceChoices(trigger: HTMLButtonElement, services: Services, actions: ChoiceSource, updated: () => Promise<void>, report: (message: string) => void,
  labels: { menu: string; loading: string; pending: string; confirm?: string; only?: string; reportLoad?: boolean; first?: boolean } = { menu: 'Change status', loading: 'Loading statuses…', pending: 'Updating status…' }, choose?: (input: JsonObject) => void) {
  const document = trigger.ownerDocument, menu = document.createElement('div');
  menu.className = 'resource-choice-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', labels.menu); menu.textContent = labels.loading;
  document.body.append(menu); trigger.setAttribute('aria-expanded', 'true');
  let disposed = false, busy = false;
  const shown = () => trigger.hasAttribute('data-view-overflow') ? trigger.closest('.view-header-tools')?.querySelector<HTMLElement>('.view-more') ?? trigger : trigger;
  const place = () => { const rect = shown().getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - menu.offsetWidth - 8))}px`; menu.style.top = `${Math.max(8, Math.min(rect.bottom + 5, document.documentElement.clientHeight - menu.offsetHeight - 8))}px`; };
  const close = (focus = false) => { if (disposed) return; disposed = true; menu.remove(); trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); document.removeEventListener('scroll', scroll, true); document.defaultView?.removeEventListener('resize', place); if (focus) shown().focus(); };
  const outside = (event: Event) => { if (!menu.contains(event.target as Node) && event.target !== trigger) close(); };
  const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => {
    // A confirmation's text field keeps its own caret and Tab keys.
    if (event.key !== 'Escape' && event.target instanceof HTMLTextAreaElement && menu.contains(event.target)) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); document.addEventListener('scroll', scroll, true); document.defaultView?.addEventListener('resize', place);
  menu.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); close(true); };
  place();
  void loadResourceChoices(services, actions.load, actions.runtime).then(loaded => {
    if (disposed) return;
    const choices = labels.only ? { ...loaded, options: loaded.options.filter(option => option.id === labels.only) } : loaded;
    if (!choices.options.length) throw new Error('This action is unavailable right now. Refresh and try again.');
    menu.replaceChildren();
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.setAttribute('role', 'menuitem'); cancel.textContent = 'Cancel'; cancel.setAttribute('aria-label', 'Cancel'); cancel.className = 'resource-choice-cancel';
    cancel.onclick = () => close(true);
    if (actions.irreversible) { menu.dataset.irreversible = ''; menu.append(cancel); }
    const direct = choices.options.length === 1 && labels.only && choices.options[0].confirm && !choices.options[0].disabled;
    if (choices.prompt && !direct) { const prompt = document.createElement('p'); prompt.className = 'resource-choice-prompt'; prompt.textContent = choices.prompt; menu.append(prompt); }
    const apply = (option: ResourceChoices['options'][number], text?: string) => {
      if (busy || disposed) return;
      const input = choiceInput(choices, option.id, text);
      if (choose) { close(true); choose(input); return; }
      busy = true; trigger.disabled = true; report(labels.pending); close(true);
      void (actions.runtime ? services.runAction(actions.runtime, { operation: actions.apply, ...input }) : services.runAction('resource.action', { actionId: actions.apply, input }))
        // Re-enable and clear the pending label before refreshing, so the refreshed view decides the final state and notice.
        .then(() => { trigger.disabled = false; report(''); return updated(); }).catch(error => { trigger.disabled = false; report(error.message ?? String(error)); });
    };
    const first = labels.first && !choices.context.overrideBlockers ? choices.options.find(option => !option.disabled) : undefined;
    if (first) { apply(first); return; }
    const options = new Map<HTMLButtonElement, boolean>();
    const confirm = (button: HTMLButtonElement, option: ResourceChoices['options'][number]) => {
      const box = document.createElement('div'), text = document.createElement('p'), subject = document.createElement('b'), back = document.createElement('button'), go = document.createElement('button');
      const own = option.confirm;
      box.className = 'resource-choice-confirm'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', option.label);
      subject.textContent = own?.prompt ?? (choices.options.length === 1 && choices.prompt ? choices.prompt : `${option.label}?`);
      text.append(subject, own ? own.note ? ` ${own.note}` : '' : ' This can’t be undone from here.');
      for (const [control, label] of [[back, direct ? 'Cancel' : 'Back'], [go, own?.action ?? labels.confirm ?? 'Confirm']] as const) { control.type = 'button'; control.setAttribute('role', 'menuitem'); control.textContent = label; }
      go.className = 'resource-choice-go';
      let field: HTMLTextAreaElement | undefined, fieldLabel: HTMLLabelElement | undefined;
      if (own?.text) {
        fieldLabel = document.createElement('label'); fieldLabel.className = 'resource-choice-text'; fieldLabel.textContent = own.text.label;
        field = document.createElement('textarea'); field.rows = 3; field.maxLength = own.text.maxLength; if (own.text.placeholder) field.placeholder = own.text.placeholder;
        fieldLabel.append(field);
      }
      const restore = () => { if (direct) { close(true); return; } box.replaceWith(button); for (const [other, disabled] of options) other.disabled = disabled; button.focus(); };
      back.onclick = restore; go.onclick = () => apply(option, field?.value);
      box.append(text, ...(fieldLabel ? [fieldLabel] : []), back, go); for (const other of options.keys()) other.disabled = true;
      button.replaceWith(box); place(); (field ?? back).focus();
    };
    for (const option of choices.options) {
      const button = document.createElement('button'); button.type = 'button'; if (choices.current) { button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(option.id === choices.current)); } else button.setAttribute('role', 'menuitem');
      button.textContent = option.label; button.setAttribute('aria-label', option.label); button.disabled = option.id === choices.current || Boolean(option.disabled);
      if (option.description) { const note = document.createElement('small'); note.textContent = option.description; button.append(note); button.title = option.description; }
      button.onclick = () => { if (option.confirm || actions.irreversible && !(actions.pickConfirms && choices.prompt)) confirm(button, option); else apply(option); };
      options.set(button, button.disabled); menu.append(button);
    }
    if (direct) { cancel.remove(); confirm(options.keys().next().value!, choices.options[0]); return; }
    if (!choices.current && !actions.irreversible) menu.append(cancel);
    place(); (actions.irreversible ? cancel : menu.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }).catch(error => {
    if (disposed) return;
    // The menu keeps its role so Escape closes only the menu, not the view behind it.
    const alert = document.createElement('p'); alert.setAttribute('role', 'alert'); alert.textContent = error.message ?? String(error); menu.replaceChildren(alert); place();
    if (labels.reportLoad) report(alert.textContent);
  });
  return close;
}
