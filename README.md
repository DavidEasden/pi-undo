# pi-undo

**Persistent workspace undo and redo for [Pi](https://github.com/badlogic/pi-mono).**

Each completed agent run creates a checkpoint that captures both the Pi session boundary and a content-addressed workspace snapshot. `/undo` moves Pi's session tree to a prior run and restores the matching workspace. `/redo` reverses the undo with a safety snapshot taken before the operation. The system is crash-safe: an interrupted restore is rolled forward or back on next startup using durable journals, write-ahead logging, and quarantine artifacts.

## Features

- **Persistent undo / redo** across Pi restarts. History is stored per-session and survives crashes.
- **Diff viewer** — `/diff` and `/diff N` show before-and-after file changes with colored, scrollable output in TUI mode and a summary in non-TUI modes.
- **Session + workspace** — Pi's session tree and workspace files are restored together as a unit.
- **Safety snapshots** — `undo` captures the current workspace as a redo safety snapshot; `tree navigation` records a rescue snapshot before switching branches.
- **Deferred prompts** — text, images, `@file` references, and paste content entered during an undo/redo are queued and processed in FIFO order once the operation completes. Prompts are never lost.
- **Crash recovery** — a write-ahead log (WAL), mutation journal, and quarantine artifacts allow in-progress operations to be rolled forward or back on restart.
- **External concurrency detection** — file fingerprint and inode checks detect external modification. Conflicting changes are never silently overwritten; the system fails closed or enters `recovery required`.
- **No Git workflow** — snapshots use a private object database. No `git commit`, `git stash`, `git reset`, branches, or forges are required.
- **Nested repositories** and **initialized submodules** are handled as independent roots. Their `.git` metadata is never modified.
- **Performance** — batch WAL operations (up to 1,024 files per batch), scoped safety snapshots, prebuilt durable transaction packs, native Rust no-clobber file helper (macOS/Linux, arm64/x64), indexed WAL record and conflict lookups, and parallel manifest blob reads keep restore fast at scale. Unsupported platforms and failed integrity checks automatically use the TypeScript fallback.

## Requirements

- Pi `0.80.10` or a compatible release.
- Node.js `22.19.0` or later.
- Git available on `PATH` (used internally for content-addressed snapshots).

### Native Rust Acceleration

pi-undo includes a cross-platform native Rust helper (`pi-undo-fs`) to accelerate filesystem operations. The published package contains these six precompiled binaries:

| Platform | Architecture | Binary |
|---|---|---|
| macOS | arm64 | `pi-undo-fs-darwin-arm64` |
| macOS | x64 | `pi-undo-fs-darwin-x64` |
| Linux | arm64 | `pi-undo-fs-linux-arm64` |
| Linux | x64 | `pi-undo-fs-linux-x64` |
| Windows | arm64 | `pi-undo-fs-win32-arm64.exe` |
| Windows | x64 | `pi-undo-fs-win32-x64.exe` |

The extension automatically selects the correct binary for the current runtime, so users do not need to install Rust or choose a platform manually. Windows binaries use the `.exe` suffix. On platforms without a precompiled binary, the extension automatically falls back to the TypeScript implementation with the same functionality.

## Installation

### Install from npm (Recommended)

All supported platforms use the same installation command. The npm package includes precompiled arm64 and x64 Rust helpers for macOS, Linux, and Windows, and the extension selects the correct version at startup:

```bash
pi install npm:@davideasden/pi-undo
```

Restart Pi to load the extension. Users do not need to install Rust or select and install a platform-specific package.

### Install from Local Source

```bash
pi install /path/to/pi-undo
```

### Load Directly for Development

```bash
pi -e /absolute/path/to/pi-undo/extensions/pi-undo.ts
```

> **Note:** `pi install` copies the entire package, including the precompiled binaries under `native/bin/`, into Pi's extension directory. To include a newly compiled native binary in a source installation, run `npm run build:native` before `pi install`.

## Usage

Work with Pi normally. `pi-undo` automatically records a boundary after each completed agent run.

### Diff

```text
/diff
```

Shows files changed by the most recent completed run. In TUI mode, select a file to open a colored, scrollable before-and-after comparison. Binary files are listed without line-by-line diff.

Use a one-based position to inspect an earlier run (`1` is the most recent):

```text
/diff 3
```

Print, JSON, and RPC modes report a one-line file and line-count summary.

### Undo

```text
/undo
```

Returns to the previous completed run on the current branch. Before restoring, it captures the current workspace as a redo safety snapshot.

After a successful undo, text entered during the operation is replayed into the editor. RPC mode reports the refill request; print and JSON modes do not replay prompts.

### Redo

```text
/redo
```

Restores the session and workspace captured immediately before the corresponding undo. The redo safety snapshot preserves edits made between the undo and the redo.

### Tree Navigation

Continue to use Pi's native command:

```text
/tree
```

Before Pi moves to another session-tree boundary, `pi-undo` validates the target and records a rescue snapshot. After navigation it restores the matching workspace.

While the agent is streaming, `/undo` and `/redo` request an abort and wait for idle. If the wait times out, no files are restored. Native `/tree` is cancelled while streaming and can be retried when idle.

The footer shows available history, for example:

```text
undo:2 redo:1
```

When crash recovery is pending, the footer shows:

```text
recovery_required
```

### Performance Notes

Real-world measurements from a 104-file undo operation before optimizations:

```text
ok files:104 total:8797ms apply:8591ms capture:89ms journal:64ms commit:27ms plan:11ms
```

After batch WAL, scoped safety snapshots, parallel restore I/O, batch file deletes, and prebuilt durable transaction packs:

```text
ok files:104 total:~1050ms apply:~850ms capture:~90ms journal:~65ms
```

After native Rust helper, durable pack caching, parallel durable finalization, batch validated blob reads, and indexed mutation/path lookups:

```text
ok files:104 total:~850ms apply:~650ms capture:~90ms journal:~65ms plan:~10ms
```

Performance gains come from:

- **Batch WAL durability** — write-once, fsync-once per batch of up to 1,024 entries instead of per-file.
- **Durable transaction packs** — source and target variants, fingerprints, modes, artifact names, and checksums are published and fsynced before native workspace mutation.
- **Prebuilt reverse/forward packs** — completed agent runs prepare both directions and pin their manifests outside the undo/redo command hot path.
- **Optional native helper** — verified regular-file batches use platform no-clobber primitives while retaining same-inode ownership artifacts; missing binaries or failed validation fall back before mutation.
- **Scoped safety snapshots** — only paths recorded in a checkpoint's `changedPaths` are snapshotted for undo/redo, not the entire workspace.
- **Parallel target I/O** — up to 32 target artifact files are written and synced concurrently.
- **Concurrent request preparation** — blob reads, live-state checks, and fingerprint computation run at 32-wide concurrency.
- **Batch file deletes** — delete operations share the same WAL batch and directory fsync merging.
- **Directory fsync merging** — barriers are applied once per unique directory per phase, not once per file.
- **Native Rust no-clobber helper** — packaged macOS arm64 binary uses platform renameat2 with EEXIST guard for regular-file batches; missing binaries or platform mismatch fall back to the TypeScript path before mutation.
- **Durable pack caching** — completed agent runs build and cache reverse/forward durable packs; the undo/redo hot path reuses the cached pack with manifest pin, avoiding redundant snapshot reads.
- **Indexed WAL record lookups** — mutation records are indexed by ordinal for O(1) direct access instead of linear scan.
- **Indexed path conflict resolution** — `exactExclusions` are stored as a Set for O(1) membership checks instead of O(n) `Array.includes`.
- **Batch validated manifest blob reads** — durable pack reads coalesce blob fetches into a single batch per manifest with combined Git validation.

## How It Works

Private state is stored alongside the Pi session:

```text
<sessionDir>/.pi-undo/
```

For every completed agent run, `pi-undo` captures:

1. A **session boundary** — the logical point in Pi's session tree.
2. A **workspace manifest** — a content-addressed snapshot of the workspace root(s).

Snapshots use a private Git object database and a temporary Git index. They never touch the repository's normal history, `HEAD`, reflog, or stash.

The restore flow is:

1. Validate current session, workspace topology, and target manifest.
2. Establish mutation authority before changing files: either durable JSON `INTENT` records on the TypeScript path or a complete fsynced transaction pack on the native path.
3. Capture a safety snapshot when content differs from the preverified checkpoint source; otherwise reuse the pinned checkpoint manifest.
4. Move the Pi session cursor to the target boundary.
5. Restore workspace paths with fingerprint and inode checks and no-clobber installation.
6. Verify the resulting session and workspace before committing the journal (`TARGET_VERIFIED` → `CLEANED`).

### Mutation Journal (WAL)

Each file change is tracked through a six-state hash chain:

```
INTENT → SOURCE_QUARANTINED → SOURCE_VERIFIED → TARGET_INSTALLED → TARGET_VERIFIED → CLEANED
```

- **INTENT** — durable intent recorded before any mutation.
- **SOURCE_QUARANTINED** — original file hard-linked to a random artifact name.
- **SOURCE_VERIFIED** — original removed, artifact content verified.
- **TARGET_INSTALLED** — new file hard-linked into place (no-clobber).
- **TARGET_VERIFIED** — workspace confirmed matching target state.
- **CLEANED** — source and target artifacts removed.

Batch operations (`beginMany`, `advanceBatch`) maintain the same per-file six-state contract while reducing physical fsync calls by grouping entries. On the native path, the transaction pack is the pre-mutation `INTENT` authority; finalization or startup recovery materializes the same six per-file states into the append-only WAL before cleanup.

Every WAL record is checksum-linked to its predecessor. The journal is append-only and never mutated in place. Native finalization advances through `TARGET_VERIFIED`, fsyncs the installed inode while its ownership marker is still present, then removes exact artifacts and appends `CLEANED`.

### Quarantine and External Concurrency

Ordinary files and symlinks are restored through same-directory, same-filesystem artifacts:

- **Source capture**: `link(original, sourceArtifact)` — fails with `EEXIST` if artifact already exists.
- **Target installation**: `link(targetArtifact, original)` — fails with `EEXIST` if original was externally recreated.
- **Fingerprint + inode**: before each state transition, both content fingerprint and `(dev, ino)` identity are verified. A matching fingerprint with a different inode is treated as external replacement and triggers a safe fail-closed state.
- **Artifact cleanup**: only artifacts registered in the journal with matching paths, names, fingerprints, and ownership are removed. Unclaimed files are never deleted.
- **Rollback**: from any state, `restoreMutation` converges to the pre-operation state. If a previous target was externally replaced with identical content but a different inode, the external file is preserved and the journal remains active.

## Safety and Recovery

- Pi `HEAD`, index, refs, reflog, stash, config, and other repository metadata are never modified.
- Nested repositories and submodules are restored as independent roots. Their `.git` directories are not created or deleted.
- If the process stops during a restore, startup recovery reads the transaction journal:
  - **Without a trusted cursor marker**: restores the rollback manifest and marks the transaction aborted.
  - **With a trusted cursor marker**: completes cursor durability and commits the transaction.
  - **On conflict** (identity, leaf, manifest, cursor, or workspace mismatch): enters `recovery required` and blocks further history mutation.

When `recovery_required` appears, first back up the workspace and Pi session JSONL. Transaction diagnostics are stored in:

```text
<sessionDir>/.pi-undo/transactions/
```

A transaction directory may contain `descriptor.json`, `restore-plan.json`, `state.json`, `mutations.jsonl`, `durable-pack-v1.bin`, and a native helper request. Do not delete `.pi-undo` without a backup: unresolved packs or quarantine artifacts may be the only surviving copy of a file version.

### Troubleshooting `recovery_required`

First stop other Pi instances, editors, formatters, and watchers that may write to the same workspace. Then completely quit and restart Pi once. Startup recovery is idempotent and normally finishes an interrupted transaction automatically. Deleting `.pi-undo` while Pi is still running does not clear the in-memory recovery lock, and the active process may recreate the directory.

If the footer includes an `opId`, locate that exact transaction first. Recovery data is stored under the session directory for each workspace. Inspecting `.pi-undo` for a different workspace can therefore produce a misleading result that no pending journal exists:

```bash
OP_ID="op-..."; TX="$(find "${PI_AGENT_DIR:-$HOME/.pi/agent}/sessions" -type d -path "*/.pi-undo/transactions/$OP_ID" -print -quit)"; test -n "$TX" && printf 'transaction=%s\n' "$TX"
```

Back up the workspace before continuing. Inspect the transaction phase and descriptor without editing them:

```bash
jq '{opId,phase,revision,observedLogicalLeaf}' "$TX/state.json"
jq '{action,fromLogicalLeaf,toLogicalLeaf,workspaceIdentity,sessionIdentity,scopeCount:(.scopePaths | length)}' "$TX/descriptor.json"
```

List every non-terminal transaction under the same `.pi-undo` root. This command is intentionally kept on one line because trailing whitespace after a continuation backslash can break `find -exec` when a multiline command is pasted:

```bash
ROOT="$(dirname "$(dirname "$TX")")"; find "$ROOT/transactions" -name state.json -type f -exec jq -r 'select(.phase != "COMMITTED" and .phase != "ABORTED") | "\(.opId) \(.phase)"' {} +
```

If `mutations.jsonl` exists, summarize the final state of each mutation ordinal and list mutations that have not been cleaned:

```bash
jq -s 'group_by(.ordinal) | map(.[-1]) | group_by(.state) | map({state: .[0].state, count: length})' "$TX/mutations.jsonl"
jq -s 'group_by(.ordinal) | map(.[-1]) | map(select(.state != "CLEANED")) | .[] | {ordinal,path,kind,state}' "$TX/mutations.jsonl"
```

- If the second command prints any records, artifacts or file mutations are still active. Do not delete or move the transaction. Preserve the workspace, session JSONL, transaction directory, and same-directory `.pi-undo-*` artifacts for manual recovery.
- If the second command prints nothing, every WAL mutation is already `CLEANED`. A footer such as `recovery_required files:1 op:...` may still appear because the conflict path count has a minimum fallback of one. `files:1` alone does not prove that one active file remains.
- Only when every mutation is `CLEANED`, the transaction phase is still `RECOVERY_REQUIRED`, and you have independently verified that the current workspace and Pi session are the result you want to keep, back up and isolate that transaction:

```bash
SESSION="$(jq -r '.sessionIdentity.path' "$TX/descriptor.json")"; STAMP="$(date '+%Y%m%d-%H%M%S')"; BACKUP="$ROOT/recovery-backup/$STAMP"; mkdir -p "$BACKUP"; cp -p "$SESSION" "$BACKUP/$(basename "$SESSION").backup"; mv "$TX" "$BACKUP/"
```

After isolating a fully cleaned transaction, completely quit every Pi process for that workspace and start Pi again. Reloading the session alone may retain the in-memory recovery lock. Do not edit `state.json` by hand because journal states and descriptors are checksum-bound. Do not remove the entire `.pi-undo` directory because it may still contain committed history, snapshots, packs, or the only recoverable copy of a file.

## Limitations

- Git-ignored files are not included in snapshots and are not created or deleted during restore.
- Empty directories are not represented in snapshots.
- Real `.git` metadata is never created, modified, or deleted.
- The workspace lock prevents concurrent `pi-undo` instances, but cannot prevent editors, watchers, or other processes from writing files concurrently.
- Fingerprint and inode checks reduce the external-concurrency race window, but cannot make the final check-and-unlink atomic in pure Node.js.
- `--no-session` mode has no durable session cursor. Undo and redo can work in-process, but crash persistence is not guaranteed.
- Uninitialized gitlinks are not initialized automatically. A broken nested repository causes capture to fail instead of being silently skipped.
- Workspace files and Pi session JSONL are not an operating-system-level ACID transaction. Snapshots, WAL, cursor markers, verification, and idempotent recovery are used to converge to the old or new state.

## Development

### Dependencies

Clone the repository and install dependencies:

```bash
git clone https://github.com/DavidEasden/pi-undo.git
cd pi-undo
npm install
```

### Build the Native Rust Helper

Install the [Rust toolchain](https://rustup.rs/) before building or updating a native binary:

```bash
npm run build:native
```

`npm run build:native` creates `pi-undo-fs` for the current build platform under `native/pi-undo-fs/target/release/`. The release workflow builds arm64 and x64 versions on macOS, Linux, and Windows runners, renames them consistently under `native/bin/`, and packages all six binaries in the npm package.

For local development on the current platform, copy the generated file into `native/bin/` and rename it for the platform. For example, a Windows build must use the corresponding `.exe` filename.

```bash
cp native/pi-undo-fs/target/release/pi-undo-fs native/bin/pi-undo-fs-darwin-arm64
chmod +x native/bin/pi-undo-fs-darwin-arm64
```

The published package must contain all six platform binaries listed under Requirements. CI verifies them before packaging and publishes the complete CI-built npm package when a `v*` tag is pushed. The npm package must configure Trusted Publishing (OIDC) for this GitHub Actions workflow. If no binary is available for the current platform, the extension automatically uses the TypeScript fallback.

### Project Layout

```text
extensions/pi-undo.ts        Pi extension entry point
src/
  atomic-fs.ts               Atomic file writes, fsync helpers
  controller.ts              Undo/redo/diff controller orchestrator
  diff-ui.ts                 TUI diff view (Ink/React components)
  diff-view.ts               Diff computation and rendering
  encoding.ts                checksum, canonical JSON
  git-runner.ts              Git subprocess runner with counting
  journal.ts                 Transaction journal (session/descriptor/phase)
  model.ts                   Core types: manifest, root, session, plan
  mutation-journal.ts        WAL mutation journal (hash chain, batch ops)
  durable-pack.ts            Pre-mutation source/target authority and finalization
  native-restore.ts          Optional platform helper adapter with TypeScript fallback
  packed-recovery.ts         Pack-to-WAL rollback/roll-forward recovery
  path-safety.ts             Symlink escape, relative path safety
  pi-runtime.ts              Pi integration layer (session/extension bridge)
  quarantine.ts              File isolation, no-clobber install, external concurrency
  recovery.ts                Startup crash recovery
  restore-engine.ts          Workspace restore engine (plan → apply → verify)
  root-discovery.ts          Workspace root topology detection (nested repos, submodules)
  session-state.ts           Pi session cursor management
  snapshot-store.ts          Git-backed content-addressed snapshot store
  status-reporter.ts         Phase timing and footer status
  workspace-lock.ts          Cross-instance workspace lock
native/pi-undo-fs/           Rust no-clobber regular-file helper
native/bin/                  Precompiled platform binaries included in release packages
test/                        Unit, integration, recovery, and fault-injection tests
```

### Testing

```bash
npm test                  # Full test suite (425+ tests)
npm run test:native       # Rust helper and durable-pack recovery tests
npm run test:watch        # Watch mode
npm run test:integration  # Pi runtime and extension integration tests
npm run typecheck         # TypeScript type checking
npm run pack:dry-run      # Inspect npm package contents
```

The typecheck filters known pre-existing issues in Pi's own dependencies (`undici-types`, `@modelcontextprotocol`, `@google/genai`, `ReadonlySessionManager`). Only new project-level errors are enforced.

## Performance Benchmarks

Benchmark tests assert Git call counts and WAL record counts, not wall-clock thresholds, to avoid environmental flakiness. Selected synthetic results (104-file restore, includes fixture setup, capture, plan, and apply):

| Scenario | Git calls | WAL records | Duration |
|---|---|---|---|
| 104-file restore (write) — batch + parallel I/O | ≤12 | 624 | ~1.1s |
| 100-file restore (delete) — batch deletes | ≤12 | 600 | ~0.6s |
| 4,000-file rollback snapshot — batch Git | ≤24 (4 x `mktree`, 4 x `commit-tree`) | — | ~7s |

The 104-file standalone apply probe (10 warmup iterations + 10 measured) completes in approximately 3.9s post-optimization on the TypeScript path, and approximately 2.8s on the native Rust path.

### Performance Optimizations

Several hot paths were profiled and corrected from quadratic (n doubled ≈ 4× cost) to near-linear scaling. Each change was verified against the existing test suite (425+ tests) plus fault-injection and adversarial-diff tests. Optimization order was guided by real profile data rather than static code review alone. After this phase, attention shifted to the native Rust helper path, which dominates production workloads.

#### Wall-clock comparison (n changed files + n ignored files)

**Plan phase** — undo diff derivation and workspace topology check:

| n | Before | After | Improvement |
|---|---|---|---|
| 1,000 | ~178ms | ~131ms | 1.4× |
| 2,000 | ~399ms | ~259ms | 1.5× |
| 5,000 | ~2.5s | ~699ms | ~3.6× |

**Bidirectional durable pack prepare** — agent-settled caching for undo/redo:

| n | Before (no batch) | After (batched) | Improvement |
|---|---|---|---|
| 500 | ~949ms | ~249ms | 3.8× |
| 1,000 | ~2,940ms | ~386ms | 7.6× |
| 2,000 | ~10,512ms | ~677ms | 15.5× |

**Native apply** — the production hot path:

| n | TypeScript fallback | Native Rust helper | Improvement |
|---|---|---|---|
| 500 | ~2,572ms | ~253ms | 10.2× |
| 1,000 | ~5,726ms | ~374ms | 15.3× |
| 2,000 | ~10,521ms | ~646ms | 16.3× |

#### Algorithm microbenchmarks

| Scenario | Before | After | Improvement |
|---|---|---|---|
| 8,000×8,000 path overlap check | ~1,352ms | ~7ms | **193×** |
| 4,000-directory ignored prefix scan (plan) | ~544ms | ~161ms | **3.4×** |
| 5,000×5,000 manifest integrity verify | ~610ms | ~7ms | **87×** |

#### Key enablers

- **Manifest context batching** (`SnapshotStore.readBlobs`): one manifest read and full revalidation serves all blob fetches per operation instead of one manifest load per blob. 2,000-file pack creation dropped from 10.5s to 796ms.
- **Blob read batch sizing** (`BLOB_BATCH_MAX_ENTRIES`: 256 → 2,048): 40 `cat-file --batch` processes collapsed to 6 for 5,000 files by letting the 16MiB byte budget drive batch boundaries.
- **Path overlap indexing** (`pathSetsOverlap` in `path-safety.ts`): sorted binary search plus ancestor enumeration replaces a nested `some()` pattern. 8,000×8,000 path pairs from 1.35s to 7ms.
- **Ignored-proof prefix index** (`IgnoredProofIndex` in `restore-engine.ts`): lazily sorted binary lower-bound search for directory prefix lookups replaces a full-set spread per candidate. 4,000 directories from 544ms to 161ms.
- **WAL ordinal indexing** (`loadOrdinal` in `mutation-journal.ts`): direct array access by contiguous ordinal replaces linear `.find()` throughout quarantine and legacy recovery.
- **Native Rust no-clobber helper** (`native/pi-undo-fs`): platform native hardlink operations with EEXIST guard. Processes in ~0.3ms per file vs ~5.3ms for the TypeScript fallback, with WAL materialized from the durable pack.

## License

[MIT](LICENSE)
