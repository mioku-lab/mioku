import type {
  AIInstance,
  AIModelDescriptor,
  AIModelRole,
  AIService,
} from "mioku";
import type { ChatConfig } from "../types";
import { readField } from "../utils/record";

/** apiKey 为空时填入的哨兵值，表示连接交给 ai-service */
export const LEGACY_API_KEY_SENTINEL = "__ai_service__";

export interface RoleModels {
  main: string;
  working: string;
  vision: string;
}

export interface ResolvedRoleInstances {
  main: AIInstance;
  work: AIInstance;
  vision: AIInstance;
  models: RoleModels;
  isMultimodal: boolean;
  /** vision 角色绑的模型看不了图，已借用主模型 */
  visionFromMain: boolean;
}

const EMPTY_BINDINGS: Record<AIModelRole, string | undefined> = {
  main: undefined,
  working: undefined,
  vision: undefined,
};

export function resolveRoleInstances(
  aiService: AIService,
): ResolvedRoleInstances | null {
  const getByRole = (role: AIModelRole) =>
    aiService.getInstanceByRole?.(role) ?? aiService.get?.(role) ?? undefined;

  const main =
    getByRole("main") ?? aiService.getDefault?.() ?? aiService.get?.("main");
  if (!main) return null;

  const work = getByRole("working") ?? aiService.get?.("work") ?? main;

  const bindings = aiService.getRoleBindings?.() ?? EMPTY_BINDINGS;
  const instances = aiService.listInstances?.() ?? [];
  const instanceName = (instance: AIInstance): string | undefined => {
    const name = readField(instance, "name");
    return typeof name === "string" ? name : undefined;
  };
  const findModel = (role: AIModelRole, fallbackInstance: AIInstance) => {
    const full = bindings[role];
    if (full && full.includes("/")) return full.split("/").slice(1).join("/");
    const info = instances.find(
      (item) => item.role === role || item.name === role,
    );
    if (info?.modelId) return info.modelId;
    const fallbackName = instanceName(fallbackInstance);
    const anyInfo = instances.find((item) => item.name === fallbackName);
    return anyInfo?.modelId || "";
  };

  const mainModel = findModel("main", main);
  const workingModel = findModel("working", work) || mainModel;

  const models = aiService.listModels?.() ?? [];
  const findModelDesc = (
    role: AIModelRole,
    modelId: string,
  ): AIModelDescriptor | undefined => {
    const exact = models.find((item) => item.id === bindings[role]);
    if (exact) return exact;
    const providerId = instances.find(
      (info) => info.role === role || info.name === role,
    )?.providerId;
    return (
      models.find(
        (item) => item.modelId === modelId && item.providerId === providerId,
      ) || models.find((item) => item.modelId === modelId)
    );
  };
  // 查不到模型描述时按未知处理，不能据此判定它看不了图
  const canSeeImages = (
    role: AIModelRole,
    modelId: string,
  ): boolean | undefined => {
    const desc = findModelDesc(role, modelId);
    if (!desc) return undefined;
    return Boolean(desc.capabilities?.includes("vision"));
  };

  let vision = getByRole("vision") ?? aiService.get?.("vision") ?? work;
  let visionModel = findModel("vision", vision) || workingModel;
  let visionRole: AIModelRole = "vision";
  let visionFromMain = false;

  // vision 绑到纯文本模型时借主模型看图，否则媒体识别会被静默关掉
  if (
    canSeeImages("vision", visionModel) === false &&
    canSeeImages("main", mainModel) !== false
  ) {
    vision = main;
    visionModel = mainModel;
    visionRole = "main";
    visionFromMain = true;
  }

  const visionDesc = findModelDesc(visionRole, visionModel);
  const isMultimodal =
    visionDesc === undefined
      ? Boolean(visionModel)
      : Boolean(visionDesc.capabilities?.includes("vision"));

  return {
    main,
    work,
    vision,
    models: { main: mainModel, working: workingModel, vision: visionModel },
    isMultimodal,
    visionFromMain,
  };
}

/**
 * 没有角色绑定、但 chat/base 里还留着旧版 apiUrl/apiKey 时，
 * 用它们临时创建 main/work/vision 三个实例并绑定角色。
 * 返回是否创建了实例。
 */
export async function createLegacyRoleInstances(
  aiService: AIService,
  config: ChatConfig,
): Promise<boolean> {
  const apiUrl = String(config.apiUrl || "").trim();
  const apiKey = String(config.apiKey || "").trim();
  if (!apiUrl || !apiKey || apiKey === LEGACY_API_KEY_SENTINEL) return false;

  const mainModel = String(config.model || "").trim() || "default";
  const workingModel = String(config.workingModel || mainModel);
  const visionModel = String(config.multimodalWorkingModel || mainModel);

  await aiService.create({
    name: "main",
    apiUrl,
    apiKey,
    modelType: "multimodal",
    model: mainModel,
  });
  await aiService.create({
    name: "work",
    apiUrl,
    apiKey,
    modelType: "text",
    model: workingModel,
  });
  await aiService.create({
    name: "vision",
    apiUrl,
    apiKey,
    modelType: "multimodal",
    model: visionModel,
  });
  aiService.setDefault("main");
  aiService.setRoleBinding?.("main", `runtime-main/${mainModel}`);
  aiService.setRoleBinding?.("working", `runtime-work/${workingModel}`);
  aiService.setRoleBinding?.("vision", `runtime-vision/${visionModel}`);
  return true;
}
