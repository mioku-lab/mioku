import type { AISkill, SkillPermissionRole } from "mioku";
import type { ChatConfig } from "../types";

function normalizeSkillName(name: unknown): string {
  return String(name || "").trim();
}

export function getAllowedExternalSkillNameSet(
  config: ChatConfig,
): Set<string> | null {
  const entries = Array.isArray(config.allowedExternalSkills)
    ? config.allowedExternalSkills
        .map((item) => normalizeSkillName(item))
        .filter(Boolean)
    : [];

  return entries.length > 0 ? new Set(entries) : null;
}

export function isExternalSkillAllowed(
  config: ChatConfig,
  skillName: string,
): boolean {
  const allowedSkillNames = getAllowedExternalSkillNameSet(config);
  if (!allowedSkillNames) {
    return true;
  }

  return allowedSkillNames.has(normalizeSkillName(skillName));
}

const SKILL_PERMISSION_RANK: Record<SkillPermissionRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export function normalizeSkillPermissionRole(
  role: unknown,
): SkillPermissionRole {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "member" ||
    normalized === "admin" ||
    normalized === "owner"
  ) {
    return normalized;
  }
  return "member";
}

export function getSkillRequiredPermissionRole(
  skill: AISkill | undefined,
): SkillPermissionRole {
  if (!skill) {
    return "member";
  }
  return normalizeSkillPermissionRole(skill.permission);
}

export function hasSkillPermission(
  triggerRole: SkillPermissionRole,
  requiredRole: SkillPermissionRole,
): boolean {
  return (
    SKILL_PERMISSION_RANK[triggerRole] >= SKILL_PERMISSION_RANK[requiredRole]
  );
}

export function isSkillAllowedForRole(
  skill: AISkill | undefined,
  triggerRole: SkillPermissionRole,
): boolean {
  return hasSkillPermission(triggerRole, getSkillRequiredPermissionRole(skill));
}

export function filterAllowedExternalSkills(
  config: ChatConfig,
  skills: AISkill[],
  triggerRole?: SkillPermissionRole,
): AISkill[] {
  const allowedSkillNames = getAllowedExternalSkillNameSet(config);
  return skills.filter((skill) => {
    if (
      allowedSkillNames &&
      !allowedSkillNames.has(normalizeSkillName(skill.name))
    ) {
      return false;
    }
    return !(triggerRole && !isSkillAllowedForRole(skill, triggerRole));
  });
}
