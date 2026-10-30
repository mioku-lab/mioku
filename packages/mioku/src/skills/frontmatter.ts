import { parse as parseYaml } from "yaml";
import {
  SKILL_COMPATIBILITY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_KNOWN_KEYS,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  type SkillDiagnostic,
  type SkillInvocationPolicy,
} from "./types";

export interface ParsedSkillFile {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools: string[];
  invoke: SkillInvocationPolicy;
  /** 去掉 frontmatter 的 Markdown 正文 */
  content: string;
}

export interface SkillFileParseResult {
  /** 缺失表示该文件必须被忽略 */
  skill?: ParsedSkillFile;
  diagnostics: SkillDiagnostic[];
}

const FRONTMATTER_FENCE = "---";

function diagnostic(
  code: SkillDiagnostic["code"],
  message: string,
  path: string,
  level: SkillDiagnostic["level"] = "warn",
): SkillDiagnostic {
  return { level, code, message, path };
}

function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** 拆出 `---` 围栏之间的 YAML 与正文 */
function splitFrontmatter(
  text: string,
): { yaml: string; body: string } | undefined {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trimEnd() !== FRONTMATTER_FENCE) return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() !== FRONTMATTER_FENCE) continue;
    return {
      yaml: lines.slice(1, i).join("\n"),
      body: lines.slice(i + 1).join("\n"),
    };
  }
  return undefined;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function booleanField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes" || lowered === "on") return true;
    if (lowered === "false" || lowered === "no" || lowered === "off")
      return false;
  }
  return undefined;
}

/** 规范允许空格分隔的字符串或 YAML 列表 */
function readAllowedTools(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((item) => String(item ?? ""))
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return parts.map((part) => part.trim()).filter(Boolean);
}

function readMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || item === undefined) continue;
    result[key] =
      typeof item === "string" ? item : JSON.stringify(item) ?? String(item);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function clamp(
  value: string,
  max: number,
  label: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): string {
  if (value.length <= max) return value;
  diagnostics.push(
    diagnostic(
      "UNKNOWN_KEY",
      `frontmatter ${label} 超过 ${max} 字符，已截断`,
      path,
    ),
  );
  return value.slice(0, max);
}

/**
 * 解析并校验一个 `SKILL.md`。
 * 缺失 `skill` 表示该文件不可用：缺少 frontmatter、YAML 非法、name/description 缺失或 name 非法。
 */
export function parseSkillFile(
  path: string,
  raw: string,
): SkillFileParseResult {
  const diagnostics: SkillDiagnostic[] = [];
  const text = normalizeText(raw);
  const split = splitFrontmatter(text);
  if (!split) {
    diagnostics.push(
      diagnostic("MISSING_FRONTMATTER", "缺少 YAML frontmatter，已忽略", path, "error"),
    );
    return { diagnostics };
  }

  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(split.yaml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push(
        diagnostic("INVALID_YAML", "frontmatter 不是键值映射，已忽略", path, "error"),
      );
      return { diagnostics };
    }
    data = parsed as Record<string, unknown>;
  } catch (err) {
    diagnostics.push(
      diagnostic("INVALID_YAML", `frontmatter YAML 解析失败：${err}`, path, "error"),
    );
    return { diagnostics };
  }

  for (const key of Object.keys(data)) {
    if (SKILL_KNOWN_KEYS.includes(key)) continue;
    diagnostics.push(
      diagnostic("UNKNOWN_KEY", `未知 frontmatter 字段 "${key}"，已忽略`, path),
    );
  }

  const name = stringField(data, "name");
  if (!name) {
    diagnostics.push(
      diagnostic("MISSING_FIELD", "frontmatter 缺少 name，已忽略", path, "error"),
    );
    return { diagnostics };
  }
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(name)) {
    diagnostics.push(
      diagnostic(
        "INVALID_NAME",
        `技能名 "${name}" 不合法（仅小写字母、数字与单个连字符，最长 ${SKILL_NAME_MAX}），已忽略`,
        path,
        "error",
      ),
    );
    return { diagnostics };
  }

  const rawDescription = stringField(data, "description");
  if (!rawDescription) {
    diagnostics.push(
      diagnostic("MISSING_FIELD", "frontmatter 缺少 description，已忽略", path, "error"),
    );
    return { diagnostics };
  }

  const disableModelInvocation =
    booleanField(data["disable-model-invocation"]) ?? false;
  const userInvocable = booleanField(data["user-invocable"]) ?? true;
  const invoke: SkillInvocationPolicy = {
    modelInvocable: !disableModelInvocation,
    userInvocable,
  };
  if (!invoke.modelInvocable && !invoke.userInvocable) {
    diagnostics.push(
      diagnostic(
        "UNUSABLE_INVOCATION",
        "disable-model-invocation 与 user-invocable:false 同时设置，技能不可被任何方式调用",
        path,
      ),
    );
  }

  const license = stringField(data, "license");
  const compatibility = stringField(data, "compatibility");

  return {
    skill: {
      name,
      description: clamp(
        rawDescription,
        SKILL_DESCRIPTION_MAX,
        "description",
        path,
        diagnostics,
      ),
      ...(license ? { license } : {}),
      ...(compatibility
        ? {
            compatibility: clamp(
              compatibility,
              SKILL_COMPATIBILITY_MAX,
              "compatibility",
              path,
              diagnostics,
            ),
          }
        : {}),
      ...(() => {
        const metadata = readMetadata(data.metadata);
        return metadata ? { metadata } : {};
      })(),
      allowedTools: readAllowedTools(data["allowed-tools"]),
      invoke,
      content: split.body.trim(),
    },
    diagnostics,
  };
}
