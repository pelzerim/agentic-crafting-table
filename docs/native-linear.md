# Linear capabilities

The current [Linear GraphQL reference](https://linear.app/developers/graphql) and
its [generated SDK operations](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.graphql)
define the shapes used. The adapter sends four fixed queries (account, issue, team workflow, assigned issues) and one
explicit `issueUpdate(id, input: { stateId })` mutation to the documented endpoint.
No caller-provided GraphQL text is accepted. Browsing, polling and opening a menu
only execute read queries; selecting a new state invokes the fixed mutation.
GraphQL errors invalidate partial data even with HTTP 200. Response size, time,
identity and canonical source URL are checked before exposing content.

Account identity combines the organization and user UUID. The issue result retains
its immutable UUID, current identifier, prior identifiers, title, description and
state. An unrelated account/workspace/issue fails. Renamed workspace and issue
aliases are checked using provider metadata rather than guessed from URL slugs.

## Credential setup

Linear and Slack need no CLI. The Linear native connector reads an existing macOS Keychain credential, verifies its account
against the API, and persist only that account identity. The reader takes no
secret command arguments and never returns a secret through the UI/MCP boundary.
It does not write Keychain entries automatically. The initial setup supports one
credential slot per provider; replacing it cannot retarget older account bindings.

For a personal Linear API key, the user can store it using macOS's own concealed
password prompt (keep `-w` last and enter the key at the prompt):

```sh
security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w
```

This command changes only the user's local Keychain. It has not been executed by
these tests. Use a key permitted to read the intended issues. Changing status also requires
permission to update those issues; read-only keys can still browse. App-distribution
OAuth onboarding and simultaneous credentials for multiple Linear accounts remain
separate improvements; this initial personal-app setup does not claim them.

On Linux the key lives in the Secret Service keyring instead, stored with
`secret-tool store --label 'Agentic Crafting Table Linear' service dev.agentcraftingtable.linear account default`
and read with `secret-tool lookup`; Settings shows the command for the running platform.

The same guide is available in **Settings → Connections → Linear → How to
connect**, with a Copy button for the Keychain command. After storing the key,
choose **Connect Linear** and select the account; it connects immediately. Double-click the map, choose **From URL** and paste
an issue link to attach it with its provider title and details.

## Description rendering

The ticket view renders Markdown with Marked 18.0.14 and DOMPurify 3.4.16, bundled
locally. Headings, emphasis, nested/ordered lists, read-only task lists, quotes,
links, fenced code and GFM tables retain their formatting. Prose wraps to a
readable width; wide code and tables scroll inside the view. Raw HTML remains
inert text and unsupported link protocols are not clickable. Image attachments
appear as links opened explicitly in the browser; no remote image loads or
credential forwarding are added to the renderer. Cached content and agent context
retain the original Markdown, including after refresh failures and restart.

Five local adapter fixture tests cover immutable/alias identity, title/status, mismatched
accounts and URLs, partial GraphQL errors, fixed queries, limits, cooldown and the
Keychain argument boundary. Service fixtures cover URL creation, original workspace links, rename/UUID
reconciliation, account mismatch, replay, restart, stale refresh and bounded context.
The generic contract covers all seven connected adapters. A hidden Electron journey
checks URL-only creation, two-line compact title, inert HTML in descriptions,
rename/status refresh and saved content after restart. No native credential or live
issue was read. Real read-only issue acceptance remains open.

## Assigned tickets

A fourth fixed query, `CraftingTableAssigned($after, $states, $priorities)`, reads
the viewer's `assignedIssues` 50 at a time with `filter: { state: { type: { in:
$states } }, priority: { in: $priorities } }`, ordered by `updatedAt`. The filter
is positive: Linear's state types are `triage`, `backlog`, `unstarted`, `started`,
`completed`, `canceled` and `duplicate` (the Duplicate status); an exclusion
list would let `duplicate` through. `$states` is a non-empty, duplicate-free
subset of `LINEAR_TRIAGE_STATE_TYPES` (the first four) and `$priorities` of 0–4
(`LINEAR_TRIAGE_PRIORITIES`: any, Urgent+High, Urgent+High+Medium); the transport
refuses anything else, so no text from settings reaches the query and a type Linear
adds later is excluded by default. The third variable is an optional opaque cursor.
The comparator types (`StringComparator.in: [String!]`,
`NullableNumberComparator.in: [Float!]`) come from the public SDK schema, not from a live call. The client validates every page (account, ids,
identifier, title, canonical `linear.app` URL, state, team, priority), drops any
state type or priority outside the request again locally, stops at 100 matching
issues and reports whether more exist. An empty status selection reads nothing. It selects list fields only;
descriptions load later through the ordinary issue read once a ticket is on the map.

`TriageCoordinator` (`packages/workspace-service/triage.ts`) turns that list into
Triage to-dos through `linearTriageAdapter`; behaviour is specified in TODO-09.
`linearTriageFilter` reads the selection from the Linear ticket settings
(`triageStateTypes`, `triagePriority`; missing values mean every open status and
any priority, unknown values never widen it) and the adapter reports it as its
`scope`. A changed scope aborts a read under way and reads at once; no scope
(nothing selected) stops the import like its switch. The checkpoint stores the
scope of the last complete read: entries for to-dos the person handled are held,
not forgotten, when the first complete list under a new scope leaves their ticket
out, so toggling a status never brings back a dismissed ticket. A held entry stays
until its ticket matches again. Its
checkpoint lives in `provider_observations` under `triage:<hash of connection id>` and
commits atomically with the to-do commands, so no schema migration was needed: the
import rides in the to-do's JSON body. A read-only key is enough. Fixture tests
cover the query allowlist (each selection, refused types and priorities), paging,
the cap, idempotency, dismissal, cleanup (duplicates, an unticked status, re-import),
dedupe, the settings and backoff; no native credential or live workspace was read.
Whether the filter and ordering behave this way on a real workspace needs a live check.

## Workflow status

The default compact bubble includes the actual provider status with a colored cue.
Right-click → **Change status**, or click the current status in the full view.
Choices come from the ticket’s team, so custom states work without a hard-coded
list. The selected state is marked. Menus are read-only until a new choice is
selected. A confirmed change updates every alias and the saved provider snapshot.
Unopened tickets poll about once a minute; archive and account cooldowns apply.
A completed or canceled Linear state checks the ticket’s to-do (Mark done) and
leaving it unchecks it. Checking the to-do or Mark done moves the issue to the
team’s first completed state; unchecking or Reopen returns it to the state it had
before, else the first started one. A failed or unconfirmed write reverts the check
and shows why. Unbound tickets complete locally only.

The service binds status changes to issue/resource/account identity, rechecks team
membership and the observed state/update timestamp, and tracks a durable request
ID. A lost response is explicitly uncertain, never automatically replayed. Refresh
before making another choice. This is not a provider-side atomic conditional write;
a concurrent external edit can race between the preflight read and mutation.

New fixture checks cover custom workflows, permission/stale/account/team rejection,
ambiguous responses, alias/cache synchronization, duplicate requests, poll/write
ordering and restart. Hidden Electron checks both menus, keyboard/dismissal,
colored compact status, errors and persistence with injected local transports.
These checks do not read a native credential or mutate a real issue. Live update
acceptance remains pending a specifically supervised human run.
