# GitHub integration progress

The backend read adapter uses the installed GitHub CLI's account/keyring support.
It lists account metadata without tokens, retrieves credentials for the chosen
login only in backend memory, and sends them only to `https://api.github.com`.
No token is copied into the graph, settings, renderer or logs. The first supported
host is github.com; Enterprise and interactive account setup are not implemented.

The client validates/project-selects PR metadata, exact base/head commit IDs,
changed files, issue discussion comments and submitted reviews. Pagination stays
on the expected REST endpoint instead of following arbitrary returned URLs.
Authentication, permission, rate-limit, interruption, oversized/invalid response
and partial-pagination failures remain explicit errors. Reads use timeouts and
cancellation; redirects are rejected. This foundation is read-only.

Settings → Connections now discovers signed-in GitHub accounts on request. Choose
an account and save to create a stable binding; changing the default preserves
older bindings. Disconnect disables the table’s bindings without logging out of
GitHub CLI. Reconnecting an account reuses its saved ID. Agents discover the same
provider/account metadata through `workspace_connections` and change preferences
through the revisioned `workspace_settings` tool. No token reaches those APIs.

URL-only attachment now uses the same service operation from the inline form and
MCP. It resolves the authoritative title, binds the selected account, reuses an
existing item in the same project, and creates a map alias in another project.
Previously unbound agent-created PRs reconcile explicitly when attaching/opening;
existing account bindings never follow a changed default. Atomic graph receipts
and durable lookup jobs preserve retry identity through interrupted commits.

The expanded PR item shows its description, exact commit pair, changed files,
issue discussion and submitted reviews. Provider text is displayed as text, never
executed HTML. Snapshot/content caches persist in SQLite v8 outside map snapshots;
opening reuses recent data, and Refresh reads it again. Authentication/network
failures preserve saved content with an explicit stale notice; persisted rate-limit
backoff also applies after restart. File reads verify base/head before and after
pagination and reject incomplete results. Missing individual patches are labeled.
Content is bounded to 3 MiB per paginated read and 4 MiB per cache record.
Assignment discovery is described below; the review actions are in [native-reviews.md](native-reviews.md).

## Verification

Five tests use fixture HTTP responses and injected credential commands. They
cover authenticated headers, comparison identity, projection, multi-page results,
partial failure, rate-limit metadata, malformed/oversized responses, cancellation,
unsafe paths, and chosen-account credential handling. No real provider calls run
in normal CI.

The explicit live gate reads only:

```sh
ACT_LIVE_GITHUB=1 node scripts/smoke-github.mjs
```

Set `ACT_GITHUB_PR_URL` to a test PR your account can read. The gate reads the
authoritative title/state, the changed files, the discussion and review lists, and
checks that the head is unchanged across the read. It makes no comments, reviews or
repository changes. The expanded live gate also starts a disposable real workspace
service, selects the existing account, registers the PR as an agent would, attaches
its URL, reads all files, restarts and verifies cached content and idempotent replay,
without touching your own map. The gate has no remote write capability.

References: [GitHub PR REST API](https://docs.github.com/en/rest/pulls/pulls),
[GitHub CLI account token selection](https://cli.github.com/manual/gh_auth_token)
and [GitHub CLI account status](https://cli.github.com/manual/gh_auth_status).
The adapter pins REST API version `2026-03-10`.

Assignment discovery foundation uses GitHub's paginated authenticated `/issues`
endpoint with `filter=assigned`, then selects records containing `pull_request`.
It validates repository identities and never follows provider URLs. Incomplete
pages fail the whole read. A durable watcher and viewed-cycle acknowledgement now use this reader. See [GitHub's assigned-issues contract](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

## Request budget and conditional reads

Every GitHub transport of a login shares one request budget and conditional-read
cache ([architecture](architecture.md#provider-request-budget)).
REST GETs revalidate with the stored ETag per exact path (per page for paginated
reads) and reuse the saved body on 304, which GitHub does not count against the
5,000/h limit. Background reads are serialized and spaced, slow below 40% of the
window and pause below 15% until reset; opening an item, Refresh and writes are
never throttled. Search (the inbox) stays under 30 requests a minute.

Items poll adaptively: unchanged PRs back off from one minute to 2, 5 and 10;
merged or closed PRs settle to 30 minutes once past the rollout window (one-minute
reads for the first hour after a merge, then five, while chained deploys may start);
changes, opening, and new attention snap back to one minute. The inbox backs off
likewise and refreshes when its panel opens.

Measured with a fake clock and a fake GitHub that answers 304 for unchanged
bodies (`packages/workspace-service/request-volume.test.ts`, 60 minutes, one PR
gains a comment every ten minutes; open PRs, five reads each):

| Open PRs | Before: requests/h (all counted) | After: requests/h | After: counted against the limit | GraphQL of those |
| --- | --- | --- | --- | --- |
| 10 | 3,000 | 540 | 158 | 108 |
| 20 | 6,000 | 1,000 | 290 | 200 |
| 50 | 15,000 | 2,350 | 680 | 470 |

An opened item still reads all five endpoints at once. These are fixture numbers;
live confirmation against api.github.com (304 behaviour of each endpoint, headers)
is pending (PROVIDER-BUDGET-LIVE).

## Automatic Needs me discovery

Enabled account bindings reconcile once per minute while the workspace is open.
Settings shows sync/error status and a manual Sync now action; MCP shares
`workspace_sync_connections`. Complete pages are validated before changes. A
previously assigned PR missing from the list is fetched directly before clearing
its reason, so lost access never silently means unassigned. Errors/backoff survive
restart. Disable/close cancels pending reads; reopening continues the watcher.

An existing PR resource is reused. Repository/project mapping is inferred from
existing attached PRs for that account: exactly one visible project is required;
otherwise the new item floats. Archive/done state and positions are preserved.
Deletion suppresses reimport during the same assignment cycle. A later assignment
cycle can create it again. Account bindings cannot be retargeted in settings.

Successful visible detail rendering acknowledges a receipt for that exact
assignment cycle. Read-only API/context reads, hover, failed/stale views and stale
receipts cannot clear it. Other native/workflow attention reasons remain intact.
SQLite v9 atomically commits each reconciliation batch with its assignment state;
unchanged polling does not change the graph revision.

The opt-in live check is `ACT_LIVE_GITHUB=1 node scripts/smoke-github-assignments.mjs`.
It makes no provider writes. The full native assignment→detail→viewed/restart path
needs a real assigned test PR; fixture service and background desktop coverage
exercise that path.

## Rollout read-only acceptance

`github.rollout` uses a dedicated GET-only Actions transport through the existing
GitHub CLI account. It supports run/job links and workflow links (latest run,
optionally `?query=branch:NAME`). The exact endpoints and environment-gate shape
are documented in [GitHub's workflow run API](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs).
Job links track their entire run. The observer never approves, dispatches,
retries, cancels or posts. Results are what the workflow reports, not independent
cluster-health assertions; the detail list covers the current run attempt.

Authenticated reads through the production client/transport cover passed, queued,
waiting-for-approval, cancelled and never-run workflows. Reusable workflow templates
that declare environment gates are discovered through pending deployments rather
than guessed from job names. Reads change no account, workspace or deployment.

Deterministic fixtures cover approval/failure/rerun transitions, pagination and
errors; a live read observes existing state and is not proof of every transition
during a future rollout. Live write acceptance is neither needed nor performed for
this observer. Private repository URLs return 404 without authenticated access.
