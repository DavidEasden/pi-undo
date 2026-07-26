# pi-undo

Persistent undo and redo for [Pi](https://github.com/badlogic/pi-mono) that restores both the agent session and workspace files without requiring users to manage Git.

Each history entry represents one completed agent run. When you undo or redo, `pi-undo` moves Pi's session tree to the matching point and restores the corresponding workspace state.

## Features

- Persistent `/undo` and `/redo` across Pi restarts.
- Restores the Pi session and workspace files together.
- Preserves redo state with a safety snapshot taken immediately before undo.
- Integrates with Pi's native `/tree` navigation.
- Supports ordinary directories, Git repositories, nested repositories, and initialized submodules.
- Uses durable journals and restart recovery for interrupted operations.
- Detects conflicting external file changes and fails closed instead of overwriting unknown content.
- Does not require `git commit`, `git stash`, `git reset`, hidden branches, or any other user-managed Git workflow.

## Requirements

- Pi `0.80.10` or a compatible release.
- Node.js `22.19.0` or later.
- Git available on `PATH`.

Git is used internally to create private, content-addressed snapshots. You do not need to initialize a repository or run Git commands yourself.

## Installation

Install the published Pi package from npm:

```bash
pi install npm:@davideasden/pi-undo
```

Restart Pi after installation if the extension is not loaded in the current session.

To install a local checkout instead:

```bash
pi install ./path/to/pi-undo
```

During development, you can load the extension directly:

```bash
pi -e /absolute/path/to/pi-undo/extensions/pi-undo.ts
```

## Usage

Work with Pi normally. `pi-undo` records a boundary after each completed agent run.

### Diff

```text
/diff
```

`/diff` reviews the files changed by the most recent completed agent run. In TUI mode, select a file to open a colored, scrollable before-and-after comparison. Binary files are listed but do not receive a line-by-line diff.

Use a one-based history position to inspect an earlier applied run, where `1` is the most recent:

```text
/diff 2
```

Print, JSON, and RPC modes report a one-line file and line-count summary instead of opening the interactive viewer.

### Undo

```text
/undo
```

`/undo` returns to the previous completed agent run on the current branch. Before restoring that checkpoint, it captures the current workspace as a redo safety snapshot.

After a successful undo, `pi-undo` tries to put the original prompt back into an empty TUI editor. It never overwrites text already present in the editor. RPC mode only reports the refill request, while print and JSON modes do not promise editor refill behavior.

### Redo

```text
/redo
```

`/redo` restores the session and workspace captured immediately before the corresponding undo. It does not simply reapply the checkpoint's original after-snapshot, so edits preserved by the redo safety snapshot are restored correctly.

### Tree Navigation

Continue to use Pi's native command:

```text
/tree
```

Before Pi moves to another session-tree boundary, `pi-undo` validates the target and records a rescue snapshot. After navigation, it restores the workspace associated with the selected boundary.

If the agent is streaming, `/undo` and `/redo` request an abort and wait for the agent to become idle. If the wait times out or tools are still running, no files are restored. Native `/tree` navigation is cancelled while streaming and can be retried when Pi is idle.

The footer shows the available history, for example:

```text
undo:2 redo:1
```

## How It Works

Private state is stored alongside the Pi session:

```text
<sessionDir>/.pi-undo/
```

For every completed agent run, `pi-undo` captures the session boundary and a workspace manifest. Snapshots use a private Git object database and temporary index. They do not use the repository's normal history.

Undo, redo, and tree restoration follow the same high-level flow:

1. Validate the current session, workspace topology, and target manifest.
2. Write a durable write-ahead log (WAL) before changing files.
3. Capture a safety or rescue snapshot when required.
4. Move the Pi session to the target logical boundary.
5. Restore workspace paths with fingerprint checks and no-clobber installation.
6. Verify the resulting session and workspace before committing the journal.

Ordinary files and symbolic links are restored through same-directory, same-filesystem quarantine artifacts. For regular files, source capture uses a hard link and checks the path fingerprint and inode identity again immediately before removing the original path. This narrows the external-concurrency window, but cannot make the final check and unlink operation atomic in pure Node.js.

## Safety and Recovery

`pi-undo` does not modify the user's Git `HEAD`, index, refs, reflogs, stash, configuration, or other repository metadata. Nested repositories and initialized submodules are captured as independent roots, but only their working files are restored. The extension does not switch their real `HEAD`, run `git submodule update`, or recreate deleted `.git` metadata.

If Pi or the process stops during a restore, the next session startup reads the transaction journal:

- Without a trusted cursor marker, it restores the rollback manifest and marks the transaction aborted.
- With a trusted cursor marker, it restores the target manifest, completes cursor durability, and commits the transaction.
- If the journal, session identity, logical leaf, manifest, cursor, or workspace contents conflict, it enters `recovery required` and blocks further history mutation.

When the footer reports `recovery_required`, first back up the workspace and Pi session JSONL. Transaction diagnostics are stored in:

```text
<sessionDir>/.pi-undo/transactions/
```

The relevant transaction may contain `descriptor.json`, `restore-plan.json`, `state.json`, and mutation journal data. Do not delete the `.pi-undo` directory without a backup: unresolved quarantine artifacts may contain the only preserved copy of a file version.

## Limitations

- Git-ignored files are not included in snapshots and are not created or deleted during restore.
- Empty directories are not represented in snapshots.
- Real `.git` metadata is never restored.
- The workspace lock coordinates `pi-undo` instances, but cannot prevent editors, watchers, or other processes from writing files concurrently.
- Quarantine and repeated fingerprint checks reduce, but cannot eliminate, the final check-to-unlink race with arbitrary external processes.
- When ownership or contents cannot be proven, `pi-undo` preserves the available versions and enters `recovery required` instead of guessing, deleting, or overwriting.
- `--no-session` mode has no durable session cursor. Undo and redo can work in-process, but crash persistence is not guaranteed.
- Uninitialized gitlinks are not initialized automatically. A broken nested repository causes capture to fail instead of being silently skipped.
- Workspace files and Pi JSONL are not an operating-system-level ACID transaction. Snapshots, WAL records, cursor markers, verification, and idempotent recovery are used to converge to the old or new state.

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/DavidEasden/pi-undo.git
cd pi-undo
npm install
```

The development dependency for Pi points to:

```text
resources/pi-0.80.10/packages/coding-agent
```

For type checking and the real `AgentSession` integration tests, place the Pi `0.80.10` source tree at that path, install its workspace dependencies, and build the required workspace packages. The published package does not include `resources/`.

Useful project paths:

```text
extensions/pi-undo.ts   Pi extension entry point
src/                    Snapshot, journal, restore, and runtime implementation
test/                   Unit, integration, recovery, and fault-injection tests
```

## Testing

Run the complete test suite:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Run the Pi runtime and extension integration tests:

```bash
npm run test:integration
```

Run TypeScript type checking:

```bash
npm run typecheck
```

Inspect the npm package contents before publishing:

```bash
npm run pack:dry-run
```

## License

[MIT](LICENSE)
