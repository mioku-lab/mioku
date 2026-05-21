/**
 * AI 工具定义
 */
export interface AITool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any, event?: any) => Promise<any> | any;
}

/**
 * AI Skill 定义
 */
export interface AISkill {
  name: string;
  description: string;
  permission?: SkillPermissionRole;
  tools: AITool[];
}

/**
 * AI Skill 权限级别
 * owner: mioki 主人
 * admin: mioki 管理 + 群管 + 群主
 * member: 普通成员
 */
export type SkillPermissionRole = "owner" | "admin" | "member";

/**
 * 指令权限级别
 * 主人 管理员 群主 群成员
 */
export type CommandRole = "master" | "admin" | "owner" | "member";

/**
 * 插件帮助信息
 */
export interface PluginHelp {
  title: string;
  description: string;
  commands: Array<{
    cmd: string;
    desc: string;
    usage?: string;
    role?: CommandRole;
  }>;
}

/**
 * 插件包配置
 * package.json 中的 mioku 字段
 */
export interface PluginPackageConfig {
  services?: string[];
  help?: PluginHelp;
}

/**
 * Mioku 服务定义
 */
export interface MiokuService {
  name: string;
  version: string;
  description?: string;
  init(): Promise<void>;
  api: Record<string, any>;
  dispose?(): Promise<void>;
}

/**
 * 插件元数据
 */
export interface PluginMetadata {
  name: string;
  version: string;
  description?: string;
  path: string;
  packageJson: any;
  config: PluginPackageConfig;
}

/**
 * 服务元数据
 */
export interface ServiceMetadata {
  name: string;
  version: string;
  description?: string;
  path: string;
  packageJson: any;
}