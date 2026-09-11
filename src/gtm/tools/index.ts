/**
 * One place listing every tool registration.
 *
 * Read tools are always registered. Write tools are registered even in
 * read-only mode, on purpose: a model that cannot see gtm_create_tag will
 * confidently tell the user the server has no way to create tags, which is
 * wrong and unhelpful. Registered-but-refusing gives an accurate error that
 * names GTM_MODE, which is what the user actually needs to hear.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GtmCtx } from "../../env.ts";
import { registerReadTools } from "./read.ts";
import { registerWriteTools } from "./write.ts";

export const READ_TOOL_COUNT = 13;
export const WRITE_TOOL_COUNT = 14;
export const TOOL_COUNT = READ_TOOL_COUNT + WRITE_TOOL_COUNT;

export function registerTools(server: McpServer, ctx: GtmCtx): void {
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
}
