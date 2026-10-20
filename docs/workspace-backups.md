# Offline workspace backup and recovery

The development command `npm run workspace:backup` saves the table and its local
session recordings together. Quit Agentic Crafting Table first and let its normal
shutdown stop managed sessions. The command refuses live workspace/supervisor
owners and recorded processes that are still alive; it never stops them for you.
It does not connect to GitHub, Slack, any model provider or a remote machine.

Run from the repository with the Node version in `.nvmrc`. Supply an existing
parent directory and a **new** destination folder outside the profile:

```sh
npm run workspace:backup -- create \
  "$HOME/Library/Application Support/agent-crafting-table" \
  "$HOME/Desktop/crafting-table-backup"

npm run workspace:backup -- verify \
  "$HOME/Desktop/crafting-table-backup"

npm run workspace:backup -- prepare-recovery \
  "$HOME/Desktop/crafting-table-backup" \
  "$HOME/Desktop/crafting-table-recovery"
```

The final command prepares `profile/` and writes `READY.json` on success. It does
**not** replace the current workspace, launch the app, resume agents, or replay
jobs. An existing destination is never overwritten. Keep the original workspace
and backup until recovery has been checked.

## What is preserved

- Graph, resource IDs, connections, to-dos, layout, camera, settings, command
  receipts, provider observations, job correlations and shutdown recovery state.
- Supervisor session identities, launch deduplication, terminal output, recording
  deletion tombstones and any legacy scrollback tails.
- Agent launch/context/MCP/hook files, shell restart receipts, review launch/resume
  files, and isolated PR comparison repositories/results owned by the table.

Both SQLite stores are write-locked before checking ownership and reading files.
Snapshots include committed WAL data. Backup databases are normalized into
standalone files and stale service ownership is cleared **in the copies only**.
No source migration or graph command runs. Backup verification checks manifest
version, paths, file sizes/hashes/modes, database schema compatibility and SQLite
integrity. Hashes detect corruption; they do not authenticate an untrusted backup.

The bundle is private to the local user (directories 0700, files 0600 or 0700 for
executable comparison files), but **not encrypted**. It contains project context,
source code and terminal recordings, which may themselves contain secrets. It is
not a support report and should not be attached to issues or committed to Git.

## What stays outside the backup

Native Claude/Codex conversation directories, working repositories, installed CLIs,
OS Keychain/CLI credentials, IPC tokens, Electron caches, diagnostic logs, temporary
summary workspaces and earlier migration/backup copies are excluded. No symlink
is followed. Relative links within the copied data are preserved; absolute or
escaping links, hard links and special files cause an explicit refusal. If a
comparison repository contains an unsupported link, no backup is published.

Keep native conversation files, working folders and credentials separately under
your existing backup policy. A table recording alone cannot resume a missing
native conversation. There is no automatic retention or backup deletion policy.

## Activating a recovery copy

This first recovery tool prepares a verified copy for **the same machine and
original profile path** recorded in `READY.json`. Launch plans contain absolute
paths; relocating to a different machine/path is not implemented.

1. Confirm the command succeeded and `READY.json` exists. A partially copied
   directory without that completion record is not ready to use.
2. Keep the app and its services stopped. Preserve the existing profile in a
   separate location; do not merge files or copy over running SQLite stores.
3. Move the prepared `profile/` directory to the original profile location. This
   is an explicit operator step, not an action performed by the command.
4. Open a compatible app build. IPC tokens are regenerated. Normal startup
   recovery applies: **sessions marked for recovery in the saved checkpoint may
   resume**, and pending jobs reconcile using their saved identities. Consider
   what external work happened after the backup before activating an old snapshot.

The tool does not back up or replace the `.app` bundle, and workspace recovery is
separate from `npm run install:local -- --recover-only` for interrupted app updates.
Never rename the installed `.app` directory to keep a backup; Dock bookmarks follow
that directory. See [the installation instructions](development.md#package-and-install-locally).

## Failure and acceptance boundaries

Ordinary failures clean up only the newly created output. A killed process may
leave an incomplete folder; a backup without `manifest.json` is rejected. Retry
into a new folder and preserve partial data until inspected. SQLite releases the
source locks when the process dies. Insufficient disk space fails the copy without
replacing the source profile.

Automated tests use disposable local profiles, real SQLite WAL and service IPC,
and an actual killed backup process. They cover old-schema migration after recovery,
recording deletion, deduplication, invalid versions/paths/hashes and ownership
refusal. They do not prove power-loss durability, a clean-machine installation,
manual activation of a real user's profile, or a native/live-provider restoration.
These remain separate release acceptance gates.
