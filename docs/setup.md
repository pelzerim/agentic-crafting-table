# Setting up Agentic Crafting Table

What has to be installed and signed in before the app is useful, with the exact
commands. Written so a person or an agent can follow it top to bottom; every step
ends with a check. If you would rather hand the whole thing to an agent, give it
[the setup prompt](setup-prompt.md).

The steps are for a Mac; [On Linux](#on-linux) lists what differs. On a Mac nothing
needs `sudo`. Sign-ins are interactive (a browser or a prompt) and
cannot be scripted; an agent should run them and hand control to the person when
the tool asks.

## What you need

| Tool | Needed for | Install | Sign in / check |
| --- | --- | --- | --- |
| macOS on Apple silicon | the packaged app (`arm64` only) | — | `uname -m` → `arm64` |
| Xcode Command Line Tools | building `node-pty` and other native modules | `xcode-select --install` | `xcode-select -p` prints a path |
| Homebrew | the installs below | [brew.sh](https://brew.sh) | `brew --version` |
| Git | cloning, the app's own git calls | `brew install git` | `git --version` |
| Node 26.8.2 + npm 11 | building and running from source | `brew install nvm` then `nvm install` in the repo (reads `.nvmrc`) | `node --version` → `v26.8.2` |
| Claude Code CLI | Claude agent sessions | `npm install -g @anthropic-ai/claude-code` | `claude --version`; `claude` once to sign in |
| Codex CLI (optional) | Codex agent sessions | `npm install -g @openai/codex` | `codex --version`; `codex` once to sign in |
| GitHub CLI | pull requests, rollouts, reviews, the inbox, Auto deploy | `brew install gh` | `gh auth login` then `gh auth status` |
| Notion CLI 0.7+ (optional) | Notion page items | `brew install 4ier/tap/notion-cli` | `notion auth login` then `notion auth status` |
| Linear API key (optional) | Linear ticket items | stored in the macOS Keychain, see below | `security find-generic-password -s dev.agentcraftingtable.linear -a default` (no `-w`) |
| Slack token (optional) | Slack message items | stored in the macOS Keychain, see below | `security find-generic-password -s dev.agentcraftingtable.slack -a default` (no `-w`) |
| ImageMagick (optional) | re-recording the README demo only | `brew install imagemagick` | `magick -version` |

The app finds `claude`, `codex`, `gh` and `notion` on your **login shell's PATH**
(it imports that PATH at startup, with `~/.local/bin` and Homebrew as fallbacks).
If a tool works in Terminal, it works in the app.

## Step by step

### 1. Build tools and Node

```sh
xcode-select --install          # skip if `xcode-select -p` already prints a path
brew install git nvm
```

Follow Homebrew's note to add nvm to your shell profile, open a new shell, then in the repo:

```sh
nvm install                     # installs the version in .nvmrc
nvm use
node --version                  # v26.8.2
npm --version                   # 11.x
```

### 2. The app

```sh
git clone https://github.com/pelzerim/agentic-crafting-table.git agent-crafting-table
cd agent-crafting-table
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -1)"   # the newest release tag
npm ci                          # also downloads Electron and rebuilds native modules for it
npm run dev                     # builds and starts the app
```

Check: the window opens and shows **Create your first project**. Quit it before going on.

For a build in the Dock:

```sh
npm run package                 # stages release/staged/mac-arm64/Agentic Crafting Table.app
npm run install:local           # verifies it and installs release/mac-arm64/Agentic Crafting Table.app
```

Check: `npm run install:local` prints `Installed …` (or `Already up to date`). Launch
and pin `release/mac-arm64/Agentic Crafting Table.app`, not the staged copy.

### Updating

Releases are tags of the repository. The app looks up the newest tag once a day
(Settings → General → Check for updates daily) and shows a notice when there is a newer
one; Settings → General → About shows the running and newest versions. To update:

```sh
# quit the app first
npm run update                  # fetches tags, checks out the newest release, npm ci, package, install:local
```

It refuses while the app runs or the checkout has local changes. Installed plugin packs
are checked the same way; their notice opens Settings → Plugins with the new tag to review.

### 3. Claude Code (and Codex)

```sh
npm install -g @anthropic-ai/claude-code
claude --version
claude                          # first run: sign in, then /exit
```

Check: `claude --help` lists `--session-id`, `--resume`, `--mcp-config` and
`--plugin-dir`; the app refuses older versions. Codex is the same shape:

```sh
npm install -g @openai/codex
codex --version
codex                           # first run: sign in, then exit
```

### 4. GitHub

```sh
brew install gh
gh auth login                   # github.com, HTTPS, log in with a browser
gh auth status
```

Check: `gh auth status` shows the account as logged in. In the app, **Settings →
Connections → Connect GitHub** lists that account; pick it. The app reads through
the CLI's credential store and never copies the token anywhere. Only github.com is
supported; GitHub Enterprise is not.

### 5. Linear (optional)

Create a personal API key in Linear (Settings → API) with read access to the issues
you want on the map (and update access if you want to change status from the app).
Store it in the Keychain; keep `-w` last so the key is typed at a concealed prompt,
never on the command line:

```sh
security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w
```

Check: `security find-generic-password -s dev.agentcraftingtable.linear -a default`
prints the entry (without `-w` it does not print the key). In the app, **Settings →
Connections → Connect Linear** and pick the account.

### 6. Slack (optional)

Create a bot or user token with the history/read scopes for the conversations you
want to attach (`users:read` adds display names). Store it the same way:

```sh
security add-generic-password -U -s dev.agentcraftingtable.slack -a default -w
```

Check as for Linear, with `dev.agentcraftingtable.slack`. The app only reads; it
never posts, joins or marks anything read.

### 7. Notion (optional)

```sh
brew install 4ier/tap/notion-cli   # github.com/4ier/notion-cli, the CLI whose profiles the app reads
notion auth login                  # stores an internal integration token in ~/.config/notion-cli/config.json
notion auth status
```

In Notion's integration settings enable **Read comments** for that integration and
share each page you want on the map with it. The app reads the CLI's named profiles;
it copies nothing out of them.

## Verify the whole thing

```sh
uname -m && xcode-select -p && git --version && node --version && npm --version
claude --version && gh auth status
codex --version 2>/dev/null; notion auth status 2>/dev/null
security find-generic-password -s dev.agentcraftingtable.linear -a default >/dev/null 2>&1 && echo linear ok
security find-generic-password -s dev.agentcraftingtable.slack -a default >/dev/null 2>&1 && echo slack ok
```

Then in the app: create a project with a working directory, start an **Agent
session** (Claude), and open **Settings → Connections** to connect what you set up.

## On Linux

x64 and arm64 builds run from the same checkout; tested on Ubuntu 26.04 (GNOME on
Wayland). Everything above applies, with these differences:

| Instead of | On Linux |
| --- | --- |
| Xcode Command Line Tools, Homebrew | `sudo apt install build-essential python3 git libsecret-tools zsh`; `zsh` because, as on macOS, it is the shell used when `SHELL` is unset and the one `npm run test:runtime` starts |
| `brew install nvm` | any Node version manager that reads `.nvmrc` ([nvm](https://github.com/nvm-sh/nvm), asdf, mise) |
| `brew install gh` | the [GitHub CLI apt repository](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) |
| `brew install 4ier/tap/notion-cli` | a binary from the [notion-cli releases](https://github.com/4ier/notion-cli/releases) |
| the macOS Keychain | the Secret Service keyring (GNOME Keyring, KWallet) through `secret-tool`, see below |

**The Chromium sandbox.** Ubuntu 23.10 and later let only programs with an AppArmor
profile create the user namespaces Electron's sandbox needs, so `npm run dev`, the
tests and the packaged app abort with *The SUID sandbox helper binary was found, but
is not configured correctly*. Once per checkout, write a profile that covers only this
checkout's Electron and load it; this is the one step that needs `sudo`:

```sh
npm run sandbox:linux           # writes release/apparmor-profile and prints the two commands below
sudo install -m 644 release/apparmor-profile /etc/apparmor.d/agentic-crafting-table
sudo apparmor_parser -r /etc/apparmor.d/agentic-crafting-table
```

Do not start the app with `--no-sandbox` instead: it renders provider content.

**The app.** `npm run package` stages `release/staged/linux-<arch>/Agentic Crafting Table`
and `npm run install:local` installs `release/linux-<arch>/Agentic Crafting Table`. It also
writes `~/.local/share/applications/agentic-crafting-table.desktop`, which puts the app in
the launcher (pin it to the dock from there) and opens `act://` install links. `npm run update`
works the same way.

**Linear and Slack.** `secret-tool` asks for the value at a hidden `Password:` prompt:

```sh
secret-tool store --label 'Agentic Crafting Table Linear' service dev.agentcraftingtable.linear account default
secret-tool store --label 'Agentic Crafting Table Slack' service dev.agentcraftingtable.slack account default
```

Check with `secret-tool lookup service dev.agentcraftingtable.linear account default >/dev/null && echo linear ok`;
the redirect keeps the key off the screen.

## What the app never does

- Store a token of its own: GitHub and Notion are read through their CLIs' stores,
  Linear and Slack through the Keychain (on Linux, the Secret Service keyring), and nothing reaches the renderer, the map
  database or the logs.
- Write to a provider without you: reads are automatic; every write (a comment, a
  merge, a deploy approval, a Slack message) is a button you press, and Auto deploy
  halts on any doubt.
- Need a system Node or Docker, or `sudo` beyond the Linux packages and sandbox profile.
