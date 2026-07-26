# npm 可发现性与 0.1.1 发布设计

## 目标

提升 `@davideasden/pi-undo` 在 npm 和 Pi 相关搜索中的可发现性，同时保留 Pi 0.80.10 包画廊要求的 `pi-package` 关键词。

## 变更范围

- 将包版本从 `0.1.0` 升级为 `0.1.1`。
- 将 `keywords` 设置为：`pi-package`、`pi-agent`、`pi-extension`、`undo`、`redo`、`workspace-history`、`coding-agent`。
- 同步更新 `package-lock.json` 中对应的包版本和元数据。
- 不修改扩展实现、运行时依赖或 Pi 清单。

## 验证与发布

依次执行完整测试、TypeScript 类型检查和 npm 打包预检，确认发布包不包含 `resources/`、测试或本地 tarball。验证通过后提交并推送元数据变更，再将公开包 `@davideasden/pi-undo@0.1.1` 发布到 npm。

发布后从 npm 官方 registry 回读 `version`、`dist-tags` 和 `keywords`。如果发布失败，保留 Git 提交和已推送源码，不重复发布同一版本；查明失败原因后再决定是否重试或升级版本。
