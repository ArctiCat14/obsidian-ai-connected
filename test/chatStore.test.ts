/**
 * Chat history store test: persistence round-trip, truncation, sanitising of
 * incomplete tool turns, session caps and markdown export.
 */

import type { LlmMessage } from "../src/agent/llm";
import {
  ChatStore,
  deriveTitle,
  MAX_SESSIONS,
  MAX_STORED_TOOL_CHARS,
  sanitizeFileName,
  sanitizeMessages,
  sessionToMarkdown,
} from "../src/agent/chatStore";

// The plugin uses window.* for popout-window compatibility; plain Node has no window.
(globalThis as any).window = globalThis;

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

const files = new Map<string, string>();
const app = {
  vault: {
    adapter: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path) as string;
      },
      write: async (path: string, content: string) => {
        files.set(path, content);
      },
    },
  },
} as any;

const PATH = ".obsidian/plugins/ai-connected/chats.json";

async function main(): Promise<void> {
  console.log("\n== basics ==");
  const store = new ChatStore(app, PATH, true);
  await store.load();
  check("starts empty", store.sessions.length === 0, store.sessions);
  check("no active session initially", store.active === null);

  const session = store.create();
  check("create makes it active", store.activeId === session.id);
  check("create yields an empty session", session.messages.length === 0);
  session.title = deriveTitle("帮我总结 Inbox/Hello.md 这篇笔记");
  session.messages.push({ role: "user", content: "帮我总结 Inbox/Hello.md 这篇笔记" });
  session.messages.push({ role: "assistant", content: "好的，我先读一下。" });
  store.update(session);
  await store.save();

  check("writes chats.json", files.has(PATH));
  check("persists as valid JSON", (() => {
    try {
      JSON.parse(files.get(PATH) as string);
      return true;
    } catch {
      return false;
    }
  })());

  console.log("\n== reload ==");
  const reloaded = new ChatStore(app, PATH, true);
  await reloaded.load();
  check("restores the session count", reloaded.sessions.length === 1, reloaded.sessions.length);
  check("restores messages", reloaded.sessions[0].messages.length === 2, reloaded.sessions[0].messages);
  check("restores the active session", reloaded.activeId === session.id);
  check("restores the title", reloaded.sessions[0].title.includes("总结"), reloaded.sessions[0].title);

  console.log("\n== title derivation ==");
  check("strips markdown noise", deriveTitle("## 你好 **世界**\n\n第二行") === "你好 世界 第二行", deriveTitle("## 你好 **世界**\n\n第二行"));
  check("truncates long titles", deriveTitle("a".repeat(80)).endsWith("…"));
  check("falls back for blank input", deriveTitle("   ") === "新对话");

  console.log("\n== truncation ==");
  const bigStore = new ChatStore(app, ".obsidian/plugins/ai-connected/big.json", true);
  await bigStore.load();
  const bigSession = bigStore.create("大输出");
  bigSession.messages.push({ role: "user", content: "读一篇超长笔记" });
  bigSession.messages.push({ role: "assistant", content: "好" });
  bigSession.messages.push({ role: "tool", tool_call_id: "call_1", name: "read_note", content: "x".repeat(20000) });
  bigStore.update(bigSession);
  await bigStore.save();
  const bigReloaded = new ChatStore(app, ".obsidian/plugins/ai-connected/big.json", true);
  await bigReloaded.load();
  const toolMessage = bigReloaded.sessions[0].messages.find((m) => m.role === "tool");
  check("truncates oversized tool output", !!toolMessage && toolMessage.content.length < MAX_STORED_TOOL_CHARS + 100, toolMessage?.content.length);
  check("marks truncated content", !!toolMessage && toolMessage.content.includes("已截断"));

  console.log("\n== incomplete tool turns ==");
  const incomplete: LlmMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "read_note", arguments: '{"path":"a.md"}' } }],
    },
  ];
  check("drops assistant turn without tool results", sanitizeMessages(incomplete).length === 1);
  const complete = [...incomplete, { role: "tool" as const, tool_call_id: "call_9", name: "read_note", content: "# A" }];
  check("keeps completed tool turns", sanitizeMessages(complete).length === 3);
  check("keeps normal conversation", sanitizeMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]).length === 2);

  console.log("\n== session limits ==");
  const capStore = new ChatStore(app, ".obsidian/plugins/ai-connected/cap.json", true);
  await capStore.load();
  for (let i = 0; i < MAX_SESSIONS + 5; i++) {
    const s = capStore.create(`对话 ${i}`);
    s.messages.push({ role: "user", content: `第 ${i} 条` });
    capStore.update(s);
  }
  check(`caps at ${MAX_SESSIONS} sessions`, capStore.sessions.length === MAX_SESSIONS, capStore.sessions.length);
  await capStore.save();
  const capReloaded = new ChatStore(app, ".obsidian/plugins/ai-connected/cap.json", true);
  await capReloaded.load();
  check("cap survives reload", capReloaded.sessions.length === MAX_SESSIONS);

  console.log("\n== delete & active ==");
  const firstId = capReloaded.sessions[0].id;
  capReloaded.remove(firstId);
  check("removes the session", !capReloaded.get(firstId));
  check("moves active to another session", capReloaded.activeId !== firstId && capReloaded.activeId !== null);

  console.log("\n== disabled persistence ==");
  const disabledPath = ".obsidian/plugins/ai-connected/disabled.json";
  const disabled = new ChatStore(app, disabledPath, false);
  await disabled.load();
  const ds = disabled.create("不保存");
  ds.messages.push({ role: "user", content: "x" });
  disabled.update(ds);
  await disabled.save();
  check("does not write when persistence is off", !files.has(disabledPath));
  check("still keeps the session in memory", disabled.sessions.length === 1);

  console.log("\n== markdown export ==");
  const exported = sessionToMarkdown(reloaded.sessions[0]);
  check("has a title heading", exported.startsWith("# "), exported.slice(0, 40));
  check("includes the user turn", exported.includes("## 👤 用户"));
  check("includes the assistant turn", exported.includes("## 🤖 助手"));
  check("includes the message body", exported.includes("帮我总结 Inbox/Hello.md"));
  check("records message count", /共 \d+ 条消息/.test(exported));

  const withTool = sessionToMarkdown({
    id: "export",
    title: "带工具的对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { role: "user", content: "读一下 a.md" },
      {
        role: "assistant",
        content: "好的",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_note", arguments: '{"path":"a.md"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "read_note", content: "# A\n\n内容" },
    ],
  });
  check("renders tool calls", withTool.includes("🔧 工具 · `read_note`"), withTool.slice(0, 200));
  check("renders tool arguments", withTool.includes('"path": "a.md"'), withTool);
  check("renders tool results as callout", withTool.includes("> [!quote]- 工具结果 · read_note"));
  check("trims giant tool output in notes", withTool.length < 20000, withTool.length);

  console.log("\n== file names ==");
  check("strips illegal characters", sanitizeFileName('a/b:c*d?"e<f>g|h#i^j') === "a-b-c-d-e-f-g-h-i-j", sanitizeFileName('a/b:c*d?"e<f>g|h#i^j'));
  check("falls back when empty", sanitizeFileName("   ") === "AI 对话");
  check("limits length", sanitizeFileName("x".repeat(100)).length <= 40);

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Chat store test crashed:", error);
  process.exitCode = 1;
});
