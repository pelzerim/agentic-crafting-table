// Isolated, deterministic SDK protocol fixture. Never calls a provider.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), value = flag => args.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1) ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
// Fixture diagnostics only: no provider, prompt or terminal evidence is recorded.
process.on('uncaughtException', async error => {
  await appendFile(process.env.ACT_SUMMARY_FIXTURE_LOG + '.errors', `${error.stack}\n`);
  process.exit(1);
});
if (args.includes('--version')) { console.log('2.1.282 (summary fixture)'); process.exit(0); }
if (args.includes('--help')) { console.log('--append-system-prompt --session-id --resume --mcp-config --plugin-dir --system-prompt-snapshot --remote-control\n  --permission-mode <mode> (choices: "auto", "default", "plan")'); process.exit(0); }
assert.equal(value('--input-format'), 'stream-json');
assert.equal(value('--tools'), '');
assert.equal(value('--max-turns'), '1'); assert.ok(['0.02', '0.05', '0.25'].includes(value('--max-budget-usd')));
assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--no-session-persistence'));
assert.equal(value('--setting-sources'), '');
assert.ok(['32', '64', '300', '4000'].includes(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)); assert.equal(process.env.CLAUDE_CODE_MAX_RETRIES, '0');
const settings = JSON.parse(value('--settings'));
assert.equal(settings.disableAllHooks, true); assert.equal(settings.disableRemoteControl, true);
const result = text => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: randomUUID() }));
/** Standup digests (Haiku) and reports (Sonnet): one deterministic story per digest and fact. */
async function standup(evidence) {
  const report = evidence.standup === 'report';
  assert.equal(value('--model'), report ? 'sonnet' : 'haiku'); assert.equal(value('--max-budget-usd'), report ? '0.25' : '0.05');
  assert.ok(!JSON.stringify(evidence).includes('FAKE_PRIVATE_CREDENTIAL'));
  await appendFile(process.env.ACT_SUMMARY_FIXTURE_LOG, JSON.stringify({ model: value('--model'), standup: evidence.standup, ...(report ? { range: evidence.range, instruction: evidence.instruction, digests: evidence.digests.length, facts: evidence.facts.length } : { day: evidence.day }) }) + '\n');
  if (evidence.standup === 'agent-day') return result(`Asked: why cart totals were off by a cent in ${evidence.item}.\nFound: the cart rounded each line before adding them up.\nChanged: round once, after the sum.\nState: fixed and tested.`);
  if (evidence.standup === 'pr-day') return result(`What: ${evidence.title}.\nDid: worked on it.`);
  const short = /short/i.test(evidence.instruction ?? '');
  const stories = [
    ...evidence.digests.map(digest => ({ title: 'Cart totals were off by a cent', state: 'done', project: digest.project, evidence: digest.evidence,
      bullets: ['Looked into why cart totals were off by a cent.', 'Found that the cart rounded each line before adding them up.', 'Rounded once, after the sum, with tests.'] })),
    ...evidence.facts.filter(fact => !fact.open).map(fact => ({ title: fact.text.replace(/^[^:]+: /, ''), state: fact.state === 'blocked' ? 'blocked' : 'done', evidence: [fact.evidence], bullets: [`${fact.text}.`] })),
  ].map(story => short ? { ...story, bullets: story.bullets.slice(0, 1) } : story);
  const outlook = evidence.facts.filter(fact => fact.open).map(fact => ({ title: fact.text.replace(/^[^:]+: /, ''), state: fact.state === 'blocked' ? 'blocked' : 'ongoing', evidence: [fact.evidence], bullets: [`Still open: ${fact.text.replace(/^[^:]+: /, '')}.`] }));
  return result('```json\n' + JSON.stringify({ stories, outlook }) + '\n```');
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    assert.equal(frame.request.subtype, 'initialize');
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], models: [], agents: [] } } }));
  } else if (frame.type === 'user') {
    const evidence = JSON.parse(typeof frame.message.content === 'string' ? frame.message.content : frame.message.content.map(block => block.text ?? '').join(''));
    if (evidence.standup) { await standup(evidence); continue; }
    const text = evidence.note ?? evidence.recentOutput ?? evidence.items?.map(item => `${item.title} ${item.summary ?? ''}`).join('\n');
    assert.ok(text.length <= 6000);
    assert.ok(!text.includes('FAKE_PRIVATE_CREDENTIAL'));
    if (evidence.note || 'currentTitle' in evidence || evidence.items) assert.equal(value('--model'), 'haiku');
    await appendFile(process.env.ACT_SUMMARY_FIXTURE_LOG, JSON.stringify({ model: value('--model'), evidence }) + '\n');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: evidence.items ? (evidence.items.some(item => /billing/i.test(item.title)) ? 'Billing plan switch' : 'KEEP') : 'currentTitle' in evidence ? 'Fix thumbnail refresh loop' : evidence.note ? evidence.note.includes('Next step:') ? 'Migration decision follow-up' : 'API compatibility plan' : 'Running billing regression tests', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: randomUUID() }));
  } else assert.fail(`Unexpected frame: ${frame.type}`);
}
