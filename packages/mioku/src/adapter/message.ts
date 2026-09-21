/** 消息段的附件：图片/文件/音视频的资源引用 */
export interface Attachment {
  readonly id?: string;
  readonly url?: string;
  readonly file?: string;
  readonly data?: Uint8Array;
  readonly mime?: string;
  readonly size?: number;
  readonly name?: string;
}

/** 消息段：一段消息的最小单元，如文本、@、图片 */
export interface MessageSegment {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly attachment?: Attachment;
  isText(): boolean;
  toString(): string;
}

export interface SerializedMessageSegment {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly attachment?: Attachment;
}

/** 消息：消息段的只读数组，带文本提取与按类型过滤的便捷方法 */
export interface Message extends ReadonlyArray<MessageSegment> {
  readonly raw_message?: string;
  toString(): string;
  text(): string;
  filterByType<T extends MessageSegment = MessageSegment>(type: string): T[];
  toJSON(): SerializedMessageSegment[];
}

/** 发送消息的入参：字符串、单段或段的数组都可以 */
export type MessageInput =
  | string
  | Message
  | MessageSegment
  | readonly (string | MessageSegment)[];

export type PlatformId = string | number;

export const toId = (value: PlatformId): string => String(value);

/** 消息发送目标：群或私聊等会话的定位信息 */
export interface MessageTarget {
  readonly type: string;
  readonly id?: PlatformId;
  readonly parent_id?: PlatformId;
  readonly user_id?: PlatformId;
  readonly group_id?: PlatformId;
}

export interface SentMessage {
  readonly message_id?: string;
  readonly sent_at?: number;
}

export interface ReplyOptions {
  readonly quote?: boolean;
}

export type ReplyArg = boolean | ReplyOptions;

/** 交互按钮*/
export interface ButtonOptions {
  id?: string;
  label: string;
  /** 点击后按钮文字 */
  visitedLabel?: string;
  /** 0 灰色线框 1 蓝色线框 2 白字 3 蓝底白字 */
  style?: 0 | 1 | 2 | 3;
  /** callback 回调(默认) / command 指令(输入框插入) / link 跳转 */
  action?: "callback" | "command" | "link";
  /** callback / command 的数据 */
  data?: string;
  /** link 的跳转地址 */
  url?: string;
  /** "all" 所有人 / "admin" 仅管理员 / 用户 id 列表 */
  permission?: "all" | "admin" | readonly string[];
  /** command 点击后是否直接发送 */
  enter?: boolean;
  /** command 是否引用本消息 */
  reply?: boolean;
  /** 客户端版本过低时的提示文案 */
  unsupportedTips?: string;
}

export class MessageSegmentImpl implements MessageSegment {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly attachment: Attachment | undefined;
  constructor(
    type: string,
    data: Record<string, unknown>,
    attachment?: Attachment,
  ) {
    this.type = type;
    this.data = Object.freeze({ ...data });
    this.attachment = attachment;
  }

  isText(): boolean {
    return this.type === "text";
  }

  toString(): string {
    if (this.type === "text" && typeof this.data.text === "string")
      return this.data.text;
    return JSON.stringify({ type: this.type, data: this.data });
  }
}

class MessageImpl extends Array<MessageSegment> implements Message {
  readonly raw_message: string | undefined;
  constructor(
    segments: readonly MessageSegment[] | number,
    rawMessage?: string,
  ) {
    super();
    this.raw_message = rawMessage;
    if (typeof segments === "number") {
      this.length = segments;
      return;
    }
    for (const seg of segments) this.push(seg);
  }

  toString(): string {
    return this.map((seg) => seg.toString()).join("");
  }

  text(): string {
    return (
      this.raw_message ??
      this.filterByType("text")
        .map((seg) => String(seg.data.text ?? ""))
        .join("")
    );
  }

  filterByType<T extends MessageSegment = MessageSegment>(type: string): T[] {
    return this.filter((seg): seg is T => seg.type === type);
  }

  toJSON(): SerializedMessageSegment[] {
    return this.map((seg) => ({
      type: seg.type,
      data: seg.data,
      attachment: seg.attachment,
    }));
  }
}

export const createMessage = (
  segments: readonly MessageSegment[],
  rawMessage?: string,
): Message => new MessageImpl(segments, rawMessage);

const fileData = (
  file: string | Buffer,
  options: { local?: boolean } = {},
): Record<string, unknown> => {
  if (Buffer.isBuffer(file))
    return { file: `base64://${file.toString("base64")}` };
  if (options.local)
    return { file: `file:///${file.replace(/^\s*(file:\/\/\/)+/, "")}` };
  return { file };
};

/** 消息段构造器：按类型快速生成消息段 */
export const segment = {
  text(text: string): MessageSegment {
    return new MessageSegmentImpl("text", { text });
  },
  at(target: PlatformId): MessageSegment {
    return new MessageSegmentImpl("at", { target: toId(target) });
  },
  /** `file` 为 URL 或本地路径；传 Buffer 会转成 base64 发送 */
  image(
    file: string | Buffer,
    options: { local?: boolean } & Attachment = {},
  ): MessageSegment {
    const { local = false, ...attachment } = options;
    const data: Record<string, unknown> = {};
    if (Buffer.isBuffer(file)) {
      data.file = `base64://${file.toString("base64")}`;
    } else if (local) {
      data.file = `file:///${file.replace(/^\s*(file:\/\/\/)+/, "")}`;
    } else {
      data.url = file;
    }
    const attrs = Object.keys(attachment).length > 0 ? attachment : undefined;
    if (attrs) data.attachment = attrs;
    return new MessageSegmentImpl("image", data, attrs);
  },
  reply(messageId: PlatformId): MessageSegment {
    return new MessageSegmentImpl("reply", { message_id: toId(messageId) });
  },
  video(file: string | Buffer, options?: { local?: boolean }): MessageSegment {
    return new MessageSegmentImpl("video", fileData(file, options));
  },
  record(file: string | Buffer, options?: { local?: boolean }): MessageSegment {
    return new MessageSegmentImpl("record", fileData(file, options));
  },
  file(
    file: string | Buffer,
    options: { local?: boolean; name?: string } = {},
  ): MessageSegment {
    const data = fileData(file, options);
    if (options.name) data.name = options.name;
    return new MessageSegmentImpl("file", data);
  },
  face(id: string | number): MessageSegment {
    return new MessageSegmentImpl("face", { id: String(id) });
  },
  forward(id: string): MessageSegment {
    return new MessageSegmentImpl("forward", { id });
  },
  node(options: {
    user_id: PlatformId;
    nickname: string;
    content: MessageInput;
  }): MessageSegment {
    return new MessageSegmentImpl("node", {
      user_id: toId(options.user_id),
      nickname: options.nickname,
      content: Array.isArray(options.content)
        ? Array.from(options.content)
        : options.content,
    });
  },
  json(data: Record<string, unknown> | string): MessageSegment {
    return new MessageSegmentImpl("json", {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  },
  markdown(content: string): MessageSegment {
    return new MessageSegmentImpl("markdown", { content });
  },
  button(options: ButtonOptions): MessageSegment {
    return new MessageSegmentImpl("button", { ...options });
  },
  raw(
    type: string,
    data: Record<string, unknown>,
    attachment?: Attachment,
  ): MessageSegment {
    return new MessageSegmentImpl(type, data, attachment);
  },
} as const;

export const isMessage = (value: unknown): value is Message =>
  value instanceof MessageImpl;

/** 取消息中的第一个 @ 目标 */
export const atOf = (message: Message): string | undefined => {
  const at = message.filterByType("at")[0];
  if (!at) return undefined;
  const raw = at.data?.qq ?? at.data?.target;
  return raw == null ? undefined : String(raw);
};

export const isSegment = (value: unknown): value is MessageSegment =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { type?: unknown }).type === "string";

/** 把任意 `MessageInput` 规范化为 `Message` */
export const asMessage = (input: MessageInput): Message => {
  if (isMessage(input)) return input;
  if (typeof input === "string")
    return new MessageImpl([new MessageSegmentImpl("text", { text: input })]);
  if (isSegment(input)) return new MessageImpl([input]);
  return new MessageImpl(
    (input as readonly (string | MessageSegment)[]).map((item) =>
      typeof item === "string"
        ? new MessageSegmentImpl("text", { text: item })
        : item,
    ),
  );
};
