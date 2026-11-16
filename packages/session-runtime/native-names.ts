import { open } from 'node:fs/promises';

/** Bytes Claude Code itself reads from the end of a transcript to find its title. A name further up is not shown. */
export const CLAUDE_NAME_TAIL_BYTES = 64 * 1024;
/** Characters of a name sent to a CLI; both cut longer names in their pickers anyway. */
export const NATIVE_NAME_LENGTH = 200;

export const nativeName = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, NATIVE_NAME_LENGTH);

/** The newest name a person or the table gave this conversation (`/rename`, `--name`, a hook or the SDK).
 * Claude's own AI title is not a name: it is what the table replaces. */
export function newestClaudeName(lines: Iterable<string>): string | undefined {
  let newest: string | undefined;
  for (const line of lines) {
    if (!line.includes('"custom-title"')) continue;
    let entry: { type?: unknown; customTitle?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) newest = entry.customTitle.trim();
  }
  return newest;
}

/** The name Claude's own session picker shows, read from the transcript's tail; a line cut by the tail's start is skipped. */
export async function readClaudeName(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat(), start = Math.max(0, size - CLAUDE_NAME_TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return newestClaudeName(start > 0 ? lines.slice(1) : lines);
  } finally { await handle.close(); }
}

/** Names a Claude conversation that no process holds. A running Claude writes the name it holds back over this one, so
 * a running session takes its name from the prompt hook instead. */
export async function renameClaudeSession(id: string, title: string, cwd?: string) {
  const { renameSession } = await import('@anthropic-ai/claude-agent-sdk');
  try { await renameSession(id, nativeName(title), cwd ? { dir: cwd } : undefined); }
  catch (error) { if (!cwd) throw error; await renameSession(id, nativeName(title)); } // The folder moved; the SDK searches all projects.
}

