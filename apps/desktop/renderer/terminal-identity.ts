import type { IParser } from '@xterm/xterm';
import { PIXEL_MOUSE, modeReply, versionReply } from '../../../packages/session-runtime/terminal-identity.ts';

/** What the view's emulator adds to xterm's own answers. The supervisor gives
 * the same answers for a session no view is watching. */
export function bindTerminalIdentity(terminal: { parser: Pick<IParser, 'registerCsiHandler'> }, write: (data: string) => void) {
  const version = terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, params => {
    if (params.length && params[0] !== 0) return false;
    write(versionReply);
    return true;
  });
  const modes = terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, params => {
    if (params[0] !== PIXEL_MOUSE) return false;
    write(modeReply(PIXEL_MOUSE, 0));
    return true;
  });
  return { dispose() { version.dispose(); modes.dispose(); } };
}
