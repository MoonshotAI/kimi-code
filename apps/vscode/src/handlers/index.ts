import { cliHandlers } from "./cli.handler";
import { configHandlers } from "./config.handler";
import { mcpHandlers } from "./mcp.handler";
import { sessionHandlers } from "./session.handler";
import { chatHandlers } from "./chat.handler";
import { fileHandlers } from "./file.handler";
import { workspaceHandlers } from "./workspace.handler";
import type { Handler } from "./types";

export type { Handler, HandlerContext, BroadcastFn } from "./types";

export const handlers: Record<string, Handler<any, any>> = {
  ...workspaceHandlers,
  ...cliHandlers,
  ...configHandlers,
  ...mcpHandlers,
  ...sessionHandlers,
  ...chatHandlers,
  ...fileHandlers,
};
