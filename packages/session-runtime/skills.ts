import * as z from 'zod/v4';
import { openCodexMetadata } from './codex-client.ts';
import { probeCodex } from './codex.ts';
import { probeClaude } from './claude.ts';
import { sessionPath } from './shell-path.ts';
import type { ProjectSkill, ProjectSkillCatalog } from '../core/skills.ts';

const commandSchema = z.object({ name: z.string().min(1).max(200), description: z.string().max(16_000), argumentHint: z.string().max(2000).default(''), builtin: z.boolean().optional() });
const commandName = /^[\p{L}\p{N}][\p{L}\p{N}_.:\/-]*$/u;
export function claudeSkillCatalog(commands: unknown): ProjectSkill[] {
  const rows = z.array(commandSchema).max(5000).parse(commands), builtins = new Set(rows.filter(row => row.builtin).map(row => row.name));
  // Built-in /exit, /model, etc. are not executable project workflows. Their names
  // also take precedence over custom commands with the same spelling.
  const skills = rows.filter(row => !row.builtin && !builtins.has(row.name) && commandName.test(row.name));
  return [...new Map(skills.map(row => [row.name, { id: row.name, name: row.name, description: row.description, argumentHint: row.argumentHint }])).values()];
}

/** Initialize only: no user message, model turn, session recording or MCP servers. */
export async function discoverClaudeSkills(cwd: string): Promise<ProjectSkillCatalog> {
  const installed = await probeClaude(), env = { ...process.env, PATH: await sessionPath() };
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), abortController = new AbortController();
  const prompt = { async *[Symbol.asyncIterator]() { await gate; } };
  const run = query({ prompt, options: { cwd, env, pathToClaudeCodeExecutable: installed.executable, abortController,
    persistSession: false, strictMcpConfig: true, mcpServers: {}, settingSources: ['user', 'project', 'local'],
    settings: { disableAllHooks: true, disableRemoteControl: true }, permissionMode: 'default',
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([run.supportedCommands(), new Promise<never>((_, reject) => { timer = setTimeout(() => { abortController.abort(); reject(new Error('Claude skill discovery timed out. Retry when the CLI is ready.')); }, 10_000); })]);
    return { cwd, skills: claudeSkillCatalog(commands), warnings: [] };
  } finally { clearTimeout(timer); release(); run.close(); }
}

export async function discoverCodexSkills(cwd: string): Promise<ProjectSkillCatalog> {
  const installed = await probeCodex(), metadata = await openCodexMetadata(installed.executable, { env: { ...process.env, PATH: await sessionPath() } });
  try {
    const result = await metadata.skills(cwd), entry = result.data.find(row => row.cwd === cwd);
    if (!entry) throw new Error('Codex returned no skill catalog for this working directory');
    const counts = new Map<string, number>();
    for (const skill of entry.skills.filter(skill => skill.enabled)) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    return { cwd, skills: entry.skills.map(skill => ({ id: skill.path, name: skill.name, description: skill.description, source: skill.scope + ' · ' + skill.path,
      ...(!skill.enabled ? { unavailable: 'Disabled in Codex settings' } : !commandName.test(skill.name) ? { unavailable: 'This skill name cannot be invoked by the native terminal' } : (counts.get(skill.name) ?? 0) > 1 ? { unavailable: 'Several enabled skills share this name. Resolve the duplicate in Codex first.' } : {}),
    })), warnings: entry.errors.map(error => `${error.path}: ${error.message}`) };
  } finally { metadata.rpc.close(); }
}
