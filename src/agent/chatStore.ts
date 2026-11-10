import type { App } from "obsidian";
import type { LlmMessage } from "./llm";

export const CHAT_STORE_VERSION = 1;
export const MAX_SESSIONS = 40;
export const MAX_MESSAGES_PER_SESSION = 300;
export const MAX_STORED_TOOL_CHARS = 4000;
export const MAX_STORED_CHARS = 40000;
export const MAX_STORE_BYTES = 8 * 1024 * 1024;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: LlmMessage[];
}

export interface ChatStoreData {
  version: number;
  activeId: string | null;
  sessions: ChatSession[];
}

export function emptyStoreData(): ChatStoreData {
  return { version: CHAT_STORE_VERSION, activeId: null, sessions: [] };
}

export function deriveTitle(text: string, fallback = "新对话"): string {
  const cleaned = text
    .replace(/【[^】]*】/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 30 ? `${cleaned.slice(0, 30)}…` : cleaned;
}

function cloneMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.function.name,
              arguments: call.function.arguments.slice(0, MAX_STORED_TOOL_CHARS),
            },
          })),
        }
      : {}),
  }));
}

/**
 * Drops an assistant turn whose tool results never arrived (crash / abort mid-turn),
 * so a restored session can always be replayed to the model.
 */
export function sanitizeMessages(messages: LlmMessage[]): LlmMessage[] {
  const result: LlmMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length) {
      const expected = new Set(message.tool_calls.map((call) => call.id));
      const available = messages.slice(i + 1).filter((m) => m.role === "tool" && m.tool_call_id && expected.has(m.tool_call_id));
      if (available.length < expected.size) return result;
    }
    result.push(message);
  }
  return result;
}

export function trimMessage(message: LlmMessage): LlmMessage {
  const limit = message.role === "tool" ? MAX_STORED_TOOL_CHARS : MAX_STORED_CHARS;
  if (message.content.length <= limit) return message;
  return { ...message, content: `${message.content.slice(0, limit)}\n\n[… 已截断]` };
}

export class ChatStore {
  private data: ChatStoreData = emptyStoreData();
  private saveTimer: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly storePath: string,
    private enabled = true,
  ) {}

  get path(): string {
    return this.storePath;
  }

  get persistenceEnabled(): boolean {
    return this.enabled;
  }

  setPersistenceEnabled(value: boolean): Promise<void> {
    this.enabled = value;
    return value ? this.save() : Promise.resolve();
  }

  async load(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.storePath))) return;
      const raw = await adapter.read(this.storePath);
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Partial<ChatStoreData>;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      this.data = {
        version: CHAT_STORE_VERSION,
        activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
        sessions: sessions
          .filter((session): session is ChatSession => !!session && typeof session.id === "string")
          .map((session) => ({
            id: session.id,
            title: typeof session.title === "string" && session.title ? session.title : "未命名对话",
            createdAt: Number(session.createdAt) || Date.now(),
            updatedAt: Number(session.updatedAt) || Date.now(),
            messages: sanitizeMessages(Array.isArray(session.messages) ? session.messages : []),
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_SESSIONS),
      };
      if (!this.data.sessions.some((s) => s.id === this.data.activeId)) {
        this.data.activeId = this.data.sessions[0]?.id ?? null;
      }
    } catch (error) {
      console.warn("[ai-connected] failed to load chat history", error);
      this.data = emptyStoreData();
    }
  }

  get sessions(): ChatSession[] {
    return this.data.sessions;
  }

  get activeId(): string | null {
    return this.data.activeId;
  }

  get active(): ChatSession | null {
    if (!this.data.activeId) return null;
    return this.get(this.data.activeId) ?? null;
  }

  get(id: string): ChatSession | undefined {
    return this.data.sessions.find((session) => session.id === id);
  }

  create(title = "新对话"): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: randomId(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.data.sessions.unshift(session);
    this.data.activeId = session.id;
    this.enforceLimits();
    this.scheduleSave();
    return session;
  }

  setActive(id: string | null): void {
    this.data.activeId = id;
    this.scheduleSave();
  }

  update(session: ChatSession): void {
    const existing = this.get(session.id);
    if (!existing) {
      this.data.sessions.unshift(session);
    } else {
      existing.messages = session.messages;
      existing.title = session.title;
      existing.updatedAt = Date.now();
    }
    this.data.activeId = session.id;
    this.enforceLimits();
    this.scheduleSave();
  }

  rename(id: string, title: string): void {
    const session = this.get(id);
    if (!session) return;
    session.title = title.trim() || session.title;
    this.scheduleSave();
  }

  remove(id: string): void {
    this.data.sessions = this.data.sessions.filter((session) => session.id !== id);
    if (this.data.activeId === id) {
      this.data.activeId = this.data.sessions[0]?.id ?? null;
    }
    this.scheduleSave();
  }

  clearAll(): Promise<void> {
    this.data = emptyStoreData();
    return this.save();
  }

  scheduleSave(): void {
    if (!this.enabled) return;
    if (this.saveTimer !== null) cancelTimer(this.saveTimer);
    this.saveTimer = scheduleTimer(() => {
      this.saveTimer = null;
      void this.save();
    }, 600);
  }

  save(): Promise<void> {
    if (this.saveTimer !== null) {
      cancelTimer(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.enabled) return Promise.resolve();
    // Serialise writes so a slow adapter never interleaves two payloads.
    this.writeChain = this.writeChain.then(() => this.writeNow()).catch((error) => {
      console.warn("[ai-connected] failed to save chat history", error);
    });
    return this.writeChain;
  }

  private async writeNow(): Promise<void> {
    const payload = this.serialize();
    await this.app.vault.adapter.write(this.storePath, payload);
  }

  private serialize(): string {
    const sessions = this.data.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: sanitizeMessages(session.messages.slice(-MAX_MESSAGES_PER_SESSION)).map(
          (message) => cloneMessages([trimMessage(message)])[0],
        ),
      }));

    let json = JSON.stringify({ version: CHAT_STORE_VERSION, activeId: this.data.activeId, sessions }, null, 2);

    // Hard guard: keep the file small by dropping the oldest sessions.
    let guard = 0;
    while (json.length > MAX_STORE_BYTES && sessions.length > 1 && guard < 100) {
      sessions.pop();
      json = JSON.stringify({ version: CHAT_STORE_VERSION, activeId: this.data.activeId, sessions }, null, 2);
      guard++;
    }
    return json;
  }

  private enforceLimits(): void {
    this.data.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions.slice(0, MAX_SESSIONS);
    }
    for (const session of this.data.sessions) {
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      }
    }
  }
}

function randomId(): string {
  const cryptoApi = (globalThis as any).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** setTimeout that works in Obsidian (window) and in plain Node (tests). */
function scheduleTimer(callback: () => void, ms: number): number {
  return setTimeout(callback, ms) as unknown as number;
}

function cancelTimer(id: number): void {
  clearTimeout(id as any);
}

// --------------------------------------------------------------------- export

export function sessionToMarkdown(session: ChatSession): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || "AI 对话"}`);
  lines.push("");
  lines.push(`> 由 AI Connected 导出 · ${formatTime(session.createdAt)} · 共 ${session.messages.length} 条消息`);
  lines.push("");

  for (const message of session.messages) {
    if (message.role === "user") {
      lines.push("## 👤 用户");
      lines.push("");
      lines.push(stripAttachmentBlocks(message.content));
      lines.push("");
    } else if (message.role === "assistant") {
      if (message.content.trim()) {
        lines.push("## 🤖 助手");
        lines.push("");
        lines.push(message.content.trim());
        lines.push("");
      }
      for (const call of message.tool_calls ?? []) {
        lines.push(`### 🔧 工具 · \`${call.function.name}\``);
        lines.push("");
        lines.push("```json");
        lines.push(prettyJson(call.function.arguments));
        lines.push("```");
        lines.push("");
      }
    } else if (message.role === "tool") {
      lines.push(`> [!quote]- 工具结果${message.name ? ` · ${message.name}` : ""}`);
      for (const line of message.content.trim().split("\n").slice(0, 40)) {
        lines.push(`> ${line}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function stripAttachmentBlocks(content: string): string {
  const marker = content.lastIndexOf("\n\n---\n\n");
  if (marker > 0 && content.slice(0, marker).includes("【")) {
    return content.slice(marker + 7).trim();
  }
  return content.trim();
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
  } catch {
    return raw;
  }
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^\[\]]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();
  return (cleaned || "AI 对话").slice(0, 40);
}
