import * as fs from "node:fs";
import * as path from "node:path";
import { type MiokiContext, isOwner } from "mioki";
import { getCommandPrefix } from "./prefix";
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

export function registerLogCommand(ctx: MiokiContext): () => void {
  const dispose = ctx.handle("message", async (event: any) => {
    const text = ctx.text(event)?.trim();
    if (!text || event?.user_id === event?.self_id) return;
    const prefix = getCommandPrefix();
    if (text !== `${prefix}日志` && text !== `${prefix}log`) return;

    if (!isOwner(event)) {
      ctx.logger.warn("[boot] 日志指令仅主人可用");
      return;
    }

    const selfId = Number(event?.self_id || 0);
    const bot = ctx.pickBot(selfId);
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
      ctx.logger.error(`[boot] 读取日志失败: ${error}`);
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
    const normalize = (elements: any[]): any[] => {
      if (typeof bot?.normalizeSendable === "function") {
        return bot.normalizeSendable(elements);
      }
      return elements.map((element: any) => {
        if (
          element &&
          typeof element === "object" &&
          "type" in element &&
          "data" in element
        ) {
          return element;
        }
        if (element && typeof element === "object" && "type" in element) {
          const { type, ...data } = element;
          return { type, data };
        }
        return element;
      });
    };

    const messages = chunks.map((chunkLines, idx) => ({
      type: "node",
      data: {
        user_id: String(selfId),
        nickname: `第${idx + 1}条日志`,
        content: normalize([ctx.segment.text(chunkLines.join("\n"))]),
      },
    }));

    try {
      if (event?.message_type === "group" && event?.group_id) {
        await bot.api("send_group_forward_msg", {
          group_id: event.group_id,
          messages,
          source: "最近100条运行日志",
          summary,
        });
      } else if (event?.user_id) {
        await bot.api("send_private_forward_msg", {
          user_id: event.user_id,
          messages,
          source: "最近100条运行日志",
          summary,
        });
      }
    } catch (error) {
      ctx.logger.error(`[boot] 发送日志转发失败: ${error}`);
      await replyText(event, `发送日志失败：${String(error)}`);
    }
  });
  return dispose;
}
