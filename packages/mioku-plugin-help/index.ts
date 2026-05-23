import type { ConfigService } from "mioku";
import type { HelpService } from "mioku";
import type { ScreenshotService } from "mioku";
import { definePlugin, type MiokiContext } from "mioki";
import * as path from "path";
import { HELP_DEMO_CONFIG } from "./demo-config";
import {
  generateHelpImage,
  getPackageVersion,
  replyWithImage,
  resolveHelpBotProfile,
  resolveHelpImageIntent,
} from "./shared";
import { resetHelpRuntimeState, setHelpRuntimeState } from "./runtime";

const helpPlugin = definePlugin({
  name: "help",
  version: "1.0.0",
  description: "帮助插件，生成帮助图片",

  async setup(ctx: MiokiContext) {
    const configService = ctx.services?.config as ConfigService | undefined;
    const helpService = ctx.services?.help as HelpService | undefined;
    const screenshotService = ctx.services?.screenshot as
      | ScreenshotService
      | undefined;

    if (!helpService) {
      ctx.logger.warn("help-service 未加载，帮助插件无法运行");
      return;
    }

    if (!screenshotService) {
      ctx.logger.warn("screenshot 服务未加载，帮助插件功能受限");
    }

    if (configService) {
      await configService.registerConfig("help", "demo", HELP_DEMO_CONFIG.demo);
    }

    const miokiVersion = await getPackageVersion(
      path.join(process.cwd(), "node_modules/mioku/node_modules/mioki/package.json"),
    );
    const miokuVersion = await getPackageVersion(
      path.join(process.cwd(), "node_modules/mioku/package.json"),
    );

    setHelpRuntimeState({
      miokiVersion,
      miokuVersion,
    });

    ctx.handle("message", async (event: any) => {
      const text = ctx.text(event);
      if (!text) {
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
        const { botNickname, botAvatarUrl } = resolveHelpBotProfile(ctx, event);
        const imagePath = await generateHelpImage({
          helpService,
          screenshotService,
          miokiVersion,
          miokuVersion,
          botNickname,
          botAvatarUrl,
          targetPluginName:
            intent.type === "detail" ? intent.pluginName : undefined,
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
    });

    return () => {
      resetHelpRuntimeState();
      ctx.logger.info("帮助插件已卸载");
    };
  },
});

export default helpPlugin;
