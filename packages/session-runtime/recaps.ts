import { open } from 'node:fs/promises';
import { redactSecrets } from './activity-summary.ts';

/** Characters a recap keeps on the node. */
export const RECAP_LENGTH = 600;
/** Bytes read from the end of a transcript when looking for its newest recap. */
export const RECAP_TAIL_BYTES = 256 * 1024;
const SETTING_HINT = /\s*\(disable recaps in \/config\)\s*$/i;

export interface Recap { text: string; at: string }

function clipRecap(text: string) {
  if (text.length <= RECAP_LENGTH) return text;
  const cut = text.slice(0, RECAP_LENGTH - 1), boundary = cut.replace(/\s+\S*$/, '');
  return `${(boundary || cut).replace(/[\s,;:]+$/, '')}…`;
}

/** The newest `away_summary` Claude Code wrote into these transcript lines: redacted, flattened and capped.
 * Other entries and malformed lines are skipped. */
export function newestRecap(lines: Iterable<string>): Recap | undefined {
  let newest: { at: number; recap: Recap } | undefined;
  for (const line of lines) {
    if (!line.includes('away_summary')) continue;
    let entry: { type?: unknown; subtype?: unknown; content?: unknown; timestamp?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'system' || entry.subtype !== 'away_summary' || typeof entry.content !== 'string' || typeof entry.timestamp !== 'string') continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at) || (newest && newest.at > at)) continue;
    const text = clipRecap(redactSecrets(entry.content.replace(SETTING_HINT, '')).replace(/\s+/g, ' ').trim());
    if (text) newest = { at, recap: { text, at: new Date(at).toISOString() } };
  }
  return newest?.recap;
}

/** The newest recap in the last `RECAP_TAIL_BYTES` of a transcript; a line cut by the tail's start is skipped. */
export async function readRecap(file: string): Promise<Recap | undefined> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat(), start = Math.max(0, size - RECAP_TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return newestRecap(start > 0 ? lines.slice(1) : lines);
  } finally { await handle.close(); }
}
