const FALLBACK = 'That didn’t work. Your table is unchanged.';
const CAUSES: [RegExp, string][] = [
  [/ENOENT|no such file/i, 'A file or folder it needed is missing.'],
  [/EACCES|EPERM|permission denied/i, 'Permission was denied.'],
  [/ECONNREFUSED|socket hang up|disconnected/i, 'The workspace service isn’t responding.'],
  [/sqlite|SQLITE_|database/i, 'The workspace database couldn’t be updated.'],
  [/timed? ?out|ETIMEDOUT/i, 'It took too long to respond. Try again.'],
  [/fetch failed|ENOTFOUND|EAI_AGAIN|network/i, 'Couldn’t reach the provider. Try again in a moment.'],
];

/** One human line for a failure; raw provider or IPC text is kept only as `details`. */
export function humanError(raw: string): { message: string; details?: string } {
  const text = raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^(?:[A-Z]\w*)?Error(?: \[\w+\])?: /, '').trim();
  if (!text) return raw.trim() ? { message: FALLBACK, details: raw } : { message: FALLBACK };
  const technical = /\bE[A-Z]{3,}\b|\b[A-Z]+_[A-Z_]+\b|undefined|null|\bat \S+:\d+|\d+ ?ms\b|[{}]|\/\w[\w.-]*\//.test(text) || !/^[A-Z]/.test(text) || text.length > 200;
  if (!technical) return text === raw ? { message: text } : { message: text, details: raw };
  return { message: CAUSES.find(([pattern]) => pattern.test(raw))?.[1] ?? FALLBACK, details: raw };
}
