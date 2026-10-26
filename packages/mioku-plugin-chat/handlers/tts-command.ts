import type { MessageEvent } from "mioku";
import type { ChatPluginContext } from "../context";
import { detectAudioLanguage as detectLang, sendVoice } from "../core/media/audio";

export async function handleTtsCommand(
  pluginCtx: ChatPluginContext,
  e: MessageEvent,
  payload: string,
): Promise<void> {
  const { ctx } = pluginCtx;

  const text = String(payload || "").trim();
  if (!text) {
    await e.reply("用法: /tts <要合成的文本>");
    return;
  }

  const audioService = pluginCtx.audioService;
  if (!audioService) {
    await e.reply("audio 服务未加载，请安装 mioku-service-audio 后重启");
    return;
  }

  const isReady = await audioService.ready().catch(() => false);
  if (!isReady) {
    ctx.logger.warn(
      `[tts-cmd] audio 未就绪 status=${JSON.stringify(audioService.getStatus?.())}`,
    );
    await e.reply("audio 服务正在启动/失败，请稍后再试");
    return;
  }

  ctx.logger.info(
    `[tts-cmd] 推理: "${text.slice(0, 40)}" lang=${detectLang(text)}`,
  );

  let result;
  try {
    result = await audioService.generateByText({
      text,
      textLang: detectLang(text),
      mediaType: "wav",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[tts-cmd] 推理失败: ${message}`);
    await e.reply(`TTS 推理失败: ${message}`);
    return;
  }

  if (!result?.filePath) {
    await e.reply("TTS 推理未返回音频文件");
    return;
  }

  ctx.logger.info(`[tts-cmd] 发送 -> ${result.filePath}`);
  await sendVoice(ctx, e, result.filePath, "[tts-cmd]");
}
