import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { KimiPaths } from "./paths";
import type { SessionInfo, ContentPart } from "./schema";
import { cleanSystemTags } from "./utils";

// Constants
const SESSION_ID_REGEX = /^(?:session_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// List Sessions (Async)
export async function listSessions(workDir: string): Promise<SessionInfo[]> {
  const sessionsDir = KimiPaths.sessionsDir(workDir);

  try {
    await fsp.access(sessionsDir);
  } catch {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
  } catch (err) {
    console.warn("[storage] Failed to read sessions:", err);
    return [];
  }

  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_REGEX.test(entry.name)) {
      continue;
    }

    const sessionId = entry.name;
    const sessionDir = path.join(sessionsDir, sessionId);
    const wireFile = path.join(sessionDir, "wire.jsonl");
    const contextFile = path.join(sessionDir, "context.jsonl");
    const stateFile = path.join(sessionDir, "state.json");

    const targetFile = fs.existsSync(wireFile) ? wireFile : fs.existsSync(contextFile) ? contextFile : stateFile;
    if (!fs.existsSync(targetFile)) {
      continue;
    }

    try {
      const stat = await fsp.stat(targetFile);
      const brief = await getFirstUserMessage(sessionDir);

      sessions.push({
        id: sessionId,
        workDir,
        contextFile: targetFile,
        updatedAt: stat.mtimeMs,
        brief,
      });
    } catch (err) {
      console.warn(`[storage] Failed to stat ${sessionId}:`, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Delete Session
export async function deleteSession(workDir: string, sessionId: string): Promise<boolean> {
  const sessionDir = path.join(KimiPaths.sessionsDir(workDir), sessionId);

  try {
    await fsp.access(sessionDir);
  } catch {
    return false;
  }

  try {
    await fsp.rm(sessionDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[storage] Failed to delete ${sessionId}:`, err);
    return false;
  }
}

// Get First User Message (Stream-based, early exit)
async function getFirstUserMessage(sessionDir: string): Promise<string> {
  const wireFile = path.join(sessionDir, "wire.jsonl");
  const contextFile = path.join(sessionDir, "context.jsonl");
  const stateFile = path.join(sessionDir, "state.json");

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as { title?: string; lastPrompt?: string };
      return (state.title || state.lastPrompt || "").trim();
    } catch {
      return "";
    }
  }

  // Try wire.jsonl first, fallback to context.jsonl
  const targetFile = fs.existsSync(wireFile) ? wireFile : fs.existsSync(contextFile) ? contextFile : null;
  if (!targetFile) {
    return "";
  }

  try {
    const stream = fs.createReadStream(targetFile, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const record = JSON.parse(line);
        if (record.message?.type !== "TurnBegin") {
          continue;
        }

        const userInput = record.message.payload?.user_input;
        const text = extractUserText(userInput);
        if (text) {
          rl.close();
          stream.destroy();
          return text;
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.warn("[storage] Failed to read wire file:", err);
  }

  return "";
}

// Text Extraction Helpers
function extractUserText(userInput: unknown): string {
  if (typeof userInput === "string") {
    return cleanSystemTags(stripFileTags(userInput));
  }

  if (Array.isArray(userInput)) {
    const textParts = (userInput as ContentPart[]).filter((p): p is ContentPart & { type: "text" } => p.type === "text").map((p) => p.text);
    return cleanSystemTags(stripFileTags(textParts.join("\n")));
  }

  return "";
}

function stripFileTags(text: string): string {
  return text
    .replace(/<uploaded_files>[\s\S]*?<\/uploaded_files>\s*/g, "")
    .replace(/<document[^>]*>[\s\S]*?<\/document>\s*/g, "")
    .replace(/<image[^>]*>[\s\S]*?<\/image>\s*/g, "")
    .trim();
}
