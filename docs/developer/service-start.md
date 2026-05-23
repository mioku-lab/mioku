# 开发服务入门

## 命名规范

Mioku 中对服务命名的要求

- npm 包名：`mioku-service-name`
- 服务目录：`packages/mioku-service-name/`
- 在插件里读取的服务名：`name`

例如你要写一个 Git 仓库管理服务

- npm 包名：`mioku-service-gitrepo`
- 服务目录：`packages/mioku-service-gitrepo/`
- 在插件里读取：`ctx.services?.gitrepo`

## 服务目录结构

一个基础服务，至少需要这两个文件

```text
packages/mioku-service-gitrepo/
  index.ts
  package.json
```

如果服务逻辑比较复杂，也可以继续拆出 `types.ts`、`utils.ts` 或更多模块

## 开始编写一个服务

下面以 `gitrepo` 服务为例

```bash
mkdir -p packages/mioku-service-gitrepo
cd packages/mioku-service-gitrepo
```

新建 `package.json`

写入下面这份配置

```json
{
  "name": "mioku-service-gitrepo",
  "version": "1.0.0",
  "description": "Git 仓库管理服务",
  "main": "index.ts",
  "type": "module",
  "keywords": ["mioku"],
  "repository": {
    "type": "git",
    "url": "https://github.com/yourname/mioku-service-gitrepo.git"
  },
  "peerDependencies": {
    "mioku": "^0.8.0",
    "mioki": "^0.16.0"
  }
}
```

`package.json` 常用字段如下

| 字段            | 类型       | 必填 | 说明                          |
|---------------|----------|----|-----------------------------|
| `name`        | `string` | ✅  | 推荐使用 `mioku-service-<name>` |
| `version`     | `string` | ✅  | 服务版本号                       |
| `description` | `string` | ❌  | 服务描述                        |
| `main`        | `string` | ✅  | 服务入口文件，一般写 `index.ts`       |
| `type`        | `string` | ✅  | 必须为 `module`               |
| `peerDependencies` | `object` | ✅  | 必须依赖 `mioku` 和 `mioki`   |

## 编写 `index.ts`

下面这个例子实现了一个 Git 仓库管理服务，对外暴露

- `status()`：读取仓库状态
- `fetch()`：抓取远程更新
- `pull()`：拉取并合并远程更新

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { logger } from "mioki";
import type { MiokuService } from "mioku";

const execFileAsync = promisify(execFile);

export interface GitRepoServiceAPI {
  status(repoPath: string): Promise<{
    branch: string;
    clean: boolean;
    output: string;
  }>;
  fetch(repoPath: string, remote?: string): Promise<{
    success: boolean;
    output: string;
  }>;
  pull(repoPath: string, remote?: string, branch?: string): Promise<{
    success: boolean;
    output: string;
  }>;
}

function resolveRepoPath(repoPath: string): string {
  return path.resolve(process.cwd(), repoPath);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

const gitrepoService: MiokuService = {
  name: "gitrepo",
  version: "1.0.0",
  description: "Git 仓库管理服务",
  api: {} as GitRepoServiceAPI,

  async init() {
    this.api = {
      async status(repoPath: string) {
        const cwd = resolveRepoPath(repoPath);
        const branch = await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd,
        );
        const output = await runGit(["status", "--short", "--branch"], cwd);

        return {
          branch: branch.trim(),
          clean: !output
            .split("\n")
            .some((line) => line.trim() && !line.startsWith("##")),
          output,
        };
      },

      async fetch(repoPath: string, remote = "origin") {
        const cwd = resolveRepoPath(repoPath);
        const output = await runGit(["fetch", remote], cwd);
        return {
          success: true,
          output,
        };
      },

      async pull(repoPath: string, remote = "origin", branch?: string) {
        const cwd = resolveRepoPath(repoPath);
        const currentBranch =
          branch ||
          (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();

        const output = await runGit(
          ["pull", remote, currentBranch],
          cwd,
        );

        return {
          success: true,
          output,
        };
      },
    };

    logger.info("gitrepo-service 已就绪");
  },
};

export default gitrepoService;
```

## `MiokuService` 字段说明

服务通过一个普通对象导出，核心接口如下：

```typescript
import type { MiokuService } from "mioku";

const service: MiokuService = {
  name: "demo",
  version: "1.0.0",
  description: "示例服务",
  api: {} as DemoServiceAPI,
  async init() {},
  async dispose() {},
};
```

字段说明如下

| 字段            | 类型                    | 必填 | 说明               |
|---------------|-----------------------|----|------------------|
| `name`        | `string`              | ✅  | 服务唯一标识，应与服务目录名一致 |
| `version`     | `string`              | ✅  | 服务版本号            |
| `description` | `string`              | ❌  | 服务描述信息           |
| `api`         | `Record<string, any>` | ✅  | 对插件暴露的 API       |
| `init`        | `function`            | ✅  | 服务初始化函数          |
| `dispose`     | `function`            | ❌  | 服务卸载时的清理逻辑       |

## 服务是如何被发现的

Mioku 使用 `npx mioku` 命令或 WebUI 安装服务后，会自动从 `node_modules` 发现服务。

## 在插件里使用服务

服务写好以后，插件先在 `package.json` 里声明依赖：

```json
{
  "peerDependencies": {
    "mioku": "^0.8.0",
    "mioki": "^0.16.0",
    "mioku-service-gitrepo": "^1.0.0"
  }
}
```

然后在 `mioku.services` 中声明：

```json
{
  "mioku": {
    "services": ["gitrepo"]
  }
}
```

然后在 `index.ts` 里读取它：

```typescript
import { definePlugin } from "mioki";
import type { GitRepoServiceAPI } from "mioku-service-gitrepo";

export default definePlugin({
  name: "repo-admin",
  async setup(ctx) {
    const gitrepo = ctx.services?.gitrepo as GitRepoServiceAPI | undefined;
  },
});
```

使用示例

```typescript
import { definePlugin } from "mioki";
import type { GitRepoServiceAPI } from "mioku-service-gitrepo";

export default definePlugin({
  name: "repo-admin",
  async setup(ctx) {
    const gitrepo = ctx.services?.gitrepo as GitRepoServiceAPI | undefined;
    if (!gitrepo) {
      ctx.logger.warn("gitrepo-service 未加载");
      return;
    }

    ctx.handle("message", async (event) => {
      const text = ctx.text(event).trim();

      if (!text.startsWith("/仓库更新 ")) {
        return;
      }

      if (!ctx.isOwner(event)) {
        return;
      }

      const repoPath = text.slice("/仓库更新 ".length).trim();
      if (!repoPath) {
        await event.reply("请提供仓库路径");
        return;
      }

      const status = await gitrepo.status(repoPath);
      if (!status.clean) {
        await event.reply(
          `仓库有未提交改动，已取消拉取：\n${status.output}`,
        );
        return;
      }

      const result = await gitrepo.pull(repoPath);
      await event.reply(result.output || "拉取完成");
    });
  },
});
```