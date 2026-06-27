export interface MarketTheme {
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
  tagBg: string;
  tagBorder: string;
  tagText: string;
  versionText: string;
  badgeInstalledBg: string;
  badgeInstalledText: string;
  badgeUpdateBg: string;
  badgeUpdateText: string;
  badgeMissingBg: string;
  badgeMissingText: string;
  emptyText: string;
  footerBg: string;
  footerBorder: string;
  footerLabel: string;
  footerText: string;
  divider: string;
}

export const MARKET_BACKGROUND_IMAGE_URL =
  "https://uapis.cn/api/v1/random/image?category=acg&type=mb";

export function getMarketTheme(isNightMode: boolean): MarketTheme {
  if (isNightMode) {
    return {
      isNightMode: true,
      pageBg: "linear-gradient(180deg, #07141c 0%, #0b1c25 52%, #102730 100%)",
      shellBg: "rgba(6, 19, 25, 0.34)",
      pageAccent:
        "radial-gradient(circle at 18% 14%, rgba(76, 201, 191, 0.18), transparent 34%), radial-gradient(circle at 82% 10%, rgba(34, 211, 238, 0.12), transparent 28%)",
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
      panelDesc: "#a8cdd0",
      tagBg: "rgba(25, 52, 62, 0.9)",
      tagBorder: "rgba(125, 218, 211, 0.25)",
      tagText: "#9af8eb",
      versionText: "#8fb4b8",
      badgeInstalledBg: "rgba(34, 197, 94, 0.16)",
      badgeInstalledText: "#86efac",
      badgeUpdateBg: "rgba(245, 158, 11, 0.18)",
      badgeUpdateText: "#fcd34d",
      badgeMissingBg: "rgba(148, 196, 204, 0.12)",
      badgeMissingText: "#9fb6b8",
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
      "radial-gradient(circle at 12% 10%, rgba(45, 212, 191, 0.18), transparent 28%), radial-gradient(circle at 88% 0%, rgba(56, 189, 248, 0.14), transparent 24%)",
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
    tagBg: "rgba(237, 248, 249, 0.98)",
    tagBorder: "rgba(148, 196, 204, 0.74)",
    tagText: "#0d6a65",
    versionText: "#5b7680",
    badgeInstalledBg: "rgba(16, 185, 129, 0.12)",
    badgeInstalledText: "#047857",
    badgeUpdateBg: "rgba(245, 158, 11, 0.14)",
    badgeUpdateText: "#b45309",
    badgeMissingBg: "rgba(148, 196, 204, 0.16)",
    badgeMissingText: "#5b7680",
    emptyText: "#6f8b93",
    footerBg: "rgba(255, 255, 255, 0.94)",
    footerBorder: "rgba(148, 196, 204, 0.72)",
    footerLabel: "#5b7680",
    footerText: "#0f172a",
    divider: "rgba(148, 196, 204, 0.78)",
  };
}
