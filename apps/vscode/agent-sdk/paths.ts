import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");

function hashPath(workDir: string): string {
  return crypto.createHash("sha256").update(workDir, "utf-8").digest("hex").slice(0, 12);
}

function slugPath(workDir: string): string {
  const base = path.basename(workDir).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "workspace";
}

export const KimiPaths = {
  home: KIMI_HOME,
  config: path.join(KIMI_HOME, "config.toml"),
  mcpConfig: path.join(KIMI_HOME, "mcp.json"),

  sessionsDir(workDir: string): string {
    return path.join(KIMI_HOME, "sessions", `wd_${slugPath(workDir)}_${hashPath(workDir)}`);
  },

  sessionDir(workDir: string, sessionId: string): string {
    return path.join(KIMI_HOME, "sessions", `wd_${slugPath(workDir)}_${hashPath(workDir)}`, sessionId);
  },

  shadowGitDir(workDir: string, sessionId: string): string {
    return path.join(KIMI_HOME, "sessions", `wd_${slugPath(workDir)}_${hashPath(workDir)}`, sessionId, "shadow", ".git");
  },
};
