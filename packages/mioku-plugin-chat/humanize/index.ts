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

export class HumanizeEngine {
  readonly memoryRetrieval: MemoryRetrieval;
  readonly topicTracker: TopicTracker;
  readonly actionPlanner: ActionPlanner;
  readonly emotionAgent: EmotionAgent;
  readonly emojiAgent: EmojiAgent;
  readonly expressionLearner: ExpressionLearner;

  constructor(
    mainAI: AIInstance,
    workAI: AIInstance,
    config: ChatConfig,
    db: ChatDatabase,
  ) {
    this.memoryRetrieval = new MemoryRetrieval(workAI, config, db);
    this.topicTracker = new TopicTracker(workAI, config, db);
    this.actionPlanner = new ActionPlanner(workAI, config);
    this.emotionAgent = new EmotionAgent(workAI, config);
    this.emojiAgent = new EmojiAgent(workAI, config, db);
    this.expressionLearner = new ExpressionLearner(workAI, config, db);
  }

  async init(): Promise<void> {
    // emojiAgent 不需要初始化，它直接从文件系统读取
  }
}
