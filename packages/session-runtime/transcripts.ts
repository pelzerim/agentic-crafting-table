import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from './activity-summary.ts';
import { clockTime, localDate } from '../core/reminders.ts';

/** Characters of one day's conversation sent for a digest, after redaction. */
export const TRANSCRIPT_LIMIT = 24_000;
const HEAD = 3000, REPLY = 1200, PROMPT = 2000, TOOL_ERROR = 160;
export interface DaySlice { prompts: number; replies: number; tools: Record<string, number>; lines: string[] }

/** Only the host reads native transcripts. A slice and its evidence stay in the service; only the digest written from them is stored or shown. */
export const claudeConfigDirectory = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export function claudeTranscript(sessionId: string, directory = claudeConfigDirectory()): string | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return undefined;
  let names: string[]; try { names = readdirSync(join(directory, 'projects')); } catch { return undefined; }
  for (const name of names) { const file = join(directory, 'projects', name, `${sessionId}.jsonl`); if (existsSync(file)) return file; }
  return undefined;
}

const flat = (text: string, limit: number) => { const value = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<(?:command-[a-z]+|local-command-[a-z]+)>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim(); return value.length > limit ? value.slice(0, limit) + '…' : value; };
const blocks = (content: unknown): Record<string, unknown>[] => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object') : [];
const resultText = (content: unknown) => typeof content === 'string' ? content : blocks(content).map(block => typeof block.text === 'string' ? block.text : '').join(' ');

/** The asked local days of a Claude transcript: my prompts, Claude's text replies, tool names and short tool errors.
 * Thinking, raw tool output, meta and subagent entries are left out. */
export function sliceTranscript(lines: Iterable<string>, days: ReadonlySet<string>) {
  const slices = new Map<string, DaySlice>();
  for (const line of lines) {
    let entry: { type?: unknown; timestamp?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || entry.isSidechain || typeof entry.timestamp !== 'string') continue;
    const at = Date.parse(entry.timestamp); if (!Number.isFinite(at)) continue;
    const day = localDate(at); if (!days.has(day)) continue;
    const slice = slices.get(day) ?? { prompts: 0, replies: 0, tools: {}, lines: [] }; slices.set(day, slice);
    const stamp = `[${clockTime(at)}]`;
    for (const block of blocks(entry.message?.content)) {
      if (entry.type === 'user' && block.type === 'text' && typeof block.text === 'string') {
        const text = flat(block.text, PROMPT); if (text) { slice.prompts++; slice.lines.push(`${stamp} Me: ${text}`); }
      } else if (entry.type === 'user' && block.type === 'tool_result' && block.is_error === true) {
        const text = flat(resultText(block.content), TOOL_ERROR); if (text) slice.lines.push(`${stamp} Tool error: ${text}`);
      } else if (entry.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
        const text = flat(block.text, REPLY); if (text) { slice.replies++; slice.lines.push(`${stamp} Claude: ${text}`); }
      } else if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') slice.tools[block.name.slice(0, 80)] = (slice.tools[block.name.slice(0, 80)] ?? 0) + 1;
    }
  }
  return slices;
}
export async function readTranscriptDays(file: string, days: ReadonlySet<string>) {
  const lines: string[] = [];
  for await (const line of createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })) if (line.length < 2_000_000 && line.includes('"timestamp"')) lines.push(line);
  return sliceTranscript(lines, days);
}

/** Redacted and capped at TRANSCRIPT_LIMIT: the day's first lines (the ask), then its latest, then the tools used. */
export function transcriptEvidence(slice: DaySlice) {
  const lines = slice.lines.map(line => redactSecrets(line)), tools = Object.entries(slice.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `${name} ×${count}`).join(', ');
  const footer = tools ? `\nTools used: ${tools}` : '', budget = TRANSCRIPT_LIMIT - footer.length - 60;
  let text = lines.join('\n');
  if (text.length > budget) {
    const head: string[] = [], tail: string[] = []; let used = 0;
    for (const line of lines) { if (used + line.length + 1 > HEAD) break; head.push(line); used += line.length + 1; }
    for (let index = lines.length - 1; index >= head.length; index--) { if (used + lines[index].length + 1 > budget) break; tail.unshift(lines[index]); used += lines[index].length + 1; }
    text = [...head, `[… ${lines.length - head.length - tail.length} earlier lines left out …]`, ...tail].join('\n');
  }
  return (text + footer).trim();
}
