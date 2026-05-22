/**
 * 配置服务接口
 */
export interface ConfigService {
  // 注册配置
  registerConfig(
    pluginName: string, // 插件名称
    configName: string, // 服务名称
    initialConfig: any, // 初始配置
  ): Promise<boolean>;

  // 更新配置内容
  updateConfig(
    pluginName: string, // 插件名称
    configName: string, // 服务名称
    updates: any, // 更新内容 支持部分内容更新
  ): Promise<boolean>;

  // 获取某个插件的某个配置
  getConfig(pluginName: string, configName: string): Promise<any>;

  // 获取某个插件的全部配置
  getPluginConfigs(pluginName: string): Promise<Record<string, any>>;

  // 配置更新时的回调函数
  onConfigChange(
    pluginName: string,
    configName: string,
    callback: (newConfig: any) => void, // 回调函数
  ): () => void;
}
