export interface HelpPluginRuntimeState {
  miokiVersion?: string;
  miokuVersion?: string;
}

const runtimeState: HelpPluginRuntimeState = {};

export function setHelpRuntimeState(
  nextState: HelpPluginRuntimeState,
): HelpPluginRuntimeState {
  Object.assign(runtimeState, nextState);
  return runtimeState;
}

export function getHelpRuntimeState(): HelpPluginRuntimeState {
  return runtimeState;
}

export function resetHelpRuntimeState(): void {
  for (const key of Object.keys(runtimeState) as Array<
    keyof HelpPluginRuntimeState
  >) {
    delete runtimeState[key];
  }
}
