import { rootLogger as logger } from "../../../logger";
import { triggerRestart, type RestartMarker } from "./restart";
import { listInstalledPackages, updatePackages } from "./package-manager";

let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startAutoUpdateScheduler(
  enabled: boolean,
  time: string,
  frequency: "daily" | "weekly" | "monthly",
): () => void {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }

  if (!enabled) return () => {};

  const [hour, minute] = time.split(":").map(Number);
  if (isNaN(hour) || isNaN(minute)) {
    logger.warn(`[core] 自动更新时间格式无效: ${time}，调度器未启动`);
    return () => {};
  }

  logger.info(
    `[core] 自动更新调度器已启动: 频率=${frequency}, 时间=${time}`,
  );

  autoUpdateTimer = setInterval(async () => {
    if (running) return;
    const now = new Date();

    if (now.getHours() !== hour || now.getMinutes() !== minute) return;

    if (frequency === "weekly" && now.getDay() !== 1) return;
    if (frequency === "monthly" && now.getDate() !== 1) return;

    running = true;
    try {
      logger.info("[core] 自动更新开始...");
      const allInstalled = listInstalledPackages();
      const names = allInstalled.map((pkg) => pkg.name);
      if (names.length === 0) {
        logger.info("[core] 未找到需要更新的包");
        return;
      }

      const result = await updatePackages(names);
      if (result.code !== 0) {
        logger.error(
          `[core] 自动更新失败: ${result.stderr || result.stdout}`,
        );
        return;
      }

      logger.info("[core] 自动更新成功，准备重启...");
      const marker: RestartMarker = {
        initiatedAt: Date.now(),
        selfId: "",
        groupId: null,
        userId: "",
      };
      triggerRestart(marker);
    } catch (error) {
      logger.error(`[core] 自动更新异常: ${error}`);
    } finally {
      running = false;
    }
  }, 60000);

  return () => {
    if (autoUpdateTimer) {
      clearInterval(autoUpdateTimer);
      autoUpdateTimer = null;
    }
  };
}
