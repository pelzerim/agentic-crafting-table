## What

<!-- What the change does, in one to three sentences. -->

## Why

<!-- The problem it solves or the issue it closes. -->

## Screenshots

<!--
Required when the change shows on screen: a card, a view, a menu, a setting, a colour, a glyph.
Add before and after, or only after for something new. Delete this section when nothing visible changed.

Render them from the end-to-end tests with fixture data, never from your own board:
- a `toHaveScreenshot` baseline your change adds or updates under `tests/visual/baselines/` is the screenshot;
- otherwise add `await page.screenshot({ path: 'test-results/pr/<name>.png' })` to the spec that covers
  the change, run it with `npm run build && npx playwright test tests/e2e/<spec>.spec.ts`, and drop the file here.
-->

## Checks

- [ ] `node scripts/public-safety.mjs` reports no hits
- [ ] `npm run check` passes
- [ ] `CHANGELOG.md` has an entry under `## Unreleased` ending with `(#<PR>, @<login>)`
- [ ] Screenshots attached, or nothing visible changed
