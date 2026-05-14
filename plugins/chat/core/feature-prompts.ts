import type { ChatConfig } from "../types";

export type FeatureName =
  | "markdown"
  | "audio"
  | "web_search"
  | "web_read_page"
  | "recall_memory";

export interface FeatureMeta {
  name: FeatureName;
  configKey: string;
  hasTools: boolean;
}

export const FEATURE_METAS: FeatureMeta[] = [
  {
    name: "markdown",
    configKey: "enableMarkdownScreenshot",
    hasTools: false,
  },
  { name: "audio", configKey: "audio.enabled", hasTools: false },
  { name: "web_search", configKey: "searxng.enabled", hasTools: true },
  { name: "web_read_page", configKey: "webReader.enabled", hasTools: true },
  { name: "recall_memory", configKey: "memory.enabled", hasTools: true },
];

export function isFeatureEnabled(
  config: ChatConfig,
  feature: FeatureMeta,
): boolean {
  const key = feature.configKey;
  const parts = key.split(".");
  let value: any = config;
  for (const part of parts) {
    value = value?.[part];
  }
  return Boolean(value);
}

export function isBuiltinFeature(name: string): name is FeatureName {
  return FEATURE_METAS.some((f) => f.name === name);
}

export function getFeatureMeta(name: FeatureName): FeatureMeta | undefined {
  return FEATURE_METAS.find((f) => f.name === name);
}