import type { AITool } from "mioku";
import type { ToolContext } from "../../types";
import type { SkillSessionManager } from "../../manage/skill-session";
import {
  filterAllowedExternalSkills,
  getSkillRequiredPermissionRole,
  isExternalSkillAllowed,
  hasSkillPermission,
} from "../external-skills";
import {
  isFeatureEnabled,
  isBuiltinFeature,
  getFeatureMeta,
  type FeatureName,
} from "../feature-prompts";
import {
  buildWebSearchFeatureSection,
  buildWebReadFeatureSection,
  buildRecallMemoryFeatureSection,
} from "../prompt";
import { createWebSearchTool, createWebReadPageTool, createRecallMemoryTool } from "./web";

type ConstraintStrength = "low" | "medium" | "high";

function normalizeConstraintStrength(value: unknown): ConstraintStrength {
  if (value === "low" || value === "high" || value === "medium") return value;
  return "medium";
}

function createFeatureTools(
  toolCtx: ToolContext,
  featureName: FeatureName,
): AITool[] {
  switch (featureName) {
    case "web_search":
      return [createWebSearchTool(toolCtx)];
    case "web_read_page":
      return [createWebReadPageTool(toolCtx)];
    case "recall_memory":
      return [createRecallMemoryTool(toolCtx)];
    default:
      return [];
  }
}

export function createLoadSkillTool(
  toolCtx: ToolContext,
  skillManager: SkillSessionManager,
): AITool {
  return {
    name: "load_skill",
    description:
      "Load an external skill's tools into the current session. Tools will be available for 1 hour.",
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name to load" },
      },
      required: ["skill_name"],
    },
    handler: async (args) => {
      const skillName = String(args?.skill_name || "").trim();

      if (isBuiltinFeature(skillName)) {
        const feature = getFeatureMeta(skillName);
        if (!feature) return { error: `Feature "${skillName}" not found` };
        if (!isFeatureEnabled(toolCtx.config, feature)) {
          return { error: `Feature "${skillName}" is not enabled in config` };
        }

        const featureTools: AITool[] = feature.hasTools
          ? createFeatureTools(toolCtx, skillName)
          : [];
        if (featureTools.length > 0) {
          skillManager.loadSkill(toolCtx.sessionId, skillName, featureTools);
        } else {
          skillManager.loadFeature(toolCtx.sessionId, skillName, 60 * 60 * 1000);
        }

        const toolStrength = normalizeConstraintStrength(toolCtx.config.toolCallConstraintStrength);
        const sections: string[] = [];
        if (skillName === "web_search") {
          const s = buildWebSearchFeatureSection(toolCtx.config, toolStrength);
          if (s) sections.push(s);
        } else if (skillName === "web_read_page") {
          const s = buildWebReadFeatureSection(toolCtx.config, toolStrength);
          if (s) sections.push(s);
        } else if (skillName === "recall_memory") {
          const s = buildRecallMemoryFeatureSection(toolCtx.config);
          if (s) sections.push(s);
        }
        const usageHint = sections.length > 0 ? sections.join("\n") : "";

        return {
          success: true,
          skill_name: skillName,
          feature: true,
          expires_in: "1 hour",
          tools: featureTools.map((t) => ({
            name: `${skillName}-${t.name}`,
            description: t.description,
            parameters: t.parameters,
          })),
          ...(usageHint ? { usage: usageHint } : {}),
        };
      }

      if (!isExternalSkillAllowed(toolCtx.config, skillName)) {
        const allSkills = toolCtx.aiService.getAllSkills?.();
        const allowedSkills = allSkills
          ? filterAllowedExternalSkills(
              toolCtx.config,
              [...allSkills.values()],
              toolCtx.triggerSkillRole,
            )
          : [];
        const allowedNames = allowedSkills.map((skill) => skill.name);
        return {
          error:
            allowedNames.length > 0
              ? `Skill "${skillName}" is not allowed. Allowed skills: ${allowedNames.join(", ")}`
              : "No external skills are allowed in current config",
        };
      }

      const skill = toolCtx.aiService.getSkill(skillName);
      if (!skill) return { error: `Skill "${skillName}" does not exist` };
      const requiredRole = getSkillRequiredPermissionRole(skill);
      if (!hasSkillPermission(toolCtx.triggerSkillRole, requiredRole)) {
        return {
          error: `Permission denied: loading skill "${skill.name}" requires role "${requiredRole}", current role is "${toolCtx.triggerSkillRole}"`,
        };
      }

      skillManager.loadSkill(toolCtx.sessionId, skill.name, skill.tools);

      return {
        success: true,
        skill_name: skill.name,
        expires_in: "1 hour",
        tools: skill.tools.map((t) => ({
          name: `${skill.name}-${t.name}`,
          description: t.description,
          parameters: t.parameters,
        })),
      };
    },
  };
}
