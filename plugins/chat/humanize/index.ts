export { EmojiAgent } from "./emoji-agent";
export { MemoryRetrieval } from "./memory";
export { TopicTracker } from "./topic";
export { ActionPlanner } from "./planner";
export { TypoGenerator } from "./typo";
export { ExpressionLearner } from "./expression";
export { pickReplyStyle, pickPersonalityState } from "./utils";

import type { AIInstance } from "../../../src/services/ai/types";
import type { ChatDatabase } from "../db";
import type { ChatConfig } from "../types";
import { EmojiAgent } from "./emoji-agent";
import { MemoryRetrieval } from "./memory";
import { TopicTracker } from "./topic";
import { ActionPlanner } from "./planner";
import { TypoGenerator } from "./typo";
import { ExpressionLearner } from "./expression";

export class HumanizeEngine {
  readonly memoryRetrieval: MemoryRetrieval;
  readonly topicTracker: TopicTracker;
  readonly actionPlanner: ActionPlanner;
  readonly typoGenerator: TypoGenerator;
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
    this.typoGenerator = new TypoGenerator(config);
    this.emojiAgent = new EmojiAgent(workAI, config, db);
    this.expressionLearner = new ExpressionLearner(workAI, config, db);
  }

  async init(): Promise<void> {
    // emojiAgent 不需要初始化，它直接从文件系统读取
  }
}
