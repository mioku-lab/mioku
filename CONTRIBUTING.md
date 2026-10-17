# 贡献指南

感谢你为 Mioku 贡献代码。请在提交前阅读本文。

## 分支模型

| 分支 | 作用 |
| --- | --- |
| `main` | 发布分支，只接受来自 `dev` 的合并 |
| `dev` | 集成分支，所有贡献的目标分支 |
| `feat/*` `fix/*` 等 | 个人工作分支，从 `dev` 拉出 |

## 贡献流程

1. Fork 本仓库（维护者可直接在仓库内建分支）。
2. 从最新的 `dev` 拉出工作分支，例如 `feat/help-search`。
3. 完成开发并在本地验证。
4. 向 `dev` 提交 Pull Request，**不要**直接向 `main` 提交。
5. CI 通过并经维护者审查后合并。

一个 PR 只做一件事，改动尽量小，便于审查与回滚。

## 本地开发

环境要求：Node.js >= 22.18.0，使用 [Bun](https://bun.sh) 管理依赖。

```bash
bun install
bun run start
```

类型检查与构建在 `packages/mioku` 下执行，与 CI 保持一致：

```bash
cd packages/mioku
bun run typecheck
bun run build
```

项目目前没有测试套件，请通过实际运行验证改动。开发插件、服务、适配器之前，请先按 [AGENTS.md](./AGENTS.md) 安装开发技能。

## 提交信息

格式：`<type>(<scope>): <描述>`，scope 可省略。

- type 取值：`feat`、`fix`、`perf`、`refactor`、`docs`、`style`、`test`、`chore`、`build`、`ci`、`revert`
- 描述简短，冒号后加一个空格，末尾不加句号
- 示例：`fix(help): 修复帮助插件的分页错误`

## 代码风格

- 遵循 `mioku-code-style` 技能中的约定
- 注释只在逻辑确实不直观时添加，保持简短
- 提交前在 `packages/mioku` 下运行 `bun run typecheck`，确保无类型错误

## 持续集成

每次推送和每个 Pull Request 都会对 `packages/mioku` 运行 CI：安装依赖、类型检查、构建。CI 未通过的 PR 不会被合并。

## 发布与分支同步

维护者将 `dev` 合并到 `main` 完成发布。每次合并后，`main` 会由工作流自动合并回 `dev`，保持两个分支历史一致。若自动合并出现冲突，工作流会失败，维护者需手动解决：

```bash
git checkout dev
git merge origin/main
git push origin dev
```

## 独立仓库

适配器等生态包可以放在独立仓库中（如 `mioku-adapter-*`），也可以收录到 `official-registry.json`。独立仓库请自行维护发布流程，并在 `peerDependencies` 中声明兼容的 Mioku 版本。
