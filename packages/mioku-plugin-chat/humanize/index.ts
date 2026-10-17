export { EmojiAgent } from "./emoji-agent";
export { EmotionAgent } from "./emotion-agent";
export { MemoryRetrieval } from "./memory";
export { TopicTracker } from "./topic";
export { ActionPlanner } from "./planner";
export { ExpressionLearner } from "./expression";
export { pickReplyStyle } from "./utils";

import type { AIInstance } from "mioku";
import type { ChatDatabase } from "../db";
import type { ChatConfig } from "../types";
import { EmotionAgent } from "./emotion-agent";
import { EmojiAgent } from "./emoji-agent";
import { MemoryRetrieval } from "./memory";
import { TopicTracker } from "./topic";
import { ActionPlanner } from "./planner";
import { ExpressionLearner } from "./expression";

export type ChatConfigProvider = (groupId?: string) => ChatConfig;

export class HumanizeEngine {
  readonly memoryRetrieval: MemoryRetrieval;
  readonly topicTracker: TopicTracker;
  readonly actionPlanner: ActionPlanner;
  readonly emotionAgent: EmotionAgent;
  readonly emojiAgent: EmojiAgent;
  readonly expressionLearner: ExpressionLearner;

  constructor(
    workAI: AIInstance,
    db: ChatDatabase,
    configProvider: ChatConfigProvider,
  ) {
    this.memoryRetrieval = new MemoryRetrieval(workAI, configProvider, db);
    this.topicTracker = new TopicTracker(workAI, configProvider, db);
    this.actionPlanner = new ActionPlanner(workAI, configProvider);
    this.emotionAgent = new EmotionAgent(workAI, configProvider);
    this.emojiAgent = new EmojiAgent(workAI, configProvider);
    this.expressionLearner = new ExpressionLearner(workAI, configProvider, db);
  }

  async init(): Promise<void> {
    // emojiAgent 不需要初始化，它直接从文件系统读取
  }
}
