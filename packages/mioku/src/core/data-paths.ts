/**
 * Data Directory Utilities for Mioku Plugins
 *
 * Provides consistent data path resolution that respects the project directory
 * (process.cwd()) rather than the package installation directory.
 */

import * as path from "path";

/**
 * Get the data directory for a specific plugin
 * Returns: {cwd}/data/{pluginName}
 */
export function getPluginDataDir(pluginName: string): string {
  const dataDir = path.join(process.cwd(), "data", pluginName);
  return dataDir;
}

/**
 * Get the data directory for a service
 * Returns: {cwd}/data/{serviceName}
 */
export function getServiceDataDir(serviceName: string): string {
  const dataDir = path.join(process.cwd(), "data", serviceName);
  return dataDir;
}

/**
 * Get the main data directory
 * Returns: {cwd}/data
 */
export function getDataDir(): string {
  return path.join(process.cwd(), "data");
}

/**
 * Get the config directory for a plugin
 * Returns: {cwd}/config/{pluginName}
 */
export function getPluginConfigDir(pluginName: string): string {
  const configDir = path.join(process.cwd(), "config", pluginName);
  return configDir;
}

/**
 * Get the config directory for a service
 * Returns: {cwd}/config/service/{serviceName}
 */
export function getServiceConfigDir(serviceName: string): string {
  const configDir = path.join(process.cwd(), "config", "service", serviceName);
  return configDir;
}

/**
 * Get the main config directory
 * Returns: {cwd}/config
 */
export function getConfigDir(): string {
  return path.join(process.cwd(), "config");
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDataDir(pluginName: string): string {
  const dir = getPluginDataDir(pluginName);
  const { existsSync, mkdirSync } = require("fs");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}