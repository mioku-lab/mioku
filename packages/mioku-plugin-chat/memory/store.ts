import { Database } from "bun:sqlite";
import type {
  MemberProfile,
  MemoryItem,
  MemoryKind,
  MemoryWindowRecord,
} from "./types";

type SqlParams = Record<string, string | number>;

interface ItemRow {
  id: number;
  group_id: string;
  user_id: string | null;
  user_name: string | null;
  kind: string;
  content: string;
  detail: string | null;
  quote: string | null;
  importance: number;
  confidence: number;
  source_message_ids: string;
  window_start_at: number | null;
  window_end_at: number | null;
  active: number;
  created_at: number;
  updated_at: number;
}

interface ProfileRow {
  group_id: string;
  user_id: string;
  name: string;
  aliases: string;
  traits: string;
  habits: string;
  topics: string;
  relations: string;
  note: string;
  messages_seen: number;
  profile_seen: number;
  created_at: number;
  updated_at: number;
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function toItem(row: ItemRow): MemoryItem {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id ?? undefined,
    userName: row.user_name ?? undefined,
    kind: (row.kind || "other") as MemoryKind,
    content: row.content,
    detail: row.detail ?? undefined,
    quote: row.quote ?? undefined,
    importance: row.importance,
    confidence: row.confidence,
    sourceMessageIds: parseList(row.source_message_ids),
    windowStartAt: row.window_start_at ?? undefined,
    windowEndAt: row.window_end_at ?? undefined,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProfile(row: ProfileRow): MemberProfile {
  return {
    groupId: row.group_id,
    userId: row.user_id,
    name: row.name,
    aliases: parseList(row.aliases),
    traits: parseList(row.traits),
    habits: parseList(row.habits),
    topics: parseList(row.topics),
    relations: parseList(row.relations),
    note: row.note,
    messagesSeen: row.messages_seen,
    profileSeen: row.profile_seen ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListItemsOptions {
  userId?: string;
  since?: number;
  limit?: number;
  includeInactive?: boolean;
}

/**
 * 记忆库：与聊天记录分开一个 sqlite 文件，便于整体备份、清空与独立保留期。
 * 数据量在「每天几十条」量级，因此用即时 SQL 而不是预编译缓存。
 */
export class MemoryStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.migrate();
    if (!this.hasColumn("member_profiles", "profile_seen")) {
      this.db.run(
        "ALTER TABLE member_profiles ADD COLUMN profile_seen INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!this.hasColumn("memory_items", "quote")) {
      this.db.run("ALTER TABLE memory_items ADD COLUMN quote TEXT");
    }
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id           TEXT NOT NULL,
        user_id            TEXT,
        user_name          TEXT,
        kind               TEXT NOT NULL DEFAULT 'other',
        content            TEXT NOT NULL,
        detail             TEXT,
        quote              TEXT,
        importance         INTEGER NOT NULL DEFAULT 3,
        confidence         REAL NOT NULL DEFAULT 0.6,
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        window_start_at    INTEGER,
        window_end_at      INTEGER,
        active             INTEGER NOT NULL DEFAULT 1,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_group
        ON memory_items(group_id, active, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_items_user
        ON memory_items(group_id, user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS member_profiles (
        group_id      TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        aliases       TEXT NOT NULL DEFAULT '[]',
        traits        TEXT NOT NULL DEFAULT '[]',
        habits        TEXT NOT NULL DEFAULT '[]',
        topics        TEXT NOT NULL DEFAULT '[]',
        relations     TEXT NOT NULL DEFAULT '[]',
        note          TEXT NOT NULL DEFAULT '',
        messages_seen INTEGER NOT NULL DEFAULT 0,
        profile_seen  INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_member_profiles_group
        ON member_profiles(group_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_items_active_ts
        ON memory_items(active, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_windows (
        group_id       TEXT NOT NULL,
        window_end_at  INTEGER NOT NULL,
        window_start_at INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'ok',
        item_count     INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (group_id, window_end_at)
      );
    `);
  }

  /** 老库缺列时补上：memory.db 是本版本新增的，留着是为了以后加字段不出事 */
  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  close(): void {
    this.db.close();
  }

  insertItem(item: MemoryItem): number {
    const result = this.db
      .query(
        `INSERT INTO memory_items (
           group_id, user_id, user_name, kind, content, detail, quote,
           importance, confidence, source_message_ids,
           window_start_at, window_end_at, active, created_at, updated_at
         ) VALUES (
           $groupId, $userId, $userName, $kind, $content, $detail, $quote,
           $importance, $confidence, $messageIds,
           $windowStartAt, $windowEndAt, 1, $createdAt, $updatedAt
         )`,
      )
      .run({
        $groupId: item.groupId,
        $userId: item.userId ?? null,
        $userName: item.userName ?? null,
        $kind: item.kind,
        $content: item.content,
        $detail: item.detail ?? null,
        $quote: item.quote ?? null,
        $importance: item.importance,
        $confidence: item.confidence,
        $messageIds: JSON.stringify(item.sourceMessageIds ?? []),
        $windowStartAt: item.windowStartAt ?? null,
        $windowEndAt: item.windowEndAt ?? null,
        $createdAt: item.createdAt,
        $updatedAt: item.updatedAt,
      } as SqlParams);
    return Number(result.lastInsertRowid);
  }

  updateItem(
    id: number,
    patch: Partial<
      Pick<
        MemoryItem,
        "content" | "detail" | "quote" | "importance" | "confidence" | "active"
      >
    >,
  ): void {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { $id: id };
    const map: Array<[keyof typeof patch, string]> = [
      ["content", "content"],
      ["detail", "detail"],
      ["quote", "quote"],
      ["importance", "importance"],
      ["confidence", "confidence"],
      ["active", "active"],
    ];
    for (const [key, column] of map) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = $${column}`);
      params[`$${column}`] =
        key === "active" ? (value ? 1 : 0) : (value as string | number);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = $updatedAt");
    params.$updatedAt = Date.now();
    this.db.query(`UPDATE memory_items SET ${sets.join(", ")} WHERE id = $id`).run(params);
  }

  getItem(id: number): MemoryItem | null {
    const row = this.db
      .query("SELECT * FROM memory_items WHERE id = ?")
      .get(id) as ItemRow | null;
    return row ? toItem(row) : null;
  }

  listItems(groupId: string, options: ListItemsOptions = {}): MemoryItem[] {
    const where = ["group_id = $groupId"];
    const params: Record<string, string | number> = { $groupId: groupId };
    if (!options.includeInactive) where.push("active = 1");
    if (options.userId) {
      where.push("user_id = $userId");
      params.$userId = options.userId;
    }
    if (options.since) {
      where.push("updated_at >= $since");
      params.$since = options.since;
    }
    const rawLimit = Number(options.limit);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 2000),
    );
    const rows = this.db
      .query(
        `SELECT * FROM memory_items
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(params) as ItemRow[];
    return rows.map(toItem);
  }

  countItems(groupId?: string): number {
    const row = groupId
      ? (this.db
          .query("SELECT COUNT(*) AS n FROM memory_items WHERE group_id = ? AND active = 1")
          .get(groupId) as { n: number } | null)
      : (this.db
          .query("SELECT COUNT(*) AS n FROM memory_items WHERE active = 1")
          .get() as { n: number } | null);
    return Number(row?.n ?? 0);
  }

  /** 返回被清掉的 id，供向量库同步删除 */
  deleteItemsOlderThan(timestamp: number): number[] {
    return this.deleteAndReturnIds(
      "SELECT id FROM memory_items WHERE updated_at < ?",
      [timestamp],
      "DELETE FROM memory_items WHERE updated_at < ?",
      [timestamp],
    );
  }

  /** 每群条数上限：按「重要性低、时间旧」淘汰 */
  trimGroup(groupId: string, max: number): number[] {
    if (!Number.isFinite(max) || max <= 0) return [];
    const total = this.countItems(groupId);
    if (total <= max) return [];
    const excess = total - max;
    const rows = this.db
      .query(
        `SELECT id FROM memory_items
         WHERE group_id = ? AND active = 1
         ORDER BY importance ASC, updated_at ASC, id ASC
         LIMIT ${excess}`,
      )
      .all(groupId) as Array<{ id: number }>;
    return this.deleteIds(rows.map((row) => row.id));
  }

  /** 硬删除（管理员「忘掉」用），返回真正删掉的 id */
  removeItems(ids: number[]): number[] {
    return this.deleteIds(ids);
  }

  deactivateItems(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .query(`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${placeholders})`)
      .run(Date.now(), ...ids);
  }

  private deleteIds(ids: number[]): number[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    this.db.query(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...ids);
    return ids;
  }

  private deleteAndReturnIds(
    selectSql: string,
    selectParams: number[],
    deleteSql: string,
    deleteParams: number[],
  ): number[] {
    const rows = this.db.query(selectSql).all(...selectParams) as Array<{ id: number }>;
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) this.db.query(deleteSql).run(...deleteParams);
    return ids;
  }

  upsertProfile(profile: MemberProfile): void {
    this.db
      .query(
        `INSERT INTO member_profiles (
           group_id, user_id, name, aliases, traits, habits, topics, relations,
           note, messages_seen, profile_seen, created_at, updated_at
         ) VALUES (
           $groupId, $userId, $name, $aliases, $traits, $habits, $topics, $relations,
           $note, $messagesSeen, $profileSeen, $createdAt, $updatedAt
         )
         ON CONFLICT(group_id, user_id) DO UPDATE SET
           name = excluded.name,
           aliases = excluded.aliases,
           traits = excluded.traits,
           habits = excluded.habits,
           topics = excluded.topics,
           relations = excluded.relations,
           note = excluded.note,
           messages_seen = excluded.messages_seen,
           profile_seen = excluded.profile_seen,
           updated_at = excluded.updated_at`,
      )
      .run({
        $groupId: profile.groupId,
        $userId: profile.userId,
        $name: profile.name,
        $aliases: JSON.stringify(profile.aliases),
        $traits: JSON.stringify(profile.traits),
        $habits: JSON.stringify(profile.habits),
        $topics: JSON.stringify(profile.topics),
        $relations: JSON.stringify(profile.relations),
        $note: profile.note,
        $messagesSeen: profile.messagesSeen,
        $profileSeen: profile.profileSeen,
        $createdAt: profile.createdAt,
        $updatedAt: profile.updatedAt,
      } as SqlParams);
  }

  bumpProfileSeen(groupId: string, userId: string, name: string, now: number): number {
    const existing = this.getProfile(groupId, userId);
    if (!existing) {
      this.upsertProfile({
        groupId,
        userId,
        name,
        aliases: [],
        traits: [],
        habits: [],
        topics: [],
        relations: [],
        note: "",
        messagesSeen: 1,
        profileSeen: 0,
        createdAt: now,
        updatedAt: now,
      });
      return 1;
    }
    const next = existing.messagesSeen + 1;
    this.db
      .query(
        `UPDATE member_profiles SET messages_seen = ?, name = ?, updated_at = ?
         WHERE group_id = ? AND user_id = ?`,
      )
      .run(next, existing.name || name, now, groupId, userId);
    return next;
  }

  getProfile(groupId: string, userId: string): MemberProfile | null {
    const row = this.db
      .query("SELECT * FROM member_profiles WHERE group_id = ? AND user_id = ?")
      .get(groupId, userId) as ProfileRow | null;
    return row ? toProfile(row) : null;
  }

  listProfiles(groupId: string, limit = 200): MemberProfile[] {
    const safe = Number.isFinite(limit) ? limit : 200;
    const rows = this.db
      .query(
        `SELECT * FROM member_profiles WHERE group_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(groupId, Math.max(1, Math.min(safe, 500))) as ProfileRow[];
    return rows.map(toProfile);
  }

  deleteProfilesUpdatedBefore(timestamp: number): number {
    const rows = this.db
      .query("SELECT group_id, user_id FROM member_profiles WHERE updated_at < ?")
      .all(timestamp) as Array<{ group_id: string; user_id: string }>;
    if (rows.length > 0) {
      this.db.query("DELETE FROM member_profiles WHERE updated_at < ?").run(timestamp);
    }
    return rows.length;
  }

  recordWindow(record: MemoryWindowRecord): void {
    this.db
      .query(
        `INSERT INTO memory_windows (
           group_id, window_end_at, window_start_at, status, item_count, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, window_end_at) DO UPDATE SET
           status = excluded.status,
           item_count = excluded.item_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.groupId,
        record.windowEndAt,
        record.windowStartAt,
        record.status,
        record.itemCount,
        record.updatedAt,
      );
  }

  pruneWindowsBefore(timestamp: number): void {
    this.db.query("DELETE FROM memory_windows WHERE window_end_at < ?").run(timestamp);
  }

  stats(): {
    items: number;
    profiles: number;
    groups: number;
    profileGroups: number;
    lastItemAt: number;
  } {
    const items = this.countItems();
    const profile = this.db
      .query("SELECT COUNT(*) AS n FROM member_profiles")
      .get() as { n: number } | null;
    const groups = this.db
      .query("SELECT COUNT(DISTINCT group_id) AS n FROM memory_items WHERE active = 1")
      .get() as { n: number } | null;
    const profileGroups = this.db
      .query("SELECT COUNT(DISTINCT group_id) AS n FROM member_profiles")
      .get() as { n: number } | null;
    const last = this.db
      .query("SELECT MAX(updated_at) AS t FROM memory_items")
      .get() as { t: number | null } | null;
    return {
      items,
      profiles: Number(profile?.n ?? 0),
      groups: Number(groups?.n ?? 0),
      profileGroups: Number(profileGroups?.n ?? 0),
      lastItemAt: Number(last?.t ?? 0),
    };
  }

  clearGroup(groupId: string): number[] {
    const rows = this.db
      .query("SELECT id FROM memory_items WHERE group_id = ?")
      .all(groupId) as Array<{ id: number }>;
    const ids = rows.map((row) => row.id);
    this.db.query("DELETE FROM memory_items WHERE group_id = ?").run(groupId);
    this.db.query("DELETE FROM member_profiles WHERE group_id = ?").run(groupId);
    this.db.query("DELETE FROM memory_windows WHERE group_id = ?").run(groupId);
    return ids;
  }

  clearAll(): void {
    this.db.run("DELETE FROM memory_items");
    this.db.run("DELETE FROM member_profiles");
    this.db.run("DELETE FROM memory_windows");
  }
}
