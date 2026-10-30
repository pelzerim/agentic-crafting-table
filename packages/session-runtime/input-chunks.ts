/** One write `sessions.input` accepts. */
export const MAX_SESSION_INPUT = 64 * 1024;

/** Splits input for `sessions.input` in order, keeping surrogate pairs whole. */
export function sessionInputChunks(data: string, size = MAX_SESSION_INPUT) {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(data.length, start + size);
    if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(data.slice(start, end)); start = end;
  }
  return chunks;
}
