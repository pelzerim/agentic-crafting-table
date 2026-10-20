import { GitHubWorkflowClient, WORKFLOW_RUN_NAME } from '../../packages/provider-runtime/github-workflow.ts';
import { pullFixture } from './github.ts';
export const workflowYaml = `name: Claude Code
run-name: >-
  ${WORKFLOW_RUN_NAME}
on:
  issue_comment:
    types: [created]
jobs:
  review:
    steps:
      - run: echo fixture
`;
export const timedWorkflowYaml = `name: Claude Code
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  claude:
    if: contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@v1
  review:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
`;
export function workflowFixture(createdAt = () => '2026-09-25T12:00:00Z') {
  const fixture = {
    yaml: workflowYaml, posts: 0, paths: [] as string[], status: 200,
    comments: [] as { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }[],
    runs: [] as { id: number; workflow_id: number; path: string; event: string; display_title: string; created_at: string; run_attempt: number; status: string; conclusion: string | null; repository: { full_name: string } }[],
    jobs: [] as { id: number; run_id: number; name: string; status: string; conclusion: string | null }[],
    postFailure: undefined as Error | undefined,
    async get(path: string, signal: AbortSignal) {
      signal.throwIfAborted(); fixture.paths.push(path);
      const body = path === '/user' ? { id: 1, login: 'fixture-developer' }
        : path.includes('/contents/') ? { type: 'file', encoding: 'base64', sha: 'c'.repeat(40), content: Buffer.from(fixture.yaml).toString('base64') }
          : path.includes('/runs?') ? { workflow_runs: fixture.runs }
            : path.includes('/jobs?') ? { jobs: fixture.jobs.filter(job => path.includes(`/runs/${job.run_id}/`)) }
              : path.includes('/actions/workflows/') ? { id: 3, state: 'active', path: '.github/workflows/review.yml' }
                : path.includes('/comments?') ? fixture.comments : pullFixture;
      return { status: fixture.status, headers: new Headers(), body: structuredClone(body) };
    },
    async postReview(_identity: unknown, signal: AbortSignal) {
      signal.throwIfAborted(); fixture.posts++;
      const comment = { id: 100 + fixture.posts, body: '/review', user: { login: 'fixture-developer' }, created_at: createdAt(), updated_at: createdAt() };
      fixture.comments.push(comment);
      if (fixture.postFailure) throw fixture.postFailure;
      return { status: 201, headers: new Headers(), body: comment };
    },
  };
  const later = (at: string, seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString().replace('.000Z', 'Z');
  return Object.assign(fixture, { client: new GitHubWorkflowClient(fixture), later, complete(triggerId = 101, title = `ACT review comment ${triggerId}`) {
    const at = fixture.comments.find(comment => comment.id === triggerId)?.created_at ?? createdAt();
    fixture.runs = [{ id: 200, workflow_id: 3, path: '.github/workflows/review.yml@main', event: 'issue_comment', display_title: title, created_at: later(at, 2), run_attempt: 1, status: 'completed', conclusion: 'success', repository: { full_name: 'fixture/billing' } }];
    fixture.jobs = [{ id: 300, run_id: 200, name: 'review', status: 'completed', conclusion: 'success' }];
    fixture.comments.push({ id: 400, body: '## Summary\nFixture findings\n[Run](https://github.com/fixture/billing/actions/runs/200)', user: { login: 'github-actions[bot]' }, created_at: later(at, 3), updated_at: later(at, 90) });
  } });
}
