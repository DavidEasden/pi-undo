# English README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current README with an accurate English guide for installing, using, understanding, and developing `@davideasden/pi-undo`.

**Architecture:** Keep all public documentation in one progressive README. Put user-facing installation and commands first, then explain persistence and safety behavior, and finish with contributor setup and verification commands.

**Tech Stack:** Markdown, npm, Pi package manifest, TypeScript/Vitest development scripts.

---

## File Structure

- Modify: `README.md` — English user and contributor documentation.
- Create: `docs/superpowers/plans/2026-07-26-english-readme.md` — implementation and verification record.

### Task 1: Rewrite the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the introduction and user guide**

Write an English project summary followed by Features, Requirements, Installation, and Usage. Use these exact public commands:

```bash
pi install npm:@davideasden/pi-undo
pi install ./path/to/pi-undo
pi -e /absolute/path/to/pi-undo/extensions/pi-undo.ts
```

Document `/undo`, `/redo`, and Pi's native `/tree` behavior without introducing new commands.

- [ ] **Step 2: Add implementation and safety guidance**

Explain private snapshots under `<sessionDir>/.pi-undo/`, WAL recovery, quarantine/no-clobber restoration, external concurrency limits, Git metadata boundaries, ignored files, nested repositories, initialized submodules, and `recovery required` handling. State that users do not manage Git but must have Git installed.

- [ ] **Step 3: Add contributor workflow**

Document Node.js 22.19+, `npm install`, local Pi source expectations, and these exact scripts:

```bash
npm test
npm run test:watch
npm run test:integration
npm run typecheck
npm run pack:dry-run
```

End with the MIT license reference.

### Task 2: Verify documentation accuracy

**Files:**
- Verify: `README.md`
- Verify: `package.json`
- Verify: `extensions/pi-undo.ts`

- [ ] **Step 1: Check language and required sections**

Run: `rg -n '^## (Features|Requirements|Installation|Usage|How It Works|Safety and Recovery|Limitations|Development|Testing|License)$' README.md`

Expected: all ten headings are present.

- [ ] **Step 2: Check public commands against the implementation**

Run: `rg -n 'pi install npm:@davideasden/pi-undo|/undo|/redo|/tree|npm run test:integration|npm run typecheck|npm run pack:dry-run' README.md`

Expected: every supported install, usage, and development command is documented.

- [ ] **Step 3: Inspect the npm package**

Run: `npm run pack:dry-run`

Expected: the package contains `README.md`, `extensions/`, and `src/`, while excluding `resources/`, `test/`, and local tarballs.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git diff -- README.md`

Expected: no whitespace errors and no changes outside the agreed documentation scope.
