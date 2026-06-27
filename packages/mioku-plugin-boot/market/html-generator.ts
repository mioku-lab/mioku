import {
  getMarketTheme,
  MARKET_BACKGROUND_IMAGE_URL,
} from "./theme";
import type { MarketItem } from "../system/package-manager";

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ItemStatus {
  label: string;
  bg: string;
  text: string;
}

function resolveStatus(item: MarketItem, theme: ReturnType<typeof getMarketTheme>): ItemStatus {
  if (!item.installed) {
    return {
      label: "未安装",
      bg: theme.badgeMissingBg,
      text: theme.badgeMissingText,
    };
  }
  if (item.hasUpdate) {
    return {
      label: "可更新",
      bg: theme.badgeUpdateBg,
      text: theme.badgeUpdateText,
    };
  }
  return {
    label: "已安装",
    bg: theme.badgeInstalledBg,
    text: theme.badgeInstalledText,
  };
}

function renderCard(item: MarketItem, theme: ReturnType<typeof getMarketTheme>): string {
  const status = resolveStatus(item, theme);
  const tagsHtml = item.tags.length
    ? `<div class="market-tags">${item.tags
        .map(
          (tag) =>
            `<span class="market-tag">${escapeHtml(tag)}</span>`,
        )
        .join("")}</div>`
    : "";

  const versionLine = item.installed
    ? `当前 <b>${escapeHtml(item.installedVersion)}</b>${
        item.latest
          ? ` · 最新 <b>${escapeHtml(item.latest)}</b>`
          : ""
      }`
    : `未安装${item.latest ? ` · 最新 <b>${escapeHtml(item.latest)}</b>` : ""}`;

  return `
    <section class="market-card">
      <div class="market-card__head">
        <h3 class="market-card__title">${escapeHtml(item.name)}</h3>
        <span class="market-badge" style="background:${status.bg};color:${status.text};">${status.label}</span>
      </div>
      <p class="market-card__desc">${escapeHtml(item.description)}</p>
      <div class="market-card__version">${versionLine}</div>
      ${tagsHtml}
    </section>
  `;
}

export function generateMarketHtml(options: {
  items: MarketItem[];
  isNightMode: boolean;
  kind: "plugin" | "service";
  botAvatarUrl?: string;
  miokuVersion?: string;
}): string {
  const { items, isNightMode, kind, botAvatarUrl, miokuVersion } = options;
  const theme = getMarketTheme(isNightMode);
  const backgroundImageUrl = MARKET_BACKGROUND_IMAGE_URL;
  const heroTitle = kind === "plugin" ? "插件市场" : "服务市场";
  const noun = kind === "plugin" ? "插件" : "服务";
  const installedCount = items.filter((i) => i.installed).length;
  const heroSubtitle = `共 ${items.length} 个${noun}，已安装 ${installedCount} 个`;
  const installHint = `使用 /install ${kind} <名称> 安装${noun}`;
  const avatarSrc = botAvatarUrl || "";

  const cardsHtml = items.length
    ? items.map((item) => renderCard(item, theme)).join("")
    : `<p class="market-empty">暂无可用${noun}</p>`;

  return `
    <style>
      .market-sheet {
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        position: relative;
        overflow: hidden;
        background: ${theme.pageBg};
        color: ${theme.panelTitle};
        font-family: "SF Pro Display", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif;
      }
      .market-sheet::before,
      .market-sheet::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .market-sheet::before { background: ${theme.pageAccent}; }
      .market-sheet::after {
        background-image: ${theme.pageGrid};
        background-size: 28px 28px;
        opacity: ${isNightMode ? "0.55" : "0.35"};
      }
      .market-sheet__scene,
      .market-sheet__scene-image,
      .market-sheet__scene-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .market-sheet__scene { z-index: 0; overflow: hidden; }
      .market-sheet__scene-image {
        background-image: url("${backgroundImageUrl}");
        background-size: cover;
        background-position: center center;
        opacity: ${theme.sceneOpacity};
        filter: ${theme.sceneFilter};
        transform: scale(1.06);
      }
      .market-sheet__scene-overlay { background: ${theme.sceneGlow}, ${theme.sceneMask}; }
      .market-shell {
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
      .market-hero {
        position: relative;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 18px;
        border-radius: 24px;
        border: 1px solid ${theme.heroBorder};
        background: ${theme.heroBg};
        overflow: hidden;
      }
      .market-hero__hint {
        position: absolute;
        bottom: 18px;
        right: 18px;
        z-index: 1;
        margin: 0;
        max-width: 230px;
        text-align: right;
        font-size: 11px;
        line-height: 1.5;
        color: ${theme.subtitle};
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
      }
      .market-hero::before {
        content: "";
        position: absolute;
        inset: auto auto -42px -32px;
        width: 180px;
        height: 180px;
        border-radius: 999px;
        background: ${theme.heroGlow};
        filter: blur(4px);
      }
      .market-hero__logo {
        position: relative;
        z-index: 1;
        width: 84px;
        height: 84px;
        flex-shrink: 0;
        border-radius: 999px;
        overflow: hidden;
        background: ${isNightMode ? "rgba(126,231,221,0.08)" : "rgba(15,118,110,0.08)"};
        display: grid;
        place-items: center;
        font-size: 34px;
      }
      .market-hero__logo img { width: 100%; height: 100%; object-fit: cover; border-radius: 999px; }
      .market-hero__content { position: relative; z-index: 1; min-width: 0; }
      .market-hero__eyebrow {
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
      }
      .market-hero__title {
        margin: 0;
        font-size: 32px;
        line-height: 1.06;
        font-weight: 900;
        letter-spacing: -0.04em;
        color: ${theme.title};
      }
      .market-hero__subtitle {
        margin: 10px 0 0;
        font-size: 13px;
        line-height: 1.6;
        color: ${theme.subtitle};
      }
      .market-grid { column-count: 2; column-gap: 12px; }
      .market-card {
        break-inside: avoid;
        margin-bottom: 12px;
        border-radius: 20px;
        border: 1px solid ${theme.panelBorder};
        background: ${theme.panelBg};
        box-shadow: ${theme.panelShadow};
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .market-card__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
      }
      .market-card__title {
        margin: 0;
        font-size: 16px;
        font-weight: 800;
        color: ${theme.panelTitle};
        word-break: break-word;
      }
      .market-badge {
        flex-shrink: 0;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
      }
      .market-card__desc {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: ${theme.panelDesc};
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .market-card__version {
        font-size: 11px;
        line-height: 1.5;
        color: ${theme.versionText};
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
      }
      .market-card__version b { color: ${theme.panelTitle}; font-weight: 700; }
      .market-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .market-tag {
        padding: 2px 8px;
        border-radius: 10px;
        border: 1px solid ${theme.tagBorder};
        background: ${theme.tagBg};
        color: ${theme.tagText};
        font-size: 10px;
        font-weight: 700;
      }
      .market-empty {
        padding: 30px 16px;
        text-align: center;
        font-size: 13px;
        color: ${theme.emptyText};
      }
      .market-footer {
        display: flex;
        align-items: stretch;
        gap: 0;
        border-radius: 20px;
        border: 1px solid ${theme.footerBorder};
        background: ${theme.footerBg};
        overflow: hidden;
      }
      .market-footer__item {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
      }
      .market-footer__item + .market-footer__item { border-left: 1px solid ${theme.divider}; }
      .market-footer__icon {
        width: 36px; height: 36px; flex-shrink: 0;
        display: grid; place-items: center;
        border-radius: 12px;
        background: ${isNightMode ? "rgba(126,231,221,0.08)" : "rgba(15,118,110,0.08)"};
        color: ${theme.eyebrow};
        font-size: 18px;
      }
      .market-footer__label { font-size: 11px; line-height: 1.4; color: ${theme.footerLabel}; }
      .market-footer__value {
        margin-top: 2px;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 12px; font-weight: 700; color: ${theme.footerText};
      }
    </style>
    <div class="market-sheet">
      <div class="market-sheet__scene">
        <div class="market-sheet__scene-image"></div>
        <div class="market-sheet__scene-overlay"></div>
      </div>
      <div class="market-shell">
        <header class="market-hero">
          <div class="market-hero__logo">
            ${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="logo" />` : "🛍️"}
          </div>
          <div class="market-hero__content">
            <div class="market-hero__eyebrow">Mioku Store</div>
            <h1 class="market-hero__title">${escapeHtml(heroTitle)}</h1>
            <p class="market-hero__subtitle">${escapeHtml(heroSubtitle)}</p>
          </div>
          <p class="market-hero__hint">${escapeHtml(installHint)}</p>
        </header>
        <main class="market-grid">${cardsHtml}</main>
        <footer class="market-footer">
          <div class="market-footer__item">
            <div class="market-footer__icon">📦</div>
            <div>
              <div class="market-footer__label">来源</div>
              <div class="market-footer__value">npm · mioku-lab</div>
            </div>
          </div>
          <div class="market-footer__item">
            <div class="market-footer__icon">🚀</div>
            <div>
              <div class="market-footer__label">Platform</div>
              <div class="market-footer__value">Mioku ${escapeHtml(miokuVersion || "unknown")}</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  `;
}
