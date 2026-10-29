# Working on Agentic Crafting Table

This repository is public. Anything committed here can be read, forked and indexed, and
cannot be taken back once pushed. Treat every change as published.

## Never commit

- **Names from work or private projects**: your employer, its customers, internal products,
  services, repositories, tickets, Slack channels and people. Use neutral fixtures instead:
  `acme`, `example.com`, `Alice`, `fixture/web`, `region-1`.
- **Credentials of any kind**: API keys, tokens, OAuth secrets, cookies, private keys,
  `.env` files. Rotate a secret that was ever committed, even if the commit was undone.
- **Account and infrastructure identifiers**: cloud account ids, ARNs, registry hosts,
  internal hostnames (`*.internal`, `*.corp`), real cloud regions of a private setup, IPs.
- **Personal data**: real email addresses (use `@example.com` or a GitHub noreply address),
  home-directory paths (`/Users/<you>/…`; write `/Users/example/…`), time zones and routines.
- **Output from real work**: terminal transcripts, logs, database files, screenshots or
  baselines rendered from a real board, agent session links and transcripts.
- **Organisation-specific behaviour**: rules, defaults or wording that only make sense for one
  company. Put them in a private plugin pack or in Settings, never in the defaults here.

## Before every commit

```sh
node scripts/public-safety.mjs          # scans the tracked files; must report no hits
npm run check                           # typecheck, tests and build
```

CI runs the scan on every push and pull request and fails on any hit. The scan knows
generic shapes only (credentials, account ids, home paths, internal hosts, emails, session
links); it cannot know your employer's or customers' names, so checking for those is on you.
It cannot read images either: re-render screenshots and visual baselines from the test
fixtures only.

If the scan flags something that really is public (a library author's address in a lock
file, say), ask a maintainer before allowing it; do not weaken the scan to get a green build.

## Changes and releases

Note every user-facing change in `CHANGELOG.md` under `## Unreleased` at the top, ending each entry
with your pull request and GitHub login, e.g. `(#12, @octocat)`.

Any maintainer may cut a release once `main` is green:

1. Pull `main` and check the newest tag: `git fetch --tags && git tag --sort=-v:refname | head -1`.
   Pick the next version above it; never reuse or move a tag.
2. `npm version X.Y.Z --no-git-tag-version`, rename `## Unreleased` to `## X.Y.Z — <date>`,
   and commit both as `X.Y.Z: <what changed>`.
3. Run the scan and `npm run check`, push the commit, then `git tag -a vX.Y.Z -m X.Y.Z`
   and `git push origin vX.Y.Z`. Installed apps offer the update from the tag.

If someone else's tag landed first, take the next number instead of replacing theirs.

## Working agreement

- Read `docs/specification.md`, `docs/architecture.md` and `docs/testing.md` before changing
  behaviour; the specification wins over older notes.
- Write a failing test first, then the fix. Tests use local fixtures; never call paid model
  APIs or write to GitHub, Slack or other providers from tests or CI.
- Keep commits small and coherent, with conventional subjects (`feat(scope): …`, `fix: …`).
