import * as fs from "fs";
import type { CommandRole, PluginHelp } from "mioku";
import type { HelpService } from "mioku";
import type { ScreenshotService } from "mioku";

const ROLE_CONFIG: Record<
  CommandRole,
  {
    label: string;
    badgeBgLight: string;
    badgeBorderLight: string;
    badgeTextLight: string;
    badgeBgDark: string;
    badgeBorderDark: string;
    badgeTextDark: string;
  }
> = {
  master: {
    label: "主人",
    badgeBgLight: "rgba(245, 158, 11, 0.14)",
    badgeBorderLight: "rgba(217, 119, 6, 0.24)",
    badgeTextLight: "#92400e",
    badgeBgDark: "rgba(245, 158, 11, 0.18)",
    badgeBorderDark: "rgba(251, 191, 36, 0.28)",
    badgeTextDark: "#fcd34d",
  },
  admin: {
    label: "管理",
    badgeBgLight: "rgba(239, 68, 68, 0.12)",
    badgeBorderLight: "rgba(220, 38, 38, 0.22)",
    badgeTextLight: "#b91c1c",
    badgeBgDark: "rgba(239, 68, 68, 0.16)",
    badgeBorderDark: "rgba(248, 113, 113, 0.22)",
    badgeTextDark: "#fca5a5",
  },
  owner: {
    label: "管理",
    badgeBgLight: "rgba(239, 68, 68, 0.12)",
    badgeBorderLight: "rgba(220, 38, 38, 0.22)",
    badgeTextLight: "#b91c1c",
    badgeBgDark: "rgba(239, 68, 68, 0.16)",
    badgeBorderDark: "rgba(248, 113, 113, 0.22)",
    badgeTextDark: "#fca5a5",
  },
  member: {
    label: "成员",
    badgeBgLight: "rgba(14, 165, 233, 0.12)",
    badgeBorderLight: "rgba(2, 132, 199, 0.2)",
    badgeTextLight: "#0369a1",
    badgeBgDark: "rgba(56, 189, 248, 0.16)",
    badgeBorderDark: "rgba(103, 232, 249, 0.22)",
    badgeTextDark: "#67e8f9",
  },
};

const STOPWORDS = new Set(["help", "帮助", "菜单"]);

interface HelpKeywordCandidate {
  keyword: string;
  strictUnknown: boolean;
}

interface HelpRenderableEntry {
  pluginName: string;
  title: string;
  description: string;
  commands: PluginHelp["commands"];
  normalizedPluginName: string;
  normalizedTitle: string;
  matchKeys: Set<string>;
}

interface HelpTheme {
  isNightMode: boolean;
  pageBg: string;
  shellBg: string;
  pageAccent: string;
  pageGrid: string;
  sceneOpacity: string;
  sceneFilter: string;
  sceneMask: string;
  sceneGlow: string;
  shellBorder: string;
  shellShadow: string;
  heroBg: string;
  heroBorder: string;
  heroGlow: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  panelBg: string;
  panelBorder: string;
  panelShadow: string;
  panelTitle: string;
  panelDesc: string;
  commandBg: string;
  commandBorder: string;
  commandTitle: string;
  commandDesc: string;
  tagBg: string;
  tagBorder: string;
  tagText: string;
  emptyText: string;
  footerBg: string;
  footerBorder: string;
  footerLabel: string;
  footerText: string;
  divider: string;
}

export type HelpImageIntent =
  | { type: "none" }
  | { type: "overview" }
  | { type: "detail"; pluginName: string; pluginHelp: PluginHelp }
  | { type: "unknown"; keyword: string };

export async function getPackageVersion(
  packageJsonPath: string,
): Promise<string> {
  try {
    const content = await fs.promises.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export async function getHelpRenderVersions(): Promise<{
  miokiVersion: string;
  miokuVersion: string;
}> {
  // Both versions must be read from the installed packages in node_modules
  // — not from the host project's own `package.json`, which is usually a
  // workspace consumer (`"mioku": "workspace:*"`) and has no `version`
  // field of its own.
  const miokiVersion = await getPackageVersion(
    `${process.cwd()}/node_modules/mioki/package.json`,
  );
  const miokuCandidates = [
    `${process.cwd()}/node_modules/mioku/package.json`,
    `${process.cwd()}/../node_modules/mioku/package.json`,
  ];
  let miokuVersion = "unknown";
  for (const candidate of miokuCandidates) {
    const v = await getPackageVersion(candidate);
    if (v !== "unknown") {
      miokuVersion = v;
      break;
    }
  }

  return {
    miokiVersion,
    miokuVersion,
  };
}

export function checkNightMode(): boolean {
  const hour = new Date().getHours();
  return hour >= 19 || hour < 7;
}

export function buildHelpInfoText(helpMap: Map<string, PluginHelp>): string {
  const info: string[] = ["=== Mioku Bot 帮助信息 ===\n"];

  for (const [pluginName, help] of helpMap) {
    info.push(`【${help.title || pluginName}】${help.description || ""}`);
    if (help.commands?.length) {
      for (const cmd of help.commands) {
        const roleLabel = cmd.role
          ? ` [${ROLE_CONFIG[cmd.role]?.label || cmd.role}]`
          : "";
        info.push(`  ${cmd.cmd}${roleLabel} - ${cmd.desc}`);
      }
    }
    info.push("");
  }

  return info.join("\n");
}

export function resolveHelpImageIntent(
  text: string,
  helpMap: Map<string, PluginHelp>,
): HelpImageIntent {
  const source = String(text || "").trim();
  if (!source) {
    return { type: "none" };
  }

  if (/^[#/]/.test(source) && !/^[#/]\s*(?:help|帮助|菜单)/i.test(source)) {
    return { type: "none" };
  }

  if (/^[#/]?\s*(?:help|帮助|菜单)\s*$/i.test(source)) {
    return { type: "overview" };
  }

  const candidates = extractHelpKeywordCandidates(source);
  if (candidates.length === 0) {
    return { type: "none" };
  }

  for (const candidate of candidates) {
    const resolved = findPluginHelpByKeyword(helpMap, candidate.keyword);
    if (resolved) {
      return {
        type: "detail",
        pluginName: resolved.pluginName,
        pluginHelp: resolved.help,
      };
    }
  }

  const strictCandidate = candidates.find(
    (candidate) => candidate.strictUnknown,
  );
  if (!strictCandidate) {
    return { type: "none" };
  }

  const fallback = sanitizeKeyword(strictCandidate.keyword);
  if (!fallback) {
    return { type: "none" };
  }

  return {
    type: "unknown",
    keyword: fallback,
  };
}

export function findPluginHelpByKeyword(
  helpMap: Map<string, PluginHelp>,
  keyword: string,
): { pluginName: string; help: PluginHelp } | null {
  const normalizedQuery = normalizeForMatch(sanitizeKeyword(keyword));
  if (!normalizedQuery || STOPWORDS.has(normalizedQuery)) {
    return null;
  }

  const entries = getRenderableEntries(helpMap);
  if (entries.length === 0) {
    return null;
  }

  const directPlugin = entries.find(
    (entry) => entry.normalizedPluginName === normalizedQuery,
  );
  if (directPlugin) {
    return {
      pluginName: directPlugin.pluginName,
      help: helpMap.get(directPlugin.pluginName)!,
    };
  }

  const exactMatches = entries.filter((entry) =>
    entry.matchKeys.has(normalizedQuery),
  );
  if (exactMatches.length === 1) {
    return {
      pluginName: exactMatches[0].pluginName,
      help: helpMap.get(exactMatches[0].pluginName)!,
    };
  }

  if (normalizedQuery.length < 2) {
    return null;
  }

  const fuzzyMatches = entries
    .map((entry) => ({
      entry,
      score: scoreKeywordMatch(normalizedQuery, entry),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (fuzzyMatches.length === 0) {
    return null;
  }

  if (
    fuzzyMatches.length > 1 &&
    fuzzyMatches[0].score === fuzzyMatches[1].score
  ) {
    return null;
  }

  const resolved = fuzzyMatches[0].entry;
  return {
    pluginName: resolved.pluginName,
    help: helpMap.get(resolved.pluginName)!,
  };
}

export async function generateHelpImage(options: {
  helpService?: HelpService;
  screenshotService?: ScreenshotService;
  miokiVersion?: string;
  miokuVersion?: string;
  botNickname?: string;
  botAvatarUrl?: string;
  targetPluginName?: string;
}): Promise<string | null> {
  const {
    helpService,
    screenshotService,
    miokiVersion,
    miokuVersion,
    botNickname,
    botAvatarUrl,
    targetPluginName,
  } = options;
  if (!helpService || !screenshotService) {
    return null;
  }

  const allHelp = helpService.getAllHelp();
  const hasTarget =
    Boolean(targetPluginName) && allHelp.has(String(targetPluginName));

  const htmlContent = generateHelpHtml(
    allHelp,
    checkNightMode(),
    miokiVersion,
    miokuVersion,
    botNickname,
    botAvatarUrl,
    hasTarget ? targetPluginName : undefined,
  );

  return screenshotService.screenshot(htmlContent, {
    width: 760,
    height: 120,
    fullPage: true,
    type: "png",
  });
}

export async function replyWithImage(
  event: any,
  segment: { image: (file: string) => any } | undefined,
  imagePath: string,
): Promise<void> {
  if (!event?.reply) {
    throw new Error("当前上下文不支持发送图片回复");
  }

  try {
    if (segment?.image) {
      await event.reply(segment.image(imagePath));
    } else {
      await event.reply([{ type: "image", file: imagePath }]);
    }
  } catch {
    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = `base64://${imageBuffer.toString("base64")}`;

    if (segment?.image) {
      await event.reply(segment.image(base64Image));
    } else {
      await event.reply([{ type: "image", file: base64Image }]);
    }
  }
}

export async function sendImageFromSkillContext(options: {
  ctx: any;
  event: any;
  imagePath: string;
  quoteReply?: boolean;
}): Promise<void> {
  const { ctx, event, imagePath, quoteReply = false } = options;
  const selfId = event?.self_id != null ? Number(event.self_id) : undefined;
  const bot =
    selfId != null && typeof ctx?.pickBot === "function"
      ? ctx.pickBot(selfId)
      : undefined;

  if (!bot) {
    throw new Error("当前上下文不支持发送图片");
  }

  const buildImageSegment = (file: string) => {
    const normalizedFile = normalizeImageSource(file);
    if (ctx?.segment?.image) {
      return ctx.segment.image(normalizedFile);
    }
    return { type: "image", file: normalizedFile };
  };

  const sendPayload = async (file: string) => {
    const payload: any[] = [];
    if (quoteReply && event?.message_id != null) {
      payload.push({ type: "reply", id: String(event.message_id) });
    }
    payload.push(buildImageSegment(file));

    if (event?.message_type === "group" && event?.group_id != null) {
      await bot.sendGroupMsg(event.group_id, payload);
      return;
    }

    if (event?.user_id != null) {
      await bot.sendPrivateMsg(event.user_id, payload);
      return;
    }

    throw new Error("当前上下文不支持发送图片");
  };

  try {
    await sendPayload(imagePath);
  } catch (error) {
    if (!isLocalFilePath(imagePath)) {
      throw error;
    }

    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = `base64://${imageBuffer.toString("base64")}`;
    await sendPayload(base64Image);
  }
}

export function generateHelpHtml(
  helpMap: Map<string, PluginHelp>,
  isNightMode: boolean,
  miokiVersion: string = "unknown",
  miokuVersion: string = "unknown",
  botNickname: string = "Mioku Bot",
  botAvatarUrl?: string,
  targetPluginName?: string,
): string {
  const entries = getRenderableEntries(helpMap);
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
        font-family: "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
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

export function resolveHelpBotProfile(
  ctx: any,
  event?: any,
): { botNickname: string; botAvatarUrl?: string } {
  const fallbackNickname = "Mioku Bot";
  const selfId = event?.self_id;
  const bot =
    (selfId && typeof ctx?.pickBot === "function"
      ? ctx.pickBot(selfId)
      : null) ||
    (ctx?.bots instanceof Map ? Array.from(ctx.bots.values())[0] : null);
  const botId = selfId || bot?.uin || bot?.user_id || bot?.self_id;
  const botNickname = bot?.nickname || bot?.name || fallbackNickname;
  const botAvatarUrl = botId
    ? `https://q1.qlogo.cn/g?b=qq&nk=${botId}&s=640`
    : undefined;

  return { botNickname, botAvatarUrl };
}

function extractHelpKeywordCandidates(text: string): HelpKeywordCandidate[] {
  const source = text.trim();
  const candidates: HelpKeywordCandidate[] = [];

  const addCandidate = (value: string, strictUnknown: boolean) => {
    const keyword = sanitizeKeyword(value);
    if (!keyword) {
      return;
    }
    if (
      !candidates.some(
        (candidate) =>
          candidate.keyword === keyword &&
          candidate.strictUnknown === strictUnknown,
      )
    ) {
      candidates.push({ keyword, strictUnknown });
    }
  };

  const helpPrefixSeparated = source.match(
    /^[#/]?\s*(?:help|帮助)(?:\s+|[:：])\s*(.+)$/i,
  );
  if (helpPrefixSeparated?.[1]) {
    addCandidate(helpPrefixSeparated[1], true);
  }

  const helpPrefixMerged = source.match(
    /^[#/]?\s*(?:help|帮助)([a-z0-9\u4e00-\u9fa5]+)$/i,
  );
  if (helpPrefixMerged?.[1]) {
    addCandidate(helpPrefixMerged[1], false);
  }

  if (/^[#/]/.test(source)) {
    return candidates;
  }

  const helpSuffixSeparated = source.match(/^(.+?)\s+(?:help|帮助)\s*$/i);
  if (helpSuffixSeparated?.[1]) {
    addCandidate(helpSuffixSeparated[1], true);
  }

  const helpSuffixMerged = source.match(
    /^([a-z0-9\u4e00-\u9fa5]+)(?:help|帮助)\s*$/i,
  );
  if (helpSuffixMerged?.[1]) {
    addCandidate(helpSuffixMerged[1], false);
  }

  const menuPrefix = source.match(
    /^菜单\s*[:：]?\s*([a-z0-9\u4e00-\u9fa5]+)$/i,
  );
  if (menuPrefix?.[1]) {
    addCandidate(menuPrefix[1], false);
  }

  const menuSuffix = source.match(/^([a-z0-9\u4e00-\u9fa5]+)\s*菜单\s*$/i);
  if (menuSuffix?.[1]) {
    addCandidate(menuSuffix[1], false);
  }

  return candidates;
}

function getRenderableEntries(
  helpMap: Map<string, PluginHelp>,
): HelpRenderableEntry[] {
  return Array.from(helpMap.entries())
    .map(([pluginName, help]) => {
      const title = String(help.title || pluginName).trim() || pluginName;
      const description = String(help.description || "").trim();
      const commands = Array.isArray(help.commands) ? help.commands : [];
      const normalizedPluginName = normalizeForMatch(pluginName);
      const normalizedTitle = normalizeForMatch(title);

      const keys = new Set<string>();
      if (normalizedPluginName) {
        keys.add(normalizedPluginName);
      }
      if (normalizedTitle) {
        keys.add(normalizedTitle);
      }

      for (const token of extractMatchTokens(title)) {
        keys.add(token);
      }

      const commandAliases = commands
        .map((command) => extractCommandAlias(command.cmd))
        .filter((value): value is string => Boolean(value));
      for (const alias of commandAliases) {
        keys.add(alias);
      }

      return {
        pluginName,
        title,
        description,
        commands,
        normalizedPluginName,
        normalizedTitle,
        matchKeys: keys,
      };
    })
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName, "zh-Hans-CN"));
}

function renderPluginOverview(entry: HelpRenderableEntry): string {
  const commandTags = entry.commands
    .map(
      (command) =>
        `<span class="help-command-tag" title="${escapeHtml(command.desc || "")}" >${escapeHtml(command.cmd)}</span>`,
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
            <div class="help-command__name">${escapeHtml(command.cmd)}</div>
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

function renderRoleBadge(role: CommandRole, isNightMode: boolean): string {
  const config = ROLE_CONFIG[role];
  if (!config) {
    return "";
  }

  const background = isNightMode ? config.badgeBgDark : config.badgeBgLight;
  const border = isNightMode ? config.badgeBorderDark : config.badgeBorderLight;
  const color = isNightMode ? config.badgeTextDark : config.badgeTextLight;

  return `<span class="help-role" style="background: ${background}; border-color: ${border}; color: ${color};">${config.label}</span>`;
}

export function getHelpTheme(isNightMode: boolean): HelpTheme {
  if (isNightMode) {
    return {
      isNightMode: true,
      pageBg: "linear-gradient(180deg, #07141c 0%, #0b1c25 52%, #102730 100%)",
      shellBg: "rgba(6, 19, 25, 0.34)",
      pageAccent:
        "radial-gradient(circle at 18% 14%, rgba(76, 201, 191, 0.18), transparent 34%), radial-gradient(circle at 82% 10%, rgba(34, 211, 238, 0.12), transparent 28%), radial-gradient(circle at 50% 100%, rgba(45, 212, 191, 0.1), transparent 42%)",
      pageGrid:
        "linear-gradient(rgba(151, 214, 210, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(151, 214, 210, 0.04) 1px, transparent 1px)",
      sceneOpacity: "0.48",
      sceneFilter: "blur(1.5px) saturate(0.96) contrast(1.05) brightness(0.72)",
      sceneMask:
        "linear-gradient(180deg, rgba(3, 11, 15, 0.34), rgba(4, 16, 22, 0.2) 26%, rgba(4, 14, 20, 0.06) 52%, rgba(3, 10, 14, 0.4) 100%)",
      sceneGlow:
        "radial-gradient(circle at 24% 16%, rgba(126, 231, 221, 0.16), transparent 28%), radial-gradient(circle at 78% 10%, rgba(34, 211, 238, 0.14), transparent 26%)",
      shellBorder: "rgba(116, 202, 200, 0.18)",
      shellShadow: "0 32px 70px rgba(1, 11, 16, 0.45)",
      heroBg:
        "linear-gradient(135deg, rgba(16, 40, 50, 0.94), rgba(14, 32, 42, 0.88))",
      heroBorder: "rgba(105, 196, 194, 0.24)",
      heroGlow: "rgba(77, 217, 200, 0.16)",
      eyebrow: "#7ee7dd",
      title: "#ecfeff",
      subtitle: "#b9d7d8",
      panelBg: "rgba(12, 29, 38, 0.86)",
      panelBorder: "rgba(105, 196, 194, 0.16)",
      panelShadow: "0 18px 42px rgba(0, 0, 0, 0.22)",
      panelTitle: "#f0fdff",
      panelDesc: "#98babc",
      commandBg: "rgba(18, 41, 50, 0.92)",
      commandBorder: "rgba(108, 185, 182, 0.14)",
      commandTitle: "#83f0e1",
      commandDesc: "#d8eeed",
      tagBg: "rgba(25, 52, 62, 0.9)",
      tagBorder: "rgba(125, 218, 211, 0.25)",
      tagText: "#9af8eb",
      emptyText: "#78999a",
      footerBg: "rgba(10, 24, 32, 0.82)",
      footerBorder: "rgba(105, 196, 194, 0.16)",
      footerLabel: "#85aeb0",
      footerText: "#dffcf8",
      divider: "rgba(105, 196, 194, 0.18)",
    };
  }

  return {
    isNightMode: false,
    pageBg: "linear-gradient(180deg, #eef6f7 0%, #f6fbfb 48%, #edf5f7 100%)",
    shellBg: "rgba(255, 255, 255, 0.42)",
    pageAccent:
      "radial-gradient(circle at 12% 10%, rgba(45, 212, 191, 0.18), transparent 28%), radial-gradient(circle at 88% 0%, rgba(56, 189, 248, 0.14), transparent 24%), radial-gradient(circle at 50% 100%, rgba(13, 148, 136, 0.08), transparent 44%)",
    pageGrid:
      "linear-gradient(rgba(17, 94, 89, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(17, 94, 89, 0.05) 1px, transparent 1px)",
    sceneOpacity: "0.42",
    sceneFilter: "blur(1.5px) saturate(0.98) contrast(1.02) brightness(1.03)",
    sceneMask:
      "linear-gradient(180deg, rgba(244, 250, 251, 0.4), rgba(244, 250, 251, 0.22) 30%, rgba(244, 250, 251, 0.04) 58%, rgba(237, 245, 247, 0.46) 100%)",
    sceneGlow:
      "radial-gradient(circle at 18% 14%, rgba(45, 212, 191, 0.14), transparent 28%), radial-gradient(circle at 82% 8%, rgba(56, 189, 248, 0.12), transparent 24%)",
    shellBorder: "rgba(148, 196, 204, 0.62)",
    shellShadow: "0 26px 60px rgba(12, 50, 59, 0.12)",
    heroBg:
      "linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(240, 250, 249, 0.94))",
    heroBorder: "rgba(148, 196, 204, 0.7)",
    heroGlow: "rgba(45, 212, 191, 0.14)",
    eyebrow: "#0f766e",
    title: "#0f172a",
    subtitle: "#335761",
    panelBg: "rgba(255, 255, 255, 0.95)",
    panelBorder: "rgba(148, 196, 204, 0.68)",
    panelShadow: "0 16px 36px rgba(15, 61, 71, 0.08)",
    panelTitle: "#102430",
    panelDesc: "#4b6770",
    commandBg: "rgba(244, 251, 251, 0.98)",
    commandBorder: "rgba(185, 217, 221, 0.82)",
    commandTitle: "#0f766e",
    commandDesc: "#17353f",
    tagBg: "rgba(237, 248, 249, 0.98)",
    tagBorder: "rgba(148, 196, 204, 0.74)",
    tagText: "#0d6a65",
    emptyText: "#6f8b93",
    footerBg: "rgba(255, 255, 255, 0.94)",
    footerBorder: "rgba(148, 196, 204, 0.72)",
    footerLabel: "#5b7680",
    footerText: "#0f172a",
    divider: "rgba(148, 196, 204, 0.78)",
  };
}

function scoreKeywordMatch(query: string, entry: HelpRenderableEntry): number {
  let score = 0;

  if (
    entry.normalizedTitle.includes(query) ||
    query.includes(entry.normalizedTitle)
  ) {
    score = Math.max(
      score,
      46 - Math.abs(entry.normalizedTitle.length - query.length),
    );
  }

  for (const key of entry.matchKeys) {
    if (key.startsWith(query) || query.startsWith(key)) {
      score = Math.max(score, 58 - Math.abs(key.length - query.length));
      continue;
    }

    if (key.includes(query) || query.includes(key)) {
      score = Math.max(score, 34 - Math.abs(key.length - query.length));
    }
  }

  return Math.max(0, score);
}

function extractMatchTokens(text: string): string[] {
  const rawTokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9\u4e00-\u9fa5]+/gi);

  if (!rawTokens) {
    return [];
  }

  const tokens = rawTokens
    .map((token) => normalizeForMatch(token))
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token));

  return Array.from(new Set(tokens));
}

function extractCommandAlias(command: string): string | null {
  const value = String(command || "")
    .trim()
    .replace(/^[#/]+/, "");
  if (!value) {
    return null;
  }

  const firstToken = value.split(/\s+/)[0];
  if (!firstToken || /[<>]/.test(firstToken)) {
    return null;
  }

  if (!/[a-z0-9]/i.test(firstToken)) {
    return null;
  }

  const normalized = normalizeForMatch(firstToken);
  if (!normalized || STOPWORDS.has(normalized)) {
    return null;
  }

  return normalized;
}

function sanitizeKeyword(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[#/\s]+/, "")
    .replace(/[。.!！?？,，:：；;]+$/g, "");
}

function normalizeForMatch(value: string): string {
  const parts = String(value || "")
    .toLowerCase()
    .match(/[a-z0-9\u4e00-\u9fa5]+/gi);

  return parts ? parts.join("") : "";
}

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

export function normalizeImageSource(file: string): string {
  const value = String(file || "").trim();
  if (!value) {
    return value;
  }

  if (
    value.startsWith("file://") ||
    value.startsWith("base64://") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }

  if (isLocalFilePath(value)) {
    return `file://${value}`;
  }

  return value;
}

function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export const HELP_BACKGROUND_IMAGE_URL =
  "https://uapis.cn/api/v1/random/image?category=acg&type=mb";

export function getStatusTheme(isNightMode: boolean): HelpTheme {
  // 状态页与帮助页共享完全相同的青绿色主题，便于视觉一致。
  return getHelpTheme(isNightMode);
}
