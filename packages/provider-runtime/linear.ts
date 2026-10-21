import type { RequestBudget } from './request-budget.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ISSUE = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const LINEAR_QUERIES = Object.freeze({
  viewer: 'query CraftingTableViewer { viewer { id name } organization { id name urlKey previousUrlKeys } }',
  issue: 'query CraftingTableIssue($id: String!) { viewer { id name } organization { id name urlKey previousUrlKeys } issue(id: $id) { id identifier previousIdentifiers title description url updatedAt archivedAt state { id name type } team { id } attachments(first: 50) { nodes { url } } } }',
  workflow: 'query CraftingTableWorkflow($id: String!) { viewer { id name } organization { id name urlKey previousUrlKeys } team(id: $id) { id states(first: 250) { nodes { id name type position } pageInfo { hasNextPage } } } }',
  assigned: 'query CraftingTableAssigned($after: String, $states: [String!]!, $priorities: [Float!]!) { viewer { id name assignedIssues(first: 50, after: $after, orderBy: updatedAt, filter: { state: { type: { in: $states } }, priority: { in: $priorities } }) { nodes { id identifier title url updatedAt priority state { id name type } team { id key name } } pageInfo { hasNextPage endCursor } } } organization { id name urlKey previousUrlKeys } }',
});
export const LINEAR_STATE_MUTATION = 'mutation CraftingTableIssueState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { id name type } } } }';
const CURSOR = /^[A-Za-z0-9_=+/:.-]{1,200}$/;
export const LINEAR_ASSIGNED_PAGE = 50, LINEAR_ASSIGNED_CAP = 100;
/** The workflow state types a ticket may have to be imported. Anything else (completed, canceled,
 * duplicate, a type Linear adds later) is never requested and never kept. */
export const LINEAR_TRIAGE_STATE_TYPES = Object.freeze(['triage', 'backlog', 'unstarted', 'started'] as const);
export type LinearTriageStateType = typeof LINEAR_TRIAGE_STATE_TYPES[number];
/** Linear priorities are 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const LINEAR_TRIAGE_PRIORITIES = Object.freeze({ any: Object.freeze([0, 1, 2, 3, 4]), high: Object.freeze([1, 2]), medium: Object.freeze([1, 2, 3]) });
export type LinearTriagePriority = keyof typeof LINEAR_TRIAGE_PRIORITIES;
export interface LinearAssignedFilter { stateTypes?: readonly LinearTriageStateType[]; priority?: LinearTriagePriority }
const subset = <T>(value: unknown, allowed: readonly T[]): value is T[] => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(entry => allowed.includes(entry));
export interface LinearReadVariables { id?: string; after?: string; states?: readonly string[]; priorities?: readonly number[] }
export interface LinearTransport { read(operation: keyof typeof LINEAR_QUERIES, variables: LinearReadVariables, signal: AbortSignal): Promise<unknown>; updateState?(id: string, stateId: string, signal: AbortSignal): Promise<unknown> }
export interface LinearAccount { id: string; name: string; workspace: string; slug: string; previousSlugs: string[] }
/** A GitHub pull request attached to an issue (Linear's GitHub integration). */
export type LinearPull = { owner: string; repo: string; number: number };
export interface LinearIssue { id: string; identifier: string; previousIdentifiers: string[]; title: string; description: string; url: string; updatedAt: string; archived: boolean; teamId: string; state: { id: string; name: string; type: string }; pulls: LinearPull[] }
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?:[/?#]|$)/;
/** The GitHub pull requests among an issue's attachments, each once (owner and repository compared without case). */
export function attachedPulls(attachments: unknown): LinearPull[] {
  const nodes = (attachments as { nodes?: unknown } | null | undefined)?.nodes, pulls = new Map<string, LinearPull>();
  for (const node of Array.isArray(nodes) ? nodes.slice(0, 50) : []) {
    const match = typeof (node as { url?: unknown })?.url === 'string' ? PULL_URL.exec((node as { url: string }).url) : null;
    if (!match) continue;
    const pull = { owner: match[1], repo: match[2], number: Number(match[3]) }, key = `${pull.owner}/${pull.repo}#${pull.number}`.toLowerCase();
    if (!pulls.has(key)) pulls.set(key, pull);
  }
  return [...pulls.values()];
}
/** An open issue assigned to the credential's own user; list fields only. */
export interface LinearAssignedIssue { id: string; identifier: string; title: string; url: string; updatedAt: string; priority: number; team: { id: string; key: string; name: string }; state: { id: string; name: string; type: string } }
class LinearReadError extends Error {}
const invalid = () => new LinearReadError('Linear returned incomplete or inconsistent issue data.');
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Record<string, any>; }
export function linearAccount(raw: unknown): LinearAccount {
  const data = object(raw), viewer = object(data.viewer), org = object(data.organization);
  if (!UUID.test(viewer.id) || !UUID.test(org.id) || typeof viewer.name !== 'string' || typeof org.name !== 'string' || (typeof org.urlKey !== 'string' || !SLUG.test(org.urlKey)) || !Array.isArray(org.previousUrlKeys) || org.previousUrlKeys.some((slug: unknown) => typeof slug !== 'string' || !SLUG.test(slug))) throw invalid();
  return { id: `${org.id.toLowerCase()}/${viewer.id.toLowerCase()}`, name: viewer.name.slice(0, 100), workspace: org.name.slice(0, 100), slug: org.urlKey, previousSlugs: org.previousUrlKeys };
}
/** Linear reports its request window as x-ratelimit-requests-* (reset in epoch milliseconds). */
function observeLinear(budget: RequestBudget, response: Response) {
  const header = (name: string) => { const value = response.headers.get(name); return value === null || value === '' ? undefined : Number(value); };
  const reset = header('x-ratelimit-requests-reset'), retry = header('retry-after');
  budget.observe('core', { status: response.status, limit: header('x-ratelimit-requests-limit'), remaining: header('x-ratelimit-requests-remaining'), resetAt: reset === undefined ? undefined : reset < 1e12 ? reset * 1000 : reset,
    ...(response.status === 429 ? { retryAt: Date.now() + Math.max(1, Math.min(3600, retry || 60)) * 1000 } : {}) });
}
export function linearTransport(token: string, fetcher: typeof fetch = fetch, budget?: RequestBudget): LinearTransport {
  if (!/^[A-Za-z0-9._~-]{10,4096}$/.test(token)) throw new LinearReadError('Invalid Linear credential.');
  async function request(query: string, variables: LinearReadVariables | Record<string, string>, signal: AbortSignal, mutation = false) {
    signal.throwIfAborted();
    const release = await budget?.acquire('core', signal, mutation);
    try { return await send(query, variables, signal, mutation); } finally { release?.(); }
  }
  async function send(query: string, variables: LinearReadVariables | Record<string, string>, signal: AbortSignal, mutation: boolean) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let response: Response;
    try { response = await fetcher('https://api.linear.app/graphql', { method: 'POST', redirect: 'error', signal: combined, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }); }
    catch { signal.throwIfAborted(); throw Object.assign(new LinearReadError(mutation ? 'Linear update could not be confirmed. Refresh the issue before trying again.' : 'Linear is unreachable. Check your connection and retry.'), { outcomeUnknown: mutation }); }
    if (budget) observeLinear(budget, response);
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 1024 * 1024) throw new LinearReadError('Linear response exceeds the content limit.'); chunks.push(chunk.value); }
      combined.throwIfAborted();
      if (response.status === 429) throw Object.assign(new LinearReadError('Linear rate limit reached. Retry after the cooldown.'), { retryAt: Date.now() + Math.max(1, Math.min(3600, Number(response.headers.get('retry-after')) || 60)) * 1000 });
      if (response.status === 401 || response.status === 403) throw new LinearReadError('Linear credentials are expired or lack permission. Reconnect the selected account.');
      if (response.status !== 200) throw Object.assign(new LinearReadError(mutation ? 'Linear update could not be confirmed. Refresh the issue before trying again.' : 'Linear could not complete this read. Retry later.'), { outcomeUnknown: mutation });
      let body; try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw invalid(); }
      if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) throw Object.assign(new LinearReadError(mutation ? 'Linear did not confirm the status change. Check update permissions and refresh the issue.' : 'Linear could not return all requested fields. Check issue access and retry.'), { outcomeUnknown: mutation });
      return object(body.data);
    } catch (error) { signal.throwIfAborted(); if (error instanceof LinearReadError) { if (mutation && ![401, 403, 429].includes(response.status)) Object.assign(error, { outcomeUnknown: true }); throw error; } throw Object.assign(new LinearReadError('The Linear response was interrupted. Refresh before trying again.'), { outcomeUnknown: mutation }); }
    finally { await reader?.cancel().catch(() => {}); }
  }
  return {
    async read(operation, variables, signal) {
      const keys = Object.keys(variables);
      const allowed = !Object.hasOwn(LINEAR_QUERIES, operation) ? false
        : operation === 'viewer' ? !keys.length
        : operation === 'assigned' ? keys.every(key => ['after', 'states', 'priorities'].includes(key)) && (variables.after === undefined || typeof variables.after === 'string' && CURSOR.test(variables.after))
          && subset(variables.states, LINEAR_TRIAGE_STATE_TYPES) && subset(variables.priorities, LINEAR_TRIAGE_PRIORITIES.any)
        : keys.length === 1 && typeof variables.id === 'string' && (UUID.test(variables.id) || operation !== 'workflow' && ISSUE.test(variables.id));
      if (!allowed) throw new LinearReadError('Unsupported Linear read request.');
      return request(LINEAR_QUERIES[operation], variables, signal);
    },
    async updateState(id, stateId, signal) {
      if (!UUID.test(id) || !UUID.test(stateId)) throw new LinearReadError('Invalid Linear status update.');
      return request(LINEAR_STATE_MUTATION, { id, stateId }, signal, true);
    },
  };
}
type LinearWorkflowState = { id: string; name: string; type: string; position: number };
/** Host-owned catalogue, shared across short-lived clients, never across accounts. */
export class LinearWorkflowCache {
  private entries = new Map<string, LinearWorkflowState[]>();
  get(account: string, team: string) { const value = this.entries.get(`${account}/${team}`); return value && structuredClone(value); }
  set(account: string, team: string, states: LinearWorkflowState[]) {
    const key = `${account}/${team}`;
    this.entries.delete(key);
    if (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, structuredClone(states));
  }
}
export class LinearClient {
  private transport: LinearTransport; private account: string; private workflows: LinearWorkflowCache;
  constructor(transport: LinearTransport, account: string, workflows = new LinearWorkflowCache()) { this.transport = transport; this.account = account; this.workflows = workflows; }
  async issue(id: string, workspace: string | undefined, signal: AbortSignal): Promise<LinearIssue> {
    if (!ISSUE.test(id) && !UUID.test(id)) throw new LinearReadError('Invalid Linear issue identity.');
    const data = object(await this.transport.read('issue', { id }, signal)); signal.throwIfAborted(); const account = linearAccount(data);
    if (account.id !== this.account) throw new LinearReadError('The Linear credential belongs to another account. Reconnect the original workspace.');
    if (workspace && workspace !== account.slug && !account.previousSlugs.includes(workspace)) throw new LinearReadError('This issue URL belongs to a different Linear workspace.');
    const issue = object(data.issue), state = object(issue.state);
    if (!UUID.test(object(issue.team).id)) throw invalid();
    if (!UUID.test(issue.id) || !ISSUE.test(issue.identifier) || !Array.isArray(issue.previousIdentifiers) || issue.previousIdentifiers.some((value: unknown) => typeof value !== 'string' || !ISSUE.test(value)) || typeof issue.title !== 'string' || !issue.title.trim() || issue.title.length > 450 || (issue.description !== null && typeof issue.description !== 'string') || (issue.description?.length ?? 0) > 200_000 || typeof issue.updatedAt !== 'string' || !Number.isFinite(Date.parse(issue.updatedAt)) || (issue.archivedAt !== null && typeof issue.archivedAt !== 'string') || !UUID.test(state.id) || typeof state.name !== 'string' || state.name.length > 100 || typeof state.type !== 'string') throw invalid();
    if (id.toLowerCase() !== issue.id.toLowerCase() && id !== issue.identifier && !issue.previousIdentifiers.includes(id)) throw invalid();
    let url; try { url = new URL(issue.url); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password || url.hash || !(url.pathname === `/${account.slug}/issue/${issue.identifier}` || url.pathname.startsWith(`/${account.slug}/issue/${issue.identifier}/`)) || url.search) throw invalid();
    return { id: issue.id.toLowerCase(), identifier: issue.identifier, previousIdentifiers: issue.previousIdentifiers, title: issue.title, description: issue.description ?? '', url: url.href, updatedAt: issue.updatedAt, archived: issue.archivedAt !== null, teamId: issue.team.id.toLowerCase(), state: { id: state.id.toLowerCase(), name: state.name, type: state.type }, pulls: attachedPulls(issue.attachments) };
  }
  async workflow(id: string, workspace: string | undefined, signal: AbortSignal, fresh = false) {
    const issue = await this.issue(id, workspace, signal);
    if (issue.archived) throw new LinearReadError('Restore this issue in Linear before changing its status.');
    const cached = !fresh && this.workflows.get(this.account, issue.teamId);
    if (cached && cached.some(state => state.id === issue.state.id)) return { issue, states: cached };
    const data = object(await this.transport.read('workflow', { id: issue.teamId }, signal));
    signal.throwIfAborted();
    if (linearAccount(data).id !== this.account) throw new LinearReadError('The Linear credential belongs to another account.');
    const team = object(data.team), states = object(team.states);
    if (!UUID.test(team.id) || team.id.toLowerCase() !== issue.teamId || !Array.isArray(states.nodes) || !states.nodes.length || states.nodes.length > 250 || object(states.pageInfo).hasNextPage !== false) throw invalid();
    const choices = states.nodes.map((raw: unknown) => {
      const state = object(raw);
      if (!UUID.test(state.id) || typeof state.name !== 'string' || !state.name.trim() || state.name.length > 100 || typeof state.type !== 'string' || !Number.isFinite(state.position)) throw invalid();
      return { id: state.id.toLowerCase(), name: state.name, type: state.type, position: state.position };
    });
    if (new Set(choices.map(state => state.id)).size !== choices.length || !choices.some(state => state.id === issue.state.id.toLowerCase())) throw invalid();
    choices.sort((a, b) => a.position - b.position);
    this.workflows.set(this.account, issue.teamId, choices);
    return { issue, states: choices };
  }
  async setState(id: string, workspace: string | undefined, input: { value: string; expectedStateId: string; expectedUpdatedAt: string }, signal: AbortSignal) {
    if (![input.value, input.expectedStateId].every(value => typeof value === 'string' && UUID.test(value)) || typeof input.expectedUpdatedAt !== 'string') throw new LinearReadError('Invalid Linear status update.');
    const { issue, states } = await this.workflow(id, workspace, signal, true);
    if (!states.some(state => state.id === input.value)) throw new LinearReadError('This status is not part of the issue’s current team workflow. Reopen the status menu.');
    if (issue.state.id === input.value) return issue;
    if (issue.state.id !== input.expectedStateId || issue.updatedAt !== input.expectedUpdatedAt) throw new LinearReadError('The issue changed in Linear. Refresh and choose the status again.');
    if (!this.transport.updateState) throw new LinearReadError('This Linear connection does not support status updates.');
    signal.throwIfAborted();
    const raw = await this.transport.updateState(issue.id, input.value, signal);
    try {
      const result = object(raw), payload = object(result.issueUpdate), changed = object(payload.issue);
      if (payload.success !== true || changed.id !== issue.id || object(changed.state).id !== input.value) throw invalid();
      return await this.issue(issue.id, workspace, signal);
    } catch { throw Object.assign(new LinearReadError('Linear may have updated the issue, but confirmation failed. Refresh before trying again.'), { outcomeUnknown: true }); }
  }
  /** Issues assigned to this account in the chosen state types and priority, most recently updated
   * first. The filter is built from the fixed lists only. Every page is validated before anything
   * is returned; `truncated` means more matching issues exist beyond `cap`, never that the filter hid some. */
  async assignedIssues(signal: AbortSignal, filter: LinearAssignedFilter = {}, cap = LINEAR_ASSIGNED_CAP): Promise<{ issues: LinearAssignedIssue[]; truncated: boolean }> {
    const chosen = filter.stateTypes ?? LINEAR_TRIAGE_STATE_TYPES, priority = filter.priority ?? 'any';
    if (!Array.isArray(chosen) || chosen.length && !subset(chosen, LINEAR_TRIAGE_STATE_TYPES) || typeof priority !== 'string' || !Object.hasOwn(LINEAR_TRIAGE_PRIORITIES, priority)) throw new LinearReadError('Unsupported Linear ticket filter.');
    const states = LINEAR_TRIAGE_STATE_TYPES.filter(type => chosen.includes(type)), priorities = [...LINEAR_TRIAGE_PRIORITIES[priority]];
    signal.throwIfAborted();
    if (!states.length) return { issues: [], truncated: false };
    const limit = Math.max(1, Math.min(LINEAR_ASSIGNED_CAP, Math.floor(cap))), issues = new Map<string, LinearAssignedIssue>(), cursors = new Set<string>();
    let after: string | undefined, truncated = false;
    for (let page = 0; ; page++) {
      signal.throwIfAborted();
      const data = object(await this.transport.read('assigned', { states, priorities, ...(after === undefined ? {} : { after }) }, signal)); signal.throwIfAborted();
      const account = linearAccount(data);
      if (account.id !== this.account) throw new LinearReadError('The Linear credential belongs to another account. Reconnect the original workspace.');
      const connection = object(object(data.viewer).assignedIssues), info = object(connection.pageInfo);
      if (!Array.isArray(connection.nodes) || connection.nodes.length > LINEAR_ASSIGNED_PAGE || typeof info.hasNextPage !== 'boolean') throw invalid();
      for (const raw of connection.nodes) {
        const issue = object(raw), state = object(issue.state), team = object(issue.team);
        if (!UUID.test(issue.id) || !ISSUE.test(issue.identifier) || typeof issue.title !== 'string' || !issue.title.trim() || issue.title.length > 450 || typeof issue.updatedAt !== 'string' || !Number.isFinite(Date.parse(issue.updatedAt))
          || !Number.isInteger(issue.priority) || issue.priority < 0 || issue.priority > 4 || !UUID.test(state.id) || typeof state.name !== 'string' || state.name.length > 100 || typeof state.type !== 'string'
          || !UUID.test(team.id) || typeof team.key !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(team.key) || typeof team.name !== 'string' || team.name.length > 200) throw invalid();
        let url; try { url = new URL(issue.url); } catch { throw invalid(); }
        if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password || url.hash || url.search || !(url.pathname === `/${account.slug}/issue/${issue.identifier}` || url.pathname.startsWith(`/${account.slug}/issue/${issue.identifier}/`))) throw invalid();
        if (!(states as string[]).includes(state.type) || !priorities.includes(issue.priority)) continue;
        if (issues.size >= limit) { truncated = true; break; }
        issues.set(issue.id.toLowerCase(), { id: issue.id.toLowerCase(), identifier: issue.identifier, title: issue.title, url: url.href, updatedAt: issue.updatedAt, priority: issue.priority, team: { id: team.id.toLowerCase(), key: team.key, name: team.name }, state: { id: state.id.toLowerCase(), name: state.name, type: state.type } });
      }
      if (truncated || !info.hasNextPage) break;
      if (issues.size >= limit) { truncated = true; break; }
      if (typeof info.endCursor !== 'string' || !CURSOR.test(info.endCursor) || cursors.has(info.endCursor) || page >= Math.ceil(LINEAR_ASSIGNED_CAP / LINEAR_ASSIGNED_PAGE) * 2) throw invalid();
      cursors.add(after = info.endCursor);
    }
    return { issues: [...issues.values()], truncated };
  }

}
