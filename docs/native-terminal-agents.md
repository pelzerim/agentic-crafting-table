# OpenCode, Pi, Gemini and Grok Build

Status: launch in a real terminal, per-launch table tools where the CLI allows it, resume for
Pi and Gemini. Rule: AGENT-01b in the [specification](specification.md).

`packages/session-runtime/terminal-agents.ts` holds one small spec per CLI: its executable,
the flags its `--help` must list, and how a launch passes the model, the first prompt, the
session id and the table's MCP server. The table never writes the user's or the project's
configuration; private files go in the launch folder (`agent-launches/<request id>/`).

| CLI | Table tools | Guide | First prompt | Session id | Resume |
| --- | --- | --- | --- | --- | --- |
| `opencode` | `OPENCODE_CONFIG` → `mcp.crafting_table` (`type: local`) | `instructions` file | `--prompt` | chosen by OpenCode | no |
| `pi` | none (Pi has no MCP client) | short note, `--append-system-prompt` | after `--` | `--session-id` | `--session-id` |
| `gemini` | `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` → `mcpServers` | start of the first prompt | `--prompt-interactive` | `--session-id` | `--resume <id>` |
| `grok` | none (config files only) | short note, `--rules` | none | chosen by Grok | no |

Sources checked on 2026-11-16:

- OpenCode 1.19.5: the TUI options (`--model`, `--prompt`, `--session`, `--continue`), the
  `OPENCODE_CONFIG` merge and the `mcp` and `instructions` schema, read from the published
  package; [config docs](https://opencode.ai/docs/config/).
- Pi 0.87.1: `pi --help`.
- Gemini CLI 0.68.0: the yargs options and the settings merge (`mcpServers` is a shallow merge
  across the system defaults, user and workspace files), read from the published package;
  [CLI reference](https://geminicli.com/docs/cli/cli-reference/). Gemini CLI ended for unpaid
  and Google One accounts on 2026-06-18; Antigravity CLI (`agy`) replaced it there and is not
  supported yet.
- Grok Build: xAI's user guide only (`--rules`, `--model`, `~/.grok/config.toml`); no local
  install was checked, so the probe asks for no flags.

None of these CLIs reports turn status to the table, so their items stay in the unknown state.
A new provider needs its spec, an id in `AGENT_PROVIDER_IDS` (off by default), a label and a
plan test in `terminal-agents.test.ts`.
