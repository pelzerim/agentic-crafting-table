import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareReviewProcess, probeReview } from './review.ts';
import { providerFindingsSchema } from '../../src/pull-requests/review-findings.ts';

test('one-off reviews freeze native commands, isolate source configuration and preserve read-only controls', () => {
  const root = mkdtempSync(join(tmpdir(), 'act-review-process-'));
  try {
    for (const provider of ['codex', 'claude'] as const) {
      const requestId = randomUUID(), input = { requestId, nodeId: 'review', provider, model: provider === 'codex' ? 'gpt-6-astra' : 'opus', prompt: 'Review this exact change.', capability: { executable: '/usr/bin/native-agent', version: 'fixture' }, comparison: { repository: 'fixture/repo', number: 1, baseTipSha: 'b'.repeat(40), baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), changedFiles: ['file'], diff: 'complete patch', cwd: join(root, 'repository'), digest: 'frozen' } };
      const plan = prepareReviewProcess(root, input);
      assert.equal(plan.launch.executable, input.capability.executable); assert.equal(plan.launch.cwd, root); assert.equal(plan.launch.readOnly, true); assert.equal(plan.launch.bindings, undefined);
      assert.equal(readFileSync(join(root, `review-${requestId}.md`), 'utf8'), input.prompt);
      const args = plan.launch.args;
      if (provider === 'codex') { assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert(args.includes('--ignore-user-config')); assert(args.includes('mcp_servers={}')); }
      else { assert(args.includes('--restricted')); assert(args.includes('--safe-mode')); assert(args.includes('--strict-mcp-config')); assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep'); }
      assert.doesNotMatch(args.join(' '), /bypass|dangerously|workspace-write/);
      assert.deepEqual(prepareReviewProcess(root, input), plan);
      assert.throws(() => prepareReviewProcess(root, { ...input, model: 'changed' }), /reused/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reviews request the findings schema through native structured output when the CLI supports it', () => {
  const root = mkdtempSync(join(tmpdir(), 'act-review-schema-'));
  try {
    for (const provider of ['codex', 'claude'] as const) for (const structuredOutput of [true, false]) {
      const requestId = randomUUID(), input = { requestId, nodeId: 'review', provider, model: 'm', prompt: 'Review.', capability: { executable: '/usr/bin/native-agent', version: 'fixture', structuredOutput }, comparison: { repository: 'fixture/repo', number: 1, baseTipSha: 'b'.repeat(40), baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), changedFiles: ['file'], diff: 'patch', cwd: join(root, 'repository'), digest: 'frozen' } };
      const args = prepareReviewProcess(root, input).launch.args, value = (flag: string) => args[args.indexOf(flag) + 1];
      assert.match(args.at(-1)!, /findings JSON/);
      if (provider === 'codex') {
        assert.equal(args.includes('--output-schema'), structuredOutput);
        if (structuredOutput) assert.deepEqual(JSON.parse(readFileSync(value('--output-schema'), 'utf8')), providerFindingsSchema);
      } else {
        assert.equal(value('--output-format'), structuredOutput ? 'stream-json' : 'text'); assert.equal(args.includes('--verbose'), structuredOutput);
        assert.equal(args.includes('--json-schema'), structuredOutput);
        if (structuredOutput) assert.deepEqual(JSON.parse(value('--json-schema')), providerFindingsSchema);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the capability probe reports structured output only when the installed CLI lists the flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'act-review-probe-'));
  try {
    const help = (text: string) => { const file = join(root, randomUUID()); writeFileSync(file, `#!/bin/sh\necho '${text}'\n`, { mode: 0o700 }); return { executable: file, version: 'fixture' }; };
    const claude = '--print --safe-mode --restricted --strict-mcp-config --tools --permission-mode', codex = '--sandbox --ignore-user-config --ignore-rules --output-last-message --skip-git-repo-check';
    assert.equal(await probeReview('claude', help(`${claude} --output-format stream-json --verbose --json-schema`)), true);
    assert.equal(await probeReview('claude', help(`${claude} --output-format --json-schema`)), false);
    assert.equal(await probeReview('claude', help(claude)), false);
    assert.equal(await probeReview('codex', help(`${codex} --output-schema`)), true);
    assert.equal(await probeReview('codex', help(codex)), false);
    await assert.rejects(probeReview('codex', help('--sandbox')), /lacks required controls/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
