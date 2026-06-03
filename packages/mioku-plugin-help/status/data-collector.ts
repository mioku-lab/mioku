import * as os from "node:os";
import * as path from "node:path";
import {
  connectedBots,
  getMiokiStatus,
  systemInfo,
  type ExtendedNapCat,
  type MiokiStatus,
} from "mioki";
import type { AIService, MiokiContext } from "mioku";
import { getRenderVersions } from "../utils";
import { perfMonitor } from "./performance-monitor";
import { networkSampler } from "./network-sampler";
import type {
  AIUsageStatsLite,
  AIUsageSummary,
  BiosInfo,
  BotAccountStatus,
  DiskEntry,
  DiskInfo,
  DiskStatus,
  FrameworkStatus,
  GraphicsData,
  GpuInfo,
  MemoryStick,
  NetworkStatus,
  NodeRuntimeStatus,
  OneBotStatusData,
  OneBotVersionInfoData,
  ResourceStatus,
  StatusSnapshot,
  SystemInfo,
} from "./types";

/**
 * Aggregates runtime data from mioki, the OS, the network sampler, the
 * perf monitor, and the AI service into a single `StatusSnapshot`.
 *
 * The result is cached for `TTL_MS` to avoid duplicate collection when a
 * user fires `#状态` repeatedly. Each external await is wrapped in a
 * `Promise.race` with a 2s timeout so a single slow subsystem can't stall
 * the whole panel.
 */
const TTL_MS = 2000;
const AWAIT_TIMEOUT_MS = 2000;

let cache: { at: number; snapshot: StatusSnapshot } | null = null;

function withTimeout<T>(p: PromiseLike<T>, ms = AWAIT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Snapshot of the system's CPU tick counters at a point in time. The
 * sum covers every core, so a 4-core box that's fully loaded registers
 * `total = 4 * elapsed_in_ticks`. `idle` is the slice spent idle.
 */
interface CpuTickSample {
  idle: number;
  total: number;
  ts: number;
}

function sampleCpuTicks(): CpuTickSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, ts: Date.now() };
}

/**
 * Baseline sample taken at module load. We seed the cache eagerly so the
 * first `#状态` call (whenever it happens) already has a comparison
 * point — without this, the first call after a long idle period would
 * show 0% even if the system is under load.
 */
let prevCpuTicks: CpuTickSample = sampleCpuTicks();

/**
 * If the gap between two samples is larger than this, the previous
 * sample is too stale to produce a meaningful delta (e.g. the user
 * called `#状态` once, then came back an hour later). Discard and
 * start a fresh baseline.
 */
const CPU_SAMPLE_MAX_GAP_MS = 30_000;

/**
 * System-wide average CPU utilization between the previous sample and
 * now. Returns 0 on the first call after a baseline reset, and a value
 * in [0, 100] on subsequent calls.
 *
 * `os.cpus()` already sums ticks across all cores, so the result is
 * the per-core average — no need to divide by `cpuCores` (the old
 * `process.cpuUsage()` math did that because it summed its own usage
 * across cores; same destination, different source).
 */
function computeSystemCpuPercent(): number {
  const current = sampleCpuTicks();
  const gap = current.ts - prevCpuTicks.ts;
  if (gap > CPU_SAMPLE_MAX_GAP_MS || gap <= 0) {
    prevCpuTicks = current;
    return 0;
  }
  const idleDiff = current.idle - prevCpuTicks.idle;
  const totalDiff = current.total - prevCpuTicks.total;
  prevCpuTicks = current;
  if (totalDiff <= 0) {
    return 0;
  }
  const percent = 100 - (idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, percent));
}

/** Detect the active JS runtime and its version. */
function detectRuntime(): { name: string; version: string } {
  if (process.versions.bun) {
    return { name: "Bun", version: process.versions.bun };
  }
  return { name: "Node", version: process.versions.node };
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) {
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  if (n >= 1024 ** 2) {
    return `${(n / 1024 ** 2).toFixed(2)} MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(2)} KB`;
  }
  return `${n} B`;
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) {
    return `${days}天${hours}小时`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }
  return `${minutes}分`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (days > 0) {
    return `${days}天${String(hours).padStart(2, "0")}小时${String(minutes).padStart(2, "0")}分`;
  }
  if (hours > 0) {
    return `${hours}小时${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`;
  }
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

async function collectBots(): Promise<BotAccountStatus[]> {
  const bots = Array.from(connectedBots.values());
  if (bots.length === 0) {
    return [];
  }
  return collectBotStatuses(bots);
}

async function collectBotStatuses(
  bots: ExtendedNapCat[],
): Promise<BotAccountStatus[]> {
  let perBotCounts = new Map<number, { send: number; receive: number }>();
  try {
    const miokiStatus = await withTimeout(
      Promise.resolve().then(() => getMiokiStatus(bots)),
    );
    if (Array.isArray(miokiStatus?.bots)) {
      for (const b of miokiStatus.bots) {
        const u = safeNumber(b?.uin);
        if (u > 0) {
          perBotCounts.set(u, {
            send: safeNumber(b?.send),
            receive: safeNumber(b?.receive),
          });
        }
      }
    }
  } catch {
    // ignore
  }

  const results: BotAccountStatus[] = [];
  for (const bot of bots) {
    const uin = safeNumber(bot?.bot_id || bot?.uin || bot?.user_id);
    const nickname = String(bot?.nickname || "Unknown Bot");
    const framework = String(bot?.app_name || "unknown");
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=160`;

    // 并行拿 OneBot API 的 status / group / friend / version
    let online = true;
    let onlineDurationMs = 0;
    let groupCount = 0;
    let friendCount = 0;
    let appVersion = "unknown";
    let protocolVersion = "unknown";
    const [statusResult, groupsResult, friendsResult, versionResult] =
      await Promise.allSettled([
        withTimeout(
          Promise.resolve().then(() => bot.api<OneBotStatusData>("get_status")),
        ).catch(() => null),
        withTimeout(Promise.resolve().then(() => bot.getGroupList())).catch(
          () => [],
        ),
        withTimeout(Promise.resolve().then(() => bot.getFriendList())).catch(
          () => [],
        ),
        withTimeout(
          Promise.resolve().then(() =>
            bot.api<OneBotVersionInfoData>("get_version_info"),
          ),
        ).catch(() => null),
      ]);
    if (statusResult.status === "fulfilled" && statusResult.value) {
      const status = statusResult.value;
      // napcat-sdk 的 api() 已经把 OneBot v11 响应的 data 字段解包出来，
      const startTs = safeNumber(status?.stat?.start_time);
      if (startTs > 0) {
        // OneBot 约定：start_time 是 unix 秒；> 1e12 视为毫秒
        const startMs = startTs > 1e12 ? startTs : startTs * 1000;
        onlineDurationMs = Math.max(0, Date.now() - startMs);
      }
      if (typeof status?.online === "boolean") {
        online = status.online;
      } else if (typeof status?.good === "boolean") {
        // go-cqhttp / LLOneBot 用 good 表示总体健康
        online = status.good;
      }
    }
    if (versionResult.status === "fulfilled" && versionResult.value) {
      const v = versionResult.value;
      if (v.app_version && v.app_version.trim()) {
        appVersion = v.app_version.trim();
      }
      if (v.protocol_version && v.protocol_version.trim()) {
        protocolVersion = v.protocol_version.trim();
      }
    }
    if (
      groupsResult.status === "fulfilled" &&
      Array.isArray(groupsResult.value)
    ) {
      groupCount = groupsResult.value.length;
    }
    if (
      friendsResult.status === "fulfilled" &&
      Array.isArray(friendsResult.value)
    ) {
      friendCount = friendsResult.value.length;
    }

    const counts = perBotCounts.get(uin) || { send: 0, receive: 0 };

    results.push({
      uin,
      nickname,
      avatarUrl,
      framework,
      appVersion,
      protocolVersion,
      online,
      groupCount,
      friendCount,
      onlineDurationMs,
      send: counts.send,
      receive: counts.receive,
    });
  }
  return results;
}

async function collectFramework(
  rawBots: ExtendedNapCat[],
  botStatuses: BotAccountStatus[],
): Promise<FrameworkStatus> {
  const adapters = new Set<string>();
  for (const bot of botStatuses) {
    if (bot.framework) {
      adapters.add(bot.framework);
    }
  }

  // 从 mioki 内部服务读 plugins / versions
  let miokiStatus: MiokiStatus | null = null;
  try {
    miokiStatus = await withTimeout(
      Promise.resolve().then(() => getMiokiStatus(rawBots)),
    );
  } catch {
    // ignore
  }

  const runtime = detectRuntime();
  // Read both versions from the same `getRenderVersions` helper that the
  // help panel uses, so the status footer and the help footer agree even
  // when `mioki` is only installed under `mioku/node_modules`.
  const { miokiVersion, miokuVersion } = await getRenderVersions();
  return {
    miokuVersion,
    miokiVersion,
    napcatVersion:
      miokiStatus?.versions?.napcat ?? botStatuses[0]?.framework ?? "unknown",
    pluginCount: safeNumber(miokiStatus?.plugins?.total),
    pluginEnabled: safeNumber(miokiStatus?.plugins?.enabled),
    adapterCount: adapters.size,
    onlineBotCount: botStatuses.filter((b) => b.online).length,
    uptimeMs: safeNumber(process.uptime()) * 1000,
    runtime: runtime.name,
    runtimeVersion: runtime.version,
  };
}

async function collectResources(): Promise<ResourceStatus> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

  const cpus = os.cpus();
  const cpuInfo = cpus[0];
  const cpuModel = cpuInfo?.model || "unknown";
  const cpuCores = cpus.length;
  let speedMhz = safeNumber(cpuInfo?.speed);
  // Apple Silicon (M1/M2/M3) reports 0 from os.cpus()[0].speed because
  // Apple doesn't expose the frequency. Fall back to systeminformation's
  // cpuCurrentSpeed() which reads it from sysctl on macOS.
  if (speedMhz <= 0) {
    try {
      const cur = (await withTimeout(systemInfo.cpuCurrentSpeed())) as
        | { avg?: number; min?: number; max?: number }
        | null
        | undefined;
      const ghz = safeNumber(cur?.avg);
      if (ghz > 0) {
        speedMhz = Math.round(ghz * 1000);
      }
    } catch {
      // keep 0; renderer will show "0 MHz"
    }
  }
  const cpuModelShort =
    cpuModel.length > 22 ? `${cpuModel.slice(0, 21)}…` : cpuModel;
  const cpuSpeedGHz =
    speedMhz >= 1000
      ? `${(speedMhz / 1000).toFixed(1)} GHz`
      : `${Math.round(speedMhz)} MHz`;
  // System-wide CPU% from a 2-sample delta. `collectSnapshot` has a 2s
  // TTL, so under normal use we'll have a fresh reading each call. The
  // first call after a baseline reset returns 0 (sentinel) — see
  // `computeSystemCpuPercent` for the gap-discard policy.
  const cpuPercent = computeSystemCpuPercent();

  // systeminformation.mem() gives buffcache and swap fields that os can't.
  // Wrap in withTimeout so a single slow call doesn't stall the snapshot.
  let memBuffCacheGB = 0;
  let swapTotalGB = 0;
  let swapUsedGB = 0;
  let swapPercent = 0;
  try {
    const memInfo = await withTimeout(systemInfo.mem());
    if (memInfo && typeof memInfo === "object") {
      const buffcache = safeNumber(
        (memInfo as { buffcache?: number }).buffcache,
      );
      const swaptotal = safeNumber(
        (memInfo as { swaptotal?: number }).swaptotal,
      );
      const swapused = safeNumber((memInfo as { swapused?: number }).swapused);
      memBuffCacheGB = Number((buffcache / 1024 ** 3).toFixed(2));
      swapTotalGB = Number((swaptotal / 1024 ** 3).toFixed(2));
      swapUsedGB = Number((swapused / 1024 ** 3).toFixed(2));
      swapPercent = swaptotal > 0 ? (swapused / swaptotal) * 100 : 0;
    }
  } catch {
    // ignore — fall back to zeros
  }

  return {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    cpuModel,
    cpuModelShort,
    cpuSpeedGHz,
    cpuCores,
    memPercent: Number(memPercent.toFixed(1)),
    memUsedGB: Number((usedMem / 1024 ** 3).toFixed(2)),
    memTotalGB: Number((totalMem / 1024 ** 3).toFixed(2)),
    memBuffCacheGB,
    swapPercent: Number(swapPercent.toFixed(1)),
    swapUsedGB,
    swapTotalGB,
  };
}

function collectRuntime(): NodeRuntimeStatus {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Number((mem.heapUsed / 1024 ** 2).toFixed(1)),
    heapTotalMB: Number((mem.heapTotal / 1024 ** 2).toFixed(1)),
    rssMB: Number((mem.rss / 1024 ** 2).toFixed(1)),
    externalMB: Number((mem.external / 1024 ** 2).toFixed(1)),
    arrayBuffersMB: Number((mem.arrayBuffers / 1024 ** 2).toFixed(1)),
    eventLoopDelayMs: perfMonitor.getEventLoop(),
    gc: perfMonitor.getGC(),
  };
}

function collectNetwork(): NetworkStatus {
  const speeds = networkSampler.getLastSpeeds();
  const totals = networkSampler.getTotals();
  return {
    rxBps: speeds.rxBps,
    txBps: speeds.txBps,
    rxTotalBytes: totals.rxBytes,
    txTotalBytes: totals.txBytes,
    history: networkSampler.getRecentSeries(30 * 60 * 1000),
  };
}

async function collectDisk(): Promise<DiskStatus> {
  try {
    const fsList = await withTimeout(systemInfo.fsSize());
    if (!Array.isArray(fsList)) {
      return { entries: [] };
    }
    const sorted = [...fsList].sort(
      (a, b) => safeNumber(b?.size) - safeNumber(a?.size),
    );
    const top = sorted.slice(0, 3);
    const entries: DiskEntry[] = top.map((entry) => {
      const total = safeNumber(entry?.size);
      const used = safeNumber(entry?.used);
      const percent =
        total > 0
          ? Number(((used / total) * 100).toFixed(1))
          : safeNumber(entry?.use, 0);
      return {
        mount: String(entry?.mount || entry?.fs || "unknown"),
        usedGB: Number((used / 1024 ** 3).toFixed(2)),
        totalGB: Number((total / 1024 ** 3).toFixed(2)),
        percent,
      };
    });
    return { entries };
  } catch {
    return { entries: [] };
  }
}

async function collectSystem(): Promise<SystemInfo> {
  // Seven systeminformation calls. Each gets its own 2s timeout so a single
  // slow probe (e.g. memLayout on macOS) doesn't block the rest.
  const [
    osInfo,
    graphics,
    cpuData,
    memLayout,
    biosData,
    systemData,
    diskLayout,
  ] = await Promise.all([
    withTimeout(systemInfo.osInfo()).catch(() => null),
    withTimeout(systemInfo.graphics()).catch(() => null),
    withTimeout(systemInfo.cpu()).catch(() => null),
    withTimeout(systemInfo.memLayout()).catch(() => []),
    withTimeout(systemInfo.bios()).catch(() => null),
    withTimeout(systemInfo.system()).catch(() => null),
    withTimeout(systemInfo.diskLayout()).catch(() => []),
  ]);

  // OS: prefer the human-readable distro (e.g. "macOS Sequoia", "Ubuntu
  // 24.04 LTS") with arch appended. Fall back to `os.platform() arch` if
  // systeminformation doesn't return a distro (rare, mostly on exotic BSDs).
  let osLabel = `${os.platform()} ${os.arch()}`;
  let kernel = os.release();
  if (osInfo && typeof osInfo === "object") {
    const info = osInfo as {
      distro?: unknown;
      release?: unknown;
      kernel?: unknown;
      arch?: unknown;
    };
    const distro = String(info.distro || "").trim();
    const release = String(info.release || "").trim();
    const arch = String(info.arch || os.arch()).trim();
    if (distro) {
      osLabel =
        release && release !== "0" && release !== distro
          ? `${distro} ${release} (${arch})`
          : `${distro} (${arch})`;
    } else if (release) {
      osLabel = `${release} (${arch})`;
    } else {
      osLabel = `${os.platform()} (${arch})`;
    }
    if (info.kernel) {
      kernel = String(info.kernel);
    }
  }

  // CPU: prefer the long brand string ("AMD EPYC 7542 32-Core Processor")
  // from systeminformation. os.cpus()[0].model often truncates on Linux.
  let cpu = os.cpus()[0]?.model || "unknown";
  if (cpuData && typeof cpuData === "object") {
    const brand = String((cpuData as { brand?: unknown }).brand || "").trim();
    if (brand) {
      cpu = brand;
    }
  }

  // GPUs: support multiple. Many systems have an integrated + discrete pair
  // (e.g. Apple Silicon + eGPU, Intel iGPU + NVIDIA dGPU). On a server with
  // no GPU, this array stays empty and the renderer shows "N/A".
  const gpus: GpuInfo[] = [];
  const controllers = (graphics as GraphicsData | null)?.controllers;
  if (Array.isArray(controllers)) {
    for (const c of controllers) {
      const model = String(c?.model || "").trim();
      if (!model) continue;
      const vramBytes = safeNumber(c?.vram);
      gpus.push({
        vendor: String(c?.vendor || "").trim(),
        model,
        vramGB: Number((vramBytes / 1024 ** 3).toFixed(2)),
      });
    }
  }

  // RAM sticks. memLayout() is Linux/Win only; on macOS this returns an
  // empty array and the renderer shows "N/A". Each stick's full part number
  // is the only reliable way to identify a module.
  const memSticks: MemoryStick[] = [];
  if (Array.isArray(memLayout)) {
    for (const m of memLayout) {
      const sizeBytes = safeNumber(m?.size);
      if (sizeBytes <= 0) continue;
      memSticks.push({
        bank: String(m?.bank || "").trim(),
        sizeGB: Number((sizeBytes / 1024 ** 3).toFixed(1)),
        type: String(m?.type || "Unknown").trim(),
        speedMTs: safeNumber(m?.clockSpeed),
        manufacturer: String(m?.manufacturer || "").trim(),
        partNum: String(m?.partNum || "").trim(),
      });
    }
  }

  // BIOS / UEFI. On macOS / WSL this returns empty strings — surface as "N/A".
  const bios: BiosInfo =
    biosData && typeof biosData === "object"
      ? {
          vendor:
            String((biosData as { vendor?: unknown }).vendor || "N/A").trim() ||
            "N/A",
          version:
            String(
              (biosData as { version?: unknown }).version || "N/A",
            ).trim() || "N/A",
          releaseDate: String(
            (biosData as { releaseDate?: unknown }).releaseDate || "",
          ).trim(),
        }
      : { vendor: "N/A", version: "N/A", releaseDate: "" };

  // Chassis: "Manufacturer Model" (e.g. "Supermicro H12SSL-NT", "Dell Inc.
  // PowerEdge R750"). On macOS the system() call returns empty strings;
  // fall back to the model identifier (e.g. "Mac15,9").
  let chassis = "N/A";
  if (systemData && typeof systemData === "object") {
    const manufacturer = String(
      (systemData as { manufacturer?: unknown }).manufacturer || "",
    ).trim();
    const model = String(
      (systemData as { model?: unknown }).model || "",
    ).trim();
    if (manufacturer && model) {
      chassis = `${manufacturer} ${model}`;
    } else if (model) {
      chassis = model;
    } else if (manufacturer) {
      chassis = manufacturer;
    }
  }

  // Physical disk drives. diskLayout() is the same source as the top3 used
  // by the disk-usage section, but here we keep every drive so the system
  // info can show the actual hardware (vendor + model + size + interface).
  const disks: DiskInfo[] = [];
  if (Array.isArray(diskLayout)) {
    for (const d of diskLayout) {
      const sizeBytes = safeNumber(d?.size);
      if (sizeBytes <= 0) continue;
      disks.push({
        vendor: String(d?.vendor || "").trim(),
        name: String(d?.name || "").trim(),
        type: String(d?.type || "Unknown").trim(),
        interfaceType: String(d?.interfaceType || "").trim(),
        sizeGB: Number((sizeBytes / 1024 ** 3).toFixed(0)),
      });
    }
  }

  return {
    os: osLabel,
    kernel,
    cpu,
    gpus,
    memSticks,
    bios,
    chassis,
    disks,
  };
}

async function collectAI(ctx: MiokiContext): Promise<AIUsageStatsLite> {
  const ai = ctx?.services?.ai as AIService | undefined;
  if (!ai || typeof ai.getUsageSummary !== "function") {
    return {
      available: false,
      totalRequests: 0,
      errorRate: 0,
      cacheHitRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      topGroups: [],
      topTools: [],
    };
  }
  try {
    const summary = (await withTimeout(
      Promise.resolve(ai.getUsageSummary({ range: "7d" })),
    )) as AIUsageSummary | null | undefined;
    const totals = summary?.totals;
    const rates = summary?.rates;
    return {
      available: true,
      totalRequests: safeNumber(totals?.requests),
      errorRate: safeNumber(rates?.errorRate),
      cacheHitRate: safeNumber(rates?.cacheHitRate),
      inputTokens: safeNumber(totals?.inputTokens),
      outputTokens: safeNumber(totals?.outputTokens),
      totalTokens: safeNumber(totals?.totalTokens),
      topGroups: Array.isArray(summary?.groupRanking)
        ? summary!.groupRanking!.slice(0, 6).map((g) => ({
            name: String(g?.groupName || `群 ${g?.groupId || "?"}`),
            requests: safeNumber(g?.requests),
            totalTokens: safeNumber(g?.totalTokens),
          }))
        : [],
      topTools: Array.isArray(summary?.toolRanking)
        ? summary!.toolRanking!.slice(0, 6).map((t) => ({
            name: String(t?.name || "unknown"),
            count: safeNumber(t?.count),
          }))
        : [],
    };
  } catch {
    return {
      available: false,
      totalRequests: 0,
      errorRate: 0,
      cacheHitRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      topGroups: [],
      topTools: [],
    };
  }
}

export async function collectSnapshot(
  ctx: MiokiContext,
  options: { isNightMode: boolean } = { isNightMode: false },
): Promise<StatusSnapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { ...cache.snapshot, isNightMode: options.isNightMode };
  }

  const rawBots = Array.from(connectedBots.values());
  const [bots, disk, system, ai, resources] = await Promise.all([
    collectBots(),
    collectDisk(),
    collectSystem(),
    collectAI(ctx),
    collectResources(),
  ]);

  const framework = await collectFramework(rawBots, bots);

  const snapshot: StatusSnapshot = {
    generatedAt: Date.now(),
    isNightMode: options.isNightMode,
    bots,
    framework,
    resources,
    runtime: collectRuntime(),
    network: collectNetwork(),
    disk,
    system,
    ai,
  };

  cache = { at: Date.now(), snapshot };
  return snapshot;
}

export function clearStatusCache(): void {
  cache = null;
}

export const __formatHelpers = {
  formatUptime,
  formatDuration,
  formatBytes,
};
