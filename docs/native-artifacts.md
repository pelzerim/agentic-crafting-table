# Native Claude artifact capability

Requires Claude Code 2.1.287 or later: its native `Artifact` tool publishes private
pages and returns `https://claude.ai/code/artifact/<uuid>` or
`https://claude.ai/artifact/<id>`.

[Official Claude Code artifact documentation](https://code.claude.com/docs/en/artifacts)
describes native publication to private claude.ai pages. Availability depends on account
authentication, plan and organization policy. Publication uploads content to Anthropic;
a local HTML file without a returned URL is not an artifact. The documented browser
auto-open control is `CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0`.

**No artifact has been published by this app yet.** Everything below is implemented and
covered by fixtures; the first real run is pending human supervision (see the end).

## Artifacts on the board

`claude.artifact` (schema 2) is a URL-backed item. From URL, paste and drop recognise
only `https://claude.ai/code/artifact/<uuid>` and `https://claude.ai/artifact/<id>`
(exact host, https, no port/credentials, id charset validated, no nested asset paths);
lookalike hosts fall through to Web link. Identity is the artifact URL, so the same
artifact always resolves to one item. Saved v1 records upgrade unchanged (url and
provenance are optional; `artifactId` stays required).

The service never fetches the page. The title is the
default `Claude artifact · <first 8 id chars>`, the publishing agent's title, or a
person's rename. Clicking the card opens the page itself in the item view through the
host's `mountWebPage` service (site `claude`): an Electron `<webview>` in that site's own
persistent session (`persist:claude-artifacts`), where the person signs in to claude.ai
once (not every sign-in method is promised to work there). `apps/desktop/embedded-sites.ts` is the site registry: the main process attaches a
webview only for a registered site's partition and a URL that site allows, rebuilds the
guest's preferences from a fixed list (no preload, no Node, context isolation, sandbox, no
nested webviews), and grants no permission but clipboard writes, and those only to the site's own pages. The top-level page may
go to any https page, so a sign-in through an identity provider leaves the site and comes
back inside the item, with its cookies in the site's session; any other top-level page is
cancelled, a browser link among them opens in the browser (also when the app loads it), and popups open in the
browser. While the page is off its site, a strip above it shows the host it is on, since
there is no address bar. A download from a link is cancelled and the link opens in the browser; a file the page
makes itself (`blob:`, `data:`) is saved through the usual save dialog. The
page starts on its site at every open, and a link the site does not allow gets the panel. Only `claude` is registered; another site is one more entry. Only the open view
holds a live page. The header keeps **Open in browser**, the connected PR/agent sit under
the page, and the menu offers **Open on claude.ai**; both browser actions use the
validated `openExternal` bridge. Without a saved link, or on a host without
`mountWebPage`, the view is the small panel with **Open in browser**.

## Explain architecture

PR context menu → **Explain architecture → Claude**, or **Review → Explain
architecture** in the PR view (next to the Claude/Codex reviews), runs `pr.architecture` with `operation: "launch"`. It prepares
the frozen comparison (unchanged preparation path), writes the request (project brief,
task, PR source material) to `architecture-<requestId>.md` beside the captured checkout,
and starts one Claude session next to the PR with a context link from it. The session's
cwd is the capture folder, one level above the read-only checkout, so repository agent
configuration is not loaded. Its opening prompt is short and points at the file; the
diff never goes through argv. The agent item stores `architecture` provenance (comparison
key, source PR node, repository/number, base, base tip, head).

A live session for the same comparison key is focused instead of launching twice; an
archived one does not count. Reopening never restarts a launch: an interrupted one
fails with a plain message. Permissions are the user's normal Claude settings (Auto
mode by default). The `Artifact` tool is not added to `--allowedTools`; whether Claude
asks before publishing is Claude Code's decision and part of the supervised check.

`workspace_run` `pr.architecture` operations: `options` (`canLaunch`), `prepare`,
`status` (`pending` → `prepared` → `launching` → `launched` with `nodeId`, or `failed`)
and `launch`. Agents may use options/prepare/status; `launch` is `humanOnly` because it
spends a model run and publishes to claude.ai (Claude reviews remain agent-startable:
they publish nothing).

## Automatic attachment

Every table-launched Claude session already has a session-local PostToolUse hook. For
`tool_name: "Artifact"` the hook (`agent-hook-event.ts`) accepts only publishes (no
`action` or `publish`; never read/list/delete/asset uploads) and walks the structured
`tool_response` (shape undocumented) for claude.ai artifact URLs validated as above. It
uses one unambiguous URL, preferring `tool_input.url` on a republish. The title is
`tool_input.title`/`description`, else the `<title>` of the local `file_path` (HTML only,
≤2 MB, read-only, in the hook process; the path is not sent on). Terminal output is
never read.

The service (`agent-artifacts.ts`) checks the session binding, then places the card
below the agent, linked from it, and from its source PR: an architecture run's PR, or
the single PR the agent is connected to. It records `sessionId`, `sourcePrId` and, for
architecture runs, `headSha`. An existing card for that URL is reused and linked.

Fallback: the agent guide tells agents to register a published artifact
with no card as `claude.artifact` through the generic `item.add` path.

## Evidence and the first supervised run

Fixture coverage: URL validator/identity/upgrade, hook parsing for several response
shapes, launch/dedupe/failure/recovery, hosted Claude plans, and hidden desktop journeys
(`claude-artifacts.spec.ts`, `architecture-artifacts.spec.ts`) where the scripted native
agent emits a synthetic Artifact hook. No model call or upload happened.

Still unverified with the real CLI: the actual `tool_response` shape, that PostToolUse
fires for `Artifact`, Artifact availability for a given account, and the analysis quality.
For the first run, a person should: pick a small PR on the map, choose **Explain
architecture → Claude**, open the started session, approve the Artifact permission
prompt if Claude asks, and confirm the card appears under the agent (linked to
the PR) and opens the right page. If no card appears, check that the session replied
with a claude.ai link, then report the hook payload shape so the parser can be adjusted.
