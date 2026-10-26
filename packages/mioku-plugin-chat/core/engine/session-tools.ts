import type {
  AITool,
  MiokuContext,
  SessionToolDefinition,
  SkillPermissionRole,
} from "mioku";
import type { ChatTurnEvent, ToolContext } from "../../types";
import type { SkillToolEntry } from "../../manage/skill-session";
import {
  isExternalSkillAllowed,
  isSkillAllowedForRole,
} from "../external-skills";

const WEB_TOOL_NAMES = new Set(["web_search", "web_read_page"]);

/** 传给外部技能工具 handler 的第二个参数 */
export interface SkillRuntimeContext {
  ctx: MiokuContext;
  event: ChatTurnEvent;
  rawEvent: ChatTurnEvent;
  session_id: string;
  trigger_role: SkillPermissionRole;
  isMultimodal: boolean;
}

/** 单轮对话里联网工具的调用次数上限 */
export interface WebToolBudget {
  readonly max: number;
  tryUse(): boolean;
}

export function createWebToolBudget(max: number): WebToolBudget {
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

export interface SessionToolSources {
  chatTools: AITool[];
  skillTools: Map<string, SkillToolEntry>;
  extraTools?: AITool[];
}

export function buildSessionTools(
  toolCtx: ToolContext,
  sources: SessionToolSources,
  budget: WebToolBudget,
): SessionToolDefinition[] {
  const runtimeContext = createSkillRuntimeContext(toolCtx);
  const tools: SessionToolDefinition[] = [];

  const bind = (name: string, tool: AITool, limited: boolean): void => {
    tools.push({
      name,
      tool: {
        ...tool,
        handler: (args: unknown) => {
          if (limited && !budget.tryUse()) return webBudgetExceeded(budget.max);
          return tool.handler(args, runtimeContext);
        },
      },
    });
  };

  for (const tool of sources.chatTools) {
    bind(tool.name, tool, WEB_TOOL_NAMES.has(tool.name));
  }
  for (const tool of sources.extraTools ?? []) {
    bind(tool.name, tool, false);
  }

  const { config, aiService, triggerSkillRole } = toolCtx;
  for (const [name, { skillName, tool }] of sources.skillTools) {
    if (
      !config.enableExternalSkills ||
      !isExternalSkillAllowed(config, skillName) ||
      !isSkillAllowedForRole(aiService.getSkill(skillName), triggerSkillRole)
    ) {
      continue;
    }
    // 通过 load_skill 加载的内置联网功能同样计入次数
    bind(
      name,
      tool,
      WEB_TOOL_NAMES.has(skillName) && WEB_TOOL_NAMES.has(tool.name),
    );
  }

  return tools;
}

function createSkillRuntimeContext(toolCtx: ToolContext): SkillRuntimeContext {
  const event: ChatTurnEvent = toolCtx.event ?? {};
  return {
    ctx: toolCtx.ctx,
    event,
    rawEvent: event,
    session_id: toolCtx.sessionId,
    trigger_role: toolCtx.triggerSkillRole,
    isMultimodal: Boolean(toolCtx.config.isMultimodal),
  };
}

function webBudgetExceeded(max: number) {
  return {
    success: false,
    error: `Web search/read-page limit (${max}) reached for this conversation. Answer based on existing information instead of calling web tools again.`,
  };
}
