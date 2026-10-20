# Interaction reference

`reference.html` is a frozen interaction reference with sample data. It is an HTML
fragment with its own styles and scripts and can be opened directly in a browser.

The reference uses sample data and in-memory state. Agent sessions, reviews,
provider metadata and most actions are simulated. Reloading discards changes.
It is not connected to `src/mcp` or to real terminals. Some provider icon assets
are remote, so this is not an offline bundle.

Use it to preserve the agreed appearance and interactions while porting them into
the application. Production UI must use the shared graph/plugin/service code,
not copy the prototype's separate business logic. The written product spec takes
precedence where the prototype contains an unfinished behavior or regression.
