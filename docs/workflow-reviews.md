# `/review` workflow integration

Status: backend provider adapter implemented and fixture-tested. Durable service
orchestration and linked-item UI have local fixture and hidden desktop coverage. Live write
tests require human supervision; no test triggers a comment, review or workflow.

## A typical `/review` workflow

A typical repository workflow that answers `/review` accepts it at the beginning of a
PR issue comment. Its review job posts a placeholder as `github-actions[bot]`, then edits that same comment
with a report or an explicit failure. The placeholder and final comment link to the
workflow run. A green run without a report is insufficient.

Such a workflow often does not expose its trigger comment ID in its run name or
result comment: its `issue_comment` runs show the PR title as their display name and
carry no trigger comment ID field. Actor, timestamp and title matching
cannot distinguish simultaneous requests on the same PR. Do not guess the run;
timed tracking below refuses such overlaps as ambiguous.

The workflow file, review job and failure text are `github.review-run` settings
(defaults `.github/workflows/review.yml`, `review`, none), globally or per repository,
as is the report marker that tells a written review from a progress note.

## Tracking tiers

The capability check classifies the default-branch workflow:

- **exact** — the `run-name` below exposes the trigger comment ID. Preferred.
- **timed** — no matching `run-name`, but `on.issue_comment` (type `created` or no
  types) and exactly one configured review job (by key or `name`) with steps. This is
  the shape of the typical workflow above.
- anything else is unsupported with a specific reason; `/review` is not offered.

Timed correlation reads the trigger comment's `created_at`, then the configured workflow's
`issue_comment` runs created in [comment − 10 s, comment + 3 min] and each run's
attempt-one jobs. A run whose review job is in progress or finished
(not skipped) has started; a skipped job, or a finished run without one, is not a
candidate; a queued or missing job is undecided and blocks adoption until it
resolves. Exactly one started run is adopted. Two started runs, more than 20 runs
in the window, or another comment starting with `/review` on the same PR in the
window fail as ambiguous with the workflow runs URL; no candidate is `not-observed`
until the watch deadline. The result comment is the `github-actions[bot]` comment
posted after the trigger that links the adopted run; a completed report is held as
awaiting-result until the window closes so a late competing `/review` can still
surface. The review view shows “matched by time”. Fixture tests cover both tiers;
neither has a supervised live run yet.

## Exact run-name contract

The minimal change to a workflow is a top-level `run-name` that exposes the immutable
GitHub trigger comment ID:

```yaml
run-name: >-
  ${{ github.event_name == 'issue_comment'
      && format('ACT review comment {0}', github.event.comment.id)
      || 'Review' }}
```

The app must capability-check the workflow on the repository's default branch
before offering its write action. A supported run must match the repository,
workflow path, `issue_comment` event and exact marker. Require one distinct run ID;
duplicate API pages are harmless, multiple distinct matches are ambiguous.
The existing run URL and bot-comment identity then bind the edited result.

`workflow-correlation.ts` implements and fixture-tests this selection policy. The
backend `github-workflow.ts` adapter parses default-branch YAML, checks the active
workflow and reads bounded runs, attempt-one jobs and edited bot reports. The
separate transport only permits one exact `/review` POST and never retries it.
Read-only clients have no write method. Reruns, replaced identities, ambiguous
results and green runs without a report cannot be accepted as complete. The repository change and its
provider contract still require supervised verification before enablement.

## Uncertain writes and durable continuation

Persist the request, account/repository/PR, exact `/review` body, preflight comment
IDs and attempt time **before** posting. Store the returned trigger ID before
watching. After a timeout or crash with an uncertain POST outcome, never repost
automatically. Read back candidate comments and ask the user to identify the
trigger, including an explicit no-trigger decision if necessary. Even a single
new identical comment could belong to a concurrent client; an empty listing may
lag an accepted POST. Local tests cover zero, one and multiple candidates.

The watcher persists the trigger/run/job/result-comment identities, polls with
bounded backoff, resumes across service restarts and retains ambiguity, failure,
cancellation, timeout and missing-report states. Shutdown aborts local requests
and preserves uncertainty; it does not cancel a remote GitHub workflow. A local
Stop watching action cannot discard an unresolved POST. An explicit no-trigger
decision ends that request without posting; a new review needs a deliberate action.
The original account/repository/PR binding stays frozen. Service fixture tests cover
these transitions and source edits during preflight. Desktop tests use local provider
fixtures and never real writes. Only after human supervision
is arranged should a real comment and completed report be verified on a dedicated
test PR.

## Adapter contract references

Endpoint shapes follow GitHub's official REST documentation:
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[issue comments](https://docs.github.com/en/rest/issues/comments), and
[repository contents](https://docs.github.com/en/rest/repos/contents). These
documentation reads are not evidence of a live workflow test.

## Shared UI/MCP action

`workspace_run` / `pr.review.workflow` uses `arguments.operation`:

- `options` reads the current repository capability without posting.
- `start` (default) requires a persisted UUID `requestId`; retries reuse it.
- `status` reads local durable progress, optionally filtered by `requestId`.
- `reconcile` requires that request ID and an explicit eligible `triggerId`, or
  `null` to confirm no comment was posted and end this request without a retry.
- `stop` pauses local watching only. It cannot abandon an unresolved POST.

Status/result content appears in its own `github.review-run` item, linked to the
source PR. Report text is untrusted plain content; links are derived from verified
identities. Hidden Electron tests exercise successful restart/report navigation
and uncertain-POST confirmation; an injected provider set cannot use real GitHub
credentials or write capabilities. Live acceptance and workflow editing are
deferred to human supervision.
