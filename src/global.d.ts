/**
 * 全局类型定义
 * 这些类型在整个 mioku 项目中可用
 */

declare global {
  // 文字消息类型
  interface TextMessage {
    role: "system" | "user" | "assistant";
    content: string;
  }

  // 多模态消息类型
  interface MultimodalMessage {
    role: "system" | "user" | "assistant";
    content:
      | string
      | Array<{
          type: "text" | "image_url";
          text?: string;
          image_url?: {
            url: string;
            detail?: "auto" | "low" | "high";
          };
        }>;
  }

  // AI 实例接口（文字/多模态/工具调用生成）
  interface AIInstance {
    // 文字生成
    generateText(options: {
      prompt?: string;
      messages: TextMessage[];
      model?: string;
      temperature?: number;
    }): Promise<string>;

    // 多模态生成
    generateMultimodal(options: {
      prompt?: string;
      messages: MultimodalMessage[];
      model?: string;
      temperature?: number;
    }): Promise<string>;

    // 带工具调用的生成
    generateWithTools(options: {
      prompt?: string;
      messages: TextMessage[] | MultimodalMessage[];
      model?: string;
      tools?: (string | import("./core/types").AITool)[];
      temperature?: number;
      maxIterations?: number;
    }): Promise<{
      content: string;
      iterations: number;
      allToolCalls: Array<{
        name: string;
        arguments: any;
        result: any;
      }>;
    }>;

    // 原始补全调用
    complete(options: {
      model?: string;
      messages: any[];
      tools?: any[];
      executableTools?: Array<{
        name: string;
        tool: import("./core/types").AITool;
      }>;
      temperature?: number;
      max_tokens?: number;
      maxIterations?: number;
      stream?: boolean;
      onTextDelta?: (delta: string) => void | Promise<void>;
    }): Promise<{
      content: string | null;
      reasoning: string | null;
      toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }>;
      raw: any;
      iterations?: number;
      turnMessages?: any[];
      allToolCalls?: Array<{
        name: string;
        arguments: any;
        result: any;
      }>;
    }>;

    // 注册提示词
    registerPrompt(name: string, prompt: string): boolean;

    // 获取提示词
    getPrompt(name: string): string | undefined;

    // 获取所有提示词
    getAllPrompts(): Record<string, string>;

    // 移除提示词
    removePrompt(name: string): boolean;
  }

  // AI 服务接口
  interface AIService {
    // 创建新的 AI 实例
    create(options: {
      name: string;
      apiUrl: string;
      apiKey: string;
      modelType: "text" | "multimodal";
    }): Promise<AIInstance>;

    // 获取已有实例
    get(name: string): AIInstance | undefined;

    // 获取所有实例名称
    list(): string[];

    // 删除实例
    remove(name: string): boolean;

    // 默认实例
    setDefault(name: string): boolean;
    getDefault(): AIInstance | undefined;

    // Chat Runtime
    registerChatRuntime(runtime: import("./services/ai").ChatRuntime): boolean;
    getChatRuntime(): import("./services/ai").ChatRuntime | undefined;
    removeChatRuntime(): boolean;

    // Skill 管理
    registerSkill(skill: import("./core/types").AISkill): boolean;
    getSkill(skillName: string): import("./core/types").AISkill | undefined;
    getAllSkills(): Map<string, import("./core/types").AISkill>;
    removeSkill(skillName: string): boolean;

    // 工具查询
    getTool(toolName: string): import("./core/types").AITool | undefined;
    getAllTools(): Map<string, import("./core/types").AITool>;

    // 使用统计
    getUsageSummary(options: {
      range: import("./services/ai/usage/types").AIUsageRange;
      botId?: number;
    }): import("./services/ai/usage/types").AIUsageSummary;
    cleanupUsageStats(retentionMs?: number): number;
    finalizeUsage(
      usageId: string,
      finalization: import("./services/ai/usage/types").AIUsageFinalization,
    ): boolean;
  }
}

export {};
