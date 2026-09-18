import { logger } from "mioku";
import type {
  AIInstanceInfo,
  AIModelCapability,
  AIModelDescriptor,
  AIModelRole,
  AIProviderConfig,
  AISkill,
  AIThinkingLevel,
  AITool,
  ChatRuntime,
} from "mioku";
import { createProviderClient } from "./providers";
import { AIInstanceImpl } from "./instance";
import { ProvidersRegistry } from "./providers-registry";
import { createAIUsageStore } from "./usage/store";
import type { AIInstance, AIService } from "./types";
import type {
  AIUsageFinalization,
  AIUsageRange,
  AIUsageStore,
} from "./usage/types";
import { parseModelFullId } from "./types";

export class AIServiceImpl implements AIService {
  private instances = new Map<string, AIInstanceImpl>();
  private globalSkills = new Map<string, AISkill>();
  private toolIndex = new Map<string, AITool>();
  private bareToolIndex = new Map<string, AITool>();
  private defaultInstanceName: string | null = null;
  private chatRuntime: ChatRuntime | null = null;
  private readonly usageStore: AIUsageStore;
  private readonly registry: ProvidersRegistry;
  private roleInstances = new Map<AIModelRole, string>();
  private mainFallbackModelFullIds: string[] = [];

  constructor(usageStore: AIUsageStore, registry?: ProvidersRegistry) {
    this.usageStore = usageStore;
    this.registry = registry || new ProvidersRegistry();
    this.registry.load();
    this.registry.migrateFromChatBaseIfNeeded();
    this.defaultInstanceName = this.registry.getDefaultInstanceName() || null;
    this.mainFallbackModelFullIds = this.registry.getMainFallback();
    this.bootstrapRoleInstances();
    this.resolveMainFallbackChain();
  }

  private thinkingLevelProvider(
    providerId: string,
    modelId: string,
  ): () => AIThinkingLevel | undefined {
    return () => this.registry.getModel(`${providerId}/${modelId}`)?.thinkingLevel;
  }

  private bootstrapRoleInstances(): void {
    const roles = this.registry.getRoleBindings();
    for (const role of ["main", "working", "vision"] as AIModelRole[]) {
      const fullId = roles[role];
      if (!fullId) continue;
      try {
        const parsed = parseModelFullId(fullId);
        if (!parsed) continue;
        const provider = this.registry.getProvider(parsed.providerId);
        const client = this.registry.getClient(parsed.providerId);
        if (!provider || !client) continue;
        const instance = new AIInstanceImpl({
          name: role,
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          client,
          globalSkills: this.globalSkills,
          usageStore: this.usageStore,
          role,
          thinkingLevelProvider: this.thinkingLevelProvider(
            parsed.providerId,
            parsed.modelId,
          ),
        });
        this.instances.set(role, instance);
        this.roleInstances.set(role, role);
        if (role === "main") {
          this.defaultInstanceName = role;
          this.registry.setDefaultInstanceName(role);
        }
      } catch (error) {
        logger.warn(`[ai] bootstrap role ${role} failed: ${error}`);
      }
    }
  }

  private resolveMainFallbackChain(): AIInstanceImpl[] {
    const main = this.instances.get("main");
    if (!main) return [];
    const chain: AIInstanceImpl[] = [];
    const seen = new Set<string>([main.name]);
    for (const fullId of this.mainFallbackModelFullIds) {
      const parsed = parseModelFullId(fullId);
      if (!parsed) {
        logger.warn(`[ai] 主模型错误转移解析失败: ${fullId}`);
        continue;
      }
      const provider = this.registry.getProvider(parsed.providerId);
      if (!provider) {
        logger.warn(`[ai] 主模型错误转移提供商不存在: ${fullId}`);
        continue;
      }
      const client = this.registry.getClient(parsed.providerId);
      if (!client) {
        logger.warn(`[ai] 主模型错误转移提供商未启用: ${fullId}`);
        continue;
      }
      const key = `${parsed.providerId}/${parsed.modelId}`;
      if (seen.has(key)) {
        logger.warn(`[ai] 主模型错误转移重复: ${fullId}`);
        continue;
      }
      seen.add(key);
      let fb = this.instances.get(key);
      if (!fb) {
        fb = new AIInstanceImpl({
          name: `__fb_${parsed.providerId}_${parsed.modelId}`,
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          client,
          globalSkills: this.globalSkills,
          usageStore: this.usageStore,
          role: "working",
          thinkingLevelProvider: this.thinkingLevelProvider(
            parsed.providerId,
            parsed.modelId,
          ),
        });
        this.instances.set(fb.name, fb);
      }
      chain.push(fb);
    }
    main.setFallbackChain(chain);
    return chain;
  }

  setMainFallbackChain(modelFullIds: string[]): void {
    this.registry.setMainFallback(modelFullIds);
    this.mainFallbackModelFullIds = this.registry.getMainFallback();
    const chain = this.resolveMainFallbackChain();
  }

  getMainFallbackChain(): string[] {
    return [...this.mainFallbackModelFullIds];
  }

  async create(options: {
    name: string;
    apiUrl: string;
    apiKey: string;
    modelType: "text" | "multimodal";
    model?: string;
  }): Promise<AIInstance> {
    const providerId = `runtime-${options.name}`;
    let provider = this.registry.getProvider(providerId);
    if (!provider) {
      provider = await this.registry.createProvider({
        id: providerId,
        name: `Runtime ${options.name}`,
        protocol: "openai-chat",
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        enabled: true,
      });
    } else {
      provider = await this.registry.updateProvider(providerId, {
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        enabled: true,
      });
    }

    const modelId = String(options.model || "").trim() || "default";
    if (!this.registry.getModel(`${provider.id}/${modelId}`)) {
      this.registry.registerCustomModel({
        providerId: provider.id,
        modelId,
        name: modelId,
        capabilities:
          options.modelType === "multimodal"
            ? ["text", "vision", "tool-use"]
            : ["text", "tool-use"],
      });
    }

    return this.createInstance({
      name: options.name,
      providerId: provider.id,
      modelId,
    });
  }

  async createInstance(options: {
    name: string;
    providerId: string;
    modelId: string;
    role?: AIModelRole;
  }): Promise<AIInstance> {
    if (this.instances.has(options.name)) {
      logger.warn(`AI instance ${options.name} already exists, replacing`);
      this.instances.delete(options.name);
    }

    const provider = this.registry.getProvider(options.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${options.providerId}`);
    }
    if (!provider.enabled) {
      throw new Error(`Provider disabled: ${options.providerId}`);
    }

    const client = this.registry.getClient(options.providerId);
    if (!client) {
      throw new Error(
        `Failed to create client for provider: ${options.providerId}`,
      );
    }

    const modelId = String(options.modelId || "").trim();
    if (!modelId) throw new Error("modelId is required");

    if (!this.registry.getModel(`${options.providerId}/${modelId}`)) {
      this.registry.registerCustomModel({
        providerId: options.providerId,
        modelId,
      });
    }

    const instance = new AIInstanceImpl({
      name: options.name,
      providerId: options.providerId,
      modelId,
      client,
      globalSkills: this.globalSkills,
      usageStore: this.usageStore,
      role: options.role,
      thinkingLevelProvider: this.thinkingLevelProvider(
        options.providerId,
        modelId,
      ),
    });
    this.instances.set(options.name, instance);
    if (options.role) {
      this.roleInstances.set(options.role, options.name);
      this.registry.setRoleBinding(
        options.role,
        `${options.providerId}/${modelId}`,
      );
    }
    if (!this.defaultInstanceName) {
      this.setDefault(options.name);
    }
    if (options.role === "main") {
      this.resolveMainFallbackChain();
    }
    logger.info(
      `AI instance ${options.name} created (${options.providerId}/${modelId})`,
    );
    return instance;
  }

  get(name: string): AIInstance | undefined {
    return this.instances.get(name);
  }

  list(): string[] {
    return [...this.instances.keys()];
  }

  listInstances(): AIInstanceInfo[] {
    return [...this.instances.values()].map((instance) => ({
      name: instance.name,
      providerId: instance.providerId,
      modelId: instance.modelId,
      role: instance.role,
    }));
  }

  remove(name: string): boolean {
    const deleted = this.instances.delete(name);
    if (deleted) {
      if (this.defaultInstanceName === name) {
        this.defaultInstanceName = null;
        this.registry.setDefaultInstanceName(undefined);
      }
      for (const [role, instanceName] of this.roleInstances) {
        if (instanceName === name) this.roleInstances.delete(role);
      }
      logger.info(`AI instance ${name} removed`);
    }
    return deleted;
  }

  setDefault(name: string): boolean {
    if (!this.instances.has(name)) {
      logger.warn(`Cannot set default: AI instance ${name} not found`);
      return false;
    }
    this.defaultInstanceName = name;
    this.registry.setDefaultInstanceName(name);
    logger.info(`Default AI instance set to ${name}`);
    return true;
  }

  getDefault(): AIInstance | undefined {
    if (this.defaultInstanceName) {
      return this.instances.get(this.defaultInstanceName);
    }
    return this.instances.values().next().value;
  }

  listProviders(): AIProviderConfig[] {
    return this.registry.listProviders();
  }

  getProvider(id: string): AIProviderConfig | undefined {
    return this.registry.getProvider(id);
  }

  async createProvider(
    input: Omit<AIProviderConfig, "id"> & { id?: string },
  ): Promise<AIProviderConfig> {
    return this.registry.createProvider(input);
  }

  async updateProvider(
    id: string,
    input: Partial<AIProviderConfig>,
  ): Promise<AIProviderConfig> {
    const provider = await this.registry.updateProvider(id, input);
    for (const [name, instance] of this.instances) {
      if (instance.providerId === id) {
        await this.createInstance({
          name,
          providerId: id,
          modelId: instance.modelId,
          role: instance.role,
        });
      }
    }
    return provider;
  }

  removeProvider(id: string): boolean {
    for (const [name, instance] of this.instances) {
      if (instance.providerId === id) this.remove(name);
    }
    return this.registry.removeProvider(id);
  }

  async testProvider(
    id: string,
  ): Promise<{ ok: boolean; error?: string; models?: AIModelDescriptor[] }> {
    try {
      const provider = this.registry.getProvider(id);
      if (!provider) return { ok: false, error: "PROVIDER_NOT_FOUND" };
      const client = createProviderClient(provider);
      const models = await client.listModels();
      if (models.length > 0) {
        await this.registry.refreshModels(id);
      }
      const probeModel =
        models[0]?.modelId ||
        this.registry.listModels(id)[0]?.modelId ||
        "gpt-4o-mini";
      await client.complete({
        model: probeModel,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        temperature: 0,
        cachePreference: "prefer",
      });
      return {
        ok: true,
        models: this.registry.listModels(id),
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  listModels(providerId?: string): AIModelDescriptor[] {
    return this.registry.listModels(providerId);
  }

  async refreshModels(providerId: string): Promise<AIModelDescriptor[]> {
    return this.registry.refreshModels(providerId);
  }

  registerCustomModel(input: {
    providerId: string;
    modelId: string;
    name?: string;
    capabilities?: AIModelCapability[];
    thinkingLevel?: AIThinkingLevel;
  }): AIModelDescriptor {
    return this.registry.registerCustomModel(input);
  }

  removeCustomModel(modelFullId: string): boolean {
    return this.registry.removeCustomModel(modelFullId);
  }

  removeModel(modelFullId: string): boolean {
    const removed = this.registry.removeModel(modelFullId);
    if (!removed) return false;
    // 清理因模型删除而失去绑定的角色实例，并刷新错误转移链
    const bindings = this.registry.getRoleBindings();
    for (const [role, instanceName] of this.roleInstances) {
      if (!bindings[role]) this.remove(instanceName);
    }
    this.resolveMainFallbackChain();
    return true;
  }

  setModelThinkingLevel(
    modelFullId: string,
    level: AIThinkingLevel | undefined,
  ): boolean {
    return this.registry.setModelThinkingLevel(modelFullId, level);
  }

  getRoleBindings(): Record<AIModelRole, string | undefined> {
    return this.registry.getRoleBindings();
  }

  setRoleBinding(role: AIModelRole, modelFullId: string | undefined): boolean {
    const ok = this.registry.setRoleBinding(role, modelFullId);
    if (!ok) return false;
    if (!modelFullId) {
      const instanceName = this.roleInstances.get(role);
      if (instanceName) this.remove(instanceName);
      this.roleInstances.delete(role);
      return true;
    }
    const parsed = parseModelFullId(modelFullId);
    if (!parsed) return false;
    void this.createInstance({
      name: role,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      role,
    }).then(() => {
      this.roleInstances.set(role, role);
      if (role === "main") this.setDefault(role);
    });
    return true;
  }

  getInstanceByRole(role: AIModelRole): AIInstance | undefined {
    const name = this.roleInstances.get(role) || role;
    const instance = this.instances.get(name);
    if (instance) return instance;
    const binding = this.registry.getRoleBindings()[role];
    if (!binding) return undefined;
    const parsed = parseModelFullId(binding);
    if (!parsed) return undefined;
    const provider = this.registry.getProvider(parsed.providerId);
    const client = this.registry.getClient(parsed.providerId);
    if (!provider || !client) return undefined;
    const created = new AIInstanceImpl({
      name: role,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      client,
      globalSkills: this.globalSkills,
      usageStore: this.usageStore,
      role,
      thinkingLevelProvider: this.thinkingLevelProvider(
        parsed.providerId,
        parsed.modelId,
      ),
    });
    this.instances.set(role, created);
    this.roleInstances.set(role, role);
    if (role === "main") {
      this.resolveMainFallbackChain();
    }
    return created;
  }

  registerChatRuntime(runtime: ChatRuntime): boolean {
    this.chatRuntime = runtime;
    logger.info("Chat runtime registered successfully");
    return true;
  }

  getChatRuntime(): ChatRuntime | undefined {
    return this.chatRuntime ?? undefined;
  }

  removeChatRuntime(): boolean {
    if (!this.chatRuntime) return false;
    this.chatRuntime = null;
    logger.info("Chat runtime removed");
    return true;
  }

  registerSkill(skill: AISkill): boolean {
    if (this.globalSkills.has(skill.name)) {
      logger.warn(`Skill ${skill.name} already exists, overwriting`);
    }
    this.globalSkills.set(skill.name, skill);
    this.rebuildToolIndex();
    logger.info(
      `Skill ${skill.name} registered with ${skill.tools.length} tools`,
    );
    return true;
  }

  getSkill(skillName: string): AISkill | undefined {
    return this.globalSkills.get(skillName);
  }

  getAllSkills(): Map<string, AISkill> {
    return this.globalSkills;
  }

  removeSkill(skillName: string): boolean {
    const deleted = this.globalSkills.delete(skillName);
    if (deleted) {
      this.rebuildToolIndex();
      logger.info(`Skill ${skillName} removed`);
    }
    return deleted;
  }

  getTool(toolName: string): AITool | undefined {
    return this.toolIndex.get(toolName) ?? this.bareToolIndex.get(toolName);
  }

  getAllTools(): Map<string, AITool> {
    return new Map(this.toolIndex);
  }

  getUsageSummary(options: { range: AIUsageRange; botId?: number }) {
    return this.usageStore.getSummary(options);
  }

  cleanupUsageStats(retentionMs?: number): number {
    return this.usageStore.cleanup(retentionMs);
  }

  finalizeUsage(usageId: string, finalization: AIUsageFinalization): boolean {
    return this.usageStore.updateFinalization(usageId, finalization);
  }

  dispose(): void {
    this.usageStore.close();
  }

  private rebuildToolIndex(): void {
    this.toolIndex.clear();
    this.bareToolIndex.clear();
    for (const [skillName, skill] of this.globalSkills) {
      for (const tool of skill.tools) {
        this.toolIndex.set(`${skillName}-${tool.name}`, tool);
        if (!this.bareToolIndex.has(tool.name)) {
          this.bareToolIndex.set(tool.name, tool);
        }
      }
    }
  }
}

export function createAIService(): AIServiceImpl {
  return new AIServiceImpl(createAIUsageStore(), new ProvidersRegistry());
}
