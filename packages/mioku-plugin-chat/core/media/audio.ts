import { readFile } from "node:fs/promises";
import type { MessageEvent, MiokuContext } from "mioku";
import type { AudioServiceApi, SupportedLang } from "mioku-service-audio";

export function detectAudioLanguage(text: string): SupportedLang {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  return "en";
}

export async function synthesizeAudioSource(
  audioService: AudioServiceApi | undefined,
  text: string,
): Promise<string | null> {
  const trimmed = String(text || "").trim();
  if (!audioService) return null;
  if (!trimmed) return null;

  const isReady = await audioService.ready().catch(() => false);
  if (!isReady) return null;

  const result = await audioService.generateByText({
    text: trimmed,
    textLang: detectAudioLanguage(trimmed),
    mediaType: "wav",
  });

  if (!result?.filePath) return null;
  const filePath = result.filePath.replace(/^file:\/\//, "");
  const buf = await readFile(filePath);
  return `base64://${buf.toString("base64")}`;
}

export async function sendVoice(
  ctx: MiokuContext,
  e: Pick<MessageEvent, "reply">,
  filePath: string,
  logTag = "[audio]",
): Promise<void> {
  const fileUrl = filePath.startsWith("file://")
    ? filePath
    : `file://${filePath}`;
  try {
    await e.reply([ctx.segment.raw("record", { file: fileUrl })]);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !/File URL path must be absolute|ENOENT|cannot access|No such file/i.test(
        msg,
      )
    ) {
      throw err;
    }
    const localPath = filePath.replace(/^file:\/\//, "");
    const buf = await readFile(localPath);
    const b64 = `base64://${buf.toString("base64")}`;
    ctx.logger.info(
      `${logTag} file:// 发送失败 (${msg})，回退 base64 (${buf.length} bytes)`,
    );
    await e.reply([ctx.segment.raw("record", { file: b64 })]);
  }
}
