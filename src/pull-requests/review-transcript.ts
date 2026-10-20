import { clip } from './review-findings.ts';

export interface TranscriptLine { kind: 'start' | 'text' | 'tool' | 'error' | 'done' | 'plain'; text: string; detail?: string }
type Event = Record<string, any>;

const duration = (ms: unknown) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ''}` : `${seconds} s`;
};
const findingsCount = (value: unknown) => {
  const findings = (value as { findings?: unknown } | undefined)?.findings;
  return Array.isArray(findings) ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : undefined;
};
const flat = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join(' ') : '';

/** Readable lines from a plain-text Claude `stream-json` (or single `json` result)
 * recording. Returns undefined when the recording holds no Claude events, so the
 * caller keeps showing the native terminal. A partly written last line is skipped. */
export function reviewTranscript(recording: string): TranscriptLine[] | undefined {
  const lines: TranscriptLine[] = []; let cwd = '', events = 0;
  const relative = (path: unknown) => { const text = String(path ?? ''); return cwd && text.startsWith(`${cwd}/`) ? text.slice(cwd.length + 1) : text; };
  for (const raw of recording.split('\n')) {
    const entry = raw.trim(); if (!entry) continue;
    let event: Event | undefined;
    if (entry.startsWith('{')) { try { event = JSON.parse(entry); } catch { continue; } }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') { lines.push({ kind: 'plain', text: clip(entry, 400) }); continue; }
    events++;
    if (event.type === 'system' && event.subtype === 'init') {
      cwd = typeof event.cwd === 'string' ? event.cwd.replace(/\/$/, '') : '';
      lines.push({ kind: 'start', text: `Started${event.model ? ` · ${event.model}` : ''}`, ...(Array.isArray(event.tools) ? { detail: `Tools: ${event.tools.join(', ')}` } : {}) });
    } else if (event.type === 'assistant') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push({ kind: 'text', text: part.text.trim() });
      else if (part?.type === 'tool_use') {
        const input = part.input ?? {}, name = String(part.name ?? 'Tool');
        if (name === 'StructuredOutput') lines.push({ kind: 'tool', text: 'Returned findings', ...(findingsCount(input) ? { detail: findingsCount(input) } : {}) });
        else if (name === 'Read') lines.push({ kind: 'tool', text: `Read ${relative(input.file_path)}`, ...(input.offset ? { detail: `from line ${input.offset}` } : {}) });
        else if (name === 'Glob' || name === 'Grep') lines.push({ kind: 'tool', text: `${name} ${input.pattern ?? ''}`, ...(input.path ? { detail: `in ${relative(input.path)}` } : {}) });
        else lines.push({ kind: 'tool', text: name, detail: clip(JSON.stringify(input), 160) });
      }
    } else if (event.type === 'user') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (part?.type === 'tool_result' && part.is_error) lines.push({ kind: 'error', text: 'Tool error', detail: clip(flat(part.content).replace(/\s+/g, ' ').trim(), 300) });
    } else if (event.type === 'result') {
      const facts = [event.num_turns ? `${event.num_turns} turns` : '', duration(event.duration_ms)].filter(Boolean).join(' · ');
      if (event.is_error) lines.push({ kind: 'error', text: `Ended with ${event.subtype ?? 'an error'}${facts ? ` · ${facts}` : ''}`, ...(typeof event.result === 'string' && event.result.trim() ? { detail: clip(event.result.trim(), 600) } : {}) });
      else lines.push({ kind: 'done', text: `Finished${facts ? ` · ${facts}` : ''}`, detail: findingsCount(event.structured_output) ?? (typeof event.result === 'string' && event.result.trim() ? clip(event.result.trim(), 600) : 'No output') });
    }
  }
  return events ? lines : undefined;
}
