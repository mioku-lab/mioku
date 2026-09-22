function isConfigObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeChatConfig<T extends Record<string, any>>(
  defaults: T,
  overrides: Record<string, any>,
): T {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (isConfigObject(value)) {
      result[key] = mergeChatConfig(value, {});
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (isConfigObject(value)) {
      const baseValue = isConfigObject(result[key]) ? result[key] : {};
      result[key] = mergeChatConfig(baseValue, value);
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

export function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  );
}

export function normalizeMediaAnalysisBlacklist(
  config: Record<string, any>,
): string[] {
  const current = config.mediaAnalysisBlacklistUsers;
  const legacy = config.imageAnalysisBlacklistUsers;
  const source =
    legacy !== undefined && Array.isArray(current) && current.length === 0
      ? legacy
      : (current ?? legacy);
  return normalizeIdList(source);
}
