import type { AudioConfig } from "../../types";

interface TTSResponse {
  audio_base64?: string;
  detail?: string;
  error?: string;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function detectAudioLanguage(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) {
    return "all_ja";
  }
  if (/[\u4e00-\u9fff]/.test(text)) {
    return "all_zh";
  }
  return "en";
}

export async function synthesizeAudioBase64(
  config: AudioConfig,
  text: string,
): Promise<string> {
  const trimmedText = String(text || "").trim();
  if (!config.enabled) {
    throw new Error("Audio output is disabled");
  }
  if (!trimmedText) {
    throw new Error("Audio text cannot be empty");
  }
  if (!config.baseUrl?.trim()) {
    throw new Error("Audio service baseUrl is not configured");
  }

  const endpoint = new URL("tts", ensureTrailingSlash(config.baseUrl.trim()));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const apiKey = config.apiKey?.trim();
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: trimmedText,
      text_lang: detectAudioLanguage(trimmedText),
    }),
    signal: AbortSignal.timeout(Math.max(1000, config.timeoutMs || 20_000)),
  });

  const payload = (await response.json().catch(() => ({}))) as TTSResponse;
  if (!response.ok) {
    throw new Error(
      payload?.detail ||
        payload?.error ||
        `TTS request failed with status ${response.status}`,
    );
  }

  const audioBase64 = String(payload.audio_base64 || "").trim();
  if (!audioBase64) {
    throw new Error("TTS response missing audio_base64");
  }

  return `base64://${audioBase64}`;
}
