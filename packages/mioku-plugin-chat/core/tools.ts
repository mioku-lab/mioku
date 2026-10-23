import { logger } from "mioku";
import type { AITool } from "mioku";
import type { ToolContext } from "../types";
import type { SkillSessionManager } from "../manage/skill-session";
import { filterAllowedExternalSkills } from "./external-skills";
import { createInfoTools } from "./tools/info";
import { createLoadSkillTool } from "./tools/load-skill";
import { createWebSearchTool, createWebReadPageTool } from "./tools/web";

export function createTools(
  toolCtx: ToolContext,
  skillManager: SkillSessionManager,
): { tools: AITool[] } {
  const tools: AITool[] = [];

  tools.push(...createInfoTools(toolCtx));

  if (toolCtx.config.enableExternalSkills) {
    const allSkills = toolCtx.aiService.getAllSkills?.();
    const allowedSkills = allSkills
      ? filterAllowedExternalSkills(
          toolCtx.config,
          [...allSkills.values()],
          toolCtx.triggerSkillRole,
        )
      : [];

    if (allowedSkills.length > 0) {
      tools.push(createLoadSkillTool(toolCtx, skillManager));
    }
  }

  const activeFeatureTools = skillManager.getActiveFeatureTools(toolCtx.sessionId);
  if (activeFeatureTools.includes("web_search")) {
    tools.push(createWebSearchTool(toolCtx));
  }
  if (activeFeatureTools.includes("web_read_page")) {
    tools.push(createWebReadPageTool(toolCtx));
  }

  return { tools };
}

export { logger };
