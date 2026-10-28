# Plugin SDK

The frozen contract between Agentic Crafting Table and plugin packages, plugin API `1.3.0`.
Start with the [authoring guide](../../docs/plugins/authoring.md) and the
[example plugin](../../examples/plugins/reading-list); this page is the API map.

Import it as `@agent-crafting-table/plugin-sdk/<file>.ts` from a package whose `node_modules`
links to an app checkout's `node_modules`. Production code imports only `index.ts` and `views.ts`.

| File | Use from | Contents |
|---|---|---|
| `index.ts` | all entries | `PLUGIN_API`, `PLUGIN_DEFINITION_API_VERSION`, `parsePluginManifest`, `pluginManifestSchema`, `apiSatisfies`, `ownsIdentifier`; `defineResourcePlugin`, `fieldDefaults`, `fieldsSchema`, `validateFields`, `webLinkUrl`, `indicatorsSchema`; every type below |
| `host.ts` (types, re-exported by `index.ts`) | service and renderer | `PluginDefinitionsModule`, `ServiceModule`/`ServiceHost`, `RendererModule`/`RendererHost`, `WorkspaceServices`, `PluginStorage`, `RuntimeOperationDeclaration`/`AgentPolicy`, `McpToolContribution`, `AgentGuideSnippet`, `PluginSettingsSection`, `SettingsPreset`, `ActionContribution`, `PresentationHooks`, `ViewContribution` |
| `views.ts` | renderer | `mountViewHeader`, `mountProviderRead`, `statusChip`, `freshnessStamp`, `staleNotice`, `emptyState`, `skeleton`, `timeElement`, `formatWhen`, `whenDate`, `renderMarkdown`, `pixelGlyphElement`, `PIXEL_GLYPHS`, `glyphPath`, choice menus (`openResourceChoices`, `loadResourceChoices`, `choiceInput`), `sessionChip`, `workflowReviewChip` |
| `testing.ts` | tests only | `pluginPackageContract`, `resourcePluginContract`, `resourceConnectorContract` |
| `act-plugin.ts` | command line | `pack [dir]` writes `act-plugin.integrity.json`; `verify [dir]` checks a release against it |
| `integrity.ts` | Node tools | Release file listing, hashing and verification used by `act-plugin.ts` and the installer |

## Module shapes

```ts
// dist/definitions.mjs — platform-neutral
export default { definitions, runtimeOperations, mcpTools, agentGuide, settings, actionMenus, settingsPresets } satisfies PluginDefinitionsModule;
// dist/service.mjs — Node
export default { activate(host: ServiceHost) { host.connector(…); host.runtimeOperation(…); host.onWorkspace(…); } } satisfies ServiceModule;
// dist/renderer.mjs — browser
export default { activate(host: RendererHost) { host.views(typeId, { mountDetail }); } } satisfies RendererModule;
```

`ServiceHost`: `connector`, `runtimeOperation`, `connectionProvider`, `presentation`,
`contributeActions`, `settings()`, `connections`, `onWorkspace`, `onClose`, `pluginId`, `api`, `paths`.
`RendererHost`: `views`, `contributeViews`, `pluginId`, `api`.

## Compatibility

`apiRange` in `act-plugin.json` is a caret range checked with `apiSatisfies`. 1.1 added settings
presets; 1.3 lets a preset target the app itself (`packageId: 'app'`) for appearance settings, today only
`workingMark`, applied once per workspace while the setting still has its default. Packages built for
`^1.0.0` still load. `sdk.test.ts` pins the exported surface, so a
breaking change to this package fails the app's tests.

## Commands

```sh
node packages/plugin-sdk/act-plugin.ts pack path/to/package
node packages/plugin-sdk/act-plugin.ts verify path/to/package
```
