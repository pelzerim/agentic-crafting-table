import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findClaudeArtifactUrls, parseClaudeArtifactUrl } from '../../src/resource-plugins/items/claude-artifact/url.ts';
import { extractPageTitle } from '../../src/resource-plugins/items/web-link/metadata.ts';

type Input = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const URL_KEYS = new Set(['url', 'artifact_url', 'artifactUrl', 'link', 'href']);
/** A directory inside one of Claude Code's own worktrees. */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]/;
/** A teammate's name as the lead gave it: one token, unlike a task description in prose. */
const TEAMMATE_NAME = /^[\w.@-]{1,64}$/;

/** Every validated artifact URL in a structured tool response, noting those held by a URL-named field. */
function responseUrls(value: unknown) {
  const all = new Set<string>(), named = new Set<string>();
  let budget = 200;
  const visit = (node: unknown, key: string, depth: number) => {
    if (budget-- <= 0 || depth > 5) return;
    if (typeof node === 'string') {
      const whole = parseClaudeArtifactUrl(node);
      for (const found of whole ? [whole] : findClaudeArtifactUrls(node)) { all.add(found.url); if (URL_KEYS.has(key)) named.add(found.url); }
    } else if (Array.isArray(node)) for (const item of node.slice(0, 50)) visit(item, key, depth + 1);
    else if (node && typeof node === 'object') for (const [child, item] of Object.entries(node).slice(0, 50)) visit(item, child, depth + 1);
  };
  visit(value, '', 0);
  return { all, named };
}

/** The artifact a successful Artifact tool publish produced. The response shape is not
 * documented, so only a single unambiguous claude.ai artifact URL is accepted, preferring
 * the one the call itself named when it republished. Other actions are not publishes. */
function publishedArtifact(event: Input) {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'Artifact') return undefined;
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input as Input : {};
  if ((input.action !== undefined && input.action !== 'publish') || input.asset === true) return undefined;
  const requested = parseClaudeArtifactUrl(input.url)?.url, { all, named } = responseUrls(event.tool_response);
  const url = requested && (all.has(requested) || !all.size) ? requested : all.size === 1 ? [...all][0] : named.size === 1 ? [...named][0] : undefined;
  if (!url) return undefined;
  const label = [input.title, input.description].map(value => text(value)?.split('\n')[0].replace(/\s+/g, ' ').trim()).find(Boolean)?.slice(0, 200);
  const file = text(input.file_path), cwd = text(event.cwd);
  const filePath = file && (isAbsolute(file) ? file : cwd && isAbsolute(cwd) ? resolve(cwd, file) : undefined);
  return { url, ...(label ? { title: label } : {}), ...(filePath ? { filePath } : {}) };
}

const TITLE_FILE_BYTES = 2 * 1024 * 1024, TITLE_READ_BYTES = 128 * 1024;
/** The <title> of the local page an agent published: read-only, HTML only, size-capped. */
export function localArtifactTitle(path: string): string | undefined {
  if (!isAbsolute(path) || !/\.html?$/i.test(path)) return undefined;
  let descriptor: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > TITLE_FILE_BYTES) return undefined;
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, TITLE_READ_BYTES)), read = readSync(descriptor, buffer, 0, buffer.length, 0);
    return extractPageTitle(buffer.subarray(0, read).toString('utf8'))?.slice(0, 200);
  } catch { return undefined; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

type HookFields = { event: string | undefined; notificationType?: string; toolName?: string; recipient?: string; agentId?: string; teammate?: string; taskId?: string; model?: string; previousModel?: string; interrupt?: true; worktree?: true;
  backgroundTasks?: { id: string; type: string; status?: string; name?: string }[]; launched?: { id: string; kind: 'subagent' }; artifact?: ReturnType<typeof publishedArtifact> };

/** Fields of a Claude Code hook payload that the table uses. Turns inside a
 * subagent carry `agent_id` and are not the item's own state. Two of them still
 * say something about the item: SubagentStop ends background work the main thread
 * may be waiting on, and a subagent's finished tool shows it is running rather
 * than held at a prompt. A teammate is reported as running whether it works or
 * waits, so its tool starting and TeammateIdle are what tell the two apart. These
 * are forwarded without any of their content. So are the signals the item's sheep reads (AGENT-07e): a subagent starting,
 * compaction, a failed or denied tool, a task, a model switch. Only the tool's name, a task or model id, the teammate a
 * message goes to and two flags leave the session: no other input, error text, reason, subject or path. */
export function hookFields(event: Input, nativeSessionId: string): HookFields | undefined {
  if (event.session_id !== nativeSessionId) return;
  const name = text(event.hook_event_name), agentId = text(event.agent_id);
  if (name === 'TeammateIdle') { const teammate = text(event.teammate_name)?.slice(0, 200); return { event: name, ...(teammate ? { teammate } : {}), ...(agentId ? { agentId } : {}) }; }
  if (agentId && name === 'SubagentStart') return { event: name, agentId };
  if (agentId && name === 'PreToolUse') return { event: 'SubagentToolStart', agentId };
  if (agentId && name === 'PostToolUse') return { event: 'SubagentToolUse', agentId };
  if (agentId && name !== 'SubagentStop') return;
  const response = event.tool_response as Input | undefined;
  const launched = name === 'PostToolUse' && ['Agent', 'Task'].includes(String(event.tool_name)) && response?.status === 'async_launched' && text(response.agentId);
  const backgroundTasks = Array.isArray(event.background_tasks) ? event.background_tasks.slice(0, 100).flatMap(task => {
    const entry = task as Input | undefined, id = text(entry?.id), type = text(entry?.type), status = text(entry?.status);
    const teammate = type === 'teammate' && TEAMMATE_NAME.test(text(entry?.description) ?? '') ? text(entry?.description) : undefined;
    return id && type ? [{ id, type, ...(status ? { status } : {}), ...(teammate ? { name: teammate } : {}) }] : [];
  }) : undefined;
  const artifact = publishedArtifact(event), limited = (value: unknown) => text(value)?.slice(0, 200);
  const to = name === 'PreToolUse' || name === 'PostToolUse' ? text(event.tool_name) === 'SendMessage' && text((event.tool_input as Input | undefined)?.to) : undefined;
  const recipient = to && TEAMMATE_NAME.test(to) ? to : undefined;
  const taskId = name === 'TaskCreated' || name === 'TaskCompleted' ? limited(event.task_id) : undefined;
  const model = name === 'SessionStart' ? limited(event.model) : name === 'PostModelSwitch' ? limited(event.to_model) : undefined, previousModel = name === 'PostModelSwitch' ? limited(event.from_model) : undefined;
  return {
    event: name, ...(text(event.notification_type) ? { notificationType: text(event.notification_type) } : {}), ...(text(event.tool_name) ? { toolName: text(event.tool_name) } : {}), ...(recipient ? { recipient } : {}),
    ...(name === 'SubagentStop' && agentId ? { agentId } : {}), ...(backgroundTasks ? { backgroundTasks } : {}), ...(launched ? { launched: { id: launched, kind: 'subagent' as const } } : {}),
    ...(artifact ? { artifact } : {}), ...(taskId ? { taskId } : {}), ...(model ? { model } : {}), ...(previousModel ? { previousModel } : {}),
    ...(name === 'PostToolUseFailure' && event.is_interrupt === true ? { interrupt: true as const } : {}), ...(WORKTREE.test(text(event.cwd) ?? '') ? { worktree: true as const } : {}),
  };
}
