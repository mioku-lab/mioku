import type { AISkill, AITool } from "mioku";
import type { ScreenshotService } from "mioku";
import {
  resolveHelpBotProfile,
  sendImageFromSkillContext,
} from "../help";
import { generateStatusImage } from "../status";

export function createStatusSkill(): AISkill {
  return {
    name: "status",
    description:
      "系统状态查询，生成完整的系统状态图片",
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
            const { botNickname, botAvatarUrl } = await resolveHelpBotProfile(
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
}
