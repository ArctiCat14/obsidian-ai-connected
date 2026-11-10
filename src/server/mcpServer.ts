import type { ToolContext, ToolDef } from "../tools/types";
import { requireNote } from "../tools/helpers";

type HttpModule = typeof import("http");
type HttpServer = import("http").Server;
type IncomingMessage = import("http").IncomingMessage;
type ServerResponse = import("http").ServerResponse;

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpServerOptions {
  host: string;
  port: number;
  token: string;
  requireAuth: boolean;
  readOnly: boolean;
  version: string;
  instructions?: string;
  getTools: () => ToolDef[];
  getContext: () => ToolContext;
  onLog?: (message: string) => void;
}

interface SessionInfo {
  id: string;
  createdAt: number;
  clientInfo?: unknown;
  protocolVersion: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

const SERVER_NAME = "ai-connected";

const PROMPTS = [
  {
    name: "summarize_note",
    title: "Summarize a note",
    description: "Read one note and produce a concise summary with key points and action items.",
    arguments: [{ name: "path", description: "Vault-relative path of the note", required: true }],
  },
  {
    name: "summarize_active_note",
    title: "Summarize the active note",
    description: "Summarize whatever note the user currently has open in Obsidian.",
    arguments: [],
  },
  {
    name: "find_related_notes",
    title: "Find related notes",
    description: "Search the vault and suggest notes that should be linked to a topic or note.",
    arguments: [{ name: "topic", description: "Topic, note title or path to find related notes for", required: true }],
  },
];

export class McpServer {
  private http: HttpModule | null = null;
  private server: HttpServer | null = null;
  private sockets = new Set<import("net").Socket>();
  private sessions = new Map<string, SessionInfo>();
  private sseStreams = new Map<string, ServerResponse>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private listeningPort = 0;
  private options: McpServerOptions;

  constructor(options: McpServerOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get port(): number {
    return this.listeningPort;
  }

  get endpoint(): string {
    return `http://${this.options.host}:${this.listeningPort}/mcp`;
  }

  get sseEndpoint(): string {
    return `http://${this.options.host}:${this.listeningPort}/sse`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    // Loaded lazily so the bundle stays loadable on mobile (no Node runtime there).
    this.http = require("http") as HttpModule;

    const server = this.http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.log(`Unhandled error: ${errorMessage(err)}`);
        try {
          if (!res.headersSent) this.sendJson(res, 500, errorBody(null, -32603, errorMessage(err)));
          else res.end();
        } catch {
          /* ignore */
        }
      });
    });

    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });

    const address = server.address();
    this.listeningPort = typeof address === "object" && address ? address.port : this.options.port;
    this.server = server;
    this.log(`MCP server listening on ${this.endpoint}`);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();

    for (const [, res] of this.sseStreams) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseStreams.clear();
    this.sessions.clear();

    const server = this.server;
    this.server = null;
    this.listeningPort = 0;
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of this.sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      this.sockets.clear();
      // Safety net: never hang the unload path.
      setTimeout(resolve, 1500);
    });
  }

  // ---------------------------------------------------------------- transport

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...corsHeaders(), "Access-Control-Max-Age": "86400" });
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      this.sendJson(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: this.options.version,
        protocolVersion: LATEST_VERSION,
        tools: this.options.getTools().length,
        readOnly: this.options.readOnly,
        sessions: this.sessions.size,
      });
      return;
    }

    if (!this.isAuthorized(req, url)) {
      this.sendJson(res, 401, { error: "unauthorized", message: "Missing or invalid bearer token." });
      return;
    }

    if (url.pathname === "/mcp") {
      await this.handleStreamable(req, res);
      return;
    }
    if (url.pathname === "/sse" && req.method === "GET") {
      this.handleLegacySse(req, res);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      await this.handleLegacyMessage(req, res, url);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/info") {
      this.sendJson(res, 200, {
        name: SERVER_NAME,
        transport: ["streamable-http: /mcp", "sse: /sse"],
        endpoint: this.endpoint,
      });
      return;
    }
    this.sendJson(res, 404, { error: "not_found", message: `No route for ${url.pathname}` });
  }

  private async handleStreamable(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "DELETE") {
      const sid = this.headerValue(req, "mcp-session-id");
      if (sid) this.sessions.delete(sid);
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET") {
      // We do not push server-initiated messages; clients must use POST.
      res.writeHead(405, { ...corsHeaders(), Allow: "POST, DELETE", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed", message: "Use POST /mcp (or GET /sse for the legacy transport)." }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { ...corsHeaders(), Allow: "POST, DELETE", "Content-Type": "application/json" });
      res.end(JSON.stringify(errorBody(null, -32600, "Method not allowed")));
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      this.sendJson(res, 413, errorBody(null, -32600, errorMessage(e)));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, errorBody(null, -32700, "Parse error"));
      return;
    }

    const isBatch = Array.isArray(payload);
    const messages: JsonRpcRequest[] = (isBatch ? payload : [payload]) as JsonRpcRequest[];
    if (!messages.length) {
      this.sendJson(res, 400, errorBody(null, -32600, "Empty batch"));
      return;
    }

    let sessionId = this.headerValue(req, "mcp-session-id");
    const initMessage = messages.find((m) => m && m.method === "initialize");
    if (initMessage && !sessionId) {
      sessionId = randomId();
      this.sessions.set(sessionId, {
        id: sessionId,
        createdAt: Date.now(),
        protocolVersion: typeof initMessage.params?.protocolVersion === "string" ? initMessage.params.protocolVersion : LATEST_VERSION,
      });
    } else if (sessionId && !this.sessions.has(sessionId)) {
      // Be lenient: accept unknown session ids so restarted servers keep working.
      this.sessions.set(sessionId, { id: sessionId, createdAt: Date.now(), protocolVersion: LATEST_VERSION });
    }

    const results: unknown[] = [];
    for (const message of messages) {
      const result = await this.dispatch(message, sessionId ?? "");
      if (result !== null) results.push(result);
    }

    if (!results.length) {
      res.writeHead(202, corsHeaders());
      res.end();
      return;
    }

    const outgoing = isBatch ? results : results[0];
    const headers = { ...corsHeaders(), ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
    const accept = String(req.headers.accept ?? "");
    const wantsSseOnly = accept.includes("text/event-stream") && !accept.includes("application/json");

    if (wantsSseOnly) {
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: message\ndata: ${JSON.stringify(outgoing)}\n\n`);
      res.end();
      return;
    }

    this.sendJson(res, 200, outgoing, sessionId ? { "Mcp-Session-Id": sessionId } : {});
  }

  private handleLegacySse(req: IncomingMessage, res: ServerResponse): void {
    const id = randomId();
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${encodeURIComponent(id)}\n\n`);
    this.sseStreams.set(id, res);
    this.sessions.set(id, { id, createdAt: Date.now(), protocolVersion: "2024-11-05" });

    const timer = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(timer);
      }
    }, 25000);
    this.timers.add(timer);

    const cleanup = () => {
      clearInterval(timer);
      this.timers.delete(timer);
      this.sseStreams.delete(id);
      this.sessions.delete(id);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  private async handleLegacyMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get("sessionId") ?? this.headerValue(req, "mcp-session-id");
    const stream = sessionId ? this.sseStreams.get(sessionId) : undefined;
    if (!stream) {
      this.sendJson(res, 404, errorBody(null, -32000, "Unknown SSE session. Reconnect to /sse."));
      return;
    }

    let payload: JsonRpcRequest;
    try {
      payload = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as JsonRpcRequest;
    } catch {
      this.sendJson(res, 400, errorBody(null, -32700, "Parse error"));
      return;
    }

    res.writeHead(202, corsHeaders());
    res.end("Accepted");

    const result = await this.dispatch(payload, sessionId ?? "");
    if (result !== null) {
      try {
        stream.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      } catch {
        /* stream closed */
      }
    }
  }

  // ------------------------------------------------------------- json-rpc core

  private async dispatch(message: JsonRpcRequest, sessionId: string): Promise<unknown | null> {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      const id = message && typeof message === "object" ? message.id ?? null : null;
      return errorBody(id, -32600, "Invalid Request");
    }

    const id = message.id;
    const isNotification = id === undefined || id === null;
    const params = message.params ?? {};

    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const err = (code: number, text: string) => (isNotification ? null : errorBody(id ?? null, code, text));

    try {
      switch (message.method) {
        case "initialize": {
          const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
          const session = this.sessions.get(sessionId);
          if (session) {
            session.clientInfo = params.clientInfo;
            session.protocolVersion = version;
          }
          return ok({
            protocolVersion: version,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
              logging: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              title: "AI Connected — Obsidian",
              version: this.options.version,
            },
            instructions: this.options.instructions ?? defaultInstructions(),
          });
        }

        case "notifications/initialized":
        case "notifications/cancelled":
        case "notifications/roots/list_changed":
          return null;

        case "ping":
          return ok({});

        case "logging/setLevel":
          return ok({});

        case "tools/list":
          return ok({ tools: this.toolList() });

        case "tools/call":
          return ok(await this.callTool(params));

        case "resources/list":
          return ok({ resources: this.resourceList() });

        case "resources/templates/list":
          return ok({
            resourceTemplates: [
              {
                uriTemplate: "obsidian://vault/{path}",
                name: "Obsidian note",
                description: "Any markdown note in the vault, addressed by its vault-relative path.",
                mimeType: "text/markdown",
              },
            ],
          });

        case "resources/read":
          return ok(await this.readResource(params));

        case "prompts/list":
          return ok({ prompts: PROMPTS });

        case "prompts/get":
          return ok(this.getPrompt(params));

        default:
          return err(-32601, `Method not found: ${message.method}`);
      }
    } catch (e) {
      return err(-32603, errorMessage(e));
    }
  }

  private toolList(): unknown[] {
    return this.options.getTools().map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly,
        destructiveHint: t.destructive === true,
        idempotentHint: t.readOnly,
        openWorldHint: false,
      },
    }));
  }

  private async callTool(params: Record<string, any>): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = this.options.getTools().find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    if (this.options.readOnly && !tool.readOnly) {
      return {
        content: [{ type: "text", text: `服务器处于只读模式，"${name}" 已禁用。请在插件设置中关闭只读模式。` }],
        isError: true,
      };
    }
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, any>;
    try {
      const result = await tool.run(args, this.options.getContext());
      return { content: [{ type: "text", text: result.text }], isError: result.isError === true };
    } catch (e) {
      return { content: [{ type: "text", text: `工具执行失败：${errorMessage(e)}` }], isError: true };
    }
  }

  private resourceList(): unknown[] {
    const app = this.options.getContext().app;
    const files = app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    return files.slice(0, 500).map((f) => ({
      uri: noteUri(f.path),
      name: f.path,
      title: f.basename,
      mimeType: "text/markdown",
    }));
  }

  private async readResource(params: Record<string, any>): Promise<unknown> {
    const uri = typeof params.uri === "string" ? params.uri : "";
    const prefix = "obsidian://vault/";
    if (!uri.startsWith(prefix)) throw new Error(`Unsupported resource uri: ${uri}`);
    const path = uri
      .slice(prefix.length)
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
    const ctx = this.options.getContext();
    const file = requireNote(ctx.app, path);
    const text = await ctx.app.vault.read(file);
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }

  private getPrompt(params: Record<string, any>): unknown {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, any>;
    const prompt = PROMPTS.find((p) => p.name === name);
    if (!prompt) throw new Error(`Unknown prompt: ${name}`);

    if (name === "summarize_note") {
      const path = String(args.path ?? "");
      return {
        description: prompt.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `请阅读笔记 "${path}"（使用 read_note），然后用中文输出：1) 一句话摘要；2) 3-6 个要点；3) 待办/行动项（如有）；4) 建议添加的 [[双链]]。`,
            },
          },
        ],
      };
    }
    if (name === "summarize_active_note") {
      return {
        description: prompt.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "请用 get_active_note 读取我当前打开的笔记，概括它的核心内容，并指出可以补充或链接的地方。",
            },
          },
        ],
      };
    }
    const topic = String(args.topic ?? "");
    return {
      description: prompt.description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `关于 "${topic}"：先用 search_notes 和 list_backlinks 在笔记库中查找相关内容，列出 3-8 篇最相关的笔记（给出路径与相关原因），并建议在 "${topic}" 中补充哪些 [[双链]]。`,
          },
        },
      ],
    };
  }

  // -------------------------------------------------------------------- helpers

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!this.options.requireAuth) return true;
    const token = this.options.token;
    if (!token) return true;
    const header = String(req.headers.authorization ?? "");
    if (header.toLowerCase().startsWith("bearer ") && safeEqual(header.slice(7).trim(), token)) return true;
    if (safeEqual(url.searchParams.get("token") ?? "", token)) return true;
    return false;
  }

  private headerValue(req: IncomingMessage, name: string): string {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0] ?? "";
    return typeof value === "string" ? value : "";
  }

  private sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...corsHeaders(),
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function errorBody(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function noteUri(path: string): string {
  return "obsidian://vault/" + path.split("/").map((s) => encodeURIComponent(s)).join("/");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value ?? "");
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(new Error(`Request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => finish(err));
  });
}

function defaultInstructions(): string {
  return [
    "This server exposes an Obsidian vault. Notes are markdown files addressed by vault-relative paths.",
    "Workflow: use list_notes / search_notes / get_metadata to locate notes, read_note before editing, then use patch_note or append_note for surgical changes.",
    "Paths are relative to the vault root and must not contain '..'. Destructive tools (write_note overwrite, move_note, delete_note) require care — confirm with the user first.",
    "Prefer [[wikilinks]] when referring to other notes.",
  ].join("\n");
}
