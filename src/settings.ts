export interface AIConnectedSettings {
  // ---- MCP server ----
  mcpEnabled: boolean;
  mcpHost: string;
  mcpPort: number;
  mcpToken: string;
  mcpRequireAuth: boolean;
  mcpReadOnly: boolean;

  // ---- Built-in agent ----
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxSteps: number;
  stream: boolean;
  systemPrompt: string;
  autoAttachActiveNote: boolean;
  persistChatHistory: boolean;
  chatExportFolder: string;

  // ---- Safety ----
  confirmDestructive: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `你是嵌入 Obsidian 的 AI 笔记助手，可以直接读写当前笔记库。

工作方式：
- 需要了解笔记内容时先调用工具（search_notes / read_note / get_metadata / list_notes），不要凭空猜测。
- 修改笔记前先 read_note 读取原文；write_note 会覆盖全文，谨慎使用，优先用 append_note 或 patch_note 做局部修改。
- 删除、覆盖、移动属于破坏性操作，执行前先说明你的意图。
- 路径一律使用相对笔记库根目录的路径，例如 "项目/计划.md"。
- 引用笔记时使用 [[双链]] 形式。

回答用中文，简洁、结构清晰，必要时附上改动摘要（改了哪些文件、改了什么）。`;

export const PROVIDER_PRESETS: Record<string, { label: string; baseUrl: string; model: string }> = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" },
  moonshot: { label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  dashscope: { label: "阿里云百炼 / 通义", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
  ollama: { label: "Ollama (本地)", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
  lmstudio: { label: "LM Studio (本地)", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
  custom: { label: "自定义 (OpenAI 兼容)", baseUrl: "", model: "" },
};

export const DEFAULT_SETTINGS: AIConnectedSettings = {
  mcpEnabled: true,
  mcpHost: "127.0.0.1",
  mcpPort: 37821,
  mcpToken: "",
  mcpRequireAuth: true,
  mcpReadOnly: false,

  provider: "deepseek",
  baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
  apiKey: "",
  model: PROVIDER_PRESETS.deepseek.model,
  temperature: 0.3,
  maxSteps: 8,
  stream: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  autoAttachActiveNote: false,
  persistChatHistory: true,
  chatExportFolder: "AI 对话",

  confirmDestructive: true,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeSettings(raw: Partial<AIConnectedSettings> | null | undefined): AIConnectedSettings {
  const merged: AIConnectedSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  merged.mcpPort = clampNumber(merged.mcpPort, 1024, 65535, DEFAULT_SETTINGS.mcpPort);
  merged.mcpHost = typeof merged.mcpHost === "string" && merged.mcpHost.trim() ? merged.mcpHost.trim() : DEFAULT_SETTINGS.mcpHost;
  merged.temperature = Math.min(2, Math.max(0, Number(merged.temperature) || 0));
  merged.maxSteps = clampNumber(merged.maxSteps, 1, 24, DEFAULT_SETTINGS.maxSteps);
  merged.mcpReadOnly = merged.mcpReadOnly === true;
  merged.mcpRequireAuth = merged.mcpRequireAuth !== false;
  merged.stream = merged.stream !== false;
  merged.confirmDestructive = merged.confirmDestructive !== false;
  merged.autoAttachActiveNote = merged.autoAttachActiveNote === true;
  merged.persistChatHistory = merged.persistChatHistory !== false;
  merged.chatExportFolder =
    typeof merged.chatExportFolder === "string"
      ? merged.chatExportFolder.trim().replace(/^\/+|\/+$/g, "")
      : DEFAULT_SETTINGS.chatExportFolder;
  merged.mcpEnabled = merged.mcpEnabled !== false;
  if (typeof merged.systemPrompt !== "string" || !merged.systemPrompt.trim()) {
    merged.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  return merged;
}

export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function generateToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
