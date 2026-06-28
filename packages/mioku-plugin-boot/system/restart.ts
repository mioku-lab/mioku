import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { connectedBots, formatDuration, isInPm2, logger } from "mioki";
import { getPluginDataDir } from "mioku";

const RESTART_MARKER_PATH = path.join(getPluginDataDir("boot"), "restart.json");

export interface RestartMarker {
  initiatedAt: number;
  selfId: number;
  groupId: number | null;
  userId: number;
}

function ensureDataDir(): void {
  const dir = path.dirname(RESTART_MARKER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function writeRestartMarker(marker: RestartMarker): void {
  ensureDataDir();
  fs.writeFileSync(
    RESTART_MARKER_PATH,
    JSON.stringify(marker, null, 2),
    "utf-8",
  );
}

export function consumeRestartMarker(): RestartMarker | null {
  if (!fs.existsSync(RESTART_MARKER_PATH)) return null;
  try {
    const raw = fs.readFileSync(RESTART_MARKER_PATH, "utf-8");
    const parsed = JSON.parse(raw) as RestartMarker;
    fs.rmSync(RESTART_MARKER_PATH, { force: true });
    return parsed;
  } catch {
    fs.rmSync(RESTART_MARKER_PATH, { force: true });
    return null;
  }
}

function tempDir(): string {
  const dir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeRestartScript(): string {
  const cwd = process.cwd();
  const bun = process.execPath;
  const args = process.argv.slice(1);

  if (process.platform === "win32") {
    const scriptPath = path.join(tempDir(), "mioku-restart.bat");
    const quotedArgs = [bun, ...args].map((a) => `"${a}"`).join(" ");
    const content = [
      "@echo off",
      "ping -n 3 127.0.0.1 >nul",
      `cd /d "${cwd}"`,
      `start "mioku" ${quotedArgs}`,
      "del %~f0",
    ].join("\r\n");
    fs.writeFileSync(scriptPath, content, "utf-8");
    return scriptPath;
  }

  const scriptPath = path.join(tempDir(), "mioku-restart.sh");
  const execLine = [shellQuote(bun), ...args.map(shellQuote)].join(" ");
  const content = [
    "#!/usr/bin/env sh",
    "sleep 2",
    `cd ${shellQuote(cwd)} || exit 1`,
    `exec ${execLine}`,
  ].join("\n");
  fs.writeFileSync(scriptPath, content, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

export function cleanupStaleRestartScripts(): void {
  const dir = tempDir();
  for (const name of ["mioku-restart.sh", "mioku-restart.bat"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export function triggerRestart(marker: RestartMarker): void {
  writeRestartMarker(marker);

  if (isInPm2) {
    logger.info("[boot] 检测到 PM2 环境，退出进程后将由 PM2 自动重启");
    setTimeout(() => process.exit(0), 300);
    return;
  }

  const scriptPath = writeRestartScript();
  try {
    const child = spawn(
      process.platform === "win32" ? "cmd.exe" : "sh",
      process.platform === "win32" ? ["/c", scriptPath] : [scriptPath],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    logger.info(`[boot] 重启脚本已启动: ${scriptPath}`);
  } catch (error) {
    logger.error(`[boot] 启动重启脚本失败: ${error}`);
  }

  setTimeout(() => process.exit(0), 500);
}

export function formatUptime(ms: number): string {
  return formatDuration(ms);
}

async function waitForBot(timeoutMs = 60000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bots = Array.from(connectedBots.values());
    if (bots.length > 0) return bots[0];
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

export async function notifyRestartComplete(
  ctx: any,
  marker: RestartMarker,
): Promise<void> {
  const bot = await waitForBot();
  if (!bot) {
    logger.warn("[boot] 重启完成但未等到 bot 上线，跳过通知");
    return;
  }

  const duration = Date.now() - marker.initiatedAt;
  const message = `Bot重启成功！用时${formatDuration(duration)}`;

  try {
    if (marker.groupId) {
      await bot.sendGroupMsg(marker.groupId, [
        ctx?.segment?.text
          ? ctx.segment.text(message)
          : { type: "text", data: { text: message } },
      ]);
    } else if (marker.userId) {
      await bot.sendPrivateMsg(marker.userId, [
        ctx?.segment?.text
          ? ctx.segment.text(message)
          : { type: "text", data: { text: message } },
      ]);
    }
  } catch (error) {
    ctx?.logger?.error?.(`[boot] 发送重启完成通知失败: ${error}`);
  }
}
