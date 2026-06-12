export function isMessageEventName(eventName: unknown): boolean {
  return (
    String(eventName || "") === "message" ||
    String(eventName || "").startsWith("message.")
  );
}

export function isAccessControlledEventName(eventName: unknown): boolean {
  const s = String(eventName || "");
  return (
    s === "message" ||
    s.startsWith("message.") ||
    s.startsWith("request.") ||
    s.startsWith("notice.")
  );
}
