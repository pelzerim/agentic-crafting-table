import test from 'node:test';
import assert from 'node:assert/strict';
import { componentOf, dueStage, environmentStates, parseStageRules, reachedStage, STAGE_WINDOW_MS, stageRule, stageRulesSetting } from './stages.ts';
import type { RolloutJob } from '../../../../packages/provider-runtime/github-rollout.ts';
import plugin from './plugin.ts';

const at = (minute: number) => Date.UTC(2026, 9, 6, 13, minute);
const iso = (minute: number) => new Date(at(minute)).toISOString();
const SETTLE_MS = 10 * 60_000;
const RULES = parseStageRules(JSON.stringify([{ id: 'web-release', workflow: '^(web|docs)\\s*/\\s*release$', stages: [
  { key: 'preview', environment: 'preview' },
  { key: 'live', environment: 'live' },
  { key: 'settle', environment: 'live', delayMinutes: 10 },
] }]));
const job = (id: number, name: string, status: string, conclusion: string | null, completed?: number): RolloutJob =>
  ({ id, run_id: 7, name, status, conclusion, started_at: iso(0), completed_at: completed === undefined ? null : iso(completed) });
const deploy = (preview: [string, string | null, number?], live: [string, string | null, number?]) => [
  job(1, 'lint', 'completed', 'skipped', 0),
  job(2, 'preview / ship', preview[0], preview[1], preview[2]), job(3, 'preview / notify', preview[0], preview[1], preview[2]),
  job(4, 'live / ship', live[0], live[1], live[2]), job(5, 'live / notify', live[0], live[1], live[2]),
];
const observed = (workflow: string, runName = workflow) => ({ workflow, run: { name: runName } });

test('no workflow is staged until stage rules are configured', () => {
  assert.deepEqual(parseStageRules(''), []);
  assert.deepEqual(parseStageRules('  \n'), []);
  assert.equal(stageRule(observed('Web / Release'), []), undefined);
  assert.deepEqual(stageRulesSetting(undefined), []);
  assert.deepEqual(stageRulesSetting('[{'), [], 'a saved value that no longer parses stages nothing');
});

test('a configured rule stages workflows by name, case and spacing aside; any other workflow keeps one validation per attempt', () => {
  for (const name of ['Web / Release', 'Docs / Release', 'web/release']) assert.equal(stageRule(observed(name), RULES)?.id, 'web-release', name);
  for (const name of ['Blog / Release', 'Web / Build', 'Web / Release preview', 'Website / Release']) assert.equal(stageRule(observed(name), RULES), undefined, name);
  assert.equal(stageRule({ workflow: '', run: { name: 'Web / Release' } }, RULES)?.id, 'web-release', 'a run pinned by id has only its run name');
});

test('the settings placeholder is a valid two-stage example with a delay before the last check', () => {
  const placeholder = plugin.settings!.fields.stageRules.placeholder!;
  const [rule] = parseStageRules(placeholder);
  assert.equal(stageRule(observed('Release'), [rule])?.id, 'web-release');
  assert.deepEqual(rule.stages.map(stage => [stage.key, stage.environment, stage.label]), [['preview', 'preview', 'preview done'], ['live', 'live', 'live +10 min']]);
});

test('stage rules are validated JSON; focus and card label come from the environment and delay', () => {
  assert.deepEqual(RULES[0].stages.map(stage => [stage.key, stage.environment, stage.delayMs, stage.focus, stage.label]), [
    ['preview', 'preview', 0, 'preview', 'preview done'],
    ['live', 'live', 0, 'live', 'live done'],
    ['settle', 'live', SETTLE_MS, 'live, 10 minutes after it finished', 'live +10 min'],
  ]);
  const one = parseStageRules('[{ "id": "web", "workflow": "^web$", "stages": [{ "key": "settle", "environment": "live", "delayMinutes": 1, "focus": "live after a minute" }] }]');
  assert.deepEqual([one[0].stages[0].focus, one[0].stages[0].label], ['live after a minute', 'live +1 min']);
  for (const [text, message] of [
    ['[', /not valid JSON/],
    ['{}', /expected array/],
    ['[{ "id": "web", "workflow": "(", "stages": [{ "key": "a", "environment": "staging" }] }]', /at 0\.workflow: workflow must be a valid regular expression/],
    ['[{ "id": "web", "workflow": "^web$", "stages": [] }]', /at 0\.stages/],
    ['[{ "id": "Web", "workflow": "^web$", "stages": [{ "key": "a", "environment": "staging" }] }]', /at 0\.id: use lower-case/],
    ['[{ "id": "web", "workflow": "^web$", "stages": [{ "key": "a", "environment": "staging", "delayMinutes": -1 }] }]', /at 0\.stages\.0\.delayMinutes/],
    ['[{ "id": "web", "workflow": "^web$", "stages": [{ "key": "a", "environment": "staging" }, { "key": "a", "environment": "production" }] }]', /stage keys must be unique/],
    ['[{ "id": "web", "workflow": "^web$", "stages": [{ "key": "a", "environment": "staging", "extra": 1 }] }]', /at 0\.stages\.0/],
  ] as const) assert.throws(() => parseStageRules(text), message, text);
});

test('environments come from the job names, with their status and when they finished', () => {
  assert.deepEqual(environmentStates(deploy(['completed', 'success', 5], ['in_progress', null])).map(entry => [entry.name, entry.status, entry.finishedAt, entry.jobs.map(item => item.id)]), [
    ['other', 'skipped', at(0), [1]], ['preview', 'succeeded', at(5), [2, 3]], ['live', 'running', undefined, [4, 5]],
  ]);
  assert.equal(environmentStates(deploy(['completed', 'failure', 5], ['completed', 'skipped', 5]))[1].status, 'failed');
  assert.equal(environmentStates(deploy(['completed', 'success', 5], ['queued', null]))[2].status, 'pending');
});

test('preview done asks for the preview stage, live done for live, and 10 minutes later for the settle stage; an earlier stage gives way to a later one', () => {
  const rule = RULES[0];
  assert.equal(dueStage(rule, deploy(['in_progress', null], ['queued', null]), at(3)), undefined, 'nothing has finished');
  const preview = dueStage(rule, deploy(['completed', 'success', 5], ['queued', null]), at(6));
  assert.deepEqual(preview && [preview.key, preview.environment, preview.finishedAt, preview.dueAt, preview.jobs], ['preview', 'preview', at(5), at(5), [2, 3]]);
  const live = dueStage(rule, deploy(['completed', 'success', 5], ['completed', 'success', 20]), at(21));
  assert.deepEqual(live && [live.key, live.finishedAt, live.jobs], ['live', at(20), [4, 5]]);
  assert.equal(dueStage(rule, deploy(['completed', 'success', 5], ['completed', 'success', 20]), at(20) + SETTLE_MS - 1)?.key, 'live');
  const settle = dueStage(rule, deploy(['completed', 'success', 5], ['completed', 'success', 20]), at(20) + SETTLE_MS);
  assert.deepEqual(settle && [settle.key, settle.environment, settle.dueAt, settle.focus], ['settle', 'live', at(20) + SETTLE_MS, 'live, 10 minutes after it finished']);
  assert.equal(dueStage(rule, deploy(['completed', 'success', 5], ['completed', 'success', 20]), at(20) + SETTLE_MS + STAGE_WINDOW_MS), undefined, 'a stage nobody took within the hour is left alone');
  assert.equal(dueStage(rule, deploy(['completed', 'success', 5], ['in_progress', null]), at(5) + STAGE_WINDOW_MS + 1), undefined);
});

test('a stage counts as finished only when something in it ran: skipped or cancelled stages are not validated', () => {
  const rule = RULES[0];
  assert.equal(dueStage(rule, deploy(['completed', 'skipped', 5], ['queued', null]), at(6)), undefined);
  assert.equal(dueStage(rule, deploy(['completed', 'success', 5], ['completed', 'cancelled', 8]), at(9))?.key, 'preview', 'a cancelled live run leaves the preview stage due');
  assert.equal(dueStage(rule, deploy(['completed', 'failure', 5], ['completed', 'skipped', 5]), at(6))?.key, 'preview', 'a failed stage is validated too');
});

test('the stage a run has reached is the latest one due, however long ago, so a validation started from chat hours later still names it', () => {
  const rule = RULES[0], done = deploy(['completed', 'success', 5], ['completed', 'success', 20]);
  assert.equal(reachedStage(rule, deploy(['in_progress', null], ['queued', null]), at(3)), undefined);
  assert.equal(reachedStage(rule, deploy(['completed', 'success', 5], ['in_progress', null]), at(10))?.key, 'preview');
  assert.equal(reachedStage(rule, done, at(21))?.key, 'live');
  assert.equal(reachedStage(rule, done, at(20) + SETTLE_MS)?.key, 'settle');
  assert.equal(reachedStage(rule, done, at(20) + SETTLE_MS + STAGE_WINDOW_MS)?.key, 'settle', 'no window applies');
});

test('the component is the deepest folder all changed files share, else their top folders', () => {
  assert.deepEqual(componentOf(['services/api/billing/invoices.ts', 'services/api/billing/export.ts']), { path: 'services/api/billing', files: ['services/api/billing/invoices.ts', 'services/api/billing/export.ts'], total: 2 });
  assert.equal(componentOf(['services/a.ts', 'web/b.ts', 'services/c.ts'])?.path, 'services, web');
  assert.equal(componentOf(['README.md'])?.path, '.');
  assert.equal(componentOf([]), undefined);
  const many = componentOf(Array.from({ length: 30 }, (_, i) => `apps/api/src/file-${i}.ts`))!;
  assert.deepEqual([many.path, many.files.length, many.total], ['apps/api/src', 10, 30]);
});
