import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';

type PresenceWindow = Pick<EventEmitter, 'once' | 'removeListener'> &
  Pick<BrowserWindow, 'isMinimized' | 'isFullScreen' | 'setFullScreen' | 'restore' | 'show' | 'focus' | 'hide'>;

/** On macOS the window button and Cmd+W hide the window; Quit stops sessions. */
export const closeHidesWindow = (platform: NodeJS.Platform) => platform === 'darwin';

/** Hidden background test windows never show or take focus, but still report presence. */
export function createWindowPresence(background: boolean) {
  let pendingHide: { window: PresenceWindow; listener: () => void } | undefined;
  const cancelPendingHide = () => { if (pendingHide) pendingHide.window.removeListener('leave-full-screen', pendingHide.listener); pendingHide = undefined; };
  const presence = {
    state: 'shown' as 'shown' | 'hidden',
    hide(window: PresenceWindow) {
      presence.state = 'hidden'; cancelPendingHide();
      if (background) return;
      // Hiding a full-screen window would leave an empty space on its own Space.
      if (window.isFullScreen()) {
        const listener = () => { pendingHide = undefined; window.hide(); };
        pendingHide = { window, listener }; window.once('leave-full-screen', listener); window.setFullScreen(false);
      } else window.hide();
    },
    reveal(window: PresenceWindow) {
      presence.state = 'shown'; cancelPendingHide();
      if (background) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    },
  };
  return presence;
}
