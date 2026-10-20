# Plugins

Plugins add item types and behaviour to Agentic Crafting Table without changing the app. People
install them per machine from a git tag (Settings → Plugins); features for one team or tool ship
this way, from public or private repositories.

## Read in this order

| # | Document | Read it to |
|---|---|---|
| 1 | [Example: reading list](../../examples/plugins/reading-list/README.md) | See a complete, small package and try it in the app in five minutes |
| 2 | [Authoring guide](authoring.md) | Build, test, release and install your own package, step by step |
| 3 | [Design guide](design.md) | Make cards, views, states and copy look and read like the rest of the app |
| 4 | [SDK overview](../../packages/plugin-sdk/README.md) | Look up the API surface: manifest, hosts, view helpers, test harness, release tool |
| 5 | [Plugin packages reference](../resource-plugins.md#plugin-packages-api-1) | Host extension points, installing from git, loading and isolation in detail |
| 6 | [Design tokens](../design-tokens.md) | Pick colours, type, spacing and focus styles for plugin CSS |

## Quick answers

- **Where does my code run?** `definitions` everywhere (no Node, no DOM), `service` in the
  workspace service (Node), `renderer` in the app window (browser).
- **Is there a sandbox?** No. Plugins are trusted code; people approve each package and commit.
- **Can agents install plugins?** No. Installing, updating and removing are desktop-only.
- **What is the plugin API version?** `1.2.0` (`PLUGIN_API` in `packages/plugin-sdk/manifest.ts`).
- **How do I reload after a change?** Rebuild, then Settings → Plugins → Advanced settings →
  Reload plugins.

## For agents working on a plugin

1. Read the [authoring guide](authoring.md) top to bottom once; then work step by step and run
   each **Done when** check before the next step.
2. Copy the example; never start from a blank folder.
3. Keep ids stable after the first release; change data shape only with a migration.
4. Never test against real accounts or post to real services; use fixtures.
