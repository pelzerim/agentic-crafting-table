import test from 'node:test';
import assert from 'node:assert/strict';
import { clip, findingsJsonSchema, parseReviewOutput, findingLabel, sortFindings, findingsRollup, findingsPrompt, ignoredFindings, locationUrl, findingMarkdown, reviewMarkdown } from './review-findings.ts';
import { questionReview, sampleReview } from '../../tests/fixtures/review-findings.ts';


test('the provider schema is strict-mode compatible: closed objects with every property required', () => {
  const visit = (schema: any, path: string) => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.equal(schema.additionalProperties, false, `${path} must be closed`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} must require every property`);
      for (const [key, value] of Object.entries(schema.properties)) visit(value, `${path}.${key}`);
    }
    if (schema.items) visit(schema.items, `${path}[]`);
  };
  visit(findingsJsonSchema, '$');
  assert.deepEqual((findingsJsonSchema.properties.findings as any).items.properties.severity.enum, ['critical', 'high', 'medium', 'low', null]);
});

test('parses Claude JSON results, Codex last messages, fenced blocks and strict-mode nulls', () => {
  const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: sampleReview });
  assert.equal(parseReviewOutput(claude).kind, 'findings');
  assert.equal(parseReviewOutput(`REVIEW_STARTED:claude:opus\nwarning: something\n${claude}`).kind, 'findings', 'earlier terminal lines are ignored');
  assert.equal(parseReviewOutput(JSON.stringify(sampleReview)).kind, 'findings');
  const fenced = parseReviewOutput(`Here is my review.\n\n\`\`\`json\n${JSON.stringify(sampleReview, null, 2)}\n\`\`\`\n`);
  assert.equal(fenced.kind, 'findings');
  const nulls = { ...sampleReview, findings: [{ ...sampleReview.findings[1], severity: null, qualifier: null, when: null, why: null, fix: null, verification: { level: 'verified', note: null }, locations: [{ path: './src/a.ts', startLine: 3, endLine: null }] }] };
  const parsed = parseReviewOutput(JSON.stringify(nulls));
  assert.equal(parsed.kind, 'findings');
  if (parsed.kind === 'findings') { assert.equal(parsed.review.findings[0].severity, undefined); assert.equal(parsed.review.findings[0].locations[0].path, 'src/a.ts'); }
  const inResult = parseReviewOutput(JSON.stringify({ type: 'result', is_error: false, result: '```json\n' + JSON.stringify(sampleReview) + '\n```' }));
  assert.equal(inResult.kind, 'findings');
});

test('invalid output falls back to Markdown with a precise reason; Claude result text stays readable', () => {
  const missing = { ...sampleReview, findings: [sampleReview.findings[0], sampleReview.findings[1], { ...sampleReview.findings[2], locations: undefined }] };
  const result = parseReviewOutput(JSON.stringify(missing));
  assert.equal(result.kind, 'text');
  if (result.kind === 'text') assert.match(result.reason, /findings\[2\]\.locations/);
  const legacy = parseReviewOutput('## Review complete\n\n- **P2** `file.ts:12` — check it.');
  assert.equal(legacy.kind, 'text');
  if (legacy.kind === 'text') { assert.equal(legacy.markdown, '## Review complete\n\n- **P2** `file.ts:12` — check it.'); assert.match(legacy.reason, /no findings JSON/i); }
  const failed = parseReviewOutput(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'Partial **text**' }));
  assert.equal(failed.kind, 'text');
  if (failed.kind === 'text') assert.equal(failed.markdown, 'Partial **text**');
  const bugWithoutSeverity = parseReviewOutput(JSON.stringify({ ...sampleReview, findings: [{ ...sampleReview.findings[0], severity: undefined }] }));
  assert.equal(bugWithoutSeverity.kind, 'text');
  const duplicate = parseReviewOutput(JSON.stringify({ ...sampleReview, findings: [sampleReview.findings[0], sampleReview.findings[0]] }));
  assert.equal(duplicate.kind, 'text');
});

test('sanitizes control characters, clamps sizes and rejects unsafe paths as links', () => {
  const noisy = { ...sampleReview, summary: 'x'.repeat(2000), findings: [{ ...sampleReview.findings[0], title: 'Bad\x1b[31m title\u0007\n', locations: [{ path: '/etc/passwd', startLine: 1 }, { path: '../up.ts', startLine: 2 }, { path: 'ok.ts', startLine: 5, endLine: 3 }] }] };
  const parsed = parseReviewOutput(JSON.stringify(noisy));
  assert.equal(parsed.kind, 'findings');
  if (parsed.kind !== 'findings') return;
  assert.equal(parsed.review.summary.length, 600); assert.ok(parsed.review.summary.endsWith('…'));
  assert.equal(parsed.review.findings[0].title, 'Bad[31m title');
  assert.equal(locationUrl('acme/app', 'a'.repeat(40), parsed.review.findings[0].locations[0]), undefined);
  assert.equal(locationUrl('acme/app', 'a'.repeat(40), parsed.review.findings[0].locations[1]), undefined);
  assert.equal(parsed.review.findings[0].locations[2].endLine, undefined);
  assert.equal(locationUrl('acme/app', 'a'.repeat(40), { path: 'src/a b.ts', startLine: 4, endLine: 6 }), `https://github.com/acme/app/blob/${'a'.repeat(40)}/src/a%20b.ts#L4-L6`);
});

test('orders by severity then kind and verification; labels and roll-up summarise states', () => {
  assert.deepEqual(sortFindings(sampleReview.findings).map(finding => finding.id), ['F3', 'F1', 'F2']);
  assert.equal(findingLabel(sampleReview.findings[1]), 'Hardening');
  const rollup = findingsRollup(sampleReview, { F1: 'sent', F3: 'fixed' });
  assert.equal(rollup.counts, '3 findings · 1 critical · 1 low · 1 hard.');
  assert.equal(rollup.progress, '2 sent · 1 fixed');
  assert.deepEqual(rollup.pips, [{ tone: 'critical', style: 'fixed' }, { tone: 'low', style: 'sent' }, { tone: 'hardening', style: 'open' }]);
  assert.equal(rollup.urgent, true);
  assert.equal(findingsRollup({ ...sampleReview, findings: [] }, {}).counts, 'No findings');
});

test('a finding the person marked counts as ignored; only an agent report counts as fixed', () => {
  const events = [{ findingId: 'F1', status: 'fixed', actor: 'agent' }, { findingId: 'F2', status: 'fixed', actor: 'user' }, { findingId: 'F3', status: 'fixed', actor: 'user' }, { findingId: 'F3', status: 'sent', actor: 'system' }] as const;
  const ignored = ignoredFindings(events);
  assert.deepEqual([...ignored], ['F2']);
  const rollup = findingsRollup(sampleReview, { F1: 'fixed', F2: 'fixed', F3: 'sent' }, ignored);
  assert.equal(rollup.progress, '2 sent · 1 fixed · 1 ignored');
  assert.deepEqual(rollup.pips.map(pip => pip.style), ['sent', 'fixed', 'fixed']);
  assert.equal(findingsRollup(sampleReview, { F2: 'fixed' }, ignored).progress, '1 ignored');
});

test('the send prompt lists only the chosen findings to fix and carries the full review as context', () => {
  const prompt = findingsPrompt({ review: sampleReview, findingIds: ['F1', 'F2'], reviewNodeId: 'review-1', repository: 'acme/app', number: 42, title: 'Resize thumbnails', url: 'https://github.com/acme/app/pull/42', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), note: 'Keep the sync path' });
  const [task, context] = prompt.split('<review>');
  assert.match(task, /Fix only F1, F2/);
  assert.match(task, /F1 · Low · Thumbnails are resized synchronously/); assert.match(task, /F2 · Hardening · Readers match exact file names/);
  assert.doesNotMatch(task, /Tokens are logged/);
  assert.match(task, /Note from the user: Keep the sync path/);
  assert.match(task, /workspace_report_review_fixes/); assert.match(task, /"reviewNodeId":"review-1"/);
  assert.match(task, /acme\/app#42/); assert.match(task, new RegExp(`reviewed head ${'a'.repeat(40)}`));
  assert.match(context, /Tokens are logged/);
  assert.doesNotMatch(prompt, /[\x00-\x08\x0b-\x1f\x7f]/);
  assert.doesNotMatch(prompt, /review loop/);
  const loop = findingsPrompt({ review: sampleReview, findingIds: ['F3'], reviewNodeId: 'review-2', repository: 'acme/app', number: 42, title: 'Resize thumbnails', headSha: 'a'.repeat(40), loop: { round: 2, of: 3, branch: 'feature/thumbnails' } });
  assert.match(loop.split('<review>')[0], /Review loop round 2 of 3/);
  assert.match(loop.split('<review>')[0], /push the fix to feature\/thumbnails/);
});

test('Claude stream-json recordings parse from their final result event', () => {
  const events = [{ type: 'system', subtype: 'init', model: 'claude-opus', tools: ['Read'] },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the change.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x/src/a.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '{"not":"findings"}' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: sampleReview }, { type: 'rate_limit_event' }];
  assert.equal(parseReviewOutput(events.map(event => JSON.stringify(event)).join('\n')).kind, 'findings');
  const crashed = parseReviewOutput(events.slice(0, 3).map(event => JSON.stringify(event)).join('\n'));
  assert.equal(crashed.kind, 'text'); if (crashed.kind === 'text') assert.match(crashed.reason, /no findings JSON/);
  const failed = parseReviewOutput([...events.slice(0, 2), { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Stopped' }].map(event => JSON.stringify(event)).join('\n'));
  assert.equal(failed.kind, 'text'); if (failed.kind === 'text') assert.match(failed.reason, /error_max_turns/);
});

test('long text is clamped at a word boundary; titles and verification notes keep their full length', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('stops the whole service from booting in any environment', 40), 'stops the whole service from booting in…');
  assert.equal(clip('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
  const parsed = parseReviewOutput(JSON.stringify(questionReview));
  assert.equal(parsed.kind, 'findings');
  if (parsed.kind === 'findings') { assert.equal(parsed.review.findings[0].title, questionReview.findings[0].title); assert.equal(parsed.review.findings[0].verification.note, questionReview.findings[0].verification.note); }
  const long = parseReviewOutput(JSON.stringify({ ...questionReview, findings: [{ ...questionReview.findings[0], title: 'word '.repeat(100) }] }));
  if (long.kind === 'findings') { assert.ok(long.review.findings[0].title.length <= 300); assert.match(long.review.findings[0].title, /word…$/); } else assert.fail('expected findings');
});

test('the whole report is one Markdown document: PR, verdict, every finding in desk order with its state, then the notes', () => {
  const report = reviewMarkdown({ title: 'Resize thumbnails', repository: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42', headSha: 'a'.repeat(40), review: sampleReview,
    statuses: { F1: 'fixed', F2: 'fixed', F3: 'sent' },
    history: { F1: [{ status: 'sent', actor: 'system', agentTitle: 'Claude · impl' }, { status: 'fixed', actor: 'agent', agentTitle: 'Claude · impl', commit: 'abc1234aa' }], F2: [{ status: 'fixed', actor: 'user' }], F3: [{ status: 'sent', actor: 'system', agentTitle: 'Claude · docs' }] } });
  assert.equal(report, [
    '# Review: Resize thumbnails',
    'acme/app#42 · https://github.com/acme/app/pull/42 · reviewed at `aaaaaaa`',
    sampleReview.summary,
    '## Findings (3)',
    `${findingMarkdown(sampleReview.findings[2])}\n\nStatus: Sent to Claude · docs`,
    `${findingMarkdown(sampleReview.findings[0])}\n\nStatus: Fixed by Claude · impl in abc1234`,
    `${findingMarkdown(sampleReview.findings[1])}\n\nStatus: Ignored`,
    '## Checked and found correct\n\n- File names stay unique',
    '## Tests\n\nTests not run: I did not run tests.',
  ].join('\n\n'));
  assert.equal(findingMarkdown(sampleReview.findings[0]), '### F1 · Low: Thumbnails are resized synchronously\n\nVerification: Partly verified (Impact is an estimate)\n\nWhere: `src/thumbnails.ts:170–172`\n\nWhen: An album uploads many photos.\n\nWhy it matters:\n- Blocks the event loop.\n\nSuggested fix: Resize asynchronously.');
  const bare = reviewMarkdown({ title: 'Local change', review: { ...sampleReview, findings: [], checked: [], tests: { ran: true, notes: '' } }, statuses: {}, history: {} });
  assert.equal(bare, `# Review: Local change\n\n${sampleReview.summary}\n\n## No findings\n\n## Tests\n\nTests run`);
  assert.match(reviewMarkdown({ title: 'T', review: sampleReview, statuses: {}, history: {} }), /Status: Open/);
});
