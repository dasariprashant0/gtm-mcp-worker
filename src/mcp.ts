/**
 * The MCP agent. One Durable Object instance per connected client.
 *
 * init() runs once per session. It resolves WHO this session acts as — the
 * signed-in user, from the OAuth grant the provider decrypted into
 * this.props — and closes that identity over every tool handler. A handler
 * therefore cannot accidentally act as anyone else, and every Tag Manager
 * permission check happens against the real person's GTM access.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isForcedDryRun, isReadWrite, mutationBudget, type Env, type GtmCtx } from "./env.ts";
import type { GoogleAuthProps } from "./google-oauth.ts";
import { SERVER_NAME, SERVER_VERSION, logJson, userTokenSource } from "./gtm/http.ts";
import { TOOL_COUNT, registerTools } from "./gtm/tools/index.ts";

export class GtmMCP extends McpAgent<Env, unknown, GoogleAuthProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init(): Promise<void> {
    const env = this.env;
    const props = this.props as GoogleAuthProps | undefined;

    if (!props?.googleRefreshToken) {
      // Should be unreachable: OAuthProvider gates /mcp on a valid bearer
      // token, and a token only exists alongside a grant. If it happens, fail
      // loudly rather than silently serving a session with no identity.
      throw new Error(
        "No Google grant on this MCP session. Remove and re-add this connector, then sign in " +
          "with Google again.",
      );
    }

    const ctx: GtmCtx = {
      env,
      getToken: userTokenSource(env, props.sub, props.googleRefreshToken),
      actor: props.email || props.sub,
      sub: props.sub,
      budget: { used: 0, max: mutationBudget(env) },
    };

    logJson({
      event: "mcp_session_init",
      actor: ctx.actor,
      gtm_mode: isReadWrite(env) ? "read_write" : "read_only",
      forced_dry_run: isForcedDryRun(env),
      mutation_budget: ctx.budget.max,
    });

    registerTools(this.server, ctx);

    logJson({
      event: "mcp_init",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      tools: TOOL_COUNT,
    });
  }
}
