/**
 * Small cross-feature utilities used by both the help and status panels.
 *
 * Kept dependency-free and stateless so it can be imported from anywhere
 * inside the plugin without creating a cycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Escape user-controlled text before embedding it in an HTML template.
 * Covers the five characters that change HTML/attribute semantics.
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text || "").replace(/[&<>"']/g, (match) => map[match]);
}

/**
 * Day/night toggle based on local hour. 19:00–07:00 is night; matches the
 * visual theme's two variants in `theme.ts`.
 */
export function checkNightMode(): boolean {
  const hour = new Date().getHours();
  return hour >= 19 || hour < 7;
}

/**
 * Read a package's `version` field from a path. Returns "unknown" silently
 * on any error (file not found, invalid JSON, missing field) so callers
 * can render the footer without try/catch boilerplate.
 */
export async function getPackageVersion(
  packageJsonPath: string,
): Promise<string> {
  try {
    const content = await fs.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Same as `getPackageVersion` but also verifies the package's `name`
 * field. Used by `getRenderVersions` to make sure a stray `package.json`
 * at the candidate path doesn't get reported as mioki/mioku.
 */
async function readNamedPackageVersion(
  packageJsonPath: string,
  expectedName: string,
): Promise<string> {
  try {
    const content = await fs.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as { name?: unknown; version?: unknown };
    if (pkg?.name === expectedName && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // fall through to "unknown"
  }
  return "unknown";
}

let renderVersionsCache: { miokiVersion: string; miokuVersion: string } | null = null;

/**
 * Read the installed `mioki` and `mioku` versions from the host project's
 * `node_modules`.
 *
 * In a workspace (Bun / pnpm / yarn) `mioki` is hoisted under
 * `mioku/node_modules/mioki` because mioki is a peer dep of mioku, so a
 * bare `node_modules/mioki` lookup misses. We try the nested path first
 * and fall back to the top-level install path. For `mioku` we look at
 * the host's top-level and one level up (handles monorepo layouts where
 * the plugin is loaded from a workspace root).
 *
 * Result is memoized — versions don't change at runtime, and the help
 * setup, the help skill, and the status snapshot all ask for them.
 */
export async function getRenderVersions(): Promise<{
  miokiVersion: string;
  miokuVersion: string;
}> {
  if (renderVersionsCache) {
    return renderVersionsCache;
  }

  const miokiCandidates = [
    // Nested under mioku (the typical workspace case).
    path.join(process.cwd(), "node_modules", "mioku", "node_modules", "mioki", "package.json"),
    // Hoisted top-level (a single-package install).
    path.join(process.cwd(), "node_modules", "mioki", "package.json"),
  ];
  const miokuCandidates = [
    path.join(process.cwd(), "node_modules", "mioku", "package.json"),
    path.join(process.cwd(), "..", "node_modules", "mioku", "package.json"),
  ];

  let miokiVersion = "unknown";
  for (const candidate of miokiCandidates) {
    const v = await readNamedPackageVersion(candidate, "mioki");
    if (v !== "unknown") {
      miokiVersion = v;
      break;
    }
  }

  let miokuVersion = "unknown";
  for (const candidate of miokuCandidates) {
    const v = await readNamedPackageVersion(candidate, "mioku");
    if (v !== "unknown") {
      miokuVersion = v;
      break;
    }
  }

  renderVersionsCache = { miokiVersion, miokuVersion };
  return renderVersionsCache;
}

