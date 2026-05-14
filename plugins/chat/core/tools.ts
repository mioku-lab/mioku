import { logger } from "mioki";
import type { AITool } from "../../../src";
import type { ChatMessage, ToolContext } from "../types";
import type { SkillSessionManager } from "../manage/skill-session";
import type { MemoryUserHistoryChunk } from "../humanize/memory";
import { MemoryRetrieval } from "../humanize";
import { searchWebWithSearxng } from "./web/searxng";
import { readWebPage } from "./web/web-reader";
import { TOOL_RESULT_FOLLOWUP_KEY } from "../../../src/services/ai/types";
import {
  filterAllowedExternalSkills,
  getSkillRequiredPermissionRole,
  isExternalSkillAllowed,
  hasSkillPermission,
} from "./external-skills";
import {
  FEATURE_METAS,
  isFeatureEnabled,
  isBuiltinFeature,
  getFeatureMeta,
  type FeatureName,
} from "./feature-prompts";

const DEFAULT_GROUP_RECALL_LIMIT = 300;
const DEFAULT_USER_HISTORY_LIMIT = 100;

interface CreateToolsResult {
  tools: AITool[];
}

async function createImageFollowupResult(
  imageUrl: string,
  text: string,
  note: string,
): Promise<Record<string, any>> {
  let imageUrls = [imageUrl];
  let gifFrameNote = "";

  try {
    const { isGifUrl, extractGifFrames } =
      await import("./media/gif-extractor");
    if (await isGifUrl(imageUrl)) {
      const result = await extractGifFrames(imageUrl);
      if (result && result.frames.length > 0) {
        imageUrls = result.frames;
        gifFrameNote = ` The original image is an animated GIF; ${result.frames.length} extracted frame(s) are attached in order.`;
      } else {
        logger.warn(
          "[view_image] Failed to extract GIF frames, attaching original image",
        );
      }
    }
  } catch (err) {
    logger.warn(`[view_image] Failed to prepare image attachment: ${err}`);
  }

  return {
    success: true,
    image_attached: true,
    note: `${note}${gifFrameNote}`,
    [TOOL_RESULT_FOLLOWUP_KEY]: {
      text: `${text}${gifFrameNote}`,
      images: imageUrls.map((url) => ({ url, detail: "auto" })),
    },
  };
}

/**
 * Create all tools
 */
export function createTools(
  toolCtx: ToolContext,
  skillManager: SkillSessionManager,
): CreateToolsResult {
  const tools: AITool[] = [];

  // === Info query tools (always available) ===
  tools.push(...createInfoTools(toolCtx));

  // === Meta tools (conditional) ===
  // load_skill tool is always available when external skills are enabled
  if (toolCtx.config.enableExternalSkills) {
    const allSkills = toolCtx.aiService.getAllSkills?.();
    const allowedSkills = allSkills
      ? filterAllowedExternalSkills(
          toolCtx.config,
          [...allSkills.values()],
          toolCtx.triggerSkillRole,
        )
      : [];

    if (allowedSkills.length > 0) {
      tools.push(createLoadSkillTool(toolCtx, skillManager));
    }
  }

  // === Optional feature tools (dynamically registered based on loaded features) ===
  const activeFeatureTools = skillManager.getActiveFeatureTools(toolCtx.sessionId);

  if (activeFeatureTools.includes("web_search")) {
    tools.push(createWebSearchTool(toolCtx));
  }
  if (activeFeatureTools.includes("web_read_page")) {
    tools.push(createWebReadPageTool(toolCtx));
  }
  if (activeFeatureTools.includes("recall_memory")) {
    tools.push(createRecallMemoryTool(toolCtx));
  }

  return { tools };
}

// ==================== Info Tools ====================

function createInfoTools(toolCtx: ToolContext): AITool[] {
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
            type: "number",
            description: "QQ number of the member",
          },
        },
        required: ["user_id"],
      },
      handler: async (args) => {
        try {
          const info = await toolCtx.ctx
            .pickBot(toolCtx.event.self_id)
            .getGroupMemberInfo(toolCtx.groupId!, args.user_id);
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
        properties: {},
      },
      handler: async () => {
        try {
          const list = await toolCtx.ctx
            .pickBot(toolCtx.event.self_id)
            .getGroupMemberList(toolCtx.groupId!);
          const members = (list as any[]).map((m) => ({
            user_id: m.user_id,
            nickname: m.card || m.nickname,
            role: m.role,
          }));
          return { members: members.slice(0, 50), total: members.length };
        } catch (err) {
          return { error: `Failed to get member list: ${err}` };
        }
      },
    });
  }

  // 查看图片工具
  {
    tools.push({
      name: "view_image",
      description:
        "View and analyze an image by its message ID. Use this when you need to see what's in an image to answer the user's question. The image will be analyzed and described to you.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "number",
            description:
              "The message ID (message_id) of the image. You can get this from the original message that contains the image.",
          },
        },
        required: ["message_id"],
      },
      handler: async (args) => {
        try {
          // 通过 message_id 获取消息中的图片
          const { getImageUrlByMessageId } = await import("./multimodal");
          const imageUrl = await getImageUrlByMessageId(
            toolCtx.ctx,
            args.message_id,
            toolCtx.event,
          );

          if (!imageUrl) {
            return { error: "Image not found in the specified message" };
          }

          if (toolCtx.config.isMultimodal) {
            return await createImageFollowupResult(
              imageUrl,
              `The image from message #${args.message_id} is attached. Inspect it directly and answer the user's question from the visual content.`,
              "The image has been attached to the next main model request. Inspect it directly instead of relying on a worker-model description.",
            );
          }

          // 主模型不支持视觉时，使用多模态工作模型描述图片。
          const ai = toolCtx.aiService.getDefault();
          if (!ai) {
            return { error: "AI instance not available" };
          }
          const { describeImage } = await import("./multimodal");

          const result = await describeImage(
            ai,
            imageUrl,
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
        } catch (err) {
          return { error: `Failed to analyze image: ${err}` };
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
            type: "number",
            description:
              "QQ number of the member whose avatar you want to view",
          },
        },
        required: ["user_id"],
      },
      handler: async (args) => {
        try {
          const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${args.user_id}&s=640`;

          logger.info(`[view_member_avatar] Analyzing avatar: ${avatarUrl}`);

          if (toolCtx.config.isMultimodal) {
            return await createImageFollowupResult(
              avatarUrl,
              `User ${args.user_id}'s QQ avatar is attached. Inspect it directly and answer the user's question from the visual content.`,
              "The avatar has been attached to the next main model request. Inspect it directly instead of relying on a worker-model description.",
            );
          }

          // 主模型不支持视觉时，使用多模态工作模型描述头像。
          const { describeImage } = await import("./multimodal");
          const ai = toolCtx.aiService.getDefault();
          if (!ai) {
            return { error: "AI instance not available" };
          }

          const result = await describeImage(
            ai,
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
  }

  return tools;
}

function resolveGroupRecallLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_GROUP_RECALL_LIMIT;
  }
  const normalized = Math.floor(parsed);
  return Math.max(1, normalized);
}

function resolveUserHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_HISTORY_LIMIT;
  }
  const normalized = Math.floor(parsed);
  return Math.max(1, normalized);
}

function extractTargetUserIdsFromQuestion(
  question: string,
  requesterUserId: number,
): number[] {
  const matches = question.match(/\b\d{5,12}\b/g) || [];
  const parsed = matches
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  const ids = [requesterUserId, ...parsed].filter(
    (item) => Number.isFinite(item) && item > 0,
  );
  return [...new Set(ids)].slice(0, 3);
}

async function fetchGroupHistoryByMessageIdPaging(
  toolCtx: ToolContext,
  limit: number,
): Promise<ChatMessage[]> {
  if (!toolCtx.groupId || limit <= 0) {
    return [];
  }

  const selfId = Number(toolCtx.event?.self_id || 0);
  if (!selfId) {
    return [];
  }

  const bot = toolCtx.ctx.pickBot(selfId);
  if (!bot) {
    return [];
  }

  const collected: ChatMessage[] = [];
  const seenMessageIds = new Set<string>();
  let cursorMessageId = 0;
  const maxPages = Math.max(1, Math.ceil(limit / 200) + 5);
  let page = 0;

  while (collected.length < limit && page < maxPages) {
    const remaining = limit - collected.length;
    const pageSize = Math.min(200, remaining);

    let response: any;
    try {
      response = await (bot as any).api("get_group_msg_history", {
        group_id: String(toolCtx.groupId),
        message_seq: String(cursorMessageId),
        count: pageSize,
        reverse_order: false,
        disable_get_url: true,
        parse_mult_msg: false,
        quick_reply: false,
      });
    } catch (err) {
      const errText = String(err);
      if (
        cursorMessageId > 0 &&
        (errText.includes("不存在") ||
          errText.toLowerCase().includes("not exist"))
      ) {
        logger.info(
          `[recall_memory] get_group_msg_history stop at cursor ${cursorMessageId}: ${errText}`,
        );
      } else {
        logger.warn(
          `[recall_memory] get_group_msg_history failed at cursor ${cursorMessageId}: ${errText}`,
        );
      }
      break;
    }

    const rawMessages = response?.messages || response?.data?.messages || [];
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      break;
    }

    let oldestMessageId: number | null = null;
    let newAdded = 0;

    for (const raw of rawMessages) {
      const messageId = Number(raw?.message_id || raw?.message_seq || 0);
      const key =
        messageId > 0
          ? `mid:${messageId}`
          : `${String(raw?.user_id || "unknown")}:${String(raw?.time || "0")}:${String(raw?.raw_message || "")}`;
      if (seenMessageIds.has(key)) {
        continue;
      }
      seenMessageIds.add(key);

      const content = extractGroupHistoryText(raw);
      if (!content.trim()) {
        continue;
      }

      const ts = typeof raw?.time === "number" ? raw.time * 1000 : Date.now();
      collected.push({
        sessionId: toolCtx.sessionId,
        role: String(raw?.user_id) === String(selfId) ? "assistant" : "user",
        content,
        userId:
          typeof raw?.user_id === "number" ? raw.user_id : Number(raw?.user_id),
        userName:
          raw?.sender?.card ||
          raw?.sender?.nickname ||
          String(raw?.user_id || "unknown"),
        userRole: raw?.sender?.role || "member",
        groupId: toolCtx.groupId,
        timestamp: ts,
        messageId: messageId > 0 ? messageId : undefined,
      });
      newAdded += 1;

      if (messageId > 0) {
        if (oldestMessageId === null || messageId < oldestMessageId) {
          oldestMessageId = messageId;
        }
      }
    }

    if (newAdded === 0 || oldestMessageId === null || oldestMessageId <= 1) {
      break;
    }

    // NapCat message_seq expects an existing message sequence/id.
    // Do not subtract 1 (IDs may be non-contiguous and trigger "message not exist").
    const nextCursor = oldestMessageId;
    if (nextCursor === cursorMessageId) {
      break;
    }
    cursorMessageId = nextCursor;
    page += 1;
  }

  collected.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    const aId = a.messageId || 0;
    const bId = b.messageId || 0;
    return aId - bId;
  });

  if (collected.length > limit) {
    return collected.slice(-limit);
  }
  return collected;
}

function extractGroupHistoryText(raw: any): string {
  const segments = Array.isArray(raw?.message) ? raw.message : [];
  if (segments.length === 0) {
    return String(raw?.raw_message || "").trim();
  }

  const parts: string[] = [];

  for (const seg of segments) {
    if (seg?.type === "text") {
      const text = String(seg?.data?.text || "");
      if (text) parts.push(text);
      continue;
    }

    if (seg?.type === "at") {
      const target =
        seg?.qq || seg?.data?.qq || seg?.data?.id || seg?.data?.user_id;
      if (target === "all" || target === "everyone") {
        parts.push("@全体成员");
      } else if (target) {
        parts.push(`@${target}`);
      }
      continue;
    }

    if (seg?.type === "image") {
      parts.push("[image]");
      continue;
    }
  }

  const joined = parts.join(" ").trim();
  if (joined) {
    return joined;
  }

  return String(raw?.raw_message || "").trim();
}

// ==================== Meta Tools ====================

function createLoadSkillTool(
  toolCtx: ToolContext,
  skillManager: SkillSessionManager,
): AITool {
  return {
    name: "load_skill",
    description:
      "Load an external skill's tools into the current session. Tools will be available for 1 hour.",
    parameters: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description: "Skill name to load",
        },
      },
      required: ["skill_name"],
    },
    handler: async (args) => {
      const skillName = String(args?.skill_name || "").trim();

      // Handle builtin features (markdown, audio, web_search, web_read_page, recall_memory)
      if (isBuiltinFeature(skillName)) {
        const feature = getFeatureMeta(skillName);
        if (!feature) {
          return { error: `Feature "${skillName}" not found` };
        }
        if (!isFeatureEnabled(toolCtx.config, feature)) {
          return { error: `Feature "${skillName}" is not enabled in config` };
        }

        // For features with tools, delegate to createFeatureTools
        const featureTools: AITool[] = feature.hasTools
          ? createFeatureTools(toolCtx, skillName)
          : [];
        if (featureTools.length > 0) {
          skillManager.loadSkill(toolCtx.sessionId, skillName, featureTools);
        } else {
          // For features without tools (markdown, audio), just record the feature state
          skillManager.loadFeature(toolCtx.sessionId, skillName, 60 * 60 * 1000);
        }

        return {
          success: true,
          skill_name: skillName,
          feature: true,
          expires_in: "1 hour",
          tools: featureTools.map((t) => ({
            name: `${skillName}.${t.name}`,
            description: t.description,
            parameters: t.parameters,
          })),
        };
      }

      // External skill loading (original logic)
      if (!isExternalSkillAllowed(toolCtx.config, skillName)) {
        const allSkills = toolCtx.aiService.getAllSkills?.();
        const allowedSkills = allSkills
          ? filterAllowedExternalSkills(
              toolCtx.config,
              [...allSkills.values()],
              toolCtx.triggerSkillRole,
            )
          : [];
        const allowedNames = allowedSkills.map((skill) => skill.name);

        return {
          error:
            allowedNames.length > 0
              ? `Skill "${skillName}" is not allowed. Allowed skills: ${allowedNames.join(", ")}`
              : "No external skills are allowed in current config",
        };
      }

      const skill = toolCtx.aiService.getSkill(skillName);
      if (!skill) {
        return { error: `Skill "${skillName}" does not exist` };
      }
      const requiredRole = getSkillRequiredPermissionRole(skill);
      if (!hasSkillPermission(toolCtx.triggerSkillRole, requiredRole)) {
        return {
          error: `Permission denied: loading skill "${skill.name}" requires role "${requiredRole}", current role is "${toolCtx.triggerSkillRole}"`,
        };
      }

      skillManager.loadSkill(toolCtx.sessionId, skill.name, skill.tools);

      const loadedTools = skill.tools.map((t) => ({
        name: `${skill.name}.${t.name}`,
        description: t.description,
        parameters: t.parameters,
      }));

      return {
        success: true,
        skill_name: skill.name,
        expires_in: "1 hour",
        tools: loadedTools,
      };
    },
  };
}

function createFeatureTools(
  toolCtx: ToolContext,
  featureName: FeatureName,
): AITool[] {
  switch (featureName) {
    case "web_search":
      return [createWebSearchTool(toolCtx)];
    case "web_read_page":
      return [createWebReadPageTool(toolCtx)];
    case "recall_memory":
      return [createRecallMemoryTool(toolCtx)];
    default:
      return [];
  }
}

function createWebSearchTool(toolCtx: ToolContext): AITool {
  return {
    name: "web_search",
    description:
      "Search the web using SearXNG. Use this for current events, external facts, documentation, or anything not in chat history.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Alternative input. Multiple search queries; only the first non-empty query will be used.",
        },
        limit: {
          type: "number",
          description:
            "Max number of results to return. Will be clamped by config maxLimit.",
        },
        time_range: {
          type: "string",
          enum: ["day", "month", "year"],
          description: "Optional time filter for recent results",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional categories, e.g. ["general"], ["news"], ["science"]',
        },
        engines: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional engines, e.g. ["google"], ["bing"], ["duckduckgo"]',
        },
      },
      required: [],
    },
    handler: async (args) => {
      return searchWebWithSearxng(toolCtx.config.searxng, args || {});
    },
  };
}

function createWebReadPageTool(toolCtx: ToolContext): AITool {
  return {
    name: "web_read_page",
    description:
      "Read a webpage by URL, extract its main content, and compress the content into a short, information-dense passage. Use this directly when the user already provides a URL, or combine with web_search when you need to discover relevant pages first.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The http/https URL of the webpage to read",
        },
        render_js: {
          type: "boolean",
          description:
            "Set true only if the page likely requires JavaScript rendering. This uses much more CPU and memory.",
        },
        question: {
          type: "string",
          description:
            "Optional question or focus. The tool will prioritize webpage details relevant to this question.",
        },
      },
      required: ["url"],
    },
    handler: async (args) => {
      try {
        const ai = toolCtx.config.webReader.useWorkingModel
          ? toolCtx.aiService.getDefault()
          : undefined;
        if (toolCtx.config.webReader.useWorkingModel && !ai) {
          return { success: false, error: "AI instance not available" };
        }

        return await readWebPage(
          ai,
          toolCtx.config.workingModel || toolCtx.config.model,
          toolCtx.config.webReader,
          args || {},
        );
      } catch (err) {
        return { success: false, error: `Failed to read webpage: ${err}` };
      }
    },
  };
}

function createRecallMemoryTool(toolCtx: ToolContext): AITool {
  return {
    name: "recall_memory",
    description:
      "Ask the memory worker model to retrieve historical chat context for a recall question. Use only when recall is explicitly needed and the answer is not already in current context.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The recall question to investigate, e.g. 'What did user 123 mention about travel plans before?'",
        },
      },
      required: ["question"],
    },
    handler: async (args) => {
      const question = String(args?.question || "").trim();
      if (!question) {
        return {
          success: false,
          error: "question is required",
        };
      }

      const ai = toolCtx.aiService.getDefault();
      if (!ai) {
        return { success: false, error: "AI instance not available" };
      }

      const groupHistoryLimit = resolveGroupRecallLimit(
        toolCtx.config.memory?.groupHistoryLimit,
      );
      const userHistoryLimit = resolveUserHistoryLimit(
        toolCtx.config.memory?.userHistoryLimit,
      );
      const groupHistoryMessages = await fetchGroupHistoryByMessageIdPaging(
        toolCtx,
        groupHistoryLimit,
      );
      const targetUserIds = extractTargetUserIdsFromQuestion(
        question,
        toolCtx.userId,
      );
      const userHistories: MemoryUserHistoryChunk[] = targetUserIds.map(
        (userId) => ({
          userId,
          messages: toolCtx.db.getMessagesByUser(
            userId,
            toolCtx.sessionId,
            userHistoryLimit,
          ),
        }),
      );

      const retriever = new MemoryRetrieval(ai, toolCtx.config, toolCtx.db);
      const answer = await retriever.retrieveByQuestion({
        sessionId: toolCtx.sessionId,
        question,
        nowTimestamp: Date.now(),
        groupHistoryMessages,
        userHistories,
      });
      const queriedAt = new Date().toLocaleString("zh-CN", {
        hour12: false,
      });
      return {
        success: true,
        queried_at: queriedAt,
        question,
        found: Boolean(answer),
        answer: answer || "",
        group_history_count: groupHistoryMessages.length,
        group_history_limit: groupHistoryLimit,
        user_history_limit: userHistoryLimit,
        user_history_targets: targetUserIds,
        note: answer
          ? "Memory worker retrieved historical context."
          : "Memory worker did not find useful historical context.",
      };
    },
  };
}
