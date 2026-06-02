import {
  escapeHtml,
  getStatusTheme,
  HELP_BACKGROUND_IMAGE_URL,
} from "../shared";
import type {
  AIUsageStatsLite,
  BotAccountStatus,
  DiskEntry,
  NetworkSample,
  ResourceStatus,
  StatusSnapshot,
} from "./types";

const WIDTH = 760;
const PIE_RADIUS = 44;
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;

function sectionTitle(text: string): string {
  return `<div class="status-section-title"><span>${escapeHtml(text)}</span></div>`;
}

function fmtPercent(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0%";
  }
  if (n > 100) {
    return "100%";
  }
  if (n < 10) {
    return `${n.toFixed(digits)}%`;
  }
  return `${Math.round(n)}%`;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) {
    return "—";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 10_000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString("zh-CN");
}

function fmtBytes(n: number, digits = 2): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0 B";
  }
  if (n >= 1024 ** 3) {
    return `${(n / 1024 ** 3).toFixed(digits)} GB`;
  }
  if (n >= 1024 ** 2) {
    return `${(n / 1024 ** 2).toFixed(digits)} MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(digits)} KB`;
  }
  return `${n.toFixed(0)} B`;
}

function fmtBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) {
    return "0 B/s";
  }
  return `${fmtBytes(bps)}/s`;
}

function fmtUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) {
    return `${days}天${String(hours).padStart(2, "0")}时${String(minutes).padStart(2, "0")}分`;
  }
  if (hours > 0) {
    return `${hours}时${String(minutes).padStart(2, "0")}分`;
  }
  return `${minutes}分`;
}

function progressBar(percent: number, color: string): string {
  const clamped = Math.max(0, Math.min(100, percent));
  return `<div class="status-bar"><div class="status-bar__fill" style="width:${clamped}%;background:${color};"></div></div>`;
}

function progressColor(percent: number, theme: ReturnType<typeof getStatusTheme>): string {
  if (percent >= 85) {
    return "linear-gradient(90deg, #ef4444, #f97316)";
  }
  if (percent >= 65) {
    return "linear-gradient(90deg, #f59e0b, #fbbf24)";
  }
  return `linear-gradient(90deg, ${theme.eyebrow}, ${theme.commandTitle})`;
}

function pieColor(percent: number, theme: ReturnType<typeof getStatusTheme>): string {
  if (percent >= 85) {
    return "#ef4444";
  }
  if (percent >= 65) {
    return "#f59e0b";
  }
  return theme.eyebrow;
}

function renderPieChart(percent: number, theme: ReturnType<typeof getStatusTheme>): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = (clamped / 100) * PIE_CIRCUMFERENCE;
  const rest = PIE_CIRCUMFERENCE - filled;
  const color = pieColor(percent, theme);
  const track = theme.isNightMode
    ? "rgba(125, 211, 197, 0.12)"
    : "rgba(15, 118, 110, 0.12)";
  // If percent is 0 the slice disappears; the caller already substitutes
  // an alternate "未配置" line for SWAP-with-no-swap, but keep the visual
  // graceful by also letting the label fall back to "—".
  const text = clamped <= 0 ? "—" : fmtPercent(percent, 0);
  return `
    <svg viewBox="0 0 110 110" class="status-pie">
      <circle cx="55" cy="55" r="${PIE_RADIUS}" fill="none" stroke="${track}" stroke-width="10"/>
      <circle cx="55" cy="55" r="${PIE_RADIUS}" fill="none" stroke="${color}" stroke-width="10"
        stroke-dasharray="${filled.toFixed(2)} ${rest.toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(-90 55 55)"/>
      <text x="55" y="55" text-anchor="middle" dominant-baseline="central"
        font-size="26" font-weight="800" font-family="SF Mono, monospace"
        fill="${theme.panelTitle}">${escapeHtml(text)}</text>
    </svg>
  `;
}

function renderHero(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const bots = snapshot.bots;

  const accountRows = bots.length === 0
    ? `<div class="status-hero__empty">当前没有在线账号</div>`
    : bots
        .map((bot) => {
          const statusText = bot.online ? "在线" : "离线";
          const statusColor = bot.online ? "#10b981" : "#ef4444";
          const frameworkText =
            bot.appVersion && bot.appVersion !== "unknown"
              ? `${bot.framework} ${bot.appVersion} · 协议 ${bot.protocolVersion}`
              : bot.framework;
          // Nickname is rendered as a bold large heading above the avatar
          // row (not as a chip). Chips below only carry the metadata.
          const tags = [
            { text: String(bot.uin || "—"), kind: "data" },
            { text: statusText, kind: bot.online ? "ok" : "danger" },
            { text: `好友 ${fmtNumber(bot.friendCount)}`, kind: "data" },
            { text: `群聊 ${fmtNumber(bot.groupCount)}`, kind: "data" },
            { text: `运行时长 ${fmtUptime(bot.onlineDurationMs)}`, kind: "data" },
            { text: `收 ${fmtNumber(bot.receive)}`, kind: "data" },
            { text: `发 ${fmtNumber(bot.send)}`, kind: "data" },
            { text: frameworkText, kind: "data" },
          ];
          const tagsHtml = tags
            .map(
              (t) => `<span class="status-chip status-chip--${t.kind}">${escapeHtml(t.text)}</span>`,
            )
            .join("");
          return `
            <div class="status-hero__account">
              <div class="status-hero__account-name">${escapeHtml(bot.nickname)}</div>
              <div class="status-hero__account-body">
                <span class="status-hero__account-avatar-wrap">
                  <img class="status-hero__account-avatar" src="${escapeHtml(bot.avatarUrl)}" alt="${escapeHtml(bot.nickname)}" loading="lazy" onerror="this.style.visibility='hidden'"/>
                  <span class="status-hero__account-avatar-dot" style="background:${statusColor};"></span>
                </span>
                <span class="status-hero__account-tags">${tagsHtml}</span>
              </div>
            </div>
          `;
        })
        .join("");

  return `
    <header class="status-hero">
      <div class="status-hero__content">
        <div class="status-hero__eyebrow">MIOKU STATUS</div>
        <div class="status-hero__accounts">${accountRows}</div>
      </div>
    </header>
  `;
}

function renderResourceCard(
  label: string,
  percent: number,
  lines: string[],
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const linesHtml = lines
    .map(
      (line) =>
        `<div class="status-pie-card__line">${escapeHtml(line)}</div>`,
    )
    .join("");
  return `
    <div class="status-pie-card">
      ${renderPieChart(percent, theme)}
      <div class="status-pie-card__label">${escapeHtml(label)}</div>
      <div class="status-pie-card__lines">${linesHtml}</div>
    </div>
  `;
}

function renderResourcesSection(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const r = snapshot.resources;
  const hasSwap = r.swapTotalGB > 0;
  const cards = [
    renderResourceCard(
      "CPU",
      r.cpuPercent,
      [r.cpuModelShort, `${r.cpuCores} 核 · ${r.cpuSpeedGHz}`],
      theme,
    ),
    renderResourceCard(
      "内存",
      r.memPercent,
      [
        `${r.memUsedGB} / ${r.memTotalGB} GB`,
        r.memBuffCacheGB > 0
          ? `缓存 ${r.memBuffCacheGB} GB`
          : `${snapshot.framework.runtime} 进程视角`,
      ],
      theme,
    ),
    renderResourceCard(
      "SWAP",
      hasSwap ? r.swapPercent : 0,
      hasSwap
        ? [`${r.swapUsedGB} / ${r.swapTotalGB} GB`, `可用 ${Math.max(0, r.swapTotalGB - r.swapUsedGB).toFixed(2)} GB`]
        : ["未配置", ""],
      theme,
    ),
  ].join("");
  return `
    ${sectionTitle("系统性能")}
    <div class="status-pie-grid">${cards}</div>
  `;
}

function renderRuntimeSection(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const r = snapshot.runtime;
  const runtimeName = snapshot.framework.runtime;
  const gc = r.gc;
  const items: Array<{ label: string; value: string }> = [
    { label: "Heap Used", value: fmtBytes(r.heapUsedMB * 1024 ** 2, 1) },
    { label: "Heap Total", value: fmtBytes(r.heapTotalMB * 1024 ** 2, 1) },
    { label: "RSS", value: fmtBytes(r.rssMB * 1024 ** 2, 1) },
    { label: "External", value: fmtBytes(r.externalMB * 1024 ** 2, 1) },
    { label: "ArrayBuffer", value: fmtBytes(r.arrayBuffersMB * 1024 ** 2, 1) },
    { label: "Loop Delay", value: `${r.eventLoopDelayMs.mean.toFixed(2)} ms` },
    { label: "Loop p99", value: `${r.eventLoopDelayMs.p99.toFixed(2)} ms` },
  ];
  // GC count only works under V8 with --expose-gc. Skip the row entirely
  // for Bun (which doesn't expose it) instead of showing a confusing
  // "N/A" tile.
  if (gc && gc.available) {
    items.push({ label: "GC Count", value: `${gc.count} 次` });
  }
  const cardsHtml = items
    .map(
      (it) => `
        <div class="status-runtime-block">
          <div class="status-runtime-block__label">${escapeHtml(it.label)}</div>
          <div class="status-runtime-block__value">${escapeHtml(it.value)}</div>
        </div>
      `,
    )
    .join("");
  return `
    ${sectionTitle(`${runtimeName} Runtime`)}
    <div class="status-runtime-grid">${cardsHtml}</div>
  `;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  // Catmull-Rom → cubic Bézier. The curve passes through every data point
  // (unlike the previous midpoint-based quadratic, which skipped them and
  // visually flattened peaks). Tension 0.5 is the standard Catmull-Rom
  // default; lowering it makes the curve flatter between samples.
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  const tension = 0.35;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
    const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
    const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
    const cp2y = p2.y - (p3.y - p1.y) * tension / 3;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function renderNetworkChart(history: NetworkSample[]): string {
  const w = WIDTH - 56;
  const h = 120;
  const marginL = 56;
  const marginR = 12;
  const marginT = 10;
  const marginB = 22;
  const innerW = w - marginL - marginR;
  const innerH = h - marginT - marginB;

  if (history.length < 2) {
    return `<svg viewBox="0 0 ${w} ${h}" class="status-chart"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#94a3b8" font-size="11">数据采集中…</text></svg>`;
  }

  const maxVal = Math.max(
    1,
    ...history.map((s) => Math.max(s.rxBps, s.txBps)),
  );
  const yMax = maxVal * 1.2;
  const t0 = history[0].ts;
  const t1 = history[history.length - 1].ts;
  const dt = Math.max(1, t1 - t0);

  const xOf = (ts: number) => marginL + ((ts - t0) / dt) * innerW;
  const yOf = (v: number) => marginT + innerH - (v / yMax) * innerH;

  const rxPoints = history.map((s) => ({ x: xOf(s.ts), y: yOf(s.rxBps) }));
  const txPoints = history.map((s) => ({ x: xOf(s.ts), y: yOf(s.txBps) }));

  const rxPath = buildSmoothPath(rxPoints);
  const txPath = buildSmoothPath(txPoints);

  // 用同一条 path 做面积填充（淡色）
  const rxArea =
    rxPoints.length > 0
      ? `${rxPath} L ${rxPoints[rxPoints.length - 1].x.toFixed(2)} ${(marginT + innerH).toFixed(2)} L ${rxPoints[0].x.toFixed(2)} ${(marginT + innerH).toFixed(2)} Z`
      : "";

  // 4 条横向网格
  const gridY: number[] = [];
  for (let i = 0; i <= 3; i++) {
    gridY.push(marginT + (innerH * i) / 3);
  }
  // 6 条竖向网格
  const gridX: number[] = [];
  for (let i = 0; i <= 5; i++) {
    gridX.push(marginL + (innerW * i) / 5);
  }

  const yLabels = gridY
    .map((gy) => {
      const v = ((marginT + innerH - gy) / innerH) * yMax;
      return `<text x="${marginL - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="#94a3b8">${fmtBytes(v)}/s</text>`;
    })
    .join("");
  const xLabels = gridX
    .map((gx) => {
      const tsAt = t0 + ((gx - marginL) / innerW) * dt;
      const minutesAgo = Math.round(((t1 - tsAt) / 60000) * 10) / 10;
      const label = minutesAgo <= 0.1 ? "now" : `-${minutesAgo}m`;
      return `<text x="${gx}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#94a3b8">${label}</text>`;
    })
    .join("");

  const gridLines = gridY
    .map(
      (gy) =>
        `<line x1="${marginL}" y1="${gy}" x2="${marginL + innerW}" y2="${gy}" stroke="rgba(148,163,184,0.18)" stroke-dasharray="2 3"/>`,
    )
    .join("");

  return `
    <svg viewBox="0 0 ${w} ${h}" class="status-chart">
      ${gridLines}
      <path d="${rxArea}" fill="rgba(34, 211, 238, 0.12)" stroke="none"/>
      <path d="${txPath}" fill="none" stroke="#f59e0b" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${rxPath}" fill="none" stroke="#22d3ee" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      ${yLabels}
      ${xLabels}
    </svg>
  `;
}

function renderNetworkSection(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const n = snapshot.network;
  const cells = [
    { label: "↑ 速度", value: fmtBps(n.txBps) },
    { label: "↓ 速度", value: fmtBps(n.rxBps) },
    { label: "↑ 总量", value: fmtBytes(n.txTotalBytes) },
    { label: "↓ 总量", value: fmtBytes(n.rxTotalBytes) },
  ]
    .map(
      (c) => `
        <div class="status-net-cell">
          <div class="status-net-cell__label">${escapeHtml(c.label)}</div>
          <div class="status-net-cell__value">${escapeHtml(c.value)}</div>
        </div>
      `,
    )
    .join("");
  return `
    ${sectionTitle("网络状态 · 最近 30 分钟")}
    <div class="status-chart-wrap">${renderNetworkChart(n.history)}</div>
    <div class="status-net-grid">${cells}</div>
  `;
}

function renderDiskSection(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const disk = snapshot.disk;
  if (!disk.entries || disk.entries.length === 0) {
    return `
      ${sectionTitle("磁盘状态")}
      <div class="status-empty">磁盘信息不可用</div>
    `;
  }
  const bars = disk.entries
    .map((entry: DiskEntry) => {
      return `
        <div class="status-disk-row">
          <div class="status-disk-row__head">
            <span class="status-disk-row__mount">${escapeHtml(entry.mount)}</span>
            <span class="status-disk-row__usage">${entry.usedGB}GB / ${entry.totalGB}GB · ${fmtPercent(entry.percent)}</span>
          </div>
          ${progressBar(entry.percent, progressColor(entry.percent, theme))}
        </div>
      `;
    })
    .join("");
  return `
    ${sectionTitle("磁盘状态")}
    <div class="status-disk-list">${bars}</div>
  `;
}

function renderSystemSection(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const s = snapshot.system;
  const r = snapshot.resources;
  // Horizontal layout: label and value on the same row, label fixed-width
  // on the left, value monospace on the right. Multi-GPU / multi-stick get
  // their own row with an indexed label (e.g. "显卡 1", "内存条 2").
  const items: Array<{ label: string; value: string }> = [];

  items.push({ label: "OS", value: s.os });
  items.push({ label: "内核", value: s.kernel });
  items.push({ label: "处理器", value: `${s.cpu} · ${r.cpuCores} 核` });

  // GPUs: list every controller. Many systems have an integrated + discrete
  // pair (Apple Silicon + eGPU, Intel iGPU + NVIDIA dGPU). vramGB is 0 for
  // integrated / unknown, in which case we skip the vram suffix.
  if (s.gpus.length === 0) {
    items.push({ label: "显卡", value: "N/A" });
  } else {
    s.gpus.forEach((g, i) => {
      const vram = g.vramGB > 0 ? ` · ${g.vramGB} GB` : "";
      const vendor = g.vendor && g.vendor !== g.model ? `${g.vendor} ` : "";
      items.push({
        label: `显卡 ${i + 1}`,
        value: `${vendor}${g.model}${vram}`.trim(),
      });
    });
  }

  // Memory sticks: memLayout() is Linux/Win only. macOS returns [] and we
  // surface "N/A" rather than hide the row. Headline on the value side;
  // part number is appended inline when present.
  if (s.memSticks.length === 0) {
    items.push({ label: "内存条", value: "N/A" });
  } else {
    s.memSticks.forEach((m, i) => {
      const size =
        m.sizeGB >= 1
          ? `${m.sizeGB} GB`
          : `${(m.sizeGB * 1024).toFixed(0)} MB`;
      const speed = m.speedMTs > 0 ? ` · ${m.speedMTs} MT/s` : "";
      const manu =
        m.manufacturer && m.manufacturer !== "Manufacturer"
          ? `${m.manufacturer} `
          : "";
      const bank = m.bank && m.bank !== "BANK 0" ? `${m.bank} · ` : "";
      const headline = `${bank}${manu}${m.type} ${size}${speed}`.trim();
      const value =
        m.partNum && m.partNum !== "Unknown" && m.partNum !== "00000000"
          ? `${headline} · PN ${m.partNum}`
          : headline;
      items.push({
        label: `内存条 ${i + 1}`,
        value,
      });
    });
  }

  const biosDate = s.bios.releaseDate ? ` · ${s.bios.releaseDate}` : "";
  items.push({
    label: "BIOS",
    value: `${s.bios.vendor} ${s.bios.version}${biosDate}`.trim(),
  });

  // Physical disk drives. Show vendor + name + type + size. On a typical
  // server this might be "Samsung SSD 990 PRO 2TB · NVMe"; on macOS disk
  // details are often hidden so we fall back to size only.
  if (s.disks.length === 0) {
    items.push({ label: "硬盘", value: "N/A" });
  } else {
    s.disks.forEach((d, i) => {
      const sizeLabel =
        d.sizeGB >= 1000
          ? `${(d.sizeGB / 1000).toFixed(1)} TB`
          : `${d.sizeGB} GB`;
      const vendor = d.vendor && d.vendor !== d.name ? `${d.vendor} ` : "";
      const name = d.name || d.type || "Unknown";
      const iface = d.interfaceType && d.interfaceType !== "Unknown" ? ` · ${d.interfaceType}` : "";
      items.push({
        label: `硬盘 ${i + 1}`,
        value: `${vendor}${name} · ${sizeLabel}${iface}`.trim(),
      });
    });
  }

  items.push({ label: "主机", value: s.chassis });

  const itemsHtml = items
    .map(
      ({ label, value }) => `
        <div class="status-sys-row">
          <span class="status-sys-row__label">${escapeHtml(label)}</span>
          <span class="status-sys-row__value">${escapeHtml(value)}</span>
        </div>
      `,
    )
    .join("");
  return `
    ${sectionTitle("系统信息")}
    <div class="status-sys-list">${itemsHtml}</div>
  `;
}

function renderRankingBars(
  items: Array<{ name: string; value: number }>,
  formatValue: (n: number) => string,
  color: string,
): string {
  if (items.length === 0) {
    return `<div class="status-empty">暂无数据</div>`;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  return items
    .map((item) => {
      const percent = Math.max(2, (item.value / max) * 100);
      return `
        <div class="status-rank-row">
          <div class="status-rank-row__name">${escapeHtml(item.name)}</div>
          <div class="status-rank-row__bar">
            <div class="status-rank-row__fill" style="width:${percent}%;background:${color};"></div>
          </div>
          <div class="status-rank-row__value">${escapeHtml(formatValue(item.value))}</div>
        </div>
      `;
    })
    .join("");
}

function renderAISection(
  ai: AIUsageStatsLite,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  if (!ai.available) {
    return `
      ${sectionTitle("AI 统计 · 近 7 天")}
      <div class="status-empty">AI 统计暂不可用</div>
    `;
  }
  const totals = [
    { label: "请求数", value: fmtNumber(ai.totalRequests) },
    { label: "错误率", value: fmtPercent(ai.errorRate * 100) },
    { label: "缓存命中", value: fmtPercent(ai.cacheHitRate * 100) },
    { label: "输入 Token", value: fmtNumber(ai.inputTokens) },
    { label: "输出 Token", value: fmtNumber(ai.outputTokens) },
    { label: "总 Token", value: fmtNumber(ai.totalTokens) },
  ];
  const totalsHtml = totals
    .map(
      (t) => `
        <div class="status-kv">
          <div class="status-kv__label">${escapeHtml(t.label)}</div>
          <div class="status-kv__value">${escapeHtml(t.value)}</div>
        </div>
      `,
    )
    .join("");
  const toolsColor = theme.isNightMode
    ? "linear-gradient(90deg, #38bdf8, #7ee7dd)"
    : "linear-gradient(90deg, #22d3ee, #38bdf8)";
  const toolsHtml = renderRankingBars(
    ai.topTools.map((t) => ({ name: t.name, value: t.count })),
    (n) => fmtNumber(n),
    toolsColor,
  );
  return `
    ${sectionTitle("AI 统计 · 近 7 天")}
    <div class="status-kv-grid">${totalsHtml}</div>
    <div class="status-rank-block">
      <div class="status-rank-block__title">工具调用排名</div>
      ${toolsHtml}
    </div>
  `;
}

function buildStyle(theme: ReturnType<typeof getStatusTheme>): string {
  return `
    <style>
      .status-sheet {
        position: relative;
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        background: ${theme.pageBg};
        color: ${theme.panelTitle};
        font-family: "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif;
        overflow: hidden;
      }
      .status-sheet::before,
      .status-sheet::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .status-sheet::before { background: ${theme.pageAccent}; }
      .status-sheet::after {
        background-image: ${theme.pageGrid};
        background-size: 28px 28px;
        opacity: ${theme.isNightMode ? "0.55" : "0.35"};
      }
      .status-sheet__scene,
      .status-sheet__scene-image,
      .status-sheet__scene-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .status-sheet__scene { z-index: 0; overflow: hidden; }
      .status-sheet__scene-image {
        background-image: url("${HELP_BACKGROUND_IMAGE_URL}");
        background-size: cover;
        background-position: center center;
        opacity: ${theme.sceneOpacity};
        filter: ${theme.sceneFilter};
        transform: scale(1.06);
      }
      .status-sheet__scene-overlay {
        background: ${theme.sceneGlow}, ${theme.sceneMask};
      }
      .status-shell {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 14px;
        border-radius: 30px;
        border: 1px solid ${theme.shellBorder};
        box-shadow: ${theme.shellShadow};
        padding: 14px;
        background: ${theme.shellBg};
        backdrop-filter: blur(10px) saturate(1.06);
      }
      .status-hero {
        position: relative;
        display: block;
        padding: 18px;
        border-radius: 24px;
        border: 1px solid ${theme.heroBorder};
        background: ${theme.heroBg};
        overflow: hidden;
      }
      .status-hero::before {
        content: "";
        position: absolute;
        inset: auto auto -42px -32px;
        width: 180px;
        height: 180px;
        border-radius: 999px;
        background: ${theme.heroGlow};
        filter: blur(4px);
      }
      .status-hero__content { position: relative; z-index: 1; }
      .status-hero__eyebrow {
        margin-bottom: 12px;
        padding-bottom: 10px;
        font-size: 18px;
        font-weight: 900;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
        border-bottom: 1px solid ${theme.isNightMode ? "rgba(126, 231, 221, 0.45)" : "rgba(15, 118, 110, 0.45)"};
      }
      .status-hero__accounts {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .status-hero__account {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 0;
        /* Light-green hairline separator between accounts. The first account
         * stays flush (no top line); each subsequent one gets the divider. */
        border-top: 1px solid ${theme.isNightMode ? "rgba(126, 231, 221, 0.45)" : "rgba(15, 118, 110, 0.45)"};
      }
      .status-hero__account:first-child {
        border-top: 0;
        padding-top: 4px;
      }
      .status-hero__account-name {
        font-size: 18px;
        font-weight: 800;
        line-height: 1.15;
        color: ${theme.title};
        letter-spacing: -0.005em;
        word-break: break-word;
      }
      .status-hero__account-body {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .status-hero__account-avatar-wrap {
        position: relative;
        width: 88px;
        height: 88px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .status-hero__account-avatar {
        width: 84px;
        height: 84px;
        border-radius: 50%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        border: 2px solid ${theme.tagBorder};
        background: ${theme.panelBg};
        box-shadow: 0 0 0 3px ${theme.panelBg}, 0 0 0 4px ${theme.eyebrow}33;
        display: block;
      }
      .status-hero__account-avatar-dot {
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        border: 2px solid ${theme.panelBg};
        box-sizing: border-box;
      }
      .status-hero__account-tags {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .status-hero__empty {
        font-size: 12px;
        color: ${theme.emptyText};
        text-align: center;
        padding: 8px 0;
      }
      .status-dot {
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 999px;
      }
      .status-chip {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 700;
        font-family: "SF Mono", monospace;
        background: ${theme.tagBg};
        color: ${theme.tagText};
        border: 1px solid ${theme.tagBorder};
      }
      .status-chip--ok {
        background: rgba(16, 185, 129, 0.16);
        color: #10b981;
        border-color: rgba(16, 185, 129, 0.32);
      }
      .status-chip--danger {
        background: rgba(239, 68, 68, 0.16);
        color: #ef4444;
        border-color: rgba(239, 68, 68, 0.32);
      }
      .status-section-title {
        display: flex;
        align-items: center;
        margin: 6px 4px 0;
      }
      .status-section-title span {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
      }
      .status-empty {
        padding: 18px;
        text-align: center;
        font-size: 12px;
        color: ${theme.emptyText};
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px dashed ${theme.panelBorder};
      }
      .status-kv-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      .status-kv {
        padding: 12px 14px;
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-kv__label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
      }
      .status-kv__value {
        margin-top: 6px;
        font-family: "SF Mono", monospace;
        font-size: 16px;
        font-weight: 800;
        color: ${theme.panelTitle};
      }
      .status-pie-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
      }
      .status-pie-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 16px 12px 14px;
        border-radius: 18px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-pie { width: 100px; height: 100px; }
      .status-pie-card__label {
        margin-top: 2px;
        font-size: 16px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: ${theme.panelTitle};
      }
      .status-pie-card__lines {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        margin-top: 2px;
        text-align: center;
      }
      .status-pie-card__line {
        font-size: 10.5px;
        line-height: 1.4;
        color: ${theme.panelDesc};
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status-bar {
        height: 6px;
        border-radius: 999px;
        background: ${theme.commandBg};
        overflow: hidden;
      }
      .status-bar__fill { height: 100%; border-radius: 999px; }
      .status-runtime-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
      }
      .status-runtime-block {
        padding: 12px 14px;
        border-radius: 14px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .status-runtime-block__label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
      }
      .status-runtime-block__value {
        font-family: "SF Mono", monospace;
        font-size: 14px;
        font-weight: 800;
        color: ${theme.panelTitle};
      }
      .status-sys-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px 14px;
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-sys-row {
        display: flex;
        align-items: baseline;
        gap: 12px;
        font-size: 12px;
        line-height: 1.45;
      }
      .status-sys-row__label {
        flex: 0 0 64px;
        font-size: 11px;
        font-weight: 700;
        color: ${theme.eyebrow};
        letter-spacing: 0.04em;
      }
      .status-sys-row__value {
        flex: 1 1 auto;
        min-width: 0;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 12px;
        font-weight: 700;
        color: ${theme.panelTitle};
        word-break: break-all;
      }
      .status-disk-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px 14px;
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-chart-wrap {
        padding: 8px 12px;
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-chart { display: block; width: 100%; height: 120px; }
      .status-net-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-top: 8px;
      }
      .status-net-cell {
        padding: 10px 12px;
        border-radius: 14px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
      }
      .status-net-cell__label {
        font-size: 10px;
        font-weight: 700;
        color: ${theme.eyebrow};
        letter-spacing: 0.08em;
      }
      .status-net-cell__value {
        margin-top: 4px;
        font-family: "SF Mono", monospace;
        font-size: 13px;
        font-weight: 800;
        color: ${theme.panelTitle};
      }
      .status-disk-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 0;
        border-bottom: 1px dashed ${theme.divider};
      }
      .status-disk-row:last-child { border-bottom: none; }
      .status-disk-row__head {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
      }
      .status-disk-row__mount {
        font-family: "SF Mono", monospace;
        color: ${theme.panelTitle};
        font-weight: 700;
      }
      .status-disk-row__usage {
        color: ${theme.panelDesc};
        font-family: "SF Mono", monospace;
      }
      .status-rank-block {
        padding: 12px 14px;
        border-radius: 16px;
        background: ${theme.panelBg};
        border: 1px solid ${theme.panelBorder};
        margin-top: 8px;
      }
      .status-rank-block__title {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
        margin-bottom: 8px;
      }
      .status-rank-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 5px 0;
      }
      .status-rank-row__name {
        flex: 0 0 130px;
        font-size: 12px;
        color: ${theme.panelTitle};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status-rank-row__bar {
        flex: 1;
        height: 8px;
        background: ${theme.commandBg};
        border-radius: 999px;
        overflow: hidden;
      }
      .status-rank-row__fill { height: 100%; border-radius: 999px; }
      .status-rank-row__value {
        flex: 0 0 70px;
        text-align: right;
        font-family: "SF Mono", monospace;
        font-size: 11px;
        color: ${theme.panelDesc};
      }
      .status-footer {
        display: flex;
        align-items: stretch;
        gap: 0;
        border-radius: 20px;
        border: 1px solid ${theme.footerBorder};
        background: ${theme.footerBg};
        overflow: hidden;
      }
      .status-footer__item {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
      }
      .status-footer__item + .status-footer__item {
        border-left: 1px solid ${theme.divider};
      }
      .status-footer__icon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: 12px;
        background: ${theme.isNightMode ? "rgba(126, 231, 221, 0.08)" : "rgba(15, 118, 110, 0.08)"};
        color: ${theme.eyebrow};
        font-size: 18px;
      }
      .status-footer__text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .status-footer__label {
        font-size: 11px;
        line-height: 1.4;
        color: ${theme.footerLabel};
      }
      .status-footer__value {
        margin-top: 2px;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 12px;
        line-height: 1.45;
        font-weight: 700;
        color: ${theme.footerText};
      }
    </style>
  `;
}

function renderFooter(
  snapshot: StatusSnapshot,
  theme: ReturnType<typeof getStatusTheme>,
): string {
  const fw = snapshot.framework;
  const runtimeLabel = `${fw.runtime} ${fw.runtimeVersion}`;
  return `
    <footer class="status-footer">
      <div class="status-footer__item">
        <div class="status-footer__icon">⚡</div>
        <div class="status-footer__text">
          <div class="status-footer__label">Framework</div>
          <div class="status-footer__value">Mioki ${escapeHtml(fw.miokiVersion)}</div>
        </div>
      </div>
      <div class="status-footer__item">
        <div class="status-footer__icon">🚀</div>
        <div class="status-footer__text">
          <div class="status-footer__label">Platform</div>
          <div class="status-footer__value">Mioku ${escapeHtml(fw.miokuVersion)}</div>
        </div>
      </div>
      <div class="status-footer__item">
        <div class="status-footer__icon">🥟</div>
        <div class="status-footer__text">
          <div class="status-footer__label">Runtime</div>
          <div class="status-footer__value">${escapeHtml(runtimeLabel)}</div>
        </div>
      </div>
    </footer>
  `;
}

export function renderStatusHtml(snapshot: StatusSnapshot): string {
  const theme = getStatusTheme(snapshot.isNightMode);
  const body = [
    renderResourcesSection(snapshot, theme),
    renderNetworkSection(snapshot, theme),
    renderRuntimeSection(snapshot, theme),
    renderDiskSection(snapshot, theme),
    renderAISection(snapshot.ai, theme),
    renderSystemSection(snapshot, theme),
  ].join("\n");
  return `
    ${buildStyle(theme)}
    <div class="status-sheet">
      <div class="status-sheet__scene">
        <div class="status-sheet__scene-image"></div>
        <div class="status-sheet__scene-overlay"></div>
      </div>
      <div class="status-shell">
        ${renderHero(snapshot, theme)}
        ${body}
        ${renderFooter(snapshot, theme)}
      </div>
    </div>
  `;
}
