/** 技能根分类：项目内 / 用户级 / 自定义 */
export type SkillRootKind =
  | "project-agents"
  | "project-claude"
  | "user-agents"
  | "user-claude"
  | "user-codex"
  | "custom";

/** 一个技能扫描根 */
export interface SkillRoot {
  /** 分类 id，UI 按它分组 */
  id: string;
  /** 展示名，用户级用 `~` 简写 */
  label: string;
  kind: SkillRootKind;
  /** 绝对路径 */
  path: string;
  /** 数字小的先赢（技能重名时） */
  rank: number;
  /** 是否允许从 WebUI 安装 / 卸载 */
  writable: boolean;
}

/** 调用策略，来自 frontmatter 的 disable-model-invocation / user-invocable */
export interface SkillInvocationPolicy {
  /** 是否进入模型目录并允许 `skill` 工具加载 */
  modelInvocable: boolean;
  /** 是否允许用户显式调用 */
  userInvocable: boolean;
}

/** 技能摘要：渐进披露第一级，只有路由需要的字段 */
export interface SkillSummary {
  name: string;
  description: string;
  invoke: SkillInvocationPolicy;
  /** 所属根的 id */
  rootId: string;
  /** 技能根目录绝对路径 */
  dir: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 相对技能根的附加文件 */
  resources: string[];
}

/** 完整技能定义：正文按需读取，不缓存 */
export interface SkillDefinition extends SkillSummary {
  content: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** 规范里的 allowed-tools，仅供模型参考 */
  allowedTools: string[];
}

export type SkillDiagnosticCode =
  | "INVALID_NAME"
  | "MISSING_FRONTMATTER"
  | "MISSING_FIELD"
  | "INVALID_YAML"
  | "NAME_MISMATCH"
  | "UNKNOWN_KEY"
  | "NAME_DUPLICATE"
  | "UNUSABLE_INVOCATION"
  | "READ_FAILED";

export interface SkillDiagnostic {
  level: "error" | "warn";
  code: SkillDiagnosticCode;
  message: string;
  /** 出问题的 SKILL.md 绝对路径 */
  path: string;
}

export interface SkillLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const SKILL_FILE_NAME = "SKILL.md";
/** 规范要求的技能名：小写字母数字，单连字符分隔 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;
/** 规范定义的六个字段加上两个调用控制字段 */
export const SKILL_KNOWN_KEYS: readonly string[] = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
  "user-invocable",
];
