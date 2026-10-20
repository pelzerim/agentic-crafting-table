import { stripVTControlCharacters } from 'node:util';
import { probeClaude } from './claude.ts';
import { sessionPath } from './shell-path.ts';
import type { ActivitySummaryClient } from '../../src/agents/activity-summary.ts';

/** Best-effort secret removal. Full recordings and transcripts stay local; no
 * redactor can classify every possible secret. */
export function redactSecrets(output: string): string {
  return stripVTControlCharacters(output)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    // Shell/JSON echoes can contain literal "\npassword=...": the preceding
    // letter n defeats a plain word boundary even though the value is sensitive.
    .replace(/(?:\b|\\[nrt])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token|cookie)\b["']?\s*[:=]\s*[^\r\n]+/gi, '[redacted credential]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*["']?\s*[:=]\s*[^\r\n]+/gi, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-ant-|sk-|sk_live_|sk_test_|gh[pousr]_|github_pat_|xox[baprs]-|glpat-)[A-Za-z0-9_-]{12,}/g, '[redacted token]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted key]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\/(?:Users|home)\/[^/\s]+\//g, '~/')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
/** Redacted before bounding the dispatched evidence to its latest 6,000 characters. */
export const summaryEvidence = (output: string): string => redactSecrets(output).slice(-6000).trim();

/** One tool-free helper turn, isolated from project settings and conversations.
 * The installed CLI handles the user's existing authentication. */
export function nativeSummaryClient(cwd: string): ActivitySummaryClient {
  return { async complete(request, signal) {
    signal.throwIfAborted();
    if (process.env.ACT_TEST_DATA_DIR && !process.env.ACT_SUMMARY_FIXTURE_LOG) throw new Error('AI helpers are disabled in desktop tests without an explicit fixture.');
    const installed = await probeClaude(), { query } = await import('@anthropic-ai/claude-agent-sdk');
    signal.throwIfAborted();
    const path = await sessionPath();
    signal.throwIfAborted();
    const abortController = new AbortController(), abort = () => abortController.abort();
    signal.addEventListener('abort', abort, { once: true });
    let run: ReturnType<typeof query> | undefined;
    try {
      run = query({ prompt: request.messages[0].content, options: {
      cwd, pathToClaudeCodeExecutable: installed.executable, abortController,
      model: request.model, systemPrompt: request.system, thinking: request.thinking,
      tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
      persistSession: false, maxTurns: 1, maxBudgetUsd: request.budgetUsd ?? .02, verbatimPrompts: true,
      settings: { disableAllHooks: true, disableRemoteControl: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true },
      env: { ...process.env, PATH: path, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.max_tokens), CLAUDE_CODE_MAX_RETRIES: '0' },
      stderr: () => {},
      } });
      for await (const message of run) if (message.type === 'result') {
        if (message.subtype === 'success' && !message.is_error && message.result.length <= (request.resultLimit ?? 256)) return message.result;
        throw new Error('Claude activity summary was unavailable');
      }
      throw new Error('Claude activity summary returned no result');
    } finally { signal.removeEventListener('abort', abort); run?.close(); }
  } };
}
