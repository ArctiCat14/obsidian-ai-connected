/**
 * MCP protocol smoke test.
 *
 * Bundled with esbuild (aliasing `obsidian` to ./obsidianStub.ts) and executed by Node:
 *   esbuild test/mcp.test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./test/obsidianStub.ts --outfile=test/build/mcp.test.cjs
 *   node test/build/mcp.test.cjs
 */

import { McpServer } from "../src/server/mcpServer";
import { ALL_TOOLS } from "../src/tools";
import { TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

// --------------------------------------------------------------------- fake app

const contents = new Map<string, string>([
  ["Inbox/Hello.md", "# Hello\n\nworld foo bar\n"],
  ["Projects/Plan.md", "# Plan\n\n- item one\n- item two\n\n## Milestones\n\nfoo milestone\n"],
  ["Projects/Notes/Idea.md", "---\ntags: [idea, spark]\n---\n\n# Idea\n\nfoo idea\n"],
]);

const files = new Map<string, TFile>();
const folders = new Map<string, TFolder>();

const root = new TFolder();
root.path = "/";
root.name = "";

function fileOf(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").pop() ?? path;
  file.basename = file.name.replace(/\.md$/, "");
  file.extension = "md";
  file.stat = { size: contents.get(path)?.length ?? 0, mtime: 1_700_000_000_000, ctime: 1_600_000_000_000 };
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  file.parent = folderOf(parentPath);
  return file;
}

function folderOf(path: string): TFolder {
  if (!path) return root;
  let folder = folders.get(path);
  if (!folder) {
    folder = new TFolder();
    folder.path = path;
    folder.name = path.split("/").pop() ?? path;
    folder.parent = folderOf(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    folders.set(path, folder);
  }
  return folder;
}

for (const path of contents.keys()) {
  files.set(path, fileOf(path));
  folderOf(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
}

const metadataCache = {
  resolvedLinks: { "Projects/Plan.md": { "Inbox/Hello.md": 1 } },
  getFileCache(file: TFile) {
    const tags = file.path.includes("Idea") ? [{ tag: "#spark" }] : [];
    return {
      frontmatter: file.path.includes("Idea") ? { tags: ["idea", "spark"] } : {},
      tags,
      headings: [{ level: 1, heading: file.basename }],
      links: [],
      embeds: [],
    };
  },
};

const vault = {
  getName: () => "TestVault",
  adapter: { getBasePath: () => "C:\\fake\\vault" },
  getMarkdownFiles: () => Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path)),
  getAllLoadedFiles: () => [...Array.from(folders.values()), ...Array.from(files.values())],
  getAbstractFileByPath(path: string) {
    return files.get(path) ?? folders.get(path) ?? null;
  },
  async cachedRead(file: TFile) {
    return contents.get(file.path) ?? "";
  },
  async read(file: TFile) {
    return contents.get(file.path) ?? "";
  },
  async create(path: string, content: string) {
    contents.set(path, content);
    const created = fileOf(path);
    files.set(path, created);
    return created;
  },
  async modify(file: TFile, content: string) {
    contents.set(file.path, content);
    file.stat.size = content.length;
  },
  async delete(file: TFile) {
    files.delete(file.path);
    contents.delete(file.path);
  },
  async createFolder(path: string) {
    folderOf(path);
  },
};

const app = {
  vault,
  metadataCache,
  fileManager: {
    async renameFile(file: TFile, target: string) {
      const content = contents.get(file.path) ?? "";
      contents.delete(file.path);
      files.delete(file.path);
      contents.set(target, content);
      files.set(target, fileOf(target));
    },
    async trashFile(file: TFile) {
      contents.delete(file.path);
      files.delete(file.path);
    },
  },
  workspace: {
    getActiveFile: () => files.get("Inbox/Hello.md") ?? null,
    getActiveViewOfType: () => null,
    getLeaf: () => ({ openFile: async () => undefined }),
  },
  internalPlugins: { getPluginById: () => undefined },
} as any;

const settings = { ...DEFAULT_SETTINGS, mcpToken: "test-token", mcpRequireAuth: true, mcpPort: 0 };

// ------------------------------------------------------------------- transport

let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

async function rpc(method: string, params: unknown = {}, id: number | string = 1, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { ...auth, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, json };
}

async function callTool(name: string, args: Record<string, unknown> = {}, readOnly = false) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text: string = res.json?.result?.content?.[0]?.text ?? "";
  return { status: res.status, isError: res.json?.result?.isError === true, text };
}

async function main(): Promise<void> {
  console.log("\n== MCP transport & protocol ==");
  const server = new McpServer({
    host: "127.0.0.1",
    port: 0,
    token: settings.mcpToken,
    requireAuth: true,
    readOnly: false,
    version: "1.0.0",
    getTools: () => ALL_TOOLS,
    getContext: () => ({ app, settings }),
  });
  await server.start();
  port = server.port;
  check("server listens on an ephemeral port", port > 0, port);

  const health = await fetch(`${base()}/health`).then((r) => r.json() as any);
  check("GET /health returns ok", health.ok === true && health.tools === ALL_TOOLS.length, health);

  const unauthorized = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("missing bearer token -> 401", unauthorized.status === 401, unauthorized.status);

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  check("initialize returns result", init.status === 200 && init.json.result?.protocolVersion === "2025-06-18", init.json);
  check("initialize exposes tools capability", !!init.json.result?.capabilities?.tools, init.json.result?.capabilities);
  const sessionId = init.headers.get("mcp-session-id") ?? "";
  check("initialize returns Mcp-Session-Id", sessionId.length > 0, sessionId);
  check("initialize advertises instructions", typeof init.json.result?.instructions === "string" && init.json.result.instructions.length > 0);

  const initialized = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { ...auth, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("notification -> 202 with empty body", initialized.status === 202, initialized.status);

  const list = await rpc("tools/list", {}, 2, { "Mcp-Session-Id": sessionId });
  const tools: any[] = list.json.result?.tools ?? [];
  check("tools/list returns every tool", tools.length === ALL_TOOLS.length, tools.length);
  check("tools carry readOnlyHint annotations", tools.some((t) => t.annotations?.readOnlyHint === true));
  check("destructive tools are flagged", tools.filter((t) => t.annotations?.destructiveHint).length >= 3);
  check("every tool has an object inputSchema", tools.every((t) => t.inputSchema?.type === "object"));

  const ping = await rpc("ping", {}, 3);
  check("ping -> {}", ping.json.result !== undefined && Object.keys(ping.json.result).length === 0, ping.json);

  const unknown = await rpc("does/not/exist", {}, 4);
  check("unknown method -> -32601", unknown.json.error?.code === -32601, unknown.json);

  console.log("\n== read tools ==");
  const listed = await callTool("list_notes", {});
  const listedJson = JSON.parse(listed.text);
  check("list_notes returns 3 notes", listedJson.total === 3 && listedJson.notes.length === 3, listedJson);
  check("list_notes respects folder filter", JSON.parse((await callTool("list_notes", { folder: "Projects" })).text).total === 2);

  const read = await callTool("read_note", { path: "Inbox/Hello.md" });
  check("read_note returns content", read.text.includes("# Hello") && read.text.includes("world foo bar"), read.text.slice(0, 120));
  check("read_note resolves by basename", (await callTool("read_note", { path: "Hello" })).text.includes("# Hello"));

  const missing = await callTool("read_note", { path: "Nope/Missing.md" });
  check("read_note on missing note -> isError", missing.isError === true, missing.text);

  const meta = await callTool("get_metadata", { path: "Projects/Notes/Idea.md" });
  const metaJson = JSON.parse(meta.text);
  check("get_metadata returns frontmatter tags", metaJson.tags.includes("idea"), metaJson.tags);
  check("get_metadata returns backlinks", Array.isArray(metaJson.backlinks), metaJson.backlinks);

  const active = await callTool("get_active_note", {});
  check("get_active_note reports the open note", JSON.parse(active.text).active === "Inbox/Hello.md");

  const tags = await callTool("list_tags", {});
  check("list_tags aggregates tags", JSON.parse(tags.text).tags.some((t: any) => t.tag === "spark"), tags.text);

  console.log("\n== search tools ==");
  const search = await callTool("search_notes", { query: "foo" });
  const searchJson = JSON.parse(search.text);
  check("search_notes finds 3 matches", searchJson.matches === 3, searchJson);
  check("search_notes includes snippets", typeof searchJson.results[0]?.snippet === "string");

  const regex = await callTool("search_notes", { query: "^# (Hello|Plan)$", regex: true });
  check("search_notes supports regex", JSON.parse(regex.text).matches >= 2, regex.text.slice(0, 200));

  const byTag = await callTool("search_by_tag", { tag: "#spark" });
  check("search_by_tag finds the tagged note", JSON.parse(byTag.text).count === 1, byTag.text);

  const backlinks = await callTool("list_backlinks", { path: "Inbox/Hello.md" });
  check("list_backlinks finds the referring note", JSON.parse(backlinks.text).backlinks.includes("Projects/Plan.md"), backlinks.text);

  console.log("\n== write tools ==");
  const written = await callTool("write_note", { path: "Inbox/New.md", content: "# New\n\nhello\n" });
  check("write_note creates a note", JSON.parse(written.text).created === true, written.text);
  check("write_note creates parent folders", files.has("Inbox/New.md"));

  const appended = await callTool("append_note", { path: "Inbox/New.md", content: "appended line" });
  check("append_note appends", JSON.parse(appended.text).appendedChars > 0 && (contents.get("Inbox/New.md") ?? "").endsWith("appended line"));

  const patched = await callTool("patch_note", { path: "Inbox/New.md", oldText: "hello", newText: "hello patched" });
  check("patch_note replaces text", JSON.parse(patched.text).changed === true && (contents.get("Inbox/New.md") ?? "").includes("hello patched"), patched.text);

  const heading = await callTool("patch_note", {
    path: "Projects/Plan.md",
    mode: "insert_after_heading",
    heading: "Milestones",
    newText: "### Q1\n\n- ship it",
  });
  const plan = contents.get("Projects/Plan.md") ?? "";
  check("patch_note inserts under a heading", heading.isError !== true && plan.includes("### Q1"), plan);

  const section = await callTool("patch_note", {
    path: "Projects/Plan.md",
    mode: "replace_section",
    heading: "Milestones",
    newText: "rewritten section",
  });
  check("patch_note replaces a section", section.isError !== true && (contents.get("Projects/Plan.md") ?? "").includes("rewritten section"));

  const traversal = await callTool("write_note", { path: "../escape.md", content: "x" });
  check("path traversal is rejected", traversal.isError === true && /非法路径/.test(traversal.text), traversal.text);

  const protectedPath = await callTool("write_note", { path: ".obsidian/app.json", content: "x" });
  check("writes into .obsidian are rejected", protectedPath.isError === true, protectedPath.text);

  const moved = await callTool("move_note", { from: "Inbox/New.md", to: "Archive/New.md" });
  check("move_note renames the file", JSON.parse(moved.text).moved === true && files.has("Archive/New.md"), moved.text);

  const deleted = await callTool("delete_note", { path: "Archive/New.md" });
  check("delete_note trashes the note", /回收站/.test(deleted.text), deleted.text);

  console.log("\n== resources & prompts ==");
  const resources = await rpc("resources/list", {}, 5);
  const resourceList: any[] = resources.json.result?.resources ?? [];
  check("resources/list exposes the vault", resourceList.length >= 3, resourceList.length);
  check("resources use obsidian:// uris", resourceList.every((r) => r.uri.startsWith("obsidian://vault/")));

  const target = resourceList.find((r) => r.name === "Inbox/Hello.md");
  const resourceRead = await rpc("resources/read", { uri: target?.uri ?? "" }, 6);
  check("resources/read returns the note", resourceRead.json.result?.contents?.[0]?.text?.includes("# Hello"), resourceRead.json);
  check("resources/read sets mimeType", resourceRead.json.result?.contents?.[0]?.mimeType === "text/markdown");

  const templates = await rpc("resources/templates/list", {}, 7);
  check("resources/templates/list returns a template", (templates.json.result?.resourceTemplates ?? []).length === 1);

  const prompts = await rpc("prompts/list", {}, 8);
  check("prompts/list returns prompts", (prompts.json.result?.prompts ?? []).length === 3);

  const promptGet = await rpc("prompts/get", { name: "summarize_note", arguments: { path: "Inbox/Hello.md" } }, 9);
  check("prompts/get renders messages", promptGet.json.result?.messages?.[0]?.content?.type === "text", promptGet.json);

  console.log("\n== legacy SSE transport ==");
  const sseRes = await fetch(`${base()}/sse`, { headers: { Authorization: "Bearer test-token" } });
  check("GET /sse opens an event stream", sseRes.status === 200 && (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"));
  const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  check("SSE announces the endpoint", firstChunk.includes("event: endpoint"), firstChunk);
  const sseSession = /sessionId=([^&\n]+)/.exec(firstChunk)?.[1] ?? "";
  check("SSE provides a session id", sseSession.length > 0, sseSession);

  const post = await fetch(`${base()}/messages?sessionId=${encodeURIComponent(sseSession)}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
  });
  check("POST /messages accepts the request", post.status === 202, post.status);
  const second = new TextDecoder().decode((await reader.read()).value);
  check("SSE delivers the JSON-RPC result", second.includes("tools") && second.includes("event: message"), second.slice(0, 200));
  await reader.cancel();

  console.log("\n== read-only mode ==");
  const readonly = new McpServer({
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    requireAuth: true,
    readOnly: true,
    version: "1.0.0",
    getTools: () => ALL_TOOLS,
    getContext: () => ({ app, settings }),
  });
  await readonly.start();
  const roPort = readonly.port;
  const roCall = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${roPort}/mcp`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await res.json()) as any;
  };
  const roWrite = await roCall("write_note", { path: "Inbox/Blocked.md", content: "x" });
  check("read-only mode blocks write_note", roWrite.result?.isError === true && /只读/.test(roWrite.result?.content?.[0]?.text), roWrite);
  const roRead = await roCall("list_notes", {});
  check("read-only mode allows reads", roRead.result?.isError !== true, roRead);
  await readonly.stop();

  console.log("\n== sse-only accept header ==");
  const sseOnly = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { ...auth, Accept: "text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
  });
  const sseOnlyBody = await sseOnly.text();
  check("event-stream-only client gets SSE framing", (sseOnly.headers.get("content-type") ?? "").includes("text/event-stream") && sseOnlyBody.startsWith("event: message"), sseOnlyBody.slice(0, 120));

  await server.stop();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exitCode = 1;
});
