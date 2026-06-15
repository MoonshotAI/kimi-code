import { Methods } from "../../shared/bridge";
import { getCLIManager } from "../managers";
import type { Handler } from "./types";

export const cliHandlers: Record<string, Handler<void, { ok: boolean }>> = {
  [Methods.CheckCLI]: async () => {
    const ok = await getCLIManager().checkInstalled();
    return { ok };
  },

  [Methods.InstallCLI]: async () => {
    await getCLIManager().installCLI();
    return { ok: true };
  },
};
