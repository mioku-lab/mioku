import type { AIModelDescriptor, AIService } from "mioku";

const supportsVision = (model?: AIModelDescriptor): boolean =>
  Boolean(model?.capabilities?.includes("vision"));

export function mainModelSupportsVision(
  aiService: AIService | undefined,
  fallbackModelId?: string,
): boolean {
  if (!aiService) return false;

  const models = aiService.listModels?.() ?? [];
  const boundId = aiService.getRoleBindings?.()?.main;
  if (boundId) {
    const bound = models.find((item) => item.id === boundId);
    if (bound) return supportsVision(bound);
  }

  const instance = (aiService.listInstances?.() ?? []).find(
    (item) => item.role === "main" || item.name === "main",
  );
  const modelId = fallbackModelId || instance?.modelId || "";
  if (!modelId) return false;

  return supportsVision(
    models.find(
      (item) =>
        item.modelId === modelId && item.providerId === instance?.providerId,
    ) ?? models.find((item) => item.modelId === modelId),
  );
}
