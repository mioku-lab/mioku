/** 极简字符串指纹，只用来当缓存键，不需要抗碰撞 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

interface Entry {
  groupId: string;
  value: string;
  expiresAt: number;
}

export class InjectionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): string | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, groupId: string, value: string): void {
    if (!this.enabled) return;
    this.entries.set(key, {
      groupId,
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** 有新记忆写入时按群失效，保证下一轮立刻能看到 */
  invalidateGroup(groupId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.groupId === groupId) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
