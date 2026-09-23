import { definePlugin, type MiokuContext } from "mioku";
import { getService, Services } from "mioku";
import * as path from "path";
import { HELP_DEMO_CONFIG } from "./demo-config";
import { HELP_STATUS_DEFAULT_CONFIG } from "./status/config";
import {
  generateHelpImage,
  replyWithImage,
  resolveHelpBotProfile,
  resolveHelpImageIntent,
  resolveViewerRole,
} from "./help";
import { getRenderVersions } from "./utils";
import {
  generateStatusImage,
  networkSampler,
  perfMonitor,
  resolveStatusIntent,
} from "./status";
import { createHelpSkills } from "./skills";

const helpPlugin = definePlugin({
  name: "help",

  async setup(ctx: MiokuContext) {
    // 启动后台采样器
    networkSampler.start();
    perfMonitor.start();

    const configService = getService(ctx, Services.Config);
    const helpService = getService(ctx, Services.Help);
    const screenshotService = getService(ctx, Services.Screenshot);
    const aiService = getService(ctx, Services.AI);

    if (!helpService) {
      ctx.logger.warn("help-service 未加载，帮助插件无法运行");
      return () => {
        networkSampler.stop();
        perfMonitor.stop();
        ctx.logger.info("帮助插件已卸载");
      };
    }

    if (!screenshotService) {
      ctx.logger.warn("screenshot 服务未加载，帮助插件功能受限");
    }

    if (configService) {
      await configService.registerConfig("help", "demo", HELP_DEMO_CONFIG.demo);
      await configService.registerConfig(
        "help",
        "status",
        HELP_STATUS_DEFAULT_CONFIG,
      );
    }

    // 注册 help manifest，让 `#help 状态` 能命中
    helpService.registerHelp("help", {
      title: "帮助与系统状态",
      description: "生成帮助图片与系统状态图片",
      commands: [
        { cmd: "#help", desc: "查看帮助图片" },
        {
          cmd: "#状态",
          desc: "查看完整系统状态图片（账号、资源、网络、磁盘、AI 统计、运行时、系统信息）",
        },
      ],
    });

    const { miokiVersion, miokuVersion } = await getRenderVersions();

    if (aiService) {
      for (const skill of createHelpSkills()) aiService.registerSkill(skill);
    }

    const handleHelpMessage = async (event: import("mioku").MessageEvent) => {
      const text = ctx.text(event);
      if (!text) {
        return;
      }

      // 状态指令拦截（优先级高于 help 匹配）
      const statusIntent = resolveStatusIntent(text);
      if (statusIntent.type !== "none") {
        if (!screenshotService) {
          await event.reply("screenshot 服务未加载，无法生成状态图片");
          return;
        }
        try {
          const { botNickname, botAvatarUrl } = await resolveHelpBotProfile(
            ctx,
            event,
          );
          const result = await generateStatusImage({
            ctx,
            event,
            intent: statusIntent,
            botNickname,
            botAvatarUrl,
          });
          if (result.ok && result.imagePath) {
            await replyWithImage(event, ctx.segment, result.imagePath);
          } else {
            await event.reply(
              `生成状态图片失败: ${result.error || "未知错误"}`,
            );
          }
        } catch (error) {
          ctx.logger.error(`生成状态图片失败: ${error}`);
          await event.reply(`生成状态图片失败: ${error}`);
        }
        return;
      }

      const allHelp = helpService.getAllHelp();
      const intent = resolveHelpImageIntent(text, allHelp);
      if (intent.type === "none") {
        return;
      }

      if (!screenshotService) {
        await event.reply("screenshot 服务未加载，无法生成帮助图片");
        return;
      }

      if (intent.type === "unknown") {
        await event.reply(`没有找到插件 ${intent.keyword} 的帮助`);
        return;
      }

      try {
        const { botNickname, botAvatarUrl } = await resolveHelpBotProfile(ctx, event);
        const viewerRole = await resolveViewerRole(ctx, event);
        const imagePath = await generateHelpImage({
          helpService,
          screenshotService,
          miokiVersion,
          miokuVersion,
          botNickname,
          botAvatarUrl,
          targetPluginName:
            intent.type === "detail" ? intent.pluginName : undefined,
          viewerRole,
        });

        if (!imagePath) {
          await event.reply("生成帮助图片失败");
          return;
        }

        await replyWithImage(event, ctx.segment, imagePath);
      } catch (error) {
        ctx.logger.error(`生成帮助图片失败: ${error}`);
        await event.reply(`生成帮助图片失败: ${error}`);
      }
    };

    ctx.command({
      id: "帮助菜单",
      name: "help",
      aliases: ["帮助", "菜单"],
      match: /^(?:help|帮助|菜单)(?:\s|$)/i,
      prefixes: [".", "#", "/", ""],
      description: "生成帮助图片",
      handler: ({ event }) => handleHelpMessage(event),
    });
    ctx.command({
      id: "status",
      name: "status",
      aliases: ["状态", "zt"],
      match: /^(?:status|状态|zt)(?:\s|$)/i,
      prefixes: [".", "#", "/", ""],
      description: "生成系统状态图片",
      handler: ({ event }) => handleHelpMessage(event),
    });

    return () => {
      networkSampler.stop();
      perfMonitor.stop();
      if (aiService) {
        aiService.removeSkill("help");
        aiService.removeSkill("status");
      }
      ctx.logger.info("帮助插件已卸载");
    };
  },
});

export default helpPlugin;
