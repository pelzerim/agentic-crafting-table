import { stopClaudeBackground, probeClaude, prepareClaude } from '../session-runtime/claude.ts';
import { followConversation } from '../session-runtime/agent-hook-event.ts';
import type { AgentCapability, AgentPreparation } from '../session-runtime/agent-plan.ts';
import type { PreparedSession } from './sessions.ts';
import { discoverClaudeSessions, resolveClaudeSession } from '../session-runtime/saved-sessions.ts';
import { probeCodex, codexModels, discoverCodexSessions, resolveCodexSession } from '../session-runtime/codex.ts';
import { prepareCodex } from '../session-runtime/codex-launch.ts';
import { latestSolModel } from '../session-runtime/codex-models.ts';
import type { WorkspaceState } from '../core/control.ts';
import type { AppSettings } from '../core/settings.ts';
import type { SavedSessionPage } from '../../src/resource-plugins/types.ts';
import type { ProjectSkill, ProjectSkillCatalog } from '../core/skills.ts';
import { discoverClaudeSkills, discoverCodexSkills } from '../session-runtime/skills.ts';

export interface AgentProvider {
  name: string;
  probe(): Promise<AgentCapability>;
  prepare(input: AgentPreparation, settings: AppSettings): PreparedSession;
  discover(state: WorkspaceState, query: string, offset: number, cursor?: string): Promise<SavedSessionPage>;
  resolve(id: string): Promise<{ nativeSessionId: string; cwd: string }>;
  /** Frees a fork the CLI keeps running on its own, so that an item can open it. */
  releaseFork?(id: string): Promise<void>;
  /** Keeps a running process's item bound to it when the process moved on from an empty conversation. Codex does this in its driver. */
  followConversation?(directory: string, processSessionId: string, id: string): void;
  models(): Promise<{ options: string[]; default: string }>;
  skills(cwd: string): Promise<ProjectSkillCatalog>;
  skillPrompt(skill: ProjectSkill, argumentsText: string): string;
}
type ModelChoice = { options: string[]; default: string };
/** Codex lists its models through a server started for the purpose, which takes up to a second. A list older than
 * `maxAge` is still returned at once while one shared refresh replaces it; only the first list is waited for. */
export function staleWhileRefreshing<T>(load: () => Promise<T>, maxAge = 60_000, now = Date.now) {
  let cache: { time: number; value: T } | undefined, refresh: Promise<T> | undefined;
  return (): Promise<T> => {
    if (!cache || now() - cache.time >= maxAge) refresh ??= load().then(value => { cache = { time: now(), value }; return value; }).finally(() => { refresh = undefined; });
    if (cache) { refresh?.catch(() => {}); return Promise.resolve(cache.value); }
    return refresh!;
  };
}
const codexModelChoice = staleWhileRefreshing<ModelChoice>(async () => {
  const { models } = await codexModels(), options = models.map(model => model.model);
  if (!options.length) throw new Error('The installed Codex CLI returned no available models.');
  return { options, default: latestSolModel(options) ?? models.find(model => model.isDefault)?.model ?? options[0] };
});
export const agentProviders: Readonly<Record<string, AgentProvider>> = {
  claude: { name: 'Claude', probe: probeClaude, prepare: (input, settings) => prepareClaude({ ...input, settings: settings.claude }), discover: discoverClaudeSessions, resolve: resolveClaudeSession, releaseFork: stopClaudeBackground, followConversation,
    async models() { return { options: ['opus', 'fable', 'sonnet', 'haiku'], default: 'opus' }; },
    skills: discoverClaudeSkills, skillPrompt: (skill, text) => '/' + skill.name + (text ? ' ' + text : '') },
  codex: { name: 'Codex', probe: probeCodex, prepare: input => prepareCodex(input), discover: (state, query, _offset, cursor) => discoverCodexSessions(state, query, cursor), resolve: resolveCodexSession,
    models: codexModelChoice, skills: discoverCodexSkills, skillPrompt: (skill, text) => '$' + skill.name + (text ? ' ' + text : '') },
};
export function agentProvider(id: unknown = 'claude') {
  const provider = typeof id === 'string' && Object.hasOwn(agentProviders, id) ? agentProviders[id] : undefined;
  if (!provider) throw new Error('Unsupported agent provider'); return provider;
}
