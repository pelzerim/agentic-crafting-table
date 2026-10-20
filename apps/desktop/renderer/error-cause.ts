/** One plain line for a failure screen; the raw message stays in the details disclosure. */
export function errorCause(message: string, kind: 'load' | 'render') {
  if (kind === 'render') return 'Part of the window stopped working.';
  if (/sqlite|database|SQLITE_/i.test(message)) return 'The workspace database couldn’t be read.';
  if (/did not start|service log launcher/i.test(message)) return 'The workspace service didn’t start.';
  if (/ECONNREFUSED|ENOENT|socket|disconnected|timed? ?out/i.test(message)) return 'The workspace service isn’t responding.';
  return 'Your table couldn’t be loaded.';
}
