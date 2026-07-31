const FILE_SCHEME = "file:";
const URI_LIST_COMMENT_PREFIX = "#";
const WINDOWS_DRIVE_PATH = /^\/[A-Za-z]:\//;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;
const URI_LIST_MIME_TYPE = "text/uri-list";

export type DroppedContent =
  | { kind: "media"; files: File[] }
  | { kind: "paths"; paths: string[] }
  | { kind: "none" };

interface DropDataTransfer {
  files: ArrayLike<File>;
  getData(mimeType: string): string;
}

function resourceUriToPath(uri: URL, useWindowsSeparators: boolean): string {
  let pathname = decodeURIComponent(uri.pathname);
  if (WINDOWS_DRIVE_PATH.test(pathname)) {
    pathname = pathname.slice(1);
  } else if (uri.protocol === FILE_SCHEME && uri.hostname) {
    pathname = `//${uri.hostname}${pathname}`;
  }
  return useWindowsSeparators ? pathname.replaceAll("/", "\\") : pathname;
}

function relativeToWorkspace(filePath: string, workspaceRoot: string | null): string {
  if (!workspaceRoot) {
    return filePath;
  }

  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const caseInsensitive = WINDOWS_ROOT.test(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  const comparedPath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const comparedRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;

  if (comparedPath.replace(/\/$/, "") === comparedRoot) {
    return ".";
  }
  if (!comparedPath.startsWith(`${comparedRoot}/`)) {
    return filePath;
  }
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function hasSameWorkspaceAuthority(uri: URL, workspaceUri: URL | null): boolean {
  return workspaceUri !== null &&
    uri.username === "" &&
    uri.password === "" &&
    workspaceUri.username === "" &&
    workspaceUri.password === "" &&
    uri.protocol === workspaceUri.protocol &&
    uri.hostname === workspaceUri.hostname &&
    uri.port === workspaceUri.port;
}

export function parseDroppedFilePaths(
  uriList: string,
  workspaceRoot: string | null,
  workspaceRootUri: string | null = null,
): string[] {
  const useWindowsSeparators = workspaceRoot !== null &&
    (WINDOWS_ROOT.test(workspaceRoot) || workspaceRoot.startsWith("\\\\"));
  const paths: string[] = [];
  let parsedWorkspaceUri: URL | null = null;
  if (workspaceRootUri) {
    try {
      parsedWorkspaceUri = new URL(workspaceRootUri);
    } catch {
      // A malformed workspace URI cannot authorize non-file resource schemes.
    }
  }

  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith(URI_LIST_COMMENT_PREFIX)) {
      continue;
    }
    try {
      const uri = new URL(value);
      const isWorkspaceScheme = hasSameWorkspaceAuthority(uri, parsedWorkspaceUri);
      if (uri.protocol !== FILE_SCHEME && !isWorkspaceScheme) {
        continue;
      }
      paths.push(relativeToWorkspace(resourceUriToPath(uri, useWindowsSeparators), workspaceRoot));
    } catch {
      // A URI list may contain malformed or unsupported entries; valid file URIs still apply.
    }
  }
  return paths;
}

export function resolveDroppedContent(
  dataTransfer: DropDataTransfer,
  workspaceRoot: string | null,
  workspaceRootUri: string | null,
  isMediaFile: (file: File) => boolean,
): DroppedContent {
  const mediaFiles = Array.from(dataTransfer.files).filter(isMediaFile);
  if (mediaFiles.length > 0) {
    return { kind: "media", files: mediaFiles };
  }

  const paths = parseDroppedFilePaths(
    dataTransfer.getData(URI_LIST_MIME_TYPE),
    workspaceRoot,
    workspaceRootUri,
  );
  return paths.length > 0 ? { kind: "paths", paths } : { kind: "none" };
}

export function insertDroppedFilePaths(
  text: string,
  cursorPos: number,
  paths: string[],
): { text: string; cursorPos: number } {
  const mentions = paths.map((path) => path.includes(" ") ? `@"${path}"` : `@${path}`).join(" ");
  const insertion = `${mentions} `;
  const after = text.slice(cursorPos).replace(/^\s/, "");
  return {
    text: text.slice(0, cursorPos) + insertion + after,
    cursorPos: cursorPos + insertion.length,
  };
}
