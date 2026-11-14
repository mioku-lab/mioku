import type { ChatConfig } from "../types";

export type FeatureName =
  | "markdown"
  | "audio"
  | "web_search"
  | "web_read_page";

export interface FeatureMeta {
  name: FeatureName;
  isEnabled: (config: ChatConfig) => boolean;
  hasTools: boolean;
}

export const FEATURE_METAS: FeatureMeta[] = [
  {
    name: "markdown",
    isEnabled: (cfg) => Boolean(cfg.enableMarkdownScreenshot),
    hasTools: false,
  },
  {
    name: "audio",
    isEnabled: (cfg) => Boolean(cfg.audio?.enabled),
    hasTools: false,
  },
  {
    name: "web_search",
    isEnabled: (cfg) => Boolean(cfg.searxng?.enabled),
    hasTools: true,
  },
  {
    name: "web_read_page",
    isEnabled: (cfg) => Boolean(cfg.webReader?.enabled),
    hasTools: true,
  },
];

export function isFeatureEnabled(
  config: ChatConfig,
  feature: FeatureMeta,
): boolean {
  return feature.isEnabled(config);
}

export function isBuiltinFeature(name: string): name is FeatureName {
  return FEATURE_METAS.some((f) => f.name === name);
}

export function getFeatureMeta(name: FeatureName): FeatureMeta | undefined {
  return FEATURE_METAS.find((f) => f.name === name);
}
