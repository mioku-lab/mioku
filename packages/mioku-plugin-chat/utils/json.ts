/**
 * 取模型输出里第一个 {...} 并 JSON.parse。
 * 没有时返回 undefined；格式错误照常抛出，由调用方处理。
 */
export function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  return JSON.parse(match[0]);
}
