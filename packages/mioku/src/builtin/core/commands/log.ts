import * as fs from "node:fs";
import * as path from "node:path";
import type { MiokuContext } from "../../../runtime/mioku-context";
import { replyText } from "./notify";

const LOG_LINE_COUNT = 100;
const LINES_PER_NODE = 20;

function getLogDir(): string {
  return path.join(process.cwd(), "logs");
}

function getActiveLogFile(): string | null {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) return null;
  let latest: { path: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const full = path.join(dir, entry.name);
    const mtime = fs.statSync(full).mtimeMs;
    if (!latest || mtime > latest.mtime) {
      latest = { path: full, mtime };
    }
  }
  return latest?.path ?? null;
}

function readLastLines(filePath: string, count: number): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-count);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export function registerLogCommand(ctx: MiokuContext): () => void {
  const dispose = ctx.command({
    name: "log",
    aliases: ["日志"],
    permission: "master",
    priority: -1000,
    description: "查看最近100条日志",
    handler: async ({ event }) => {
      if (event?.user_id === event?.self_id) return;

    const selfId = String(event?.self_id || "");
    const bot = event.bot;
    if (!bot) return;

    const logFile = getActiveLogFile();
    if (!logFile) {
      await replyText(event, "未找到日志文件。");
      return;
    }

    let lines: string[];
    try {
      lines = readLastLines(logFile, LOG_LINE_COUNT);
    } catch (error) {
      ctx.logger.error(`[core] 读取日志失败: ${error}`);
      await replyText(event, `读取日志失败：${String(error)}`);
      return;
    }
    if (lines.length === 0) {
      await replyText(event, "日志为空。");
      return;
    }

    let infoCount = 0;
    let warnCount = 0;
    let errorCount = 0;
    for (const line of lines) {
      if (/\bERROR\b|\berror\b/i.test(line)) {
        errorCount++;
      } else if (/\bWARN\b|\bwarn\b/i.test(line)) {
        warnCount++;
      } else if (/\bINFO\b|\binfo\b/i.test(line)) {
        infoCount++;
      }
    }
    const summary = `info ${infoCount} warn ${warnCount} error ${errorCount}`;

    const chunks = chunk(lines, LINES_PER_NODE);

    const nodes = chunks.map((chunkLines, idx) => ({
      user_id: selfId,
      nickname: `第${idx + 1}条日志`,
      content: [ctx.segment.text(chunkLines.join("\n"))],
    }));

    try {
      const target =
        event?.message_type === "group" && event?.group_id
          ? { type: "group" as const, group_id: event.group_id }
          : event?.user_id
            ? { type: "private" as const, user_id: event.user_id }
            : undefined;
      if (target) {
        await bot.sendForward(target, nodes, {
          source: "最近100条运行日志",
          summary,
        });
      }
    } catch (error) {
      ctx.logger.error(`[core] 发送日志转发失败: ${error}`);
      await replyText(event, `发送日志失败：${String(error)}`);
    }
    },
  });
  return dispose;
}
