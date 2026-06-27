import type { AIInstance } from "mioku";
import { logger } from "mioki";
import type {
  ChatConfig,
  ChatMessage,
  PlannerAction,
  PlannerResult,
} from "../types";

export class ActionPlanner {
  private ai: AIInstance;
  private config: ChatConfig;
  private actionHistory: Map<
    string,
    { action: PlannerAction; time: number }[]
  > = new Map();
  private pendingPlans: Map<string, Promise<PlannerResult>> = new Map();

  constructor(ai: AIInstance, config: ChatConfig) {
    this.ai = ai;
    this.config = config;
  }

  async plan(
    sessionId: string,
    botName: string,
    recentHistory: ChatMessage[],
    lastTriggerMessage: string,
    isIdleCheck: boolean = false,
  ): Promise<PlannerResult> {
    if (!this.config.planner?.enabled) {
      return { action: "reply", reason: "planner disabled" };
    }

    // Guard: if a plan call is already in-flight for this session, wait for it
    const existing = this.pendingPlans.get(sessionId);
    if (existing) {
      logger.info(`[ActionPlanner] Session ${sessionId} has a plan already in-flight, waiting...`);
      return existing;
    }

    const planPromise = this.doPlan(sessionId, botName, recentHistory, lastTriggerMessage, isIdleCheck);
    this.pendingPlans.set(sessionId, planPromise);

    try {
      return await planPromise;
    } finally {
      this.pendingPlans.delete(sessionId);
    }
  }

  private async doPlan(
    sessionId: string,
    botName: string,
    recentHistory: ChatMessage[],
    lastTriggerMessage: string,
    isIdleCheck: boolean,
  ): Promise<PlannerResult> {
    if (!this.config.planner?.enabled) {
      return { action: "reply", reason: "planner disabled" };
    }

    const history = this.actionHistory.get(sessionId) ?? [];
    const recentActions = history.slice(-10);
    const actionsBlock = recentActions
      .map((a) => `[${new Date(a.time).toLocaleTimeString()}] ${a.action}`)
      .join("\n");

    const chatBlock = recentHistory
      .slice(-100)
      .map((m) => {
        const time = new Date(m.timestamp);
        const timeStr = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
        return `[${timeStr}] ${m.userName || (m.role === "assistant" ? botName : "unknown")}: ${m.content}`;
      })
      .join("\n");

    const now = new Date();
    const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    let prompt: string;

    if (isIdleCheck) {
      // 空闲检测模式：没有明确触发消息，观察群友聊天并决定是否要融入对话
      prompt = `It is ${timeStr}. Your name is ${botName}.

Here is the recent chat content (from oldest to most recent):
${chatBlock || "(no chat history)"}

IMPORTANT: There is no specific trigger message this time. You are being proactively invited to observe the group chat and decide whether to speak up.

REPLY when ANY of these is true:
- The conversation mentions ${botName} (you), AI, or any topic you know about
- There's any question unanswered
- The conversation is about school, life, tech, or anything you can contribute to
- Even fragmented/random messages - you can start a new topic or comment on something!

WAIT only when:
- The conversation is clearly done and everyone left
- There's absolutely nothing you can think of to say

IMPORTANT: When in doubt, REPLY! Group chats are often casual and fragmented - that's okay! Your message doesn't need to be perfect, just be natural and friendly.

Available actions:

reply - Send a message to naturally join the conversation (1-2 sentences max, be concise!)

wait - Stay silent and continue observing

complete - The chat is dead, no one is talking

IMPORTANT: You MUST output ONLY valid JSON, no other text. The JSON must be in this exact format:
{"action": "reply", "reason": "your reason here", "wait_seconds": 0}

OR for wait:
{"action": "wait", "reason": "your reason here", "wait_seconds": 60}

OR for complete:
{"action": "complete", "reason": "your reason here", "wait_seconds": 0}

DO NOT include any explanation, markdown formatting, or additional text. Only output the JSON.`;
    } else {
      // 正常模式：由触发消息驱动的 planner
      prompt = `It is ${timeStr}. Your name is ${botName}.

Here is the chat content:
${chatBlock}

Action history:
${actionsBlock || "(none)"}

Message that triggered you: ${lastTriggerMessage}

Available actions:

reply - Respond ONLY when truly necessary:
- Someone directly asked you a question
- Someone mentioned you specifically
- Something needs explanation or clarification
- There's an obvious opportunity to add real value

wait - DEFAULT choice. Stay silent when:
- You have nothing meaningful to add
- The conversation doesn't need you
- Someone else is already handling it
- You're just being polite but have nothing to say

complete - The chat is over, no activity for a while

IMPORTANT: Silence is golden. When in doubt, WAIT. Don't speak just because you can.

IMPORTANT: You MUST output ONLY valid JSON, no other text. The JSON must be in this exact format:
{"action": "reply", "reason": "your reason here", "wait_seconds": 0}

OR for wait:
{"action": "wait", "reason": "your reason here", "wait_seconds": 30}

OR for complete:
{"action": "complete", "reason": "your reason here", "wait_seconds": 0}

DO NOT include any explanation, markdown formatting, or additional text. Only output the JSON.`;
    }

    try {
      logger.info(
        `[ActionPlanner] Planning action for session ${sessionId}, last message: "${lastTriggerMessage.substring(0, 50)}...", isIdleCheck: ${isIdleCheck}`,
      );

      const content = await this.ai.generateText({
        prompt,
        messages: [],
        model: this.config.workingModel || this.config.model,
        temperature: isIdleCheck ? 0.3 : 0.2,
        max_tokens: isIdleCheck ? 300 : 500,
      });

      // 如果返回内容为空，使用默认值
      if (!content || !content.trim()) {
        logger.warn(
          `[ActionPlanner] Empty response from AI, using default reply`,
        );
        return { action: "reply", reason: "empty response" };
      }

      // 尝试提取 JSON 块
      let jsonStr = "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      if (!jsonStr) {
        logger.warn(
          `[ActionPlanner] Failed to find JSON in response: ${content.substring(0, 100)}`,
        );
        return { action: "reply", reason: "parse failed" };
      }

      // 尝试解析 JSON
      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        // 尝试修复常见的 JSON 错误
        try {
          // 移除可能存在的尾随逗号
          jsonStr = jsonStr.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          logger.warn(
            `[ActionPlanner] Failed to parse JSON: ${jsonStr.substring(0, 100)}`,
          );
          return { action: "reply", reason: "parse failed" };
        }
      }
      const action: PlannerAction =
        parsed.action === "wait"
          ? "wait"
          : parsed.action === "complete"
            ? "complete"
            : "reply";

      const result: PlannerResult = {
        action,
        reason: parsed.reason || "",
        waitMs:
          action === "wait"
            ? Math.min(
                Math.max((parsed.wait_seconds || 30) * 1000, 10000),
                300000,
              )
            : undefined,
      };

      const actions = this.actionHistory.get(sessionId) ?? [];
      actions.push({ action, time: Date.now() });
      if (actions.length > 20) actions.splice(0, actions.length - 20);
      this.actionHistory.set(sessionId, actions);

      logger.info(
        `[ActionPlanner] Session ${sessionId}: action=${action}, reason="${result.reason}"${result.waitMs ? `, waitMs=${result.waitMs}` : ""}`,
      );
      return result;
    } catch (err) {
      logger.error(`[ActionPlanner] Error: ${err}`);
      return { action: "wait", reason: "error fallback", waitMs: 60_000 };
    }
  }
}