import type { AITool } from "mioku";
import type { ToolContext } from "../../types";

/** 单轮工具预算：和联网工具一样按轮计数，防止模型反复重试 */
export interface MemoryToolBudget {
  readonly max: number;
  tryUse(): boolean;
}

export function createMemoryToolBudget(max: number): MemoryToolBudget {
  let used = 0;
  return {
    max,
    tryUse() {
      if (max > 0 && used >= max) return false;
      used++;
      return true;
    },
  };
}

function budgetExceeded(max: number) {
  return {
    success: false,
    error: `记忆检索次数已用完（本轮上限 ${max} 次），请直接用已有信息回答。`,
  };
}

export function createMemoryTools(
  toolCtx: ToolContext,
  budget: MemoryToolBudget,
): AITool[] {
  const memory = toolCtx.memory;
  const groupId = toolCtx.groupId;
  if (!memory || !groupId || !toolCtx.config.memory.recallToolsEnabled) {
    return [];
  }

  return [
    {
      name: "recall_group_context",
      description:
        "在本群的历史里查资料：过去的对话、群员说过的事、群里的约定。返回带时间和发言人的条目，必要时附带原话。上下文里没有答案时再用。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要查的内容，用自然语言描述，例如「上周说的那家店」",
          },
          days: {
            type: "number",
            description: "往回查多少天，默认 30",
          },
          about: {
            type: "string",
            description: "只看某个成员说的话时填他的名字或 user_id",
          },
        },
        required: ["query"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (!budget.tryUse()) return budgetExceeded(budget.max);
        const query = String(args.query ?? "").trim();
        if (!query) return { success: false, error: "query 不能为空" };
        const days = Number(args.days);
        const about = String(args.about ?? "").trim();
        try {
          const result = await memory.recallGroupContext({
            groupId,
            sessionId: toolCtx.sessionId,
            query,
            ...(Number.isFinite(days) && days > 0 ? { days } : {}),
            ...(about ? { who: about } : {}),
          });
          if (!result) {
            return {
              success: true,
              found: 0,
              result: "没有查到相关内容。别硬编，直接按不知道处理。",
            };
          }
          return { success: true, found: true, result };
        } catch (error) {
          return { success: false, error: `检索失败：${error}` };
        }
      },
    },
    {
      name: "recall_member_profile",
      description:
        "查某个群员的画像：身份、性格、说话习惯、常聊话题、和别人的关系，以及关于他的最近记忆。",
      parameters: {
        type: "object",
        properties: {
          who: {
            type: "string",
            description: "群员的名字或 user_id",
          },
        },
        required: ["who"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (!budget.tryUse()) return budgetExceeded(budget.max);
        const who = String(args.who ?? "").trim();
        if (!who) return { success: false, error: "who 不能为空" };
        try {
          const result = await memory.profileOfMember({ groupId, who });
          if (!result) {
            return {
              success: true,
              found: 0,
              result: `还没有 ${who} 的画像。`,
            };
          }
          return { success: true, found: true, result };
        } catch (error) {
          return { success: false, error: `查询失败：${error}` };
        }
      },
    },
  ];
}
