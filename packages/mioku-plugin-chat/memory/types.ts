/** 一条群聊记忆：原子、可独立理解、尽量带细节与原话 */
export type MemoryKind =
  | "fact"
  | "event"
  | "preference"
  | "promise"
  | "relation"
  | "plan"
  | "health"
  | "other";

export interface MemoryItem {
  id?: number;
  groupId: string;
  /** 这条记忆关于谁；群级记忆（约定、群事件）留空 */
  userId?: string;
  userName?: string;
  kind: MemoryKind;
  /** 一句完整、具体的中文陈述，包含时间/地点/人物/数字等细节 */
  content: string;
  /** 前后经过或补充上下文，可空 */
  detail?: string;
  /** 原话摘录，可空；用于还原语气与措辞 */
  quote?: string;
  importance: number;
  confidence: number;
  sourceMessageIds: string[];
  windowStartAt?: number;
  windowEndAt?: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 群员轮廓：滚动合并的长期印象，不存逐条消息 */
export interface MemberProfile {
  groupId: string;
  userId: string;
  name: string;
  aliases: string[];
  traits: string[];
  habits: string[];
  topics: string[];
  relations: string[];
  note: string;
  messagesSeen: number;
  /** 上次重画画像时的 messagesSeen，用来判断是否需要再更新 */
  profileSeen: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryWindowRecord {
  groupId: string;
  windowStartAt: number;
  windowEndAt: number;
  status: "ok" | "skipped" | "failed";
  itemCount: number;
  updatedAt: number;
}

/** 工作模型抽取出来的一条候选记忆 */
export interface ExtractedMemory {
  about?: string;
  aboutName?: string;
  kind: MemoryKind;
  content: string;
  detail?: string;
  quote?: string;
  importance: number;
  confidence: number;
  messageIds: string[];
}

export interface MemoryStats {
  items: number;
  profiles: number;
  groups: number;
  profileGroups: number;
  lastItemAt: number;
}

export interface MemoryStatus extends MemoryStats {
  enabled: boolean;
  vectorReady: boolean;
  buffered: number;
  bufferGroups: number;
  injected: number;
  cacheEntries: number;
  lastExtractAt: number;
  lastError: string;
}

/** 群聊记忆配置（chat/memory） */
export interface MemoryConfig {
  /** 总开关：关闭后既不抽取也不注入 */
  enabled: boolean;
  /** 抽取用哪个模型角色 */
  extractModel: "working" | "main";
  /** 缓冲区最长等待多久必须抽取一次（分钟） */
  windowMinutes: number;
  /** 窗口内少于这么多条消息就继续攒着 */
  minMessagesPerWindow: number;
  /** 每群缓冲区上限，超过先丢最旧的 */
  maxBufferMessages: number;
  /** 定时器检查间隔（毫秒） */
  extractIntervalMs: number;
  /** 单次送给模型的聊天记录字符上限 */
  maxCharsPerWindow: number;
  /** 低于该置信度的候选记忆直接丢弃 */
  minConfidence: number;
  /** 单群记忆条数上限，超出按重要性淘汰 */
  maxItemsPerGroup: number;
  /** 记忆保留时长（月），默认 3 */
  retentionMonths: number;
  /** 每轮注入多少条记忆 */
  injectTopK: number;
  /** 注入块字符预算 */
  injectMaxChars: number;
  /** 检索最低相关度（余弦）；低于它不算命中，字面命中不受此限 */
  minRelevance: number;
  /** 检索超时（毫秒），超时本轮不注入 */
  injectTimeoutMs: number;
  /** 群员轮廓开关 */
  profileEnabled: boolean;
  /** 每个成员每积累多少条消息更新一次轮廓 */
  profileUpdateEvery: number;
  /** 是否给模型暴露 recall_* 工具 */
  recallToolsEnabled: boolean;
  /** 每轮工具调用次数上限 */
  recallToolBudget: number;
  /** 工具默认回溯天数 */
  contextLookbackDays: number;
  /** 注入块缓存时长（毫秒），0 表示不缓存 */
  cacheTtlMs: number;
  /** 原文消息是否也入向量库（可选，代价是每条消息都要向量化） */
  indexMessages: boolean;
  /** 入向量的最短消息长度，太短的复读/表情会被跳过 */
  indexMessageMinChars: number;
  /** 原文索引保留天数 */
  indexMessageRetentionDays: number;
  /** 命中记忆后是否回查原文消息 */
  sourceTraceback: boolean;
  /** 每次回查几条原文 */
  sourceTracebackLimit: number;
}
