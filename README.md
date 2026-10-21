# Agentic Crafting Table

**Your agents, pull requests, tickets and terminals on one map. Zoom in to work;
zoom out to see what needs you.**

![One story in 40 seconds: an agent working in its own view; back on the map two pull requests join its project; reviews are triggered from the right-click menu; two findings from one review are sent to the agent; the other pull request is merged from the menu; its rollout appears and a validation passes, with the report; the merged pull request, its rollout and its review are sent to the Undermap together; zooming out to the neighbouring projects and their pipelines](docs/media/demo.gif)

## Features

**A map, not a list**
- Every project is a neighborhood; every piece of work is an item on it. Open an item
  by zooming into it and it keeps its place, links and all.
- Link items to say what feeds what: a ticket into an agent, a brief into a pull
  request, a pull request into its rollout.
- Zoom out and projects become dashboards: who needs you, what is working, the
  pull request pipeline. Zoom out further for the whole table.
- Three items close together form a plot with a signpost; drag the sign to move them all.

**Agents that know where they are**
- Start Claude or Codex in a project folder. They get the project's context and an
  MCP server, read the map, add to it and link what they make.
- Resume a saved conversation later; reconnect to a running one after a restart.
- Run installed project skills as tracked native runs, with a model of your choice.
- Agents get short, auto-generated titles from what they are doing.

**Needs me, not notifications**
- One panel lists what is waiting for you: an agent with a question, a review request,
  a failed rollout. Mark it seen and it leaves; opening it can mark it seen too.
- Native macOS banners when the app is in the background, if you want them.

**GitHub without the browser**
- Pull requests show their conversation with new comments marked, replies, Fix with
  agent and one-click merge.
- **Review loop** runs a review, fixes the critical and high findings, and reviews again
  until a round comes back clean.
- **Auto deploy** merges once ready, deploys to staging, validates, approves to
  production and validates again, phase by phase, while you watch. Any doubt halts it.
- Rollouts live on the map and show their state; open one for its jobs and gates.
- A GitHub inbox of other people's pull requests that want something from you.

**Terminals that survive**
- Real local shells with your own configuration. They outlive renderer and service
  restarts and keep their scrollback.

**To-dos where the work is**
- Items join the to-do list; imported tickets land in an inbox you triage onto a project.
- Next, Later, Done; reminders; muted projects drop out of the way until you unmute them.

**Your tools as plugin packs**
- The public base ships the generic item types: agents, terminals, notes, to-dos, links,
  GitHub pull requests and rollouts, reviews, Linear, Notion and Slack.
- Team-specific items ship as plugin packs from their own git repository and install
  through **Settings → Plugins**. Items of a pack that is not installed stay on the map
  as placeholders.

## Get it running

macOS on Apple silicon. Node 26 and npm 11 to build; the packaged app brings its own.
You also want the Claude Code CLI and the GitHub CLI signed in; Codex, Linear, Slack
and Notion are optional. [Setup](docs/setup.md) lists every tool with its `brew`
or `npm` install and a check, and [the setup prompt](docs/setup-prompt.md) is the
same thing as a prompt you can hand to your agent.

```sh
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -1)"   # the newest release
npm ci
npm run dev              # build and start the app
```

For an app in the Dock:

```sh
npm run package          # stage a build in release/staged
npm run install:local    # install it (quit the running app first)
```

Then launch `release/mac-arm64/Agentic Crafting Table.app`.

First steps:
1. **Create your first project** and give it a working directory.
2. Double-click empty space in it → **Agent session** → **Start Claude**. The Claude
   or Codex CLI must be installed and signed in.
3. **Settings → Connections** for GitHub, Linear, Notion and Slack. Everything the app
   has read stays readable offline.

Middle-click any item to open it on the web.

### Updating

Releases are tags (`vX.Y.Z`); [CHANGELOG.md](CHANGELOG.md) lists what each one
changed. The app tells you when a newer one exists. Quit it, then:

```sh
npm run update           # check out the newest release, build it and install it
```

It refuses while the app runs or the checkout has local changes. Your projects and
settings stay where they are.

0.1.0 has no `npm run update` yet, so move off it once by hand, with the app quit:

```sh
git fetch --tags origin
git checkout --detach "$(git tag --list 'v*' --sort=-v:refname | head -1)"
npm ci
npm run package
npm run install:local
```

## Docs

| Document | What it is for |
| --- | --- |
| [Setup](docs/setup.md) · [setup prompt](docs/setup-prompt.md) | Every tool to install and sign in to, with checks; the prompt version for your agent |
| [Using the app](docs/using-the-app.md) | Day-to-day guide: items, agents, terminals, moving work, settings |
| [Write your own plugins](docs/plugins/README.md) | Build, test, release and install a plugin pack; starts with an example |
| [Development](docs/development.md) | Code layout, build, tests, packaging, local install, diagnostics |
| [Product specification](docs/specification.md) | The agreed behaviour, requirement by requirement |
| [Architecture](docs/architecture.md) | Processes, data, sessions, plugins and integration decisions |
| [Native Claude](docs/native-claude.md) · [Codex](docs/native-codex.md) · [skills](docs/native-skills.md) | How agent sessions are launched, resumed and tracked |
| [GitHub](docs/native-github.md) · [Linear](docs/native-linear.md) · [Notion](docs/native-notion.md) · [Slack](docs/native-slack.md) | What each connector reads and does |
| [Workspace backups](docs/workspace-backups.md) | Offline backup, verification and recovery |
| [Testing strategy](docs/testing.md) | Coverage, automated journeys and live checks |

## Licence

[MIT](LICENSE).
