import { isRecord } from "./record";

/** 段上平铺的字段（旧适配器写法） */
export function segTop(seg: unknown, key: string): unknown {
  return isRecord(seg) ? seg[key] : undefined;
}

/** 段 data 里的字段 */
export function segData(seg: unknown, key: string): unknown {
  return isRecord(seg) && isRecord(seg.data) ? seg.data[key] : undefined;
}

/** 平铺字段优先，其次 data 字段 */
export function segField(seg: unknown, key: string): unknown {
  return segTop(seg, key) || segData(seg, key);
}

export function segUrl(seg: unknown): string | undefined {
  const url = segField(seg, "url");
  return url ? String(url) : undefined;
}

/** 文本段正文 */
export function segText(seg: unknown): string {
  return String(segData(seg, "text") ?? segTop(seg, "text") ?? "");
}

/** @ 段的目标账号，兼容 qq / id / user_id 写法 */
export function segAtTarget(seg: unknown): unknown {
  return (
    segTop(seg, "qq") ||
    segData(seg, "qq") ||
    segData(seg, "id") ||
    segData(seg, "user_id")
  );
}
