/**
 * Public API for the help feature.
 *
 * Everything the plugin entry point and the AI skills need from the
 * help subsystem re-exports from here. Internal modules stay private
 * to their concerns.
 */

export {
  generateHelpImage,
  resolveHelpBotProfile,
  replyWithImage,
  sendImageFromSkillContext,
  normalizeImageSource,
} from "./image";
export {
  resolveHelpImageIntent,
  findPluginHelpByKeyword,
  getRenderableEntries,
} from "./intent";
export { buildHelpInfoText } from "./info";
export { generateHelpHtml } from "./html-generator";
export type { HelpImageIntent, HelpRenderableEntry } from "./types";
export { ROLE_CONFIG, STOPWORDS } from "./role-config";
