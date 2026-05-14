import type { AITool } from "../../../src";
import type { SkillSession } from "../types";
import type { FeatureName } from "../core/feature-prompts";

/**
 * 技能会话管理器
 * 管理每个 session 的技能加载和工具注册
 */
export class SkillSessionManager {
  private sessions: Map<string, Map<string, SkillSession>> = new Map();
  private features: Map<string, Map<string, FeatureSession>> = new Map();
  private EXPIRY_MS = 60 * 60 * 1000; // 1 hour

  getTools(sessionId: string): Map<string, AITool> {
    const result = new Map<string, AITool>();
    const sessionSkills = this.sessions.get(sessionId);
    if (!sessionSkills) return result;

    const now = Date.now();
    for (const [skillName, session] of sessionSkills) {
      if (now > session.expiresAt) {
        sessionSkills.delete(skillName);
        continue;
      }
      for (const [toolName, tool] of session.tools) {
        result.set(toolName, tool);
      }
    }
    return result;
  }

  loadSkill(
    sessionId: string,
    skillName: string,
    tools: AITool[],
  ): SkillSession {
    let sessionSkills = this.sessions.get(sessionId);
    if (!sessionSkills) {
      sessionSkills = new Map();
      this.sessions.set(sessionId, sessionSkills);
    }

    const now = Date.now();
    const toolMap = new Map<string, AITool>();
    for (const tool of tools) {
      toolMap.set(`${skillName}.${tool.name}`, tool);
    }

    const session: SkillSession = {
      skillName,
      tools: toolMap,
      loadedAt: now,
      expiresAt: now + this.EXPIRY_MS,
    };
    sessionSkills.set(skillName, session);
    return session;
  }

  unloadSkill(sessionId: string, skillName: string): boolean {
    const sessionSkills = this.sessions.get(sessionId);
    if (!sessionSkills) return false;
    return sessionSkills.delete(skillName);
  }

  getActiveSkillsInfo(
    sessionId: string,
    isSkillVisible?: (skillName: string) => boolean,
  ): string {
    const sessionSkills = this.sessions.get(sessionId);
    if (!sessionSkills || sessionSkills.size === 0) return "";

    const now = Date.now();
    const lines: string[] = [];

    for (const [skillName, session] of sessionSkills) {
      if (now > session.expiresAt) {
        sessionSkills.delete(skillName);
        continue;
      }
      if (isSkillVisible && !isSkillVisible(skillName)) {
        continue;
      }
      const remainingMin = Math.ceil((session.expiresAt - now) / 60000);
      const toolNames = [...session.tools.keys()].join(", ");
      lines.push(
        `- ${skillName} (expires in ${remainingMin}min): ${toolNames}`,
      );
    }

    if (lines.length === 0) return "";
    return `## Loaded External Skills\n${lines.join("\n")}`;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, sessionSkills] of this.sessions) {
      for (const [skillName, session] of sessionSkills) {
        if (now > session.expiresAt) {
          sessionSkills.delete(skillName);
        }
      }
      if (sessionSkills.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
    for (const [sessionId, sessionFeatures] of this.features) {
      for (const [featureName, feature] of sessionFeatures) {
        if (now > feature.expiresAt) {
          sessionFeatures.delete(featureName);
        }
      }
      if (sessionFeatures.size === 0) {
        this.features.delete(sessionId);
      }
    }
  }

  loadFeature(
    sessionId: string,
    featureName: FeatureName,
    ttlMs: number,
  ): void {
    let sessionFeatures = this.features.get(sessionId);
    if (!sessionFeatures) {
      sessionFeatures = new Map();
      this.features.set(sessionId, sessionFeatures);
    }

    const now = Date.now();
    sessionFeatures.set(featureName, {
      featureName,
      loadedAt: now,
      expiresAt: now + ttlMs,
    });
  }

  getActiveFeatureNames(sessionId: string): FeatureName[] {
    const sessionFeatures = this.features.get(sessionId);
    if (!sessionFeatures) return [];

    const now = Date.now();
    const result: FeatureName[] = [];
    for (const [featureName, feature] of sessionFeatures) {
      if (now > feature.expiresAt) {
        sessionFeatures.delete(featureName);
        continue;
      }
      result.push(feature.featureName);
    }
    return result;
  }

  getActiveFeatureTools(sessionId: string): FeatureName[] {
    // Only return features that have tools (web_search, web_read_page, recall_memory)
    const all = this.getActiveFeatureNames(sessionId);
    return all.filter((name) => {
      switch (name) {
        case "web_search":
        case "web_read_page":
        case "recall_memory":
          return true;
        default:
          return false;
      }
    });
  }
}

interface FeatureSession {
  featureName: FeatureName;
  loadedAt: number;
  expiresAt: number;
}
