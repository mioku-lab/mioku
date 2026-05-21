/**
 * Plugin Runtime State Management
 *
 * Provides a way for plugins to store state that needs to persist
 * across the plugin lifecycle but should be isolated per plugin.
 */

interface PluginRuntimeState {
  [pluginName: string]: Record<string, any>;
}

const runtimeState: PluginRuntimeState = {};

/**
 * Get the runtime state for a plugin
 */
export function getPluginRuntimeState(pluginName: string): Record<string, any> {
  if (!runtimeState[pluginName]) {
    runtimeState[pluginName] = {};
  }
  return runtimeState[pluginName];
}

/**
 * Set/update the runtime state for a plugin
 */
export function setPluginRuntimeState(
  pluginName: string,
  state: Record<string, any>,
): Record<string, any> {
  if (!runtimeState[pluginName]) {
    runtimeState[pluginName] = {};
  }
  Object.assign(runtimeState[pluginName], state);
  return runtimeState[pluginName];
}

/**
 * Reset the runtime state for a plugin
 */
export function resetPluginRuntimeState(pluginName: string): void {
  delete runtimeState[pluginName];
}

/**
 * Get all plugin runtime states (for debugging)
 */
export function getAllPluginRuntimeStates(): PluginRuntimeState {
  return { ...runtimeState };
}