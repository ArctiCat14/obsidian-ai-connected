import type { App } from "obsidian";
import type { AIConnectedSettings } from "../settings";

export interface ToolContext {
  app: App;
  settings: AIConnectedSettings;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDef {
  /** MCP / function-calling name. snake_case. */
  name: string;
  /** Human readable title, shown in the MCP tool annotations. */
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** True when the tool never mutates the vault. */
  readOnly: boolean;
  /** True when the tool can destroy or overwrite user data. */
  destructive?: boolean;
  run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(text: string): ToolResult {
  return { text };
}

export function fail(text: string): ToolResult {
  return { text, isError: true };
}

export function json(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}
