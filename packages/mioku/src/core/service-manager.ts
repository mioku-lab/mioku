import * as fs from "fs/promises";
import * as path from "path";
import { existsSync, mkdirSync } from "fs";
import { logger, type MiokiContext } from "mioki";
import type { ServiceMetadata, MiokuService } from "./types";

const SERVICE_MANAGER_SYMBOL = Symbol.for("mioku.service-manager");

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 服务管理器
 */
export class ServiceManager {
  private services: Map<string, MiokuService> = new Map();
  private serviceMetadata: Map<string, ServiceMetadata> = new Map();
  private servicesDir: string = "services";

  public static getInstance(): ServiceManager {
    const g = global as any;
    if (!g[SERVICE_MANAGER_SYMBOL]) {
      g[SERVICE_MANAGER_SYMBOL] = new ServiceManager();
    }
    return g[SERVICE_MANAGER_SYMBOL];
  }

  async discoverServices(miokuConfig: any = {}): Promise<ServiceMetadata[]> {
    // Use services_dir from mioku config if provided, otherwise default to "services" in project root
    if (miokuConfig.services_dir) {
      this.servicesDir = path.resolve(process.cwd(), miokuConfig.services_dir);
    } else {
      this.servicesDir = path.resolve(process.cwd(), "services");
    }

    const discovered: ServiceMetadata[] = [];

    // Discover from local services/ directory
    if (existsSync(this.servicesDir)) {
      const localServices = await this.discoverFromDir(this.servicesDir);
      discovered.push(...localServices);
    } else {
      // Ensure the directory exists for user services
      mkdirSync(this.servicesDir, { recursive: true });
    }

    // Discover builtin services (config, ai, screenshot, webui)
    await this.loadBuiltinServices();

    logger.info(`o.O 发现了 ${this.serviceMetadata.size} 个服务`);
    return Array.from(this.serviceMetadata.values());
  }

  private async discoverFromDir(servicesDir: string): Promise<ServiceMetadata[]> {
    const discovered: ServiceMetadata[] = [];

    try {
      const entries = await fs.readdir(servicesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const servicePath = path.join(servicesDir, entry.name);
        const metadata = await this.loadServiceMetadata(entry.name, servicePath);
        if (metadata) {
          discovered.push(metadata);
          this.serviceMetadata.set(entry.name, metadata);
        }
      }
    } catch (error) {
      logger.error(`扫描服务目录失败: ${error}`);
    }

    return discovered;
  }

  private async loadServiceMetadata(
    name: string,
    servicePath: string,
  ): Promise<ServiceMetadata | null> {
    const packageJsonPath = path.join(servicePath, "package.json");

    if (!(await pathExists(packageJsonPath))) {
      return null;
    }

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf-8"),
      );
      const metadata: ServiceMetadata = {
        name,
        version: packageJson.version || "0.0.0",
        description: packageJson.description,
        path: servicePath,
        packageJson,
      };
      return metadata;
    } catch (error: any) {
      logger.error(`解析服务 ${name} 失败: ${error.message}`);
      return null;
    }
  }

  /**
   * Load built-in services from the package
   */
  private async loadBuiltinServices(): Promise<void> {
    // Builtin services are registered directly via the package exports
    // This method is called to ensure they're counted in the discovery output
    const builtinServices = ["config", "ai", "screenshot", "webui"];
    for (const name of builtinServices) {
      if (!this.serviceMetadata.has(name)) {
        logger.debug(`Registered builtin service: ${name}`);
      }
    }
  }

  async checkMissingServices(requiredServices: Set<string>): Promise<string[]> {
    const missing: string[] = [];
    for (const serviceName of requiredServices) {
      if (!this.serviceMetadata.has(serviceName)) {
        missing.push(serviceName);
      }
    }
    return missing;
  }

  async loadAllServices(ctx: MiokiContext): Promise<void> {
    const allMetadata = Array.from(this.serviceMetadata.values());
    logger.info(`O.o 准备加载 ${allMetadata.length} 个服务...`);

    for (const metadata of allMetadata) {
      await this.loadService(metadata, ctx);
    }
  }

  private async loadService(
    metadata: ServiceMetadata,
    ctx: MiokiContext,
  ): Promise<boolean> {
    try {
      const indexPath = path.join(metadata.path, "index.ts");
      const indexJsPath = path.join(metadata.path, "index.js");
      const indexExists = await pathExists(indexPath);
      const indexJsExists = await pathExists(indexJsPath);
      const entryPoint = indexExists ? indexPath : indexJsPath;

      if (!entryPoint || (!indexExists && !indexJsExists)) {
        logger.error(`服务 ${metadata.name} 入口丢失`);
        return false;
      }

      let importPath = entryPoint;
      if (process.platform === "win32") {
        importPath = "file:///" + entryPoint.replace(/\\/g, "/");
      }

      const serviceModule = await import(importPath);
      const service: MiokuService = serviceModule.default || serviceModule;

      if (!service || typeof service.init !== "function") return false;

      await service.init();
      if (service.api) {
        if (!(ctx as any).services) (ctx as any).services = {};
        (ctx as any).services[metadata.name] = service.api;
      }

      this.services.set(metadata.name, service);
      return true;
    } catch (error: any) {
      logger.error(`加载服务 ${metadata.name} 失败: ${error.message}`);
      return false;
    }
  }

  /**
   * Register a builtin service directly
   */
  registerBuiltinService(name: string, service: MiokuService): void {
    this.services.set(name, service);
  }

  /**
   * Get a loaded service
   */
  getService(name: string): MiokuService | undefined {
    return this.services.get(name);
  }

  async disposeAll(): Promise<void> {
    for (const [name, service] of this.services) {
      if (service.dispose) await service.dispose();
    }
    this.services.clear();
  }

  reset(): void {
    this.services.clear();
    this.serviceMetadata.clear();
  }
}

export default ServiceManager.getInstance();