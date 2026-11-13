import { readTools } from "./read";
import { searchTools } from "./search";
import type { ToolDef } from "./types";
import { writeTools } from "./write";

export * from "./types";

export const ALL_TOOLS: ToolDef[] = [...readTools, ...searchTools, ...writeTools];

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Convert our registry into the OpenAI / MCP function-calling shape. */
export function toolsForLlm(tools: ToolDef[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}

export function toolsForMcp(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
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
