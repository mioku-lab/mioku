/**
 * Status panel data types.
 *
 * The status panel is rendered from a single `StatusSnapshot` aggregated by
 * `data-collector.ts`. Every field is plain data; rendering logic lives in
 * `html-generator.ts`.
 */

export interface BotAccountStatus {
  uin: number;
  nickname: string;
  avatarUrl: string;
  /** Underlying bot framework identifier, e.g. "QQBot" / "NapCat" / "LLOneBot". */
  framework: string;
  /** Adapter app version, e.g. "5.0.6" — from OneBot `get_version_info.app_version`. */
  appVersion: string;
  /** OneBot protocol version, e.g. "v11" — from OneBot `get_version_info.protocol_version`. */
  protocolVersion: string;
  online: boolean;
  groupCount: number;
  friendCount: number;
  send: number;
  receive: number;
}

/**
 * OneBot v11 `get_version_info` payload (already unwrapped from the
 * `{ status, retcode, data, ... }` envelope by napcat-sdk's `bot.api`).
 */
export interface OneBotVersionInfoData {
  app_name: string;
  protocol_version: string;
  app_version: string;
}

/**
 * OneBot v11 `get_status` payload (already unwrapped by napcat-sdk).
 * Per napcat 官方文档: `{ online, good, stat }` —— `stat` 是空对象，
 * 不包含 `start_time` 或任何统计字段。本接口只声明文档承诺的字段。
 */
export interface OneBotStatusData {
  online: boolean;
  good: boolean;
  stat: Record<string, never>;
}

/** Subset of mioku's `AIService.getUsageSummary` payload that we actually render. */
export interface AIUsageSummary {
  totals?: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  rates?: {
    errorRate?: number;
    cacheHitRate?: number;
  };
  groupRanking?: Array<{
    groupId?: number | string;
    groupName?: string;
    requests?: number;
    totalTokens?: number;
  }>;
  toolRanking?: Array<{
    name?: string;
    count?: number;
  }>;
}

/** Subset of `systeminformation.graphics()` payload that we actually render. */
export interface GraphicsData {
  controllers?: Array<{
    model?: string;
    vendor?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface FrameworkStatus {
  miokuVersion: string;
  miokiVersion: string;
  napcatVersion: string;
  /** Total discovered plugins (enabled + disabled). */
  pluginCount: number;
  /** Currently enabled plugins. */
  pluginEnabled: number;
  /** Number of distinct bot frameworks (deduplicated by app_name). */
  adapterCount: number;
  onlineBotCount: number;
  uptimeMs: number;
  /** Detected JS runtime name: "Bun" / "Node" / "Deno". */
  runtime: string;
  /** Detected JS runtime version. */
  runtimeVersion: string;
}

export interface ResourceStatus {
  cpuPercent: number;
  cpuModel: string;
  /** CPU brand truncated to ~22 chars with ellipsis. */
  cpuModelShort: string;
  /** Human-readable clock, e.g. "2.9 GHz" / "900 MHz". */
  cpuSpeedGHz: string;
  cpuCores: number;
  memPercent: number;
  memUsedGB: number;
  memTotalGB: number;
  /** Buffers + cache as reported by `systeminformation.mem().buffcache`. 0 if unavailable. */
  memBuffCacheGB: number;
  /** 0..100, or 0 if no swap configured. */
  swapPercent: number;
  swapUsedGB: number;
  swapTotalGB: number;
}

export interface NodeRuntimeStatus {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  arrayBuffersMB: number;
  eventLoopDelayMs: { mean: number; p99: number };
  /** null when `--expose-gc` is not enabled. */
  gc:
    | {
        available: boolean;
        count: number;
        lastDurationMs?: number;
      }
    | null;
}

export interface NetworkSample {
  ts: number;
  rxBps: number;
  txBps: number;
}

export interface NetworkStatus {
  rxBps: number;
  txBps: number;
  rxTotalBytes: number;
  txTotalBytes: number;
  /** Last 30 minutes of samples, oldest first. */
  history: NetworkSample[];
}

export interface DiskEntry {
  mount: string;
  usedGB: number;
  totalGB: number;
  percent: number;
}

export interface DiskStatus {
  entries: DiskEntry[];
  readMBps?: number;
  writeMBps?: number;
  iops?: number;
}

/** One GPU as reported by `systeminformation.graphics().controllers`. */
export interface GpuInfo {
  vendor: string;
  model: string;
  /** VRAM in GB. 0 if unknown / integrated. */
  vramGB: number;
}

/** One physical memory module as reported by `systeminformation.memLayout()`. */
export interface MemoryStick {
  bank: string;
  sizeGB: number;
  /** "DDR4" / "DDR5" / "LPDDR5" / "Unknown". */
  type: string;
  /** Transfer rate in MT/s, e.g. 3200 / 4800. 0 if unknown. */
  speedMTs: number;
  manufacturer: string;
  partNum: string;
}

/** BIOS / UEFI firmware info from `systeminformation.bios()`. */
export interface BiosInfo {
  vendor: string;
  version: string;
  releaseDate: string;
}

/** One physical disk drive from `systeminformation.diskLayout()`. */
export interface DiskInfo {
  vendor: string;
  name: string;
  /** "HDD" / "SSD" / "NVMe" / unknown. */
  type: string;
  /** "SATA" / "NVMe" / "USB" / unknown. */
  interfaceType: string;
  sizeGB: number;
}

export interface SystemInfo {
  /** "macOS Sequoia 15.5 (arm64)" / "Ubuntu 24.04 LTS (x86_64)". */
  os: string;
  /** Kernel string, e.g. "Darwin 25.5.0" / "Linux 6.8.0-31-generic". */
  kernel: string;
  /** Full CPU brand from `systeminformation.cpu().brand`. */
  cpu: string;
  /** All GPUs detected, integrated + discrete. Empty if none. */
  gpus: GpuInfo[];
  /** All physical RAM modules. Empty if `memLayout()` not supported (e.g. macOS). */
  memSticks: MemoryStick[];
  /** BIOS / UEFI. vendor "N/A" if not supported. */
  bios: BiosInfo;
  /** System manufacturer + model, e.g. "Supermicro H12SSL-NT". "N/A" on macOS. */
  chassis: string;
  /** All physical disk drives. Empty on systems where `diskLayout()` is
   * not supported (rare) or no drives are detected. */
  disks: DiskInfo[];
}

export interface AIUsageStatsLite {
  available: boolean;
  totalRequests: number;
  errorRate: number;
  cacheHitRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  topGroups: Array<{ name: string; requests: number; totalTokens: number }>;
  topTools: Array<{ name: string; count: number }>;
}

export interface StatusSnapshot {
  generatedAt: number;
  isNightMode: boolean;
  bots: BotAccountStatus[];
  framework: FrameworkStatus;
  resources: ResourceStatus;
  runtime: NodeRuntimeStatus;
  network: NetworkStatus;
  disk: DiskStatus;
  system: SystemInfo;
  ai: AIUsageStatsLite;
}

/** Intent returned by `resolveStatusIntent`. Only "full" or "none" — the panel
 * always renders the complete status; sub-section shortcuts were removed. */
export interface StatusIntentFull {
  type: "full";
}

export interface StatusIntentNone {
  type: "none";
}

export type StatusIntent = StatusIntentFull | StatusIntentNone;
