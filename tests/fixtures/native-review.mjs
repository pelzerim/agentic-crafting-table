import assert from 'node:assert/strict';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1], codex = args[0] === 'exec';
if (codex) { assert.equal(value('--sandbox'), 'read-only'); assert(args.includes('--ignore-user-config')); assert(args.includes('--ignore-rules')); assert(args.includes('mcp_servers={}')); }
else { assert(args.includes('--safe-mode')); assert(args.includes('--restricted')); assert(args.includes('--strict-mcp-config')); assert.equal(value('--tools'), 'Read,Glob,Grep'); assert.equal(value('--permission-mode'), 'dontAsk'); }
const path = JSON.parse(args.at(-1).match(/request at ("(?:\\.|[^"\\])*")\./)[1]);
const prompt = await readFile(path, 'utf8');
assert(prompt.includes('Return the review in this session and finish')); assert(prompt.includes('+ review change')); assert(prompt.includes('c'.repeat(40))); assert(prompt.includes('Findings JSON schema'));
const structured = codex ? args.includes('--output-schema') : args.includes('--json-schema');
if (structured && codex) JSON.parse(await readFile(value('--output-schema'), 'utf8'));
if (structured && !codex) { assert.equal(value('--output-format'), 'stream-json'); assert(args.includes('--verbose')); JSON.parse(value('--json-schema')); }
console.log(`\x1b[36mREVIEW_STARTED:${codex ? 'codex' : 'claude'}:${value('--model')}\x1b[0m`);
const events = [{ type: 'system', subtype: 'init', cwd: process.cwd(), model: value('--model'), tools: ['Read', 'Glob', 'Grep'] }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the change.' }, { type: 'tool_use', name: 'Read', input: { file_path: join(process.cwd(), 'repository', 'file.ts') } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: '1\\tconst value = 1;' }] } }];
if (structured && !codex) for (const event of events) console.log(JSON.stringify(event));
while (true) { try { await access(join(process.cwd(), 'finish')); break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
// A finish file holding JSON is returned as the structured findings; anything else as a text review.
const finish = (await readFile(join(process.cwd(), 'finish'), 'utf8')).trim(), findings = finish.startsWith('{') ? finish : undefined;
const review = findings ?? '## Review complete\n\n- **P2** `file.ts:12` — verify the changed input before applying it.';
const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 72_000, result: findings ? '' : review, ...(findings ? { structured_output: JSON.parse(findings) } : {}) };
const output = !findings && !structured ? review : codex ? findings ?? review : structured ? JSON.stringify(result) : '```json\n' + findings + '\n```';
if (codex) await writeFile(value('--output-last-message'), output);
console.log(output);
