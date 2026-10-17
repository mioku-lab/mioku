#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import consola from "consola";

import type { ConfirmPromptOptions, TextPromptOptions } from "consola";

type ConfirmOpts = Omit<ConfirmPromptOptions, "type" | "required"> & {
  required?: boolean;
};
type TextOpts = Omit<TextPromptOptions, "type" | "required"> & {
  required?: boolean;
};

const confirm = async (
  message: string,
  options?: ConfirmOpts,
): Promise<boolean> =>
  (await consola.prompt(message, {
    type: "confirm",
    cancel: "reject",
    ...options,
  })) as boolean;

const input = async (message: string, options?: TextOpts): Promise<string> => {
  let result: string;
  do {
    result = (await consola.prompt(message, {
      type: "text",
      cancel: "reject",
      ...options,
    })) as string;
    if (options?.required && !result) continue;
    break;
  } while (true);
  return result;
};

const select = <T extends string>(
  message: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> =>
  consola.prompt(message, {
    type: "select",
    cancel: "reject",
    options,
  }) as Promise<T>;

export interface OneBotCliContext {
  readonly cwd: string;
  readonly logger?: typeof consola;
}

/** 正向连接实例:适配器主动连接 OneBot 实现 */
export interface OneBotInstanceInput {
  protocol: "ws" | "wss";
  host: string;
  port: number;
  token?: string;
  reconnect: boolean;
}

/** 反向连接服务器:适配器监听端口,OneBot 实现主动接入(最多一个) */
export interface OneBotServerInput {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  path: string;
  token?: string;
}

export interface OneBotCliConfig {
  instances: OneBotInstanceInput[];
  server: OneBotServerInput;
}

const askServerConfig = async (): Promise<OneBotServerInput> => {
  const portRaw = await input("反向服务器监听端口", {
    default: "3939",
    placeholder: "3939",
  });
  const hostRaw = await input("监听地址", {
    default: "0.0.0.0",
    placeholder: "0.0.0.0",
  });
  const pathRaw = await input("WebSocket 路径", {
    default: "/onebot/v11/ws",
    placeholder: "/onebot/v11/ws",
  });
  const token = await input("访问令牌 (建议设置,可空)", { placeholder: "可空" });

  const server: OneBotServerInput = {
    enabled: true,
    listenHost: hostRaw || "0.0.0.0",
    listenPort: Number(portRaw) || 3939,
    path: pathRaw || "/onebot/v11/ws",
    token: token || "",
  };
  return server;
};

const askClientInstance = async (): Promise<OneBotInstanceInput> => {
  const protocol = await select("连接协议", [
    { label: "ws (未加密)", value: "ws" as const },
    { label: "wss (加密)", value: "wss" as const },
  ]);
  const hostRaw = await input("NapCat 主机地址", {
    default: "localhost",
    placeholder: "localhost",
  });
  const host = hostRaw || "localhost";
  const portRaw = await input("NapCat 端口", {
    default: "3001",
    placeholder: "3001",
  });
  const port = Number(portRaw) || 3001;
  const token = await input("访问令牌 (可空)", { placeholder: "可空" });
  const reconnect = await confirm("断线自动重连？", { initial: true });

  const instance: OneBotInstanceInput = {
    protocol: protocol === "wss" ? "wss" : "ws",
    host,
    port,
    reconnect,
  };
  if (token) instance.token = token;
  return instance;
};

export const run = async (ctx: OneBotCliContext): Promise<OneBotCliConfig> => {
  const log = ctx.logger ?? consola;
  log.info(`正在配置 onebotv11 适配器连接参数`);
  log.info("");

  while (true) {
    // 无论是否启用,都写入完整的默认 server 配置
    let server: OneBotServerInput = {
      enabled: false,
      listenHost: "0.0.0.0",
      listenPort: 3939,
      path: "/onebot/v11/ws",
      token: "",
    };
    const instances: OneBotInstanceInput[] = [];

    const enableServer = await confirm(
      "是否启用反向连接服务器（OneBot 实现主动接入,最多一个）？",
      { initial: false },
    );
    if (enableServer) server = await askServerConfig();

    const addClients = await confirm("是否添加正向连接 bot（适配器主动连接 NapCat）？", {
      initial: true,
    });
    if (addClients) {
      let addMore = true;
      while (addMore) {
        instances.push(await askClientInstance());
        addMore = await confirm("是否继续添加连接实例？", { initial: false });
        if (addMore) log.info("");
      }
    }

    if (!server.enabled && instances.length === 0) {
      log.warn("至少需要启用反向连接服务器或添加一个正向连接 bot");
      log.info("");
      continue;
    }
    return { instances, server };
  }
};

const isRunningAsMain = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};

if (isRunningAsMain()) {
  void (async () => {
    const cwd = process.cwd();
    const pkgPath = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgPath)) {
      consola.error("未找到 package.json，请在机器人项目根目录运行此向导");
      process.exit(1);
    }
    const config = await run({ cwd });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      mioku?: Record<string, unknown>;
    };
    pkg.mioku = pkg.mioku ?? {};
    const adapters =
      (pkg.mioku.adapters as Record<string, unknown> | undefined) ?? {};
    pkg.mioku.adapters = { ...adapters, onebotv11: config };
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    consola.success("已写入 onebotv11 适配器配置");
  })();
}

export default run;
