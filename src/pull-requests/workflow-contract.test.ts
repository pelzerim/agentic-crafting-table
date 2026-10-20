import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKFLOW_REVIEW_CONTRACT, parseRepositoryOverrides, workflowFileName, workflowReviewContract, workflowReviewSettingsFields } from './workflow-contract.ts';
import { fieldDefaults, validateFields } from '../resource-plugins/define.ts';
import reviewRunPlugin from '../resource-plugins/items/github-review-run/plugin.ts';

test('the /review contract defaults are neutral and every part is a setting', () => {
  assert.deepEqual(DEFAULT_WORKFLOW_REVIEW_CONTRACT, { workflowPath: '.github/workflows/review.yml', jobName: 'review', failureText: '', reportMarker: String.raw`^(?:#{1,6} +\S|\*\*[^*\n]+:\*\*)` });
  assert.deepEqual(fieldDefaults(workflowReviewSettingsFields), { ...DEFAULT_WORKFLOW_REVIEW_CONTRACT, repositories: '' });
  assert.deepEqual(workflowReviewContract(undefined, 'acme/app'), DEFAULT_WORKFLOW_REVIEW_CONTRACT);
  const custom = { workflowPath: '.github/workflows/agent.yml', jobName: 'agent-review', failureText: 'agent review did not complete', reportMarker: '^Result:' };
  assert.deepEqual(workflowReviewContract({ ...custom }, 'acme/app'), custom);
  assert.equal(workflowFileName({ ...DEFAULT_WORKFLOW_REVIEW_CONTRACT, workflowPath: '.github/workflows/agent-review.yaml' }), 'agent-review.yaml');
});

test('repository overrides replace only the parts they name, matched case-insensitively', () => {
  const settings = { workflowPath: '.github/workflows/review.yml', jobName: 'review', failureText: 'did not finish',
    repositories: 'acme/app | .github/workflows/agent.yml | agent-review\n\n  Acme/Docs |  | docs review | docs failed  \nacme/api' };
  assert.deepEqual(workflowReviewContract(settings, 'ACME/app'), { workflowPath: '.github/workflows/agent.yml', jobName: 'agent-review', failureText: 'did not finish', reportMarker: DEFAULT_WORKFLOW_REVIEW_CONTRACT.reportMarker });
  assert.deepEqual(workflowReviewContract(settings, 'acme/docs'), { workflowPath: '.github/workflows/review.yml', jobName: 'docs review', failureText: 'docs failed', reportMarker: DEFAULT_WORKFLOW_REVIEW_CONTRACT.reportMarker });
  assert.deepEqual(workflowReviewContract(settings, 'acme/api'), { workflowPath: '.github/workflows/review.yml', jobName: 'review', failureText: 'did not finish', reportMarker: DEFAULT_WORKFLOW_REVIEW_CONTRACT.reportMarker });
  assert.deepEqual(workflowReviewContract(settings, 'other/repo'), workflowReviewContract({ ...settings, repositories: '' }, 'other/repo'));
  assert.equal(parseRepositoryOverrides('').size, 0);
});

test('settings reject workflow files outside .github/workflows, unsafe job names and malformed override lines', () => {
  const valid = (values: Record<string, string>) => validateFields(workflowReviewSettingsFields, { ...fieldDefaults(workflowReviewSettingsFields), ...values });
  assert.equal(valid({}), true);
  assert.equal(valid({ workflowPath: '.github/workflows/agent.yml' }), true);
  for (const workflowPath of ['agent.yml', '.github/workflows/../secret.yml', '.github/workflows/x.txt', '']) assert.equal(valid({ workflowPath }), false, workflowPath);
  for (const jobName of ['', 'job|name', '-leading']) assert.equal(valid({ jobName }), false, jobName);
  assert.equal(valid({ repositories: 'acme/app | .github/workflows/a.yml | job | text\nacme/b' }), true);
  for (const repositories of ['not a repo', 'acme/app | other/path.yml', 'acme/app | | -bad', 'acme/app | | job | text | extra']) {
    assert.equal(valid({ repositories }), false, repositories);
    assert.throws(() => parseRepositoryOverrides(repositories), /override/i);
  }
});

test('a report marker that is not a regular expression is refused when saved', () => {
  const validate = reviewRunPlugin.settings!.validate!;
  assert.doesNotThrow(() => validate({ ...fieldDefaults(workflowReviewSettingsFields), reportMarker: '^Result:' }));
  assert.throws(() => validate({ ...fieldDefaults(workflowReviewSettingsFields), reportMarker: '(' }), /Report marker/);
});
