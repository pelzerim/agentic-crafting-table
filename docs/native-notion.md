# Notion read capability

The adapter expects the Notion CLI 0.7.0 or later and its named-profile config
format. The adapter reads existing named CLI profiles in the
backend; no credential is copied into workspace records or returned to the UI.
Unlike a native keychain login, this is reuse of the CLI's existing config-file
credential store. App-managed credential storage remains an OS-keychain concern.
Profile plus bot identity pins the account; changing the CLI's active profile must
not retarget an item. The bot identity is checked against the API before content.

The adapter uses GET-only, fixed-origin requests with redirects disabled and
API version `2026-03-11`. A page is read through metadata, every title-property
page and recursively paginated block children. It bounds requests, blocks, text,
response bytes and recursion depth, rejects repeated cursors and partial reads,
and checks the page revision again before returning. Unsupported block types
remain explicitly marked as requiring Notion; media are not remotely loaded.

Primary references:

- [Retrieve page metadata](https://developers.notion.com/reference/retrieve-a-page):
  metadata and title-property limits; the page response is not its child content.
- [Retrieve block children](https://developers.notion.com/reference/get-block-children):
  cursor pagination and recursive children, read permissions and current API version.
- [Token identity](https://developers.notion.com/reference/get-self): account check.
- [Notion CLI source](https://github.com/4ier/notion-cli): named profile storage
  (`cmd/auth.go` and `internal/config/config.go`).

Five fixture tests cover paginated title/nested content, unknown blocks, bounds,
changed revisions, malformed pagination, wrong account, token rotation, GET-only
transport and error normalization. These tests do not establish a live page read.
Settings now discovers named CLI profiles, and URL-only creation verifies the
provider title before persisting. The detail view renders text and block nesting,
exposes refresh/stale errors and safely opens the canonical page URL. Context is
attributed and bounded to 32,000 characters with an explicit excerpt marker.
Unbound legacy aliases preserve their original records until account binding can
reconcile the provider identity. A service restart/cache/alias/context test and a
hidden desktop URL→content→refresh→restart test pass, including a reviewed
screenshot and inert provider HTML. The connector joins the shared contract suite.
Live test-page acceptance remains pending.

## Comments

[Retrieve comments](https://developers.notion.com/reference/list-comments)
(`GET /v1/comments?block_id=…`, cursor pagination) returns the open comments
associated with the given ID. A page ID returns page-level discussions only;
inline discussions are attached to blocks, so each block has to be asked
separately. The endpoint needs the integration's **Read comments** capability and
answers 403 `restricted_resource` without it.

What the connector covers per read (bounded, sharing the poll cadence and 429
backoff): the page's own comments, up to 10 blocks already known to carry
discussions and the next 10 blocks in turn (first 500 non-structural blocks), at
most 500 comments kept. A background read of an unchanged page reuses its content
(`/v1/users/me` + `/v1/pages/{id}` only). A 403 on comments keeps the page content
and reports comments as unavailable; background reads retry after 30 minutes.
Resolved discussions are not returned by Notion and so never count.

Identity: `notion auth login` stores an internal integration token, whose
`/v1/users/me` bot owner is the workspace, not a person. The integration's own
comments are excluded automatically (and an OAuth owner when present); a person's
own comments are excluded only through Settings → Notion page → Comments → “Your
Notion user ID” (comma-separated IDs, dashes optional).

Setup for the person: in Notion's integration settings enable **Read comments**
for the integration used by the selected CLI profile, and share (connect) each page
with that integration. Live read-only comment acceptance is pending a supervised
run against a real page; fixture tests do not establish it.

## Title, comment cue and upgraded web links

**Title.** The item's name is the page's title property (all its pages joined;
“Untitled” when empty). A background read compares `last_edited_time` and re-reads
the title only when it changed, which Notion also bumps on a rename, so a renamed
page renames its item on the next poll. Nothing in the app renames a Notion item.

**Comment cue.** Unread comments use the same indicator as a pull request's unseen
comments (`unreadCommentsIndicator` in `src/resource-plugins/indicators.ts`): the
card row, the far-zoom badge and dashboard rows need no Notion code.

**Upgraded web links (spec RES-10).** A Notion page that was added before
`app.notion.com` and `notion.com` links were recognised is saved as a Web link
titled by Notion's public page title (“Notion”, since the page needs a login).
With a connected Notion account it becomes a Notion page item at the next service
start, or when the account is connected, keeping its place, links and to-dos:

1. `registry.conversions` finds `notion.page` for the link's URL (syntax only).
2. The page is read once through the default Notion connection: the normal first
   read (identity, page, title, blocks, comments), marked as background work.
3. Only then `item.convert` rewrites the resource in place and the read is saved
   as its first snapshot. Comments already on the page are recorded as read, so
   the upgrade shows no count and raises nothing; later comments do.

A page that is not shared with the integration fails step 2 and stays a web link;
it is asked again at the next start (identity plus one page request). After
sharing the page, right-click the link → **Convert to Notion page**, or restart.
A page already on the map as a Notion item is not duplicated; the link stays.
Archived and Undermap links are left alone. Fixture tests cover all of this; the
first start against a real workspace is a pending live check.
