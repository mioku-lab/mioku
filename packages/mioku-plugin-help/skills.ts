import type { AISkill, AITool } from "mioku";
import type { HelpService } from "mioku";
import type { ScreenshotService } from "mioku";
import {
  buildHelpInfoText,
  generateHelpImage,
  getHelpRenderVersions,
  resolveHelpBotProfile,
  sendImageFromSkillContext,
} from "./shared";
import { generateStatusImage } from "./status";

const helpSkill: AISkill = {
  name: "help",
  description: "帮助系统，获取插件帮助信息和发送帮助图片",
  permission: "member",
  tools: [
    {
      name: "get_help_info",
      description:
        "获取所有插件的帮助信息文本，这个仅用于用户向你询问某个功能的具体用法时使用",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async (_args: any, runtimeCtx?: any) => {
        const ctx = runtimeCtx?.ctx;
        const helpService = ctx?.services?.help as HelpService | undefined;
        if (!helpService) {
          return "help-service 未加载，无法获取帮助信息";
        }

        return buildHelpInfoText(helpService.getAllHelp());
      },
    } as AITool,
    {
      name: "send_help_image",
      description:
        "生成并发送帮助图片到群聊，如果有人说他想看帮助，优先调用图片发送而不是自己查看帮助。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async (_args: any, runtimeCtx?: any) => {
        const ctx = runtimeCtx?.ctx;
        const event = runtimeCtx?.event || runtimeCtx?.rawEvent;
        const helpService = ctx?.services?.help as HelpService | undefined;
        const screenshotService = ctx?.services?.screenshot as
          | ScreenshotService
          | undefined;
        const { miokiVersion, miokuVersion } = await getHelpRenderVersions();

        if (!screenshotService) {
          return "screenshot 服务未加载，无法生成帮助图片";
        }

        try {
          const { botNickname, botAvatarUrl } = resolveHelpBotProfile(
            ctx,
            event,
          );
          const imagePath = await generateHelpImage({
            helpService,
            screenshotService,
            miokiVersion,
            miokuVersion,
            botNickname,
            botAvatarUrl,
          });

          if (!imagePath) {
            return "生成帮助图片失败";
          }

          // Help skill defaults to normal send instead of quote-reply.
          await sendImageFromSkillContext({
            ctx,
            event,
            imagePath,
            quoteReply: false,
          });
          return "已发送帮助图片";
        } catch (error) {
          return `生成帮助图片失败: ${error}`;
        }
      },
    } as AITool,
  ],
};

const statusSkill: AISkill = {
  name: "status",
  description:
    "系统状态查询，生成完整的系统状态图片（账号、资源、网络、磁盘、AI 统计、运行时、系统信息）",
  permission: "member",
  tools: [
    {
      name: "send_status_image",
      description:
        "生成并发送完整的系统状态图片。当用户问「看看状态」「机器人怎么样」「服务器忙吗」「资源还够吗」「看看 AI 用了多少」时优先使用。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async (_args: any, runtimeCtx?: any) => {
        const ctx = runtimeCtx?.ctx;
        const event = runtimeCtx?.event || runtimeCtx?.rawEvent;
        const screenshotService = ctx?.services?.screenshot as
          | ScreenshotService
          | undefined;
        if (!screenshotService) {
          return "screenshot 服务未加载";
        }
        try {
          const { botNickname, botAvatarUrl } = resolveHelpBotProfile(
            ctx,
            event,
          );
          const result = await generateStatusImage({
            ctx,
            event,
            intent: { type: "full" },
            botNickname,
            botAvatarUrl,
          });
          if (!result.ok || !result.imagePath) {
            return `生成状态图片失败: ${result.error || "未知错误"}`;
          }
          await sendImageFromSkillContext({
            ctx,
            event,
            imagePath: result.imagePath,
            quoteReply: false,
          });
          return "已发送状态图片";
        } catch (error) {
          return `生成状态图片失败: ${error}`;
        }
      },
    } as AITool,
  ],
};

const helpSkills: AISkill[] = [helpSkill, statusSkill];

export default helpSkills;
