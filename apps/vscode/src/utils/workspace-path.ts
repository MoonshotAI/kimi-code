import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { relativeFsPath } from "./fs-path";

export interface WorkspacePath {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
}

export function workDirUriFromPath(
  workspaceRootUri: vscode.Uri,
  workspaceRoot: string,
  workDir: string,
): vscode.Uri | undefined {
  const relativePath = relativeFsPath(workspaceRoot, workDir);
  if (relativePath === undefined) return undefined;
  return relativePath === ""
    ? workspaceRootUri
    : vscode.Uri.joinPath(workspaceRootUri, ...toPathSegments(relativePath));
}

export function resolveWorkspacePath(
  workDirUri: vscode.Uri,
  input: string,
  options: { allowRoot?: boolean } = {},
): WorkspacePath | undefined {
  const normalized = input.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input)
  ) return undefined;

  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return undefined;
  if (segments.length === 0) {
    return options.allowRoot === true ? { uri: workDirUri, relativePath: "" } : undefined;
  }

  return {
    uri: vscode.Uri.joinPath(workDirUri, ...segments),
    relativePath: segments.join("/"),
  };
}

export function relativeWorkspacePath(rootUri: vscode.Uri, candidateUri: vscode.Uri): string | undefined {
  if (rootUri.scheme !== candidateUri.scheme) return undefined;

  // VS Code exposes native Windows file paths through `fsPath`, while URI
  // paths always use `/`. Comparing the URI strings makes the same drive or
  // UNC path look different when only separator or drive/share casing differs.
  // Native filesystem semantics are the right contract for `file:` URIs.
  if (rootUri.scheme === "file") {
    const relativePath = relativeFsPath(rootUri.fsPath, candidateUri.fsPath);
    return relativePath === "" ? undefined : relativePath;
  }

  if (rootUri.authority !== candidateUri.authority) return undefined;

  const relativePath = path.posix.relative(normalizeUriPath(rootUri.path), normalizeUriPath(candidateUri.path));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.posix.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath;
}

export async function isWorkspacePathContained(
  rootUri: vscode.Uri,
  candidateUri: vscode.Uri,
  options: { allowMissing?: boolean } = {},
): Promise<boolean> {
  if (rootUri.toString() !== candidateUri.toString() && relativeWorkspacePath(rootUri, candidateUri) === undefined) {
    return false;
  }
  if (rootUri.scheme !== "file" || candidateUri.scheme !== "file") return true;

  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(rootUri.fsPath),
      options.allowMissing === true ? realExistingPath(candidateUri.fsPath) : realpath(candidateUri.fsPath),
    ]);
    return relativeFsPath(realRoot, realCandidate) !== undefined;
  } catch {
    return false;
  }
}

export function isWorkspacePathContainedSync(
  rootUri: vscode.Uri,
  candidateUri: vscode.Uri,
  options: { allowMissing?: boolean } = {},
): boolean {
  if (rootUri.toString() !== candidateUri.toString() && relativeWorkspacePath(rootUri, candidateUri) === undefined) {
    return false;
  }
  if (rootUri.scheme !== "file" || candidateUri.scheme !== "file") return true;

  try {
    const realRoot = realpathSync(rootUri.fsPath);
    const realCandidate =
      options.allowMissing === true
        ? realExistingPathSync(candidateUri.fsPath)
        : realpathSync(candidateUri.fsPath);
    return relativeFsPath(realRoot, realCandidate) !== undefined;
  } catch {
    return false;
  }
}

async function realExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      let isDanglingSymlink = false;
      try {
        isDanglingSymlink = (await lstat(current)).isSymbolicLink();
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }
      if (isDanglingSymlink) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function realExistingPathSync(candidate: string): string {
  let current = candidate;
  while (true) {
    try {
      return realpathSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      let isDanglingSymlink = false;
      try {
        isDanglingSymlink = lstatSync(current).isSymbolicLink();
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }
      if (isDanglingSymlink) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toPathSegments(value: string): string[] {
  return value.replaceAll("\\", "/").split("/").filter(Boolean);
}

function normalizeUriPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}
