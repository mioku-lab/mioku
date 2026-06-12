import type { AccessControlConfig } from "mioku";

export const ACCESS_DEFAULT_CONFIG: AccessControlConfig = {
  version: 1,
  global: { plugins: {}, commands: {} },
  groups: {},
  users: {},
};

export function normalizeAccessConfig(
  config: Partial<AccessControlConfig> | any,
): AccessControlConfig {
  return {
    version: 1,
    global: {
      plugins: config?.global?.plugins ?? {},
      commands: config?.global?.commands ?? {},
    },
    groups: config?.groups ?? {},
    users: config?.users ?? {},
  };
}
