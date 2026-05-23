export const BASE_CONFIG = {
  apiUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gemini-3.0-flash-preview",
  workingModel: "deepseek/deepseek-v3.2-exp", // 工作模型，用于 planner 等轻量任务
  multimodalWorkingModel: "doubao-seed-2.0-mini", // 多模态工作模型，用于图片描述等任务
  isMultimodal: true,
  maxContextTokens: 128,
  temperature: 0.8,
  historyCount: 100, // 群聊历史消息数量
  maxIterations: 20, // AI 迭代次数限制，-1 表示不限制
};
