const TS = /^\d{10}\.\d{6}$/;
const CHANNEL = /^[CGD][A-Z0-9]{1,80}$/;
const USER = /^[UW][A-Z0-9]{1,80}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com$/;
type Method = 'auth.test' | 'conversations.info' | 'conversations.replies' | 'users.info';
export interface SlackTransport { read(method: Method, args: Record<string, string>, signal: AbortSignal): Promise<unknown> }
export interface SlackAccount { id: string; host: string; team: string; user: string }
export interface SlackMessage { ts: string; userId: string; author: string; text: string; edited: boolean; selected: boolean; incomplete: boolean }
export interface SlackThread { title: string; url: string; channel: string; selectedTs: string; threadTs: string; scope: 'message' | 'thread'; messages: SlackMessage[]; incomplete: boolean }
export class SlackReadError extends Error { code: string; constructor(message: string, code = 'UNAVAILABLE') { super(message); this.code = code; } }
/** `what` names the failed check without quoting any conversation content. */
const invalid = (what?: string) => new SlackReadError(`Slack returned incomplete or inconsistent conversation data${what ? ` (${what})` : ''}.`);
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Record<string, any>; }
export function slackAccount(raw: unknown): SlackAccount {
  const value = object(raw); let url; try { url = new URL(value.url); } catch { throw invalid(); }
  if (value.ok !== true || !/^T[A-Z0-9]{1,80}$/.test(value.team_id) || !USER.test(value.user_id) || typeof value.team !== 'string' || typeof value.user !== 'string' || url.protocol !== 'https:' || !HOST.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw invalid();
  return { id: `${value.team_id}/${value.user_id}`, host: url.hostname, team: value.team.slice(0, 100), user: value.user.slice(0, 100) };
}
export function slackTransport(token: string, fetcher: typeof fetch = fetch): SlackTransport {
  if (!/^xox[bp]-[A-Za-z0-9-]{10,4090}$/.test(token)) throw new SlackReadError('Use a Slack bot or user API token permitted to read this conversation.');
  return { async read(method, args, signal) {
    signal.throwIfAborted();
    const keys = Object.keys(args).sort().join(',');
    const valid = method === 'auth.test' ? keys === '' : method === 'conversations.info' ? keys === 'channel' && CHANNEL.test(args.channel) : method === 'users.info' ? keys === 'user' && USER.test(args.user) : method === 'conversations.replies' && (keys === 'channel,limit,ts' || keys === 'channel,cursor,limit,ts') && CHANNEL.test(args.channel) && TS.test(args.ts) && args.limit === '15' && (!args.cursor || args.cursor.length <= 1024 && !/[\x00-\x1f\x7f]/.test(args.cursor));
    if (!valid) throw new SlackReadError('Unsupported Slack read request.');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15_000)]), url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
    let response: Response;
    try { response = await fetcher(url, { method: method === 'auth.test' ? 'POST' : 'GET', redirect: 'error', signal: combined, headers: { Authorization: `Bearer ${token}` } }); }
    catch { signal.throwIfAborted(); throw new SlackReadError('Slack is unreachable. Check your connection and retry.'); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) throw new SlackReadError('Slack response exceeds the content limit.'); chunks.push(chunk.value); }
      combined.throwIfAborted();
      if (response.status === 429) throw Object.assign(new SlackReadError('Slack rate limit reached. Retry after the cooldown.', 'RATE_LIMITED'), { retryAt: Date.now() + Math.max(1, Math.min(3600, Number(response.headers.get('retry-after')) || 60)) * 1000 });
      if (response.status !== 200) throw new SlackReadError('Slack could not complete this read. Retry later.');
      let value; try { value = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw invalid(); }
      if (value.ok !== true) {
        if (value.error === 'missing_scope') throw new SlackReadError('The Slack token lacks a required read permission.', 'MISSING_SCOPE');
        if (value.error === 'user_not_found') throw new SlackReadError('Slack member is unavailable.', 'USER_NOT_FOUND');
        if (['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'].includes(value.error)) throw new SlackReadError('Slack credentials are expired or revoked. Reconnect the selected account.');
        if (['channel_not_found', 'not_in_channel', 'thread_not_found', 'message_not_found'].includes(value.error)) throw new SlackReadError('This Slack message is deleted, private or unavailable to the selected account.');
        throw new SlackReadError('Slack could not return this content. Check access and retry.');
      }
      return value;
    } catch (error) { signal.throwIfAborted(); if (error instanceof SlackReadError) throw error; throw new SlackReadError('The Slack response was interrupted. Retry later.'); }
    finally { await reader?.cancel().catch(() => {}); }
  } };
}
export class SlackClient {
  private transport: SlackTransport; private account: string;
  constructor(transport: SlackTransport, account: string) { this.transport = transport; this.account = account; }
  async thread(input: { workspaceHost: string; channelId: string; messageTs: string; scope: 'message' | 'thread'; threadTs?: string }, signal: AbortSignal): Promise<SlackThread> {
    if (!HOST.test(input.workspaceHost) || !CHANNEL.test(input.channelId) || !TS.test(input.messageTs) || (input.threadTs !== undefined && !TS.test(input.threadTs)) || !['message', 'thread'].includes(input.scope) || (input.scope === 'thread' && !input.threadTs)) throw new SlackReadError('Invalid Slack message identity.');
    const account = slackAccount(await this.transport.read('auth.test', {}, signal)); signal.throwIfAborted();
    if (account.id !== this.account) throw new SlackReadError('The Slack credential belongs to another account. Reconnect the original workspace.');
    if (account.host !== input.workspaceHost) throw new SlackReadError('This message URL belongs to another Slack workspace.');
    const info = object(await this.transport.read('conversations.info', { channel: input.channelId }, signal)), channel = object(info.channel);
    if (info.ok !== true || channel.id !== input.channelId || (channel.name !== undefined && typeof channel.name !== 'string')) throw invalid('channel details');
    const channelName = typeof channel.name === 'string' ? channel.name.slice(0, 120) : input.channelId;
    const messages: SlackMessage[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor = '', root = '', total = 0, complete = false, anchor = input.threadTs ?? input.messageTs, followed = false;
    for (let page = 0; page < 32; page++) {
      const result = object(await this.transport.read('conversations.replies', { channel: input.channelId, ts: anchor, limit: '15', ...(cursor ? { cursor } : {}) }, signal)); signal.throwIfAborted();
      if (result.ok !== true || !Array.isArray(result.messages) || (result.has_more !== undefined && typeof result.has_more !== 'boolean')) throw invalid('reply page');
      // Slack may add the thread root on top of the requested replies; the thread-wide limits below bound the total.
      if (!result.messages.length || result.messages.length > 100) throw invalid(result.messages.length ? 'oversized reply page' : 'empty reply page');
      for (const raw of result.messages) {
        const message = object(raw);
        // Slack repeats the thread root as the first message of every later page.
        if (page > 0 && raw === result.messages[0] && message.ts === root) continue;
        if (!TS.test(message.ts) || seen.has(message.ts) || typeof message.text !== 'string' || message.text.length > 40_000 || message.subtype === 'message_deleted' || (message.thread_ts !== undefined && !TS.test(message.thread_ts))) throw invalid(seen.has(message.ts) ? 'repeated message' : message.subtype === 'message_deleted' ? 'deleted message' : 'message fields');
        // Asked for a reply by its own timestamp, Slack returns only that reply; read the thread it names instead.
        if (!root && !input.threadTs && !followed && message.thread_ts && message.thread_ts !== message.ts) { anchor = message.thread_ts; followed = true; page = -1; cursor = ''; break; }
        if (!root) { root = message.thread_ts ?? message.ts; if (root !== message.ts || (input.threadTs && root !== input.threadTs)) throw invalid('thread start'); }
        if ((message.thread_ts ?? message.ts) !== root) throw invalid('message outside the thread');
        const user = USER.test(message.user) ? message.user : /^B[A-Z0-9]{1,80}$/.test(message.bot_id) ? message.bot_id : '';
        total += message.text.length; if (total > 200_000 || messages.length >= 480) throw new SlackReadError('This Slack thread exceeds the reading limit. Open it in Slack.');
        seen.add(message.ts);
        const botName = message.bot_profile?.name, posted = typeof message.username === 'string' && message.username.trim() ? message.username.trim().slice(0, 200) : '';
        messages.push({ ts: message.ts, userId: user, author: typeof botName === 'string' && user.startsWith('B') ? botName.slice(0, 200) : posted || user || 'Unknown sender', text: message.text, edited: Boolean(message.edited), selected: message.ts === input.messageTs, incomplete: Boolean(message.files?.length || message.attachments?.length || (!message.text && message.blocks?.length)) });
      }
      if (page < 0) continue;
      const next = result.response_metadata?.next_cursor;
      if (next !== undefined && (typeof next !== 'string' || next.length > 1024)) throw invalid('page cursor');
      cursor = (next ?? '').trim();
      if (!cursor) { if (result.has_more) throw invalid('missing next page'); complete = true; break; }
      if (result.has_more === false || cursors.has(cursor)) throw invalid('repeated page'); cursors.add(cursor);
    }
    if (!complete) throw new SlackReadError('This Slack thread exceeds the pagination limit. Open it in Slack.');
    // Slack pages a long thread newest replies first; timestamps have a fixed width, so they sort as text.
    messages.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    const selected = messages.find(message => message.selected); if (!selected) throw new SlackReadError('The selected Slack message is deleted or no longer present in this thread.');
    const authors = [...new Set(messages.map(message => message.userId).filter(id => USER.test(id)))];
    for (const id of authors.slice(0, 32)) {
      try {
        const value = object(await this.transport.read('users.info', { user: id }, signal)), user = object(value.user);
        if (value.ok !== true || user.id !== id) throw invalid();
        const name = user.profile?.display_name || user.real_name || user.name;
        if (typeof name !== 'string' || !name.trim()) throw invalid();
        for (const message of messages.filter(message => message.userId === id)) message.author = name.slice(0, 200);
      } catch (error) { signal.throwIfAborted(); if (!(error instanceof SlackReadError) || !['MISSING_SCOPE', 'USER_NOT_FOUND'].includes(error.code)) throw error; }
    }
    signal.throwIfAborted();
    const excerpt = selected.text.replace(/\s+/g, ' ').trim();
    const title = `#${channelName} · ${excerpt ? excerpt.slice(0, 180) + (excerpt.length > 180 ? '…' : '') : 'Slack message'}`;
    const url = new URL(`https://${account.host}/archives/${input.channelId}/p${input.messageTs.replace('.', '')}`); url.searchParams.set('thread_ts', root); url.searchParams.set('cid', input.channelId);
    return { title, url: url.href, channel: channelName, selectedTs: input.messageTs, threadTs: root, scope: input.scope, messages, incomplete: messages.some(message => message.incomplete) };
  }
}
