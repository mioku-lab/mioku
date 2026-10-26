export { EmojiAgent } from "./emoji-agent";
export { EmotionAgent } from "./emotion-agent";
export { TopicTracker } from "./topic";
export { ExpressionSampler } from "./style-samples";
export { pickReplyStyle } from "./utils";

import type { AIInstance } from "mioku";
import type { ChatConfigProvider } from "../types";
import type { ChatDatabase } from "../db";
import { EmojiAgent } from "./emoji-agent";
import { EmotionAgent } from "./emotion-agent";
import { TopicTracker } from "./topic";
import { ExpressionSampler } from "./style-samples";

export type { ChatConfigProvider };

/**
 * 拟人引擎
 * TODO(错别字模拟)
 * TODO(自我纠正)
 */
export class HumanizeEngine {
  readonly topicTracker: TopicTracker;
  readonly emotionAgent: EmotionAgent;
  readonly emojiAgent: EmojiAgent;
  readonly expressionSampler: ExpressionSampler;

  constructor(
    workAI: AIInstance,
    db: ChatDatabase,
    configProvider: ChatConfigProvider,
  ) {
    this.topicTracker = new TopicTracker(workAI, configProvider, db);
    this.emotionAgent = new EmotionAgent(workAI, configProvider);
    this.emojiAgent = new EmojiAgent(workAI, configProvider);
    this.expressionSampler = new ExpressionSampler(db, configProvider);
  }

  async init(): Promise<void> {
    // emojiAgent 直接从文件系统读取，不需要初始化
  }
}
