/**
 * Workspace/user skill discovery — local port of the node-sdk
 * `discoverSkills` (G-1 vscode localization). Reads the `SKILL.md` file of
 * each bundle under `<work_dir>/.kimi-code/skills` (project) and
 * `<KIMI_CODE_HOME>/skills` (user); project wins on a same-name collision;
 * results are name-sorted.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveKimiHome } from "./mcp-config";
import type { SkillSummary } from "./types";

const DISABLE_MODEL_INVOCATION_KEYS = [
  "disable_model_invocation",
  "disable-model-invocation",
  "disableModelInvocation",
] as const;

/** Skills visible to a new session in `workDir`, without creating one. */
export async function listWorkspaceSkills(workDir: string): Promise<SkillSummary[]> {
  if (workDir.trim().length === 0) {
    throw new Error("listWorkspaceSkills requires workDir");
  }
  const byName = new Map<string, SkillSummary>();
  const roots: ReadonlyArray<[string, SkillSummary["source"]]> = [
    [join(workDir, ".kimi-code", "skills"), "project"],
    [join(resolveKimiHome(), "skills"), "user"],
  ];
  for (const [root, source] of roots) {
    for (const skill of await discoverSkillBundles(root, source)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

async function discoverSkillBundles(
  rootDir: string,
  source: SkillSummary["source"],
): Promise<SkillSummary[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const dir = join(rootDir, entry);
      const skillPath = join(dir, "SKILL.md");
      let text: string;
      try {
        text = await readFile(skillPath, "utf-8");
      } catch {
        return;
      }
      const parsed = parseSkillFrontmatter(text, entry);
      if (parsed === undefined) return;
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source,
        path: skillPath,
        ...(parsed.disableModelInvocation === undefined
          ? {}
          : { disableModelInvocation: parsed.disableModelInvocation }),
      });
    }),
  );
  return skills;
}

/** Parse a SKILL.md's YAML frontmatter (flat `key: value` subset). */
function parseSkillFrontmatter(
  text: string,
  fallbackName: string,
):
  | { name: string; description: string; disableModelInvocation?: boolean }
  | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return undefined;

  let name: string | undefined;
  let description = "";
  let disableModelInvocation: boolean | undefined;
  for (const line of lines.slice(1, close)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = parseScalar(trimmed.slice(colon + 1).trim());
    switch (key) {
      case "name":
        if (value.length > 0) name = value;
        break;
      case "description":
        description = value;
        break;
      default:
        if ((DISABLE_MODEL_INVOCATION_KEYS as readonly string[]).includes(key)) {
          disableModelInvocation = value === "true";
        }
        break;
    }
  }
  return {
    name: name ?? fallbackName,
    description,
    ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
  };
}

/** Strip matching quotes from a scalar value; else as-is. */
function parseScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
