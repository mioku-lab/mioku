import * as fs from "fs/promises";
import * as path from "path";
import { botConfig, logger, type MiokiContext } from "mioki";
import type { AIService } from "../types";
import type { HelpService } from "../service-types";
import type { AISkill } from "./types";
import pluginManager from "./plugin-manager";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toImportPath(filePath: string): string {
  if (process.platform === "win32") {
    return "file:///" + filePath.replace(/\\/g, "/");
  }
  return filePath;
}

function isAISkill(value: any): value is AISkill {
  return (
    value &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    Array.isArray(value.tools)
  );
}

function extractSkills(moduleExports: any): AISkill[] {
  const candidates = [
    moduleExports?.default,
    moduleExports?.skills,
    moduleExports,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isAISkill);
    }
    if (isAISkill(candidate)) {
      return [candidate];
    }
  }

  return [];
}

async function resolveSkillsEntry(pluginPath: string): Promise<string | null> {
  const tsPath = path.join(pluginPath, "skills.ts");
  if (await pathExists(tsPath)) {
    return tsPath;
  }

  const jsPath = path.join(pluginPath, "skills.js");
  if (await pathExists(jsPath)) {
    return jsPath;
  }

  return null;
}

/**
 * Auto-register plugin help manifests and AI skills
 */
export async function registerPluginArtifacts(
  ctx: MiokiContext,
): Promise<void> {
  const enabledPlugins = new Set<string>(
    Array.isArray(botConfig?.plugins) ? botConfig.plugins : [],
  );
  const pluginMetadata = pluginManager
    .getAllMetadata()
    .filter((metadata) =>
      enabledPlugins.size > 0 ? enabledPlugins.has(metadata.name) : true,
    );

  const helpService = ctx.services?.help as HelpService | undefined;
  const aiService = ctx.services?.ai as AIService | undefined;

  if (helpService) {
    let helpCount = 0;
    for (const metadata of pluginMetadata) {
      if (!metadata.config.help) {
        continue;
      }
      helpService.registerHelp(metadata.name, metadata.config.help);
      helpCount += 1;
    }
    logger.info(`[plugin-artifacts] Registered ${helpCount} help manifest(s)`);
  }

  if (!aiService) {
    return;
  }

  let skillCount = 0;
  for (const metadata of pluginMetadata) {
    const skillsEntry = await resolveSkillsEntry(metadata.path);
    if (!skillsEntry) {
      continue;
    }

    try {
      const moduleExports = await import(toImportPath(skillsEntry));
      const skills = extractSkills(moduleExports);

      if (skills.length === 0) {
        logger.warn(
          `[plugin-artifacts] Plugin ${metadata.name} has ${path.basename(skillsEntry)} but exported no valid skill`,
        );
        continue;
      }

      for (const skill of skills) {
        aiService.registerSkill(skill);
        skillCount += 1;
      }
    } catch (error: any) {
      logger.error(
        `[plugin-artifacts] Failed to load skills for plugin ${metadata.name}: ${error?.message || error}`,
      );
    }
  }

  logger.info(`[plugin-artifacts] Registered ${skillCount} skill(s)`);
}