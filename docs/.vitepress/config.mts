import { defineConfig } from "vitepress";
import typedocSidebar from "../reference/api/typedoc-sidebar.json";

const SITE_URL =
  process.env.MIOKU_SITE_URL?.replace(/\/+$/, "") || "https://mioku.top";

const OG_IMAGE = "/images/home/about-hero-dark.jpg";
const DEFAULT_DESCRIPTION = "AI 优先的插件式机器人框架，基于 TypeScript 与 bun";
const REPO_URL = "https://github.com/mioku-lab/mioku";

function pageUrl(relativePath: string): string {
  if (!relativePath || relativePath === "index.md") return `${SITE_URL}/`;
  const clean = relativePath.replace(/\.md$/, "").replace(/\/index$/, "");
  return `${SITE_URL}/${clean}`;
}

type PageType =
  | "home"
  | "guide"
  | "developer"
  | "advanced"
  | "reference"
  | "api"
  | "other";

function detectPageType(relativePath: string): PageType {
  if (!relativePath || relativePath === "index.md") return "home";
  if (relativePath.startsWith("guide/")) return "guide";
  if (relativePath.startsWith("developer/")) return "developer";
  if (relativePath.startsWith("advanced/")) return "advanced";
  if (relativePath === "reference/index.md") return "reference";
  if (relativePath.startsWith("reference/api/")) return "api";
  return "other";
}

function jsonLdForPage(opts: {
  type: PageType;
  title: string;
  description: string;
  url: string;
}): string {
  const { type, title, description, url } = opts;
  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Mioku",
    url: SITE_URL,
    inLanguage: "zh-CN",
    description: DEFAULT_DESCRIPTION,
    publisher: {
      "@type": "Organization",
      name: "Mioku",
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/images/home/miku-logo.png`,
      },
    },
  };

  let node: Record<string, unknown>;
  switch (type) {
    case "home":
      node = {
        ...base,
        "@type": "SoftwareApplication",
        name: "Mioku",
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Bot Framework",
        operatingSystem: "Linux, macOS, Windows",
        description,
        url,
        image: `${SITE_URL}${OG_IMAGE}`,
        codeRepository: REPO_URL,
        license: "https://opensource.org/licenses/MIT",
        author: { "@type": "Person", name: "Jerryplusy" },
        offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
        keywords:
          "mioku, qq bot, onebot v11, plugin framework, ai bot, typescript",
      };
      break;
    case "api":
      node = {
        ...base,
        "@type": "TechArticle",
        headline: title,
        description,
        url,
        image: `${SITE_URL}${OG_IMAGE}`,
        author: { "@type": "Person", name: "Jerryplusy" },
        publisher: base.publisher,
        about: {
          "@type": "SoftwareSourceCode",
          name: "Mioku",
          codeRepository: REPO_URL,
        },
        inLanguage: "zh-CN",
      };
      break;
    case "guide":
    case "developer":
    case "advanced":
    case "reference":
      node = {
        ...base,
        "@type": "TechArticle",
        headline: title,
        description,
        url,
        image: `${SITE_URL}${OG_IMAGE}`,
        author: { "@type": "Person", name: "Jerryplusy" },
        publisher: base.publisher,
        inLanguage: "zh-CN",
      };
      break;
    default:
      node = {
        ...base,
        "@type": "WebPage",
        name: title,
        description,
        url,
        image: `${SITE_URL}${OG_IMAGE}`,
        isPartOf: { "@type": "WebSite", name: "Mioku", url: SITE_URL },
        inLanguage: "zh-CN",
      };
  }

  return JSON.stringify(node);
}

export default defineConfig({
  lang: "zh-CN",
  title: "Mioku",
  description: DEFAULT_DESCRIPTION,
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  head: [
    ["meta", { name: "theme-color", content: "#79d8cf" }],
    ["meta", { name: "apple-mobile-web-app-capable", content: "yes" }],
    ["meta", { name: "format-detection", content: "telephone=no" }],
    [
      "meta",
      {
        name: "theme-color",
        content: "#79d8cf",
        media: "(prefers-color-scheme: light)",
      },
    ],
    [
      "meta",
      {
        name: "theme-color",
        content: "#0f172a",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    ["link", { rel: "icon", href: "/favicon.ico" }],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
    ],
    [
      "link",
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
    ],
    ["link", { rel: "manifest", href: "/site.webmanifest" }],
    ["meta", { property: "og:site_name", content: "Mioku" }],
    ["meta", { property: "og:locale", content: "zh_CN" }],
    ["meta", { name: "twitter:site", content: "@mioku_lab" }],
    ["meta", { property: "og:image", content: `${SITE_URL}${OG_IMAGE}` }],
    ["meta", { property: "og:image:width", content: "1376" }],
    ["meta", { property: "og:image:height", content: "768" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "Mioku — AI 优先的插件式机器人框架",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${SITE_URL}${OG_IMAGE}` }],
    [
      "meta",
      {
        name: "twitter:image:alt",
        content: "Mioku — AI 优先的插件式机器人框架",
      },
    ],
  ],
  transformPageData(pageData) {
    const relativePath = pageData.relativePath || "";
    const url = pageUrl(relativePath);
    const title = pageData.title
      ? `${pageData.title} | Mioku`
      : "Mioku — AI 优先的插件式机器人框架";
    const description =
      (pageData.frontmatter?.description as string | undefined)?.trim() ||
      DEFAULT_DESCRIPTION;
    const pageType = detectPageType(relativePath);
    const isHome = pageType === "home";

    pageData.frontmatter ??= {};
    const head = ((pageData.frontmatter.head as unknown[]) ??= []);

    head.push(["link", { rel: "canonical", href: url }]);

    head.push([
      "meta",
      { property: "og:type", content: isHome ? "website" : "article" },
    ]);
    head.push([
      "meta",
      { property: "og:title", content: isHome ? "Mioku" : title },
    ]);
    head.push(["meta", { property: "og:description", content: description }]);
    head.push(["meta", { property: "og:url", content: url }]);

    head.push([
      "meta",
      { name: "twitter:title", content: isHome ? "Mioku" : title },
    ]);
    head.push(["meta", { name: "twitter:description", content: description }]);
    head.push(["meta", { name: "twitter:url", content: url }]);

    const ld = jsonLdForPage({ type: pageType, title, description, url });
    head.push(["script", { type: "application/ld+json" }, ld]);
  },
  themeConfig: {
    logo: { src: "/images/home/cong.png", alt: "Mioku" },
    siteTitle: "Mioku",
    search: {
      provider: "local",
    },
    nav: [
      { text: "使用指南", link: "/guide/introduction" },
      { text: "开发者", link: "/developer/overview" },
      { text: "深入", link: "/advanced/event-bus" },
      { text: "类型参考", link: "/reference/" },
      { text: "插件市场", link: "/guide/market" },
      { text: "关于", link: "/about" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "使用指南",
          items: [
            { text: "认识 Mioku", link: "/guide/introduction" },
            { text: "快速开始", link: "/guide/quick-start" },
            { text: "适配器", link: "/guide/adapters" },
            { text: "配置文件", link: "/guide/configuration" },
            { text: "插件市场", link: "/guide/market" },
            { text: "WebUI", link: "/guide/webui" },
            { text: "部署方式", link: "/guide/deployment" },
          ],
        },
      ],
      "/developer/": [
        {
          text: "开发文档",
          items: [{ text: "架构总览", link: "/developer/overview" }],
        },
        {
          text: "插件开发",
          items: [
            { text: "第一个插件", link: "/developer/first-plugin" },
            { text: "事件处理", link: "/developer/events" },
            { text: "命令管理器", link: "/developer/commands" },
            { text: "消息与消息段", link: "/developer/message" },
            { text: "操作 Bot", link: "/developer/bot" },
            { text: "定时任务与生命周期", link: "/developer/cron-lifecycle" },
            { text: "配置与数据存储", link: "/developer/config-data" },
            { text: "权限与访问控制", link: "/developer/permissions" },
            { text: "插件间通信", link: "/developer/communicate" },
            { text: "使用 AI 服务", link: "/developer/ai" },
            { text: "发布插件", link: "/developer/publish" },
          ],
        },
        {
          text: "服务开发",
          items: [{ text: "开发服务", link: "/developer/service-dev" }],
        },
        {
          text: "适配器开发",
          items: [
            { text: "开发适配器", link: "/developer/adapter-dev" },
            { text: "能力系统", link: "/developer/capability-dev" },
          ],
        },
      ],
      "/advanced/": [
        {
          text: "深入机制",
          items: [
            { text: "事件总线", link: "/advanced/event-bus" },
            { text: "消息与事件去重", link: "/advanced/event-dedup" },
            { text: "包发现与加载", link: "/advanced/loader" },
            { text: "驱动器", link: "/advanced/driver" },
            { text: "运行时生命周期", link: "/advanced/runtime" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "API 参考",
          items: [{ text: "类型文档导读", link: "/reference/" }],
        },
        {
          text: "auto generated",
          items: typedocSidebar,
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/mioku-lab/mioku" },
    ],
    outline: {
      level: [2, 3],
      label: "本页目录",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最后更新于",
      formatOptions: {
        dateStyle: "short",
        timeStyle: "short",
      },
    },
    footer: {
      message: "Released under the MIT License with love.",
      copyright: `Copyright © ${new Date().getFullYear()} Jerryplusy`,
    },
  },
});
