/**
 * Render the help image HTML.
 *
 * The output is a complete HTML document with inline CSS, designed to be
 * piped through the screenshot service at 760px wide, fullPage.
 *
 * Two layouts are produced:
 * - Overview (default): 2-column grid of all plugins, each as a compact
 *   card with command tags.
 * - Detail (when `targetPluginName` matches): single full-width card with
 *   every command expanded (description, role badge, optional usage).
 */

import type { CommandRole, PluginHelp } from "mioku";
import { botConfig } from "mioki";
import { escapeHtml } from "../utils";
import { getHelpTheme, HELP_BACKGROUND_IMAGE_URL } from "../theme";
import { getRenderableEntries } from "./intent";
import { ROLE_CONFIG } from "./role-config";
import type { HelpRenderableEntry } from "./types";

function resolvePrefixPlaceholder(cmd: string): string {
  const value = String(cmd || "");
  if (value.startsWith("?")) {
    return `${botConfig.prefix ?? "#"}${value.slice(1)}`;
  }
  return value;
}

function renderRoleBadge(
  role: CommandRole,
  isNightMode: boolean,
): string {
  const config = ROLE_CONFIG[role];
  if (!config) {
    return "";
  }

  const background = isNightMode ? config.badgeBgDark : config.badgeBgLight;
  const border = isNightMode ? config.badgeBorderDark : config.badgeBorderLight;
  const color = isNightMode ? config.badgeTextDark : config.badgeTextLight;

  return `<span class="help-role" style="background: ${background}; border-color: ${border}; color: ${color};">${config.label}</span>`;
}

function renderPluginOverview(entry: HelpRenderableEntry): string {
  const commandTags = entry.commands
    .map(
      (command) =>
        `<span class="help-command-tag" title="${escapeHtml(command.desc || "")}" >${escapeHtml(resolvePrefixPlaceholder(command.cmd))}</span>`,
    )
    .join("");

  return `
    <section class="help-plugin help-plugin--overview">
      <div class="help-plugin__head">
        <div class="help-plugin__title-row">
          <h3 class="help-plugin__title">${escapeHtml(entry.title)}</h3>
          <span class="help-plugin__alias">${escapeHtml(entry.pluginName)}</span>
        </div>
        <p class="help-plugin__desc">${escapeHtml(entry.description || "暂无插件简介")}</p>
      </div>
      ${
        entry.commands.length > 0
          ? `<div class="help-plugin__body"><div class="help-command-tags">${commandTags}</div></div>`
          : `<p class="help-plugin__empty">暂无命令</p>`
      }
    </section>
  `;
}

function renderPluginDetail(
  entry: HelpRenderableEntry,
  isNightMode: boolean,
): string {
  const commandsHtml = entry.commands
    .map((command) => {
      const roleBadge = command.role
        ? renderRoleBadge(command.role as CommandRole, isNightMode)
        : "";

      return `
        <div class="help-command">
          <div class="help-command__top">
            <div class="help-command__name">${escapeHtml(resolvePrefixPlaceholder(command.cmd))}</div>
            ${roleBadge}
          </div>
          <div class="help-command__desc">${escapeHtml(command.desc || "")}</div>
          ${
            command.usage
              ? `<div class="help-command__usage">示例：<code>${escapeHtml(command.usage)}</code></div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  return `
    <section class="help-plugin help-plugin--detail">
      <div class="help-plugin__head">
        <div class="help-plugin__title-row">
          <h3 class="help-plugin__title">${escapeHtml(entry.title)}</h3>
          <span class="help-plugin__alias">${escapeHtml(entry.pluginName)}</span>
        </div>
        <p class="help-plugin__desc">${escapeHtml(entry.description || "暂无插件简介")}</p>
      </div>
      ${
        entry.commands.length > 0
          ? `<div class="help-plugin__body">${commandsHtml}</div>`
          : `<p class="help-plugin__empty">暂无命令</p>`
      }
    </section>
  `;
}

/**
 * Build the full help image HTML. `targetPluginName` switches the
 * renderer to detail mode for that plugin (no-op if the name doesn't
 * match anything in `helpMap`).
 *
 * `viewerRole` filters out commands the requesting user can't invoke,
 * so the image only surfaces what they can actually run.
 */
export function generateHelpHtml(
  helpMap: Map<string, PluginHelp>,
  isNightMode: boolean,
  miokiVersion: string = "unknown",
  miokuVersion: string = "unknown",
  botNickname: string = "Mioku Bot",
  botAvatarUrl?: string,
  targetPluginName?: string,
  viewerRole: CommandRole = "master",
): string {
  const entries = getRenderableEntries(helpMap, viewerRole);
  const selectedEntry = targetPluginName
    ? entries.find((entry) => entry.pluginName === targetPluginName)
    : undefined;

  const isDetailMode = Boolean(selectedEntry);
  const logoPath = "../../plugins/help/source/miku.png";
  const avatarSrc = botAvatarUrl || logoPath;
  const backgroundImageUrl = HELP_BACKGROUND_IMAGE_URL;
  const theme = getHelpTheme(isNightMode);

  const pluginsHtml = isDetailMode
    ? renderPluginDetail(selectedEntry!, isNightMode)
    : entries.map((entry) => renderPluginOverview(entry)).join("");

  const heroTitle = isDetailMode
    ? `${botNickname} · ${selectedEntry!.title}`
    : botNickname;
  const heroSubtitle = isDetailMode
    ? `${selectedEntry!.pluginName} 插件，共 ${selectedEntry!.commands.length} 条命令`
    : `共 ${entries.length} 个插件 发送 <插件名>帮助查看详细信息`;

  return `
    <style>
      .help-sheet {
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

      .help-sheet::before,
      .help-sheet::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .help-sheet::before {
        background: ${theme.pageAccent};
      }

      .help-sheet::after {
        background-image: ${theme.pageGrid};
        background-size: 28px 28px;
        opacity: ${isNightMode ? "0.55" : "0.35"};
      }

      .help-sheet__scene,
      .help-sheet__scene-image,
      .help-sheet__scene-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .help-sheet__scene {
        z-index: 0;
        overflow: hidden;
      }

      .help-sheet__scene-image {
        background-image: url("${backgroundImageUrl}");
        background-size: cover;
        background-position: center center;
        opacity: ${theme.sceneOpacity};
        filter: ${theme.sceneFilter};
        transform: scale(1.06);
      }

      .help-sheet__scene-overlay {
        background: ${theme.sceneGlow}, ${theme.sceneMask};
      }

      .help-shell {
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

      .help-hero {
        position: relative;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 18px 18px 16px;
        border-radius: 24px;
        border: 1px solid ${theme.heroBorder};
        background: ${theme.heroBg};
        overflow: hidden;
      }

      .help-hero::before {
        content: "";
        position: absolute;
        inset: auto auto -42px -32px;
        width: 180px;
        height: 180px;
        border-radius: 999px;
        background: ${theme.heroGlow};
        filter: blur(4px);
      }

      .help-hero::after {
        content: "";
        position: absolute;
        inset: -70px -50px auto auto;
        width: 220px;
        height: 220px;
        border-radius: 999px;
        background: ${theme.heroGlow};
        filter: blur(18px);
      }

      .help-hero__logo {
        position: relative;
        z-index: 1;
        width: 92px;
        height: 92px;
        flex-shrink: 0;
        border-radius: 999px;
        overflow: hidden;
      }

      .help-hero__logo img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 999px;
        box-shadow: 0 10px 24px ${isNightMode ? "rgba(0, 0, 0, 0.32)" : "rgba(15, 61, 71, 0.14)"};
      }

      .help-hero__content {
        position: relative;
        z-index: 1;
        min-width: 0;
      }

      .help-hero__eyebrow {
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: ${theme.eyebrow};
      }

      .help-hero__title {
        margin: 0;
        font-size: 34px;
        line-height: 1.06;
        font-weight: 900;
        letter-spacing: -0.04em;
        color: ${theme.title};
      }

      .help-hero__subtitle {
        margin: 10px 0 0;
        max-width: 520px;
        font-size: 13px;
        line-height: 1.6;
        color: ${theme.subtitle};
      }

      .help-grid {
        column-count: 2;
        column-gap: 12px;
      }

      .help-detail {
        display: block;
      }

      .help-plugin {
        display: flex;
        flex-direction: column;
        min-height: 0;
        border-radius: 20px;
        border: 1px solid ${theme.panelBorder};
        background: ${theme.panelBg};
        box-shadow: ${theme.panelShadow};
        overflow: hidden;
        break-inside: avoid;
        margin-bottom: 12px;
      }

      .help-plugin__head {
        padding: 14px 14px 12px;
        border-bottom: 1px solid ${theme.panelBorder};
      }

      .help-plugin__title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .help-plugin__title {
        margin: 0;
        min-width: 0;
        font-size: 16px;
        line-height: 1.25;
        font-weight: 800;
        color: ${theme.panelTitle};
        word-break: break-word;
      }

      .help-plugin__alias {
        flex-shrink: 0;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid ${theme.tagBorder};
        background: ${theme.tagBg};
        color: ${theme.tagText};
        font-size: 11px;
        line-height: 1.5;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-weight: 700;
      }

      .help-plugin__desc {
        margin: 8px 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: ${theme.panelDesc};
      }

      .help-plugin__body {
        padding: 10px;
      }

      .help-plugin__empty {
        padding: 20px 16px;
        text-align: center;
        font-size: 12px;
        color: ${theme.emptyText};
      }

      .help-command-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .help-command-tag {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 4px 9px;
        border-radius: 12px;
        border: 1px solid ${theme.commandBorder};
        background: ${theme.commandBg};
        color: ${theme.commandTitle};
        font-size: 11px;
        line-height: 1.4;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .help-plugin--detail .help-plugin__head {
        padding: 16px 16px 14px;
      }

      .help-plugin--detail .help-plugin__body {
        padding: 12px;
      }

      .help-command {
        padding: 12px;
        border-radius: 16px;
        background: ${theme.commandBg};
        border: 1px solid ${theme.commandBorder};
      }

      .help-command + .help-command {
        margin-top: 10px;
      }

      .help-command__top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .help-command__name {
        flex: 1;
        min-width: 0;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 13px;
        line-height: 1.45;
        font-weight: 800;
        color: ${theme.commandTitle};
        word-break: break-word;
      }

      .help-command__desc {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.6;
        color: ${theme.commandDesc};
      }

      .help-command__usage {
        margin-top: 8px;
        font-size: 11px;
        line-height: 1.55;
        color: ${theme.panelDesc};
      }

      .help-command__usage code {
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 11px;
        color: ${theme.commandTitle};
      }

      .help-role {
        flex-shrink: 0;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.5;
        font-weight: 700;
        letter-spacing: 0.02em;
        border: 1px solid transparent;
      }

      .help-footer {
        display: flex;
        align-items: stretch;
        gap: 0;
        border-radius: 20px;
        border: 1px solid ${theme.footerBorder};
        background: ${theme.footerBg};
        overflow: hidden;
      }

      .help-footer__item {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
      }

      .help-footer__item + .help-footer__item {
        border-left: 1px solid ${theme.divider};
      }

      .help-footer__icon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: 12px;
        background: ${isNightMode ? "rgba(126, 231, 221, 0.08)" : "rgba(15, 118, 110, 0.08)"};
        color: ${theme.eyebrow};
        font-size: 18px;
      }

      .help-footer__label {
        font-size: 11px;
        line-height: 1.4;
        color: ${theme.footerLabel};
      }

      .help-footer__value {
        margin-top: 2px;
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
        font-size: 12px;
        line-height: 1.45;
        font-weight: 700;
        color: ${theme.footerText};
      }
    </style>
    <div class="help-sheet">
      <div class="help-sheet__scene">
        <div class="help-sheet__scene-image"></div>
        <div class="help-sheet__scene-overlay"></div>
      </div>
      <div class="help-shell">
        <header class="help-hero">
          <div class="help-hero__logo">
            <img src="${escapeHtml(avatarSrc)}" alt="logo" />
          </div>
          <div class="help-hero__content">
            <div class="help-hero__eyebrow">Mioku Assistant</div>
            <h1 class="help-hero__title">${escapeHtml(heroTitle)}</h1>
            <p class="help-hero__subtitle">${escapeHtml(heroSubtitle)}</p>
          </div>
        </header>

        <main class="${isDetailMode ? "help-detail" : "help-grid"}">
          ${pluginsHtml}
        </main>

        <footer class="help-footer">
          <div class="help-footer__item">
            <div class="help-footer__icon">⚡</div>
            <div>
              <div class="help-footer__label">Framework</div>
              <div class="help-footer__value">Mioki ${escapeHtml(miokiVersion)}</div>
            </div>
          </div>
          <div class="help-footer__item">
            <div class="help-footer__icon">🚀</div>
            <div>
              <div class="help-footer__label">Platform</div>
              <div class="help-footer__value">Mioku ${escapeHtml(miokuVersion)}</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  `;
}
