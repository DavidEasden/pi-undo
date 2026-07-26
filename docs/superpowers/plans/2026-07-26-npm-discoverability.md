# npm Discoverability 0.1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布带有精准搜索关键词的 `@davideasden/pi-undo@0.1.1`。

**Architecture:** 仅更新 npm 包元数据：`package.json` 是关键词与版本的来源，`package-lock.json` 保持根包版本一致。功能代码、依赖和 Pi manifest 均不变。

**Tech Stack:** npm、JSON、Vitest、TypeScript。

---

## 文件结构

- Modify: `package.json` — 更新版本与 npm 搜索关键词。
- Modify: `package-lock.json` — 同步根包版本。
- Create: `docs/superpowers/plans/2026-07-26-npm-discoverability.md` — 记录实施与验证步骤。

### Task 1: 更新发布元数据

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 更新版本与关键词**

将版本设置为 `0.1.1`，将 `keywords` 设置为：

```json
["pi-package", "pi-agent", "pi-extension", "undo", "redo", "workspace-history", "coding-agent"]
```

- [ ] **Step 2: 验证 JSON 元数据一致**

Run: `node -e 'const p=require("./package.json"),l=require("./package-lock.json"); if(p.version!=="0.1.1"||l.version!==p.version||l.packages[""].version!==p.version) process.exit(1); console.log(p.version,p.keywords.join(","))'`

Expected: 输出 `0.1.1` 和七个预期关键词，退出码为 0。

### Task 2: 完整验证并提交

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`

- [ ] **Step 1: 运行完整测试**

Run: `npm test`

Expected: 所有测试通过。

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码为 0。

- [ ] **Step 3: 运行打包预检**

Run: `npm run pack:dry-run`

Expected: 包版本为 `0.1.1`，不含 `resources/`、测试或本地 tarball。

- [ ] **Step 4: 提交并推送**

```bash
git add package.json package-lock.json docs/superpowers/plans/2026-07-26-npm-discoverability.md
git commit -m "chore: improve npm package discoverability"
git push origin main
```

Expected: `origin/main` 指向新提交。

### Task 3: 发布并回读 npm 元数据

**Files:**
- Publish: `@davideasden/pi-undo@0.1.1`

- [ ] **Step 1: 使用临时认证配置发布**

Run: `npm publish --access public --registry=https://registry.npmjs.org/`

Expected: 输出 `+ @davideasden/pi-undo@0.1.1`。认证信息只写入权限受限的临时 npmrc，并在进程退出时删除。

- [ ] **Step 2: 从官方 registry 回读结果**

Run: `npm view @davideasden/pi-undo name version keywords dist-tags dist.tarball --json --registry=https://registry.npmjs.org/`

Expected: `version` 和 `latest` 均为 `0.1.1`，关键词与 Task 1 一致。
