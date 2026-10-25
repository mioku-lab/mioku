import type { AIInstance, Bot, PlatformId } from "mioku";
import type { ChatConfig } from "../../types";
import { segField, segTop, segUrl } from "../../utils/segment";
import {
  getSegmentSourceCandidates,
  type HistoryMediaProcessingOptions,
} from "./history-media";

export { getSegmentSourceCandidates };

/** 媒体摘要用到的工作模型 */
export function mediaModelsOf(
  config: ChatConfig,
): Pick<HistoryMediaProcessingOptions, "workingModel" | "multimodalWorkingModel"> {
  return {
    workingModel: config.workingModel || config.model,
    multimodalWorkingModel: config.multimodalWorkingModel || config.model,
  };
}

export function createMediaProcessingOptions(
  ai: AIInstance,
  config: ChatConfig,
  rest: Omit<
    HistoryMediaProcessingOptions,
    "ai" | "workingModel" | "multimodalWorkingModel"
  >,
): HistoryMediaProcessingOptions {
  return { ai, ...mediaModelsOf(config), ...rest };
}

export function getSegmentUrl(seg: unknown): string | null {
  const url = segUrl(seg)?.trim();
  return url || null;
}

export async function getVideoSourceCandidatesFromMessage(
  bot: Bot | undefined,
  messageId: PlatformId | undefined,
): Promise<string[]> {
  if (messageId == null || !bot) return [];
  const result = await bot.getMessage(messageId);
  const segments: unknown = result?.message;
  if (!Array.isArray(segments)) return [];
  const candidates: string[] = [];
  for (const seg of segments) {
    if (segTop(seg, "type") !== "video") continue;
    candidates.push(...getSegmentSourceCandidates(seg));
  }
  return candidates;
}

export function getForwardId(seg: unknown): string {
  return String(segField(seg, "id") || "");
}

export function getCardData(seg: { data?: unknown }): string | null {
  const data = seg.data;
  if (!data) return null;
  return typeof data === "string" ? data : JSON.stringify(data);
}

export function isMediaAnalysisBlocked(
  config: ChatConfig,
  userId: string,
): boolean {
  return Boolean(config.mediaAnalysisBlacklistUsers?.includes(userId));
}
