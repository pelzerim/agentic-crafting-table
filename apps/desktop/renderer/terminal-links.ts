import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal, ILinkHandler } from '@xterm/xterm';
import { browserUrl } from '../browser-url.ts';

export interface TerminalLink { url: string; x: number; y: number }
export function bindTerminalLinks(terminal: Terminal, open: (link: TerminalLink) => void) {
  let hovered: string | undefined, down: { x: number; y: number } | undefined;
  const handler = {
    allowNonHttpProtocols: false,
    hover(_event, uri) { try { hovered = browserUrl(uri); } catch { hovered = undefined; } },
    leave() { hovered = undefined; },
    activate(event, uri) {
      // A selection drag, auxiliary click or forced-selection modifier is not
      // navigation. xterm owns wrapped ranges and hover decorations.
      if (event.button !== 0 || event.shiftKey || down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      try {
        const url = browserUrl(uri);
        event.preventDefault(); event.stopPropagation();
        terminal.clearSelection();
        open({ url, x: event.clientX, y: event.clientY });
      } catch { /* Non-browser links cannot reach either native bridge. */ }
    },
  } satisfies ILinkHandler;
  const addon = new WebLinksAddon(handler.activate, { hover: handler.hover, leave: handler.leave });
  terminal.options.linkHandler = handler;
  terminal.loadAddon(addon);
  const element = terminal.element!, screen = element.querySelector('.xterm-screen')!;
  const rememberDown = (event: MouseEvent) => { down = { x: event.clientX, y: event.clientY }; };
  element.addEventListener('mousedown', rememberDown, true);
  // Linkifier runs on the screen, before the outer terminal's mouse-reporting
  // listeners. Keep a link click out of a TUI's input stream. Shift-drag still
  // reaches xterm's normal forced-selection path; shell selection is unchanged.
  const mouse = (event: Event) => {
    const e = event as MouseEvent;
    if (hovered && !e.shiftKey && terminal.modes.mouseTrackingMode !== 'none') {
      event.stopPropagation();
      if (event.type === 'mousedown' && e.button === 0) terminal.focus();
    }
  };
  screen.addEventListener('mousedown', mouse); screen.addEventListener('mousemove', mouse);
  return () => { element.removeEventListener('mousedown', rememberDown, true); screen.removeEventListener('mousedown', mouse); screen.removeEventListener('mousemove', mouse); addon.dispose(); terminal.options.linkHandler = undefined; };
}
