// 版本号比较：解析 semver 的数字段与预发布标识，忽略 build 元数据。

interface ParsedVersion {
  nums: number[];
  pre: string[];
}

function parseVersion(input: string): ParsedVersion | null {
  const raw = String(input ?? "")
    .trim()
    .replace(/^[=v\s]+/, "");
  if (!raw) return null;
  const withoutBuild = raw.split("+")[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const nums = core.split(".").map((n) => Number.parseInt(n, 10));
  if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return null;
  return { nums, pre: pre ? pre.split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  // 正式版高于同号预发布
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    return a.length === 0 ? 1 : -1;
  }
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx > ny ? 1 : -1;
    // 数字标识低于字母标识
    if (!Number.isNaN(nx)) return -1;
    if (!Number.isNaN(ny)) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** a 大于 b 返回 1，相等 0，小于 -1；无法解析时退化为字符串比较 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** 取版本列表中的最高正式版；只有预发布时返回其中最高的一个 */
export function pickHighestVersion(versions: readonly string[]): string | null {
  let stable: string | null = null;
  let any: string | null = null;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (!parsed) continue;
    if (any === null || compareVersions(version, any) > 0) any = version;
    if (parsed.pre.length > 0) continue;
    if (stable === null || compareVersions(version, stable) > 0)
      stable = version;
  }
  return stable ?? any;
}
