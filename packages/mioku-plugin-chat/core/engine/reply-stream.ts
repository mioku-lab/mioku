import {
  consumeCompleteStreamUnits,
  isQuoteMarkerOnlyUnit,
} from "../media/markdown-message";
import { cleanStreamSegment, createThinkTagStreamFilter } from "./reply-text";

export interface ReplyStream {
  /** 模型的增量文本 */
  push(delta: string): Promise<void>;
  /** 模型输出结束，冲刷缓冲 */
  end(): Promise<void>;
  /** 已经发出的消息 */
  readonly sent: readonly string[];
}

/** 把流式增量切成完整的消息单元，每凑齐一条就交给 emit 发出 */
export function createReplyStream(
  emit: (text: string, unitIndex: number, sentIndex: number) => Promise<void>,
): ReplyStream {
  const thinkFilter = createThinkTagStreamFilter();
  const sent: string[] = [];
  let buffer = "";
  let unitIndex = 0;
  let pendingQuoteMarkers: string[] = [];

  const emitUnit = async (unit: string): Promise<void> => {
    const index = unitIndex++;
    const text = cleanStreamSegment(unit);
    if (!text || text === "---") return;
    await emit(text, index, sent.length);
    sent.push(text);
  };

  const flush = async (force: boolean): Promise<void> => {
    while (true) {
      const { units, rest } = consumeCompleteStreamUnits(buffer, force);
      buffer = rest;
      if (units.length === 0) break;

      for (const unit of units) {
        if (!unit.trim()) continue;
        // 单独一行的引用标记并到下一条
        if (isQuoteMarkerOnlyUnit(unit)) {
          pendingQuoteMarkers.push(unit.trim());
          continue;
        }
        const merged = pendingQuoteMarkers.length
          ? [...pendingQuoteMarkers, unit].join("\n")
          : unit;
        pendingQuoteMarkers = [];
        await emitUnit(merged);
      }

      if (!force) break;
    }
    if (force) pendingQuoteMarkers = [];
  };

  return {
    sent,
    async push(delta) {
      buffer += thinkFilter.push(delta, false);
      await flush(false);
    },
    async end() {
      buffer += thinkFilter.push("", true);
      await flush(true);
    },
  };
}
