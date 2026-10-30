import type { SkillDefinition, SkillSummary } from "./types";

const DEFAULT_DESCRIPTION_MAX = 500;

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 目录行：`- \`name\`: description` */
export function renderSkillCatalog(
  skills: readonly SkillSummary[],
  options: { maxDescriptionLength?: number } = {},
): string {
  const max = options.maxDescriptionLength ?? DEFAULT_DESCRIPTION_MAX;
  return skills
    .map((skill) => {
      const description =
        skill.description.length > max
          ? `${skill.description.slice(0, max - 1)}…`
          : skill.description;
      return `- \`${skill.name}\`: ${escapeText(description)}`;
    })
    .join("\n");
}

/** 加载结果：伪 XML 包裹的资源清单与正文，模型语料里常见的形状 */
export function renderSkillContent(skill: SkillDefinition): string {
  const lines = [`技能目录：${skill.dir}`];
  if (skill.resources.length > 0) {
    lines.push("附带文件（相对该目录，用 read 读取、用 bash 执行）：");
    for (const resource of skill.resources) lines.push(`- ${resource}`);
  } else {
    lines.push("该技能没有附带文件。");
  }
  if (skill.compatibility) lines.push(`环境要求：${skill.compatibility}`);
  if (skill.allowedTools.length > 0) {
    lines.push(`该技能声明预授权工具：${skill.allowedTools.join(" ")}`);
  }

  return [
    `<skill_content name="${skill.name}">`,
    "<skill_resources>",
    ...lines.map(escapeText),
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}
