import {logger} from "mioku";
import type { AITool } from "mioku";
import { TOOL_RESULT_FOLLOWUP_KEY } from "mioku";
import type { ToolContext } from "../../types";
import { mainModelSupportsVision } from "../../utils/model";

async function createImageFollowupResult(
  imageUrl: string,
  text: string,
  note: string,
): Promise<Record<string, any>> {
  let imageUrls = [imageUrl];
  let gifFrameNote = "";

  try {
    const { isGifUrl, extractGifFrames } = await import("../media/gif-extractor");
    if (await isGifUrl(imageUrl)) {
      const result = await extractGifFrames(imageUrl);
      if (result && result.frames.length > 0) {
        imageUrls = result.frames;
        gifFrameNote = ` The original image is an animated GIF; ${result.frames.length} extracted frame(s) are attached in order.`;
      } else {
        logger.warn("[view_media] Failed to extract GIF frames, attaching original image");
      }
    }
  } catch (err) {
    logger.warn(`[view_media] Failed to prepare image attachment: ${err}`);
  }

  const { prepareImageUrlsForModel } = await import("../media/image-compress");
  const compressedImageUrls = await prepareImageUrlsForModel(imageUrls);

  return {
    success: true,
    image_attached: true,
    note: `${note}${gifFrameNote}`,
    [TOOL_RESULT_FOLLOWUP_KEY]: {
      text: `${text}${gifFrameNote}`,
      images: compressedImageUrls.map((url) => ({ url, detail: "auto" })),
    },
  };
}

function createVideoFollowupResult(
  videoUrl: string,
  text: string,
  note: string,
): Record<string, any> {
  return {
    success: true,
    video_attached: true,
    note,
    [TOOL_RESULT_FOLLOWUP_KEY]: {
      text,
      videos: [{ url: videoUrl, detail: "auto" }],
    },
  };
}

export function createInfoTools(toolCtx: ToolContext): AITool[] {
  const tools: AITool[] = [];

  if (toolCtx.groupId) {
    tools.push({
      name: "get_group_member_info",
      description:
        "Get detailed info about a group member,including gender, age, QQ rating, group level, group title, etc",
      parameters: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description:
              "Platform user id of the member (QQ number, or openid on QQ official)",
          },
        },
        required: ["user_id"],
      },
      handler: async (args) => {
        try {
          const bot = toolCtx.event?.bot;
          if (!bot) return { error: `Failed to get member info: bot not found` };
          const info = await bot.getMemberInfo(toolCtx.groupId!, args.user_id);
          if (!info) return { error: `Failed to get member info: member not found` };
          return {
            nickname: info.nickname,
            card: info.card,
            sex: info.sex,
            age: info.age,
            area: info.area,
            level: info.level,
            qq_level: info.qq_level,
            title: info.title,
          };
        } catch (err) {
          return { error: `Failed to get member info: ${err}` };
        }
      },
    });

    tools.push({
      name: "get_group_member_list",
      description: "Get the list of group members (returns name and role only)",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Optional max members to return (server still caps at 50)",
          },
        },
        required: [],
      },
      handler: async (args) => {
        try {
          const bot = toolCtx.event?.bot;
          if (!bot) return { error: `Failed to get member list: bot not found` };
          const list = await bot.getGroupMembers(toolCtx.groupId!);
          const members = (list as any[]).map((m) => ({
            user_id: m.user_id,
            nickname: m.card || m.nickname,
            role: m.role,
          }));
          const limitRaw = Math.floor(Number(args?.limit));
          const limit =
            Number.isFinite(limitRaw) && limitRaw > 0
              ? Math.min(limitRaw, 50)
              : 50;
          return { members: members.slice(0, limit), total: members.length };
        } catch (err) {
          return { error: `Failed to get member list: ${err}` };
        }
      },
    });
  }

  tools.push({
    name: "view_media",
    description:
      "View and analyze an image or video by its message ID. Use this when you need to see what's in an image or video to answer the user's question. The media will be analyzed and described to you.",
    parameters: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description:
            "The message ID (message_id) of the image or video. You can get this from the original message that contains the media.",
        },
      },
      required: ["message_id"],
    },
    handler: async (args) => {
      try {
        const { getMediaByMessageId, describeImage } = await import("../multimodal");
        const media = await getMediaByMessageId(toolCtx.ctx, args.message_id, toolCtx.event);

        if (!media) {
          return { error: "Image or video not found in the specified message" };
        }

        if (media.kind === "image") {
          if (mainModelSupportsVision(toolCtx.aiService, toolCtx.config.model)) {
            return await createImageFollowupResult(
              media.url,
              `The image from message #${args.message_id} is attached. Inspect it directly and answer the user's question from the visual content.`,
              "The image has been attached to the next main model request. Inspect it directly instead of relying on a worker-model description.",
            );
          }

          const visionAI = toolCtx.aiService.getInstanceByRole?.("vision") ?? toolCtx.aiService.getDefault();
          if (!visionAI) return { error: "AI instance not available" };

          const result = await describeImage(
            visionAI,
            media.url,
            toolCtx.config.multimodalWorkingModel,
            toolCtx.event?.raw_message || undefined,
          );

          if (!result.success) {
            return { error: result.error || "Failed to analyze image" };
          }

          return {
            success: true,
            description: result.description,
            note: "The image has been analyzed. Use the description above to answer the user's question.",
          };
        }

        // 视频：超阈值一律交多模态工作模型概括（抽帧），否则按主模型是否多模态决定直接附加或概括。
        const {
          downloadVideoForAnalysis,
          summarizeVideoContent,
          probeVideoMimeType,
          VIDEO_FULL_UPLOAD_MAX_BYTES,
        } = await import("../media/history-media");

        const videoFile = await downloadVideoForAnalysis(media.sources, {
          logger: {
            info: (m) => logger.info(m),
            warn: (m) => logger.warn(m),
            error: (m) => logger.error(m),
          },
        });

        try {
          const attachFullVideo =
            mainModelSupportsVision(toolCtx.aiService, toolCtx.config.model) &&
            videoFile.byteSize <= VIDEO_FULL_UPLOAD_MAX_BYTES;

          if (attachFullVideo) {
            const fs = await import("fs/promises");
            const mimeType = await probeVideoMimeType(videoFile.path);
            const buffer = await fs.readFile(videoFile.path);
            const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
            return createVideoFollowupResult(
              dataUrl,
              `The video from message #${args.message_id} is attached. Inspect it directly and answer the user's question from the visual content.`,
              "The video has been attached to the next main model request. Inspect it directly instead of relying on a worker-model description.",
            );
          }

          const visionAI = toolCtx.aiService.getInstanceByRole?.("vision") ?? toolCtx.aiService.getDefault();
          if (!visionAI) return { error: "AI instance not available" };

          const summary = await summarizeVideoContent(videoFile.path, videoFile.byteSize, {
            ai: visionAI,
            multimodalWorkingModel: toolCtx.config.multimodalWorkingModel,
            logger: {
              info: (m) => logger.info(m),
              warn: (m) => logger.warn(m),
              error: (m) => logger.error(m),
            },
          });

          return {
            success: true,
            description: summary,
            note: "The video has been summarized. Use the description above to answer the user's question.",
          };
        } finally {
          await videoFile.cleanup();
        }
      } catch (err) {
        return { error: `Failed to analyze media: ${err}` };
      }
    },
  });

  tools.push({
    name: "view_member_avatar",
    description:
      "View and analyze a group member's QQ avatar. Use this when you need to see what someone's avatar looks like. The avatar will be analyzed and described to you.",
    parameters: {
      type: "object",
      properties: {
        user_id: {
          type: "string",
          description:
            "Platform user id of the member whose avatar you want to view",
        },
      },
      required: ["user_id"],
    },
    handler: async (args) => {
      try {
        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${args.user_id}&s=640`;
        logger.info(`[view_member_avatar] Analyzing avatar: ${avatarUrl}`);

        if (mainModelSupportsVision(toolCtx.aiService, toolCtx.config.model)) {
          return await createImageFollowupResult(
            avatarUrl,
            `User ${args.user_id}'s QQ avatar is attached. Inspect it directly and answer the user's question from the visual content.`,
            "The avatar has been attached to the next main model request. Inspect it directly instead of relying on a worker-model description.",
          );
        }

        const { describeImage } = await import("../multimodal");
        const visionAI = toolCtx.aiService.getInstanceByRole?.("vision") ?? toolCtx.aiService.getDefault();
        if (!visionAI) return { error: "AI instance not available" };

        const result = await describeImage(
          visionAI,
          avatarUrl,
          toolCtx.config.multimodalWorkingModel,
          `User ${args.user_id}'s QQ avatar`,
        );

        if (!result.success) {
          return { error: result.error || "Failed to analyze avatar" };
        }

        return {
          success: true,
          description: result.description,
          note: "The avatar has been analyzed. Use the description above to answer the user's question.",
        };
      } catch (err) {
        return { error: `Failed to analyze avatar: ${err}` };
      }
    },
  });

  return tools;
}
