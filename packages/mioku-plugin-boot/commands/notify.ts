import type { AIService, MiokiContext } from "mioku";

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function replyNotice(options: {
  ctx: MiokiContext;
  event: any;
  instruction: string;
  fallbackMessage: string;
  error?: unknown;
}): Promise<void> {
  const { ctx, event, instruction, fallbackMessage, error } = options;
  if (error != null) {
    ctx.logger.error(
      `[boot] ${instruction}\n执行错误: ${normalizeErrorMessage(error)}`,
    );
  }

  const aiService = ctx.services?.ai as AIService | undefined;
  const chatRuntime = aiService?.getChatRuntime();
  if (chatRuntime) {
    try {
      const lines = [instruction];
      if (error != null) {
        lines.push(`执行错误: ${normalizeErrorMessage(error)}`);
      }
      await chatRuntime.generateNotice({
        event,
        instruction: lines.join("\n"),
        send: true,
      });
      return;
    } catch (noticeError) {
      ctx.logger.error(`boot notice failed: ${noticeError}`);
    }
  }

  await event.reply(fallbackMessage, true);
}

export function replyText(event: any, text: string): Promise<void> {
  return event.reply(text, true);
}
