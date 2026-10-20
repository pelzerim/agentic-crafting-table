# Prompt: set up Agentic Crafting Table on this Mac

Copy everything below the line into your coding agent (Claude Code, Codex or
similar) in a terminal on the Mac you want to set up. It follows
[docs/setup.md](setup.md) and stops for the parts only a person can do.

---

You are setting up **Agentic Crafting Table** (ACT), an Electron desktop app, on
this Mac so I can build it from source, install it in the Dock, and use it with
Claude Code and GitHub. Optional connectors (Codex, Linear, Slack, Notion) are set up
only if I say so when you ask.

Rules:

1. Work step by step. After each step run the check given and show me its output.
   Do not move on while a check fails; fix it or ask me.
2. Never put a secret on a command line, in a file, or in your output. Where a
   command ends in `-w`, run it exactly like that so the Keychain prompts me for the
   value; do not add the value yourself.
3. Sign-ins are mine. When a command opens a browser or asks for a login, stop and
   tell me what to do; continue when I say it is done.
4. Install only what is listed. No `sudo`. Do not change my shell profile beyond
   what Homebrew's nvm instructions require, and show me that edit before making it.
5. If a tool is already installed and its check passes, skip its install.
6. Finish with a short report: what you installed, what I signed in to, what was
   skipped, and anything that still fails.

Steps:

**1. Platform and build tools.** Check `uname -m` prints `arm64`. Check
`xcode-select -p` prints a path; if not, run `xcode-select --install` and wait for
me to finish the dialog. Check `brew --version`; if Homebrew is missing, stop and
give me the install line from https://brew.sh to run myself.

**2. Git and Node.** `brew install git nvm` (skip what is present). Follow the nvm
post-install note so `nvm` works in a new shell. In the repository directory run
`nvm install` and `nvm use`; check `node --version` prints `v26.8.2` and
`npm --version` starts with `11.`.

**3. The repository.** If this directory is not already the ACT checkout, clone
`https://github.com/pelzerim/agentic-crafting-table.git` and work in it. Then `npm ci`. Check it ends without errors
(native modules are rebuilt during install; that is expected to take a minute).

**4. Run from source.** `npm run dev`. Tell me to look for a window that says
**Create your first project**, then quit the app, then continue.

**5. Install into the Dock.** With the app quit: `npm run package`, then
`npm run install:local`. Check the installer prints `Installed …` or
`Already up to date`. Tell me to launch and pin
`release/mac-arm64/Agentic Crafting Table.app` (not the one under `release/staged`).

**6. Claude Code.** Check `claude --version`; if missing,
`npm install -g @anthropic-ai/claude-code`. Check `claude --help` mentions
`--session-id`, `--resume`, `--mcp-config` and `--plugin-dir`; if not, update it.
Then run `claude` once so I can sign in; stop and hand it to me; I will type `/exit`.

**7. GitHub.** Check `gh --version`; if missing, `brew install gh`. Run
`gh auth status`; if not logged in, run `gh auth login` (github.com, HTTPS, browser)
and hand it to me. Check `gh auth status` shows the account.

**8. Optional connectors.** Ask me which of these I want, then do only those:
- *Codex:* `npm install -g @openai/codex`, check `codex --version`, run `codex` once
  for me to sign in.
- *Linear:* ask me to create a personal API key in Linear with read access to my
  issues. Run `security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w`
  and hand me the prompt. Check
  `security find-generic-password -s dev.agentcraftingtable.linear -a default`
  finds the entry (no `-w`).
- *Slack:* ask me for a bot or user token with history/read scopes (and
  `users:read`). Run `security add-generic-password -U -s dev.agentcraftingtable.slack -a default -w`
  and hand me the prompt. Check with `find-generic-password` as above.
- *Notion:* `brew install 4ier/tap/notion-cli`, run `notion auth login` and hand
  it to me, check `notion auth status`. Remind me to enable **Read comments** on the
  integration and share each page with it.

**9. Final check.** Run:

```sh
uname -m && xcode-select -p && git --version && node --version && npm --version
claude --version && gh auth status
codex --version 2>/dev/null; notion auth status 2>/dev/null
security find-generic-password -s dev.agentcraftingtable.linear -a default >/dev/null 2>&1 && echo linear ok
security find-generic-password -s dev.agentcraftingtable.slack -a default >/dev/null 2>&1 && echo slack ok
```

Then tell me to open the app, create a project with a working directory, start an
**Agent session** with Claude, and go to **Settings → Connections** to connect the
accounts we set up. Give me the report from rule 6.
