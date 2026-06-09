import { Methods } from "../../shared/bridge";
import { MCPManager } from "../managers";
import type { Handler } from "./types";

export const mcpHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetMCPServers]: async () => {
    return MCPManager.getServers();
  },
};
