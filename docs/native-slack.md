# Slack read capability

Read-only API contract:
[authentication identity](https://docs.slack.dev/reference/methods/auth.test/),
[conversation details](https://docs.slack.dev/reference/methods/conversations.info/),
[paginated thread reads](https://docs.slack.dev/reference/methods/conversations.replies/),
[member display names](https://docs.slack.dev/reference/methods/users.info/).
The adapter allowlists only these methods. `auth.test` uses POST but checks identity;
no method sends messages, marks conversations read, joins channels or changes Slack.

Use a bot or user API token with the history/read scopes needed for the intended
conversation. `users:read` supplies display names; if that scope is absent or a
member is unavailable, exact member IDs remain visible. The app never requests
broader access automatically. Account identity pins the team/user and verifies the
URL workspace host before reading channel content. A renamed host currently needs
an updated source link; old hosts are not assumed to belong to the new workspace.

The client retains timestamps as strings, checks the parent and selected reply,
paginates with 15 messages per page and rejects missing/cyclic cursors, duplicate
messages or a missing selected message. It bounds reads to 32 pages, 480 messages,
200,000 text characters and 32 display-name lookups; remaining authors retain IDs.
Files and attachments require Slack and are marked as incomplete rather than fetched.
Slack may change during pagination; this is an observed read, not an atomic thread
snapshot. A rate limit produces an explicit cooldown rather than partial success.
Non-Marketplace distribution can have tighter API limits than an internal app;
a successful local fixture does not prove that a real account can paginate quickly.

## Credential setup and acceptance

The connector reuses the backend-only Keychain reader. The initial native
setup uses a generic password with service `dev.agentcraftingtable.slack`, account
`default`. Provision through Keychain Access or its concealed native prompt:

```sh
security add-generic-password -U -s dev.agentcraftingtable.slack -a default -w
```

On Linux use `secret-tool store --label 'Agentic Crafting Table Slack' service dev.agentcraftingtable.slack account default`.

No credential has been read or written by the automated tests. Six local adapter
fixtures cover account/workspace binding, timestamp fidelity, pagination, deleted
messages, profile fallback, cancellation, method allowlisting and cooldown.
The plugin now supports URL-only creation, resolved parent identity, highlighted
selected replies, attributed safe text, refresh/stale errors and bounded explicit
context. Message scope sends only the selected message; thread scope sends the
fetched thread. HTML and Slack formatting remain inert text. Service/restart and
hidden desktop fixtures pass; eight connectors share the plugin contract.
A real permitted test-channel read and native credential setup remain pending.
All remote mutations still require human supervision of the specific run.
