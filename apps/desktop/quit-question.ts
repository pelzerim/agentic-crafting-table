/** The part of a BrowserWindow the question uses. */
export type QuitQuestionWindow = {
  isDestroyed(): boolean;
  webContents: { id: number; isDestroyed(): boolean; send(channel: string, value: unknown): void; on(event: string, listener: () => void): unknown; removeListener(event: string, listener: () => void): unknown };
};

/** What ends a page without an answer from it. */
const pageGone = ['destroyed', 'render-process-gone', 'did-navigate'] as const;

/** Asks every window whether the app may quit. A window acknowledges the question at once (`'asking'`) and
 * answers when its open views have saved or the person has decided; that answer is waited for without a limit.
 * A window that cannot be asked agrees: one that does not acknowledge in time, and one whose page goes away. A
 * window that has not answered `showAfterMs` after acknowledging is shown, because a view in it is asking the
 * person or is still saving. */
export function createQuitQuestion<Window extends QuitQuestionWindow>({ windows, show, acknowledgeWithinMs = 2000, showAfterMs = 400 }: { windows(): Window[]; show(window: Window): void; acknowledgeWithinMs?: number; showAfterMs?: number }) {
  let questions = 0;
  const asked = new Map<string, { acknowledge(): void; give(agreed: boolean): void }>();
  const askWindow = (id: number, window: Window) => new Promise<boolean>(resolve => {
    const contents = window.webContents, key = `${id}:${contents.id}`;
    let showTimer: NodeJS.Timeout | undefined;
    const give = (agreed: boolean) => {
      if (!asked.delete(key)) return;
      clearTimeout(unacknowledged); clearTimeout(showTimer);
      for (const event of pageGone) contents.removeListener(event, agree);
      resolve(agreed);
    };
    const agree = () => give(true);
    const unacknowledged = setTimeout(agree, acknowledgeWithinMs);
    asked.set(key, {
      acknowledge() {
        clearTimeout(unacknowledged);
        showTimer ??= setTimeout(() => { if (!window.isDestroyed()) show(window); }, showAfterMs);
      },
      give,
    });
    for (const event of pageGone) contents.on(event, agree);
    contents.send('app:before-quit', { id });
  });
  return {
    async ask() {
      const id = ++questions;
      const answers = await Promise.all(windows().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed()).map(window => askWindow(id, window)));
      return answers.every(Boolean);
    },
    /** A message a window sent on `app:before-quit-answer`. */
    answer(senderId: number, message: unknown) {
      if (typeof message !== 'object' || message === null) return;
      const { id, answer } = message as { id?: unknown; answer?: unknown };
      const open = typeof id === 'number' ? asked.get(`${id}:${senderId}`) : undefined;
      if (!open) return;
      if (answer === 'asking') open.acknowledge(); else if (typeof answer === 'boolean') open.give(answer);
    },
  };
}
