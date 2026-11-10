import { requestUrl } from "obsidian";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  stream: boolean;
}

export interface LlmToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
}

export interface ChatHooks {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("尚未配置 API Base URL，请在插件设置中填写。");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (/\/chat\/completions$/i.test(url)) return url;
  return url + "/chat/completions";
}

export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as any).name === "AbortError";
}

function buildPayload(cfg: LlmConfig, messages: LlmMessage[], tools: LlmToolSchema[], stream: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map(toApiMessage),
    stream,
    temperature: cfg.temperature,
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
  return payload;
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.tool_call_id ?? "", name: message.name };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length) {
    return { role: "assistant", content: message.content || null, tool_calls: message.tool_calls };
  }
  return { role: message.role, content: message.content };
}

function headersFor(cfg: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = (cfg.apiKey || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Runs one chat completion. Uses streaming fetch when enabled, and transparently
 * falls back to Obsidian's requestUrl (no CORS restrictions) when fetch fails.
 */
export async function chatCompletion(
  cfg: LlmConfig,
  messages: LlmMessage[],
  tools: LlmToolSchema[] = [],
  hooks: ChatHooks = {},
): Promise<ChatResult> {
  if (!cfg.model.trim()) throw new Error("尚未配置模型名称（model），请在插件设置中填写。");
  const url = normalizeBaseUrl(cfg.baseUrl);

  if (cfg.stream) {
    try {
      return await streamViaFetch(url, cfg, messages, tools, hooks);
    } catch (error) {
      if (isAbortError(error) || hooks.signal?.aborted) throw error;
      // Network/CORS problem: retry once without streaming through requestUrl.
    }
  }
  return await viaRequestUrl(url, cfg, messages, tools);
}

async function viaRequestUrl(
  url: string,
  cfg: LlmConfig,
  messages: LlmMessage[],
  tools: LlmToolSchema[],
): Promise<ChatResult> {
  const response = await requestUrl({
    url,
    method: "POST",
    headers: headersFor(cfg),
    body: JSON.stringify(buildPayload(cfg, messages, tools, false)),
    throw: false,
  });

  if (response.status >= 400) {
    throw new Error(describeHttpError(response.status, response.text));
  }
  let data: any;
  try {
    data = response.json;
  } catch {
    throw new Error(`模型返回了非 JSON 内容：${String(response.text).slice(0, 300)}`);
  }
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  return {
    content: extractContent(message.content),
    toolCalls: extractToolCalls(message.tool_calls),
    finishReason: String(choice?.finish_reason ?? ""),
  };
}

async function streamViaFetch(
  url: string,
  cfg: LlmConfig,
  messages: LlmMessage[],
  tools: LlmToolSchema[],
  hooks: ChatHooks,
): Promise<ChatResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headersFor(cfg), Accept: "text/event-stream" },
    body: JSON.stringify(buildPayload(cfg, messages, tools, true)),
    signal: hooks.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(describeHttpError(response.status, text));
  }
  if (!response.body) throw new Error("响应不可读取（stream body 为空）");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = "";
  const toolCalls: LlmToolCall[] = [];

  const handleEvent = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        hooks.onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : toolCalls.length;
          if (!toolCalls[index]) {
            toolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
          }
          const target = toolCalls[index];
          if (tc.id) target.id = String(tc.id);
          if (tc.function?.name) target.function.name += String(tc.function.name);
          if (typeof tc.function?.arguments === "string") target.function.arguments += tc.function.arguments;
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer.startsWith("\r\n", boundary) ? 4 : 2));
        handleEvent(chunk);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (buffer.trim()) handleEvent(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  const cleanCalls = toolCalls
    .filter((c): c is LlmToolCall => !!c && !!c.function.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));

  return { content, toolCalls: cleanCalls, finishReason };
}

function extractContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function extractToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: LlmToolCall[] = [];
  value.forEach((raw, i) => {
    const fn = raw?.function;
    if (!fn || typeof fn.name !== "string" || !fn.name) return;
    let args = fn.arguments;
    if (typeof args !== "string") args = JSON.stringify(args ?? {});
    calls.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `call_${Date.now()}_${i}`,
      type: "function",
      function: { name: fn.name, arguments: args },
    });
  });
  return calls;
}

function describeHttpError(status: number, body: unknown): string {
  const text = typeof body === "string" ? body : "";
  let detail = text.slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    /* plain text body */
  }
  const hints: Record<number, string> = {
    401: "API Key 无效或缺失",
    403: "没有访问权限（地区限制 / 模型未开通）",
    404: "模型或接口路径不存在，请检查 Base URL 与 model",
    429: "请求过于频繁 / 额度用尽",
  };
  const hint = hints[status] ? `（${hints[status]}）` : "";
  return `请求失败 HTTP ${status}${hint}：${detail || "无响应内容"}`;
}

export async function testConnection(cfg: LlmConfig): Promise<string> {
  const result = await chatCompletion(
    { ...cfg, stream: false, temperature: 0 },
    [
      { role: "system", content: "You are a health check. Reply with exactly: OK" },
      { role: "user", content: "ping" },
    ],
    [],
  );
  return result.content.trim() || "(空响应)";
}
