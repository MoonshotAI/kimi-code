# File endpoints

This page lists the server's file endpoints: the session file system, the workspace file system, the host file endpoints, and the HTTP behavior of the endpoints that return binary streams. Shared conventions such as [authentication](./server-api.md#authentication), the [response envelope](./server-api.md#response-envelope), and [error codes](./server-api.md#error-codes) are covered in [Server API](./server-api.md). The endpoints for sessions themselves are in [Session endpoints](./server-api-sessions.md).

::: danger Warning
`GET /api/v1/fs:content` can read the raw bytes of any file on the host and is gated only by the API token. Be careful when exposing the server port beyond the local machine.
:::

## Common rules

The following conventions apply to several endpoints on this page and are not repeated under each endpoint.

- **Request form for session file operations**: in-session file operations all go through `POST /api/v1/sessions/{session_id}/fs:{action}` with a JSON body. Actions are `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `git_status:batch` / `pull_request` / `pull_request:batch` / `diff` / `open` / `open-in` / `reveal`.
- **Execution environment**: actions run on the environment the session was created on. `open`, `open-in`, and `reveal` only work for sessions on the `local` environment; for a session on another environment they return `50001`.
- **Common error codes for session file operations**: every `fs:{action}` endpoint may return the following error codes, which are not repeated in each endpoint's error list. For `fs:search`, `40401` has a broader meaning; see [that endpoint](#post-api-v1-sessions-session-id-fs-search).
  - `40001`: body validation failure, or the action name after `fs:` is not supported
  - `40401`: session not found
  - `40420`: the session's environment not found
  - `40926`: the session's environment is unavailable or lacks a capability the action needs. All actions need the file system capability; `search`, `grep`, `git_status`, `pull_request`, `diff`, and their batch forms also need the process execution capability
  - `40930`: the session requires a newer server to read
- **Common error codes for workspace file operations**: the three endpoints under `/api/v1/workspace/fs:*` all return `40001` (body validation failure) and `40410` (workspace not found and not a usable absolute path). These two codes are not repeated in each endpoint's error list.

### Entry object

`fs:list`, `fs:list_many`, `fs:stat`, `fs:stat_many`, `fs:mkdir`, and `POST /api/v1/workspace/fs:list` all describe a file system path with an entry object:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | Entry path |
| `name` | string | Entry name |
| `kind` | string | `file` / `directory` / `symlink`. A symlink itself is `symlink`, regardless of its target type |
| `size` | integer | File size in bytes. Present only when `kind` is `file` |
| `modified_at` | string | Modification time, in ISO 8601 format |
| `etag` | string | The entry's ETag |
| `mime` | string | MIME type. Present only when `fs:stat` returns a file entry |
| `language_id` | string | Language identifier. Present only when `fs:stat` returns a file entry and the language can be detected from the file name |
| `is_directory` | boolean | Returned only by directory-listing endpoints: `true` when the entry is a symlink to a directory, omitted otherwise. A symlink whose target is outside the workspace counts as a directory only when the request sets `allow_external_symlinks: true` |

The entry object schema also declares `is_binary`, `is_symlink_to`, `git_status`, and `child_count`. The current implementation does not return these fields.

## Session file system

List directories, read files, search, query Git status, and open files on the host, all within the session workspace.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/fs:list` | List directory entries, optionally recursive |
| `POST /api/v1/sessions/{session_id}/fs:read` | Read a slice of a file as text or base64 |
| `POST /api/v1/sessions/{session_id}/fs:list_many` | List several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:stat` | Stat a single path |
| `POST /api/v1/sessions/{session_id}/fs:stat_many` | Stat several paths in one call |
| `POST /api/v1/sessions/{session_id}/fs:mkdir` | Create a directory |
| `POST /api/v1/sessions/{session_id}/fs:search` | Fuzzy-search files and directories by name |
| `POST /api/v1/sessions/{session_id}/fs:grep` | Search file contents |
| `POST /api/v1/sessions/{session_id}/fs:git_status` | Read Git status |
| `POST /api/v1/sessions/{session_id}/fs:git_status:batch` | Read Git status for several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:pull_request` | Read the pull request linked to a directory |
| `POST /api/v1/sessions/{session_id}/fs:pull_request:batch` | Read the pull requests linked to several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:diff` | Return the unified git diff of a single file |
| `POST /api/v1/sessions/{session_id}/fs:open` | Open a file with an editor or the default program (`local` environment only) |
| `POST /api/v1/sessions/{session_id}/fs:open-in` | Open a file or directory in a given application (`local` environment only) |
| `POST /api/v1/sessions/{session_id}/fs:reveal` | Reveal a file in the file manager (`local` environment only) |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Download a file (binary stream) |

### `POST /api/v1/sessions/{session_id}/fs:list`

Lists the entries of a directory in the session workspace, optionally recursing into subdirectories.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Directory to list, relative to the session work directory. Default `.` |
| `depth` | body | integer | Recursion depth, 1–10. Default `1` |
| `limit` | body | integer | Maximum number of entries in `items`, 1–1000. Default `200`. Subdirectory entries are not subject to this limit |
| `show_hidden` | body | boolean | Include dotfiles. Default `false` |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `exclude_globs` | body | string[] | Additional globs to skip |
| `allow_ignored_globs` | body | string[] | Globs to let through even when gitignored (e.g. `.tmp`). Ignored ancestor directories of a match are kept so the match stays reachable. Allowing dot-paths also requires `show_hidden: true` |
| `allow_external_symlinks` | body | boolean | When `true`, allows `path` to point outside the workspace through a symlink, and treats symlinked directories whose targets are outside the workspace as directories (marks `is_directory` and recurses into them). Default `false` |
| `sort` | body | string | `type_first` (default) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | Ignored by the current implementation; entries do not carry `git_status`. Default `false` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `items` | object[] | The first-level [entry objects](#entry-object) |
| `truncated` | boolean | `true` when `limit` cut `items` short, or when entries expanded through symlinked directories exceed 10000 |
| `children_by_path` | object | Present only when `depth` is greater than 1 and subdirectories were expanded. Keys are the expanded subdirectory paths; values are the entry lists of those directories |

- `40409`: path not found (including a `path` that is not a directory)
- `40411`: permission denied by the host filesystem
- `41303`: the session is on a remote environment and a directory has more than 50000 entries
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:read`

Reads a slice of a session file as text or base64.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File path, relative to the session work directory |
| `offset` | body | integer | Byte offset to start at. Default `0` |
| `length` | body | integer | Bytes to read, 1–10485760 (10 MiB). Default `1048576` (1 MiB) |
| `encoding` | body | string | `auto` (default) / `utf-8` / `base64` |
| `allow_external_symlinks` | body | boolean | When `true`, allows reading a file that points outside the workspace through a symlink. Default `false` |

With `encoding` set to `auto`, text comes back as `utf-8` (non-UTF-8 text is transcoded) and binary content as `base64`. With `encoding` set to `utf-8`, the server forces a text read and rejects binary files.

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | File path, relative to the session work directory |
| `content` | string | The content read |
| `encoding` | string | The encoding actually used: `utf-8` / `base64` |
| `size` | integer | Full file size in bytes |
| `truncated` | boolean | `true` when more content follows the range read |
| `etag` | string | The file's ETag |
| `mime` | string | MIME type |
| `language_id` | string | Language identifier. Present only when the content is returned as `utf-8` and the language can be detected from the file name |
| `line_count` | integer | Number of lines in the returned content. Present only when the content is returned as `utf-8` |
| `is_binary` | boolean | Whether the file is binary |

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `40906`: path is a directory
- `40907`: the file is binary but `encoding: "utf-8"` was requested
- `41302`: the file is larger than 10 MiB (judged by the full file size, regardless of `offset` and `length`)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:list_many`

Lists several session directories in one call. When a path fails, its error goes into the response and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `paths` | body | string[] | Required. Directories to list, 1–100 entries |

The remaining body fields `depth`, `limit`, `show_hidden`, `follow_gitignore`, `exclude_globs`, `sort`, and `include_git_status` have the same types, ranges, and defaults as in [`fs:list`](#post-api-v1-sessions-session-id-fs-list). When `depth` is greater than 1, the server still recurses, but the response contains only the first-level entries of each directory.

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `results` | object | A map from each successfully listed path to its first-level [entry objects](#entry-object) |
| `truncated_paths` | string[] | Paths whose listing hit `limit`. Omitted when there are none |
| `partial_errors` | object | A map from each failed path to its `{ code, msg }` error. Omitted when nothing failed |

- `41304`: a path escapes the session workspace (the whole request fails)

### `POST /api/v1/sessions/{session_id}/fs:stat`

Stats a single path in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. Path to stat, relative to the session work directory |

On success, `data` is the path's [entry object](#entry-object).

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:stat_many`

Stats several session paths in one call. A path that cannot be read reports `null` instead of failing the whole request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `paths` | body | string[] | Required. Paths to stat, 1–1000 entries |

On success, `data.entries` maps each requested path to its [entry object](#entry-object), or to `null` when the path cannot be read (including when it does not exist).

- `41304`: a path escapes the session workspace (the whole request fails)

### `POST /api/v1/sessions/{session_id}/fs:mkdir`

Creates a directory in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. Directory to create, relative to the session work directory |
| `recursive` | body | boolean | Create missing parent directories. Default `false` |

On success, `data` is the created directory's [entry object](#entry-object). With `recursive: true`, an existing directory also succeeds and returns that directory's entry object.

- `40409`: parent directory not found (non-recursive create), or a component of the path is not a directory
- `40411`: permission denied by the host filesystem
- `40919`: path already exists (with `recursive: true`, only when the existing path is not a directory)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:search`

Fuzzy-searches file and directory names in the session workspace. An empty `query` string lists the top-level entries instead.

The `{session_id}` slot also accepts a workspace reference (a [registered workspace](./server-api-service.md#workspaces) id or an absolute root path); the server then searches that workspace. This form is for draft sessions that have not been created yet. The first-class session-less endpoint is [`POST /api/v1/workspace/fs:search`](#post-api-v1-workspace-fs-search).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id, or a workspace reference |
| `query` | body | string | Required. Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `items[].path` | string | Hit path |
| `items[].name` | string | Hit name |
| `items[].kind` | string | `file` / `directory` / `symlink` |
| `items[].score` | number | Fuzzy-match score, between 0 and 1 |
| `items[].match_positions` | integer[] | Matched character offsets |
| `truncated` | boolean | `true` when hits beyond `limit` were dropped |

Hits are ordered by match quality first; at equal quality, ordinary hits come before ignored hits. When ignored hits are included, the server may run one supplemental scan.

- `40401`: the reference is neither a session nor a resolvable workspace (replaces the "session not found" meaning in the [common error codes](#common-rules))
- `40409`: `query` is empty and the workspace root does not exist
- `40411`: `query` is empty and the host filesystem denies reading the workspace root
- `41303`: the session is on a remote environment and a directory has more than 50000 entries

### `POST /api/v1/sessions/{session_id}/fs:grep`

Searches file contents in the session workspace. Matching is by literal string by default, and by regular expression with `regex: true`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `pattern` | body | string | Required. Text or regular expression to search for |
| `regex` | body | boolean | Treat `pattern` as a regular expression. Default `false` |
| `case_sensitive` | body | boolean | Match case. Default `true` |
| `include_globs` | body | string[] | Keep only files matching one of these globs |
| `exclude_globs` | body | string[] | Skip files matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `max_files` | body | integer | Maximum files to scan, 1–10000. Default `200` |
| `max_matches_per_file` | body | integer | Matches kept per file, 1–10000. Default `50` |
| `max_total_matches` | body | integer | Total matches kept, 1–100000. Default `5000` |
| `context_lines` | body | integer | Context lines carried with each match, 0–10. Default `2` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `files[].path` | string | File path |
| `files[].matches[].line` | integer | Line of the match |
| `files[].matches[].col` | integer | Column of the match |
| `files[].matches[].text` | string | Text of the matching line |
| `files[].matches[].before` | string[] | Context before the match, at most `context_lines` lines |
| `files[].matches[].after` | string[] | Context after the match, at most `context_lines` lines |
| `files_scanned` | integer | Number of files scanned |
| `truncated` | boolean | `true` when one of the match budgets cut the results short |
| `elapsed_ms` | integer | Elapsed time in milliseconds |

- `41305`: the search timed out

### `POST /api/v1/sessions/{session_id}/fs:git_status`

Reads Git status, optionally limited to a set of paths. With `root`, entry paths are relative to that directory. Without it, the whole Git worktree is queried and entry paths are relative to the repository root.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `root` | body | string | Workspace directory to limit the query to; a relative path resolves from the session work directory. Omit to query the whole Git worktree |
| `paths` | body | string[] | Limit the status to these paths. With `root`, relative paths resolve from that directory; otherwise from the session work directory |
| `include_pull_request` | body | boolean | Include the linked pull request. Default `true` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `branch` | string | Current branch name. Empty string in detached HEAD state |
| `ahead` | integer | Commits ahead of the upstream branch; `0` without an upstream branch |
| `behind` | integer | Commits behind the upstream branch; `0` without an upstream branch |
| `entries` | object | A map from each changed path to its status: `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted` |
| `additions` | integer | Lines added in the working tree relative to `HEAD` (staged and unstaged changes, excluding untracked files), limited by `root` and `paths`. `0` when there are no changes or the repository has no commits yet |
| `deletions` | integer | Lines deleted in the working tree relative to `HEAD`, counted the same way as `additions` |
| `pullRequest` | object \| null | The linked pull request, with the same shape and value rules as [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request). `null` with `include_pull_request: false` |

- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace, or, with `root`, a path in `paths` escapes that directory

### `POST /api/v1/sessions/{session_id}/fs:git_status:batch`

Reads Git status for several workspace directories in one call. When a directory fails, its error goes into `errors` and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `roots` | body | string[] | Required. Workspace directories to query, 1–32 entries |
| `include_pull_request` | body | boolean | Include the linked pull request in each result. Default `true` |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same status object as [`fs:git_status`](#post-api-v1-sessions-session-id-fs-git-status). `errors` maps each failed root to its `{ code, msg }` error, using the same error codes as the single-directory endpoint.

No error codes beyond the [common error codes](#common-rules).

### `POST /api/v1/sessions/{session_id}/fs:pull_request`

Reads the pull request linked to a given directory in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `root` | body | string | Workspace directory to query; a relative path resolves from the session work directory. Defaults to the session work directory |

On success, `data` is `{ number, state, url }`, where `state` is `open` / `merged` / `closed` / `draft`. `data` is `null` when no pull request is found.

The server queries the current branch's pull request with `gh` (the GitHub CLI) and caches the result per directory and branch for 60 seconds. It also returns `null` when the directory is not on any branch, `gh` is unavailable, or the query fails.

- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:pull_request:batch`

Reads the pull requests linked to several workspace directories in one call. When a directory fails, its error goes into `errors` and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `roots` | body | string[] | Required. Workspace directories to query, 1–32 entries |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same object as [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request), or `null`. `errors` maps each failed root to its `{ code, msg }` error.

No error codes beyond the [common error codes](#common-rules).

### `POST /api/v1/sessions/{session_id}/fs:diff`

Returns the unified git diff of a single file in a given directory of the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to diff, relative to `root` |
| `root` | body | string | Workspace directory to query; a relative path resolves from the session work directory. Defaults to the session work directory |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | File path, relative to `root` |
| `diff` | string | Unified diff text. An untracked file is output as a new file |
| `truncated` | boolean | `true` when the diff text exceeded 1048576 characters and was truncated to that length |

- `40409`: the file does not exist and has no corresponding change in Git
- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace, or `path` escapes `root`

### `POST /api/v1/sessions/{session_id}/fs:open`

Opens a session file on the host. `local` environment only.

When the server process has the environment variable `KIMI_CODE_EDITOR`, `VISUAL`, or `EDITOR` set, the server takes the first non-empty value in that order as the editor command and opens the file with it. When none is set, the file opens with the host operating system's default program.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to (positive integer). Takes effect only when the editor command is `code`, `cursor`, or `windsurf` |

On success, `data` is `{ opened: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the opener could not be started

### `POST /api/v1/sessions/{session_id}/fs:open-in`

Opens a session file or directory in a given host application. `local` environment only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `app_id` | body | string | Required. Target application: `finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | Required. File or directory to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to (positive integer). Takes effect only when `app_id` is `cursor` or `vscode` |

On success, `data` is `{ opened: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the application failed to launch

### `POST /api/v1/sessions/{session_id}/fs:reveal`

Reveals a session file in the host operating system's file manager. `local` environment only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to reveal, relative to the session work directory |

On success, `data` is `{ revealed: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the file manager could not be started

### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

Downloads a file from the session workspace. `{path}` is the file path relative to the session work directory, followed by the literal `:download` suffix. The response is a binary stream with Range and ETag support; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | path | string | Required. File path relative to the session work directory, plus the `:download` suffix |
| `allow_external_symlinks` | query | string | `true` / `false`. When `true`, allows downloading a file that points outside the workspace through a symlink. Default `false` |

- `40001`: the path is empty, the `:download` suffix is missing, or `allow_external_symlinks` is not `true` / `false`
- `40401`: session not found
- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `40420`: the session's environment not found
- `40906`: path is a directory
- `40926`: the session's environment is unavailable
- `40930`: the session requires a newer server to read
- `41304`: path escapes the session workspace

## Workspace file system

List directories, search files, and suggest `@` file-completion candidates directly in a given workspace, without a session. The workspace is given by the `workspace` field in the request body, not by the URL.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/workspace/fs:list` | Session-less workspace directory listing |
| `POST /api/v1/workspace/fs:search` | Session-less workspace search |
| `POST /api/v1/workspace/fs:suggest` | Session-less file-completion candidates (for `@` file mentions) |

### `POST /api/v1/workspace/fs:list`

The session-less form of [`fs:list`](#post-api-v1-sessions-session-id-fs-list).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](./server-api-service.md#workspaces) id, or an absolute root path (registered on the spot) |
| `path` | body | string | Directory to list, relative to the workspace root. Default `.` |
| `depth` | body | integer | Recursion depth, 1–10. Default `1` |
| `limit` | body | integer | Maximum number of entries in `items`, 1–1000. Default `200`. Subdirectory entries are not subject to this limit |
| `show_hidden` | body | boolean | Include dotfiles. Default `false` |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `exclude_globs` | body | string[] | Additional globs to skip |
| `allow_ignored_globs` | body | string[] | Globs to show even when gitignored |
| `allow_external_symlinks` | body | boolean | When `true`, allows `path` to point outside the workspace through a symlink, and treats symlinked directories whose targets are outside the workspace as directories (marks `is_directory` and recurses into them). Default `false` |
| `sort` | body | string | `type_first` (default) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |

On success, `data` has the same shape as for [`fs:list`](#post-api-v1-sessions-session-id-fs-list).

- `40409`: path not found or not a directory
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the workspace, including through a symlink when `allow_external_symlinks` is not enabled

### `POST /api/v1/workspace/fs:search`

The session-less form of [`fs:search`](#post-api-v1-sessions-session-id-fs-search).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](./server-api-service.md#workspaces) id, or an absolute root path (registered on the spot) |
| `query` | body | string | Required. Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |

On success, `data` is `{ items, truncated }`, with the same hit shape and ordering as [`fs:search`](#post-api-v1-sessions-session-id-fs-search).

- `40409`: `query` is empty and the workspace root does not exist
- `40411`: `query` is empty and the host filesystem denies reading the workspace root

### `POST /api/v1/workspace/fs:suggest`

Suggests file and directory completion candidates in a workspace without a session. This is the backend for `@` file mentions in the input box.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](./server-api-service.md#workspaces) id, or an absolute root path (registered on the spot) |
| `query` | body | string | Required. Partial path text to complete |
| `limit` | body | integer | Maximum candidates, 1–200. Default `50`; fd searches return at most `20` |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |
| `show_hidden` | body | boolean | Include dotfiles. Default `false`; fd searches always include them |
| `stream` | body | boolean | Return NDJSON preview / final events when `true`. Default `false` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |

On success, `data` is `{ items, truncated }`, where each item is `{ path, name, kind, score, match_positions }`, the same shape as a [`fs:search`](#post-api-v1-sessions-session-id-fs-search) hit. Candidates are ordered by match quality first; at equal quality, ordinary candidates come before ignored candidates.

When fd (a command-line file finder) is available, the server uses the same strategy as local `@` completion: hidden paths are always included, each root scans at most 100 entries per pass, and at most 20 items are returned. Matches beyond the scan cap may be missed. When ignored candidates are included, the server may run one supplemental `--no-ignore-vcs` scan. When fd is unavailable, the server falls back to the ripgrep / Node implementation.

With `stream: true`, the response is NDJSON (one JSON object per line) instead of a single JSON object. Each envelope's `data` contains `phase` (`preview` / `final` / `error`) and the same result fields as above. A preview carries ordinary fd candidates with `truncated: true`; the final result, sent after the ignored scan finishes, replaces the preview. Closing the connection cancels the search.

When an error occurs after the stream has started, the server writes one envelope line with `phase: "error"` and then ends the stream; the envelope `code` is still `0`. The error goes in `data.error` as `{ code, message }`: `code` is the server's internal string error identifier (such as `fs.path_not_found`), or the number `50001` for an unrecognized exception.

No error codes beyond the [common error codes](#common-rules).

## Host files

Access the file system of the machine running the server directly by absolute path, without a session or workspace. These endpoints serve cross-directory file completion and the folder picker. `fs:content` and `fs:mkdir` can also reach the file system of another registered environment through `environment_id`.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/fs:suggest` | File-completion candidates across one or more absolute root directories |
| `GET /api/v1/fs:browse` | List host directories (for the folder picker) |
| `GET /api/v1/fs:home` | The user's home directory and recent workspaces |
| `GET /api/v1/fs:content` | Read the raw bytes of any host file (gated only by the token; be careful when exposing the port) |
| `POST /api/v1/fs:mkdir` | Create a directory by absolute path |

### `POST /api/v1/fs:suggest`

Suggests file and directory completion candidates across one or more absolute root directories, without a session or workspace; nothing is registered. The first root is the primary root: candidates under it come back as relative paths, and candidates under the other roots as absolute paths. Overlapping roots are searched once.

The body takes `roots` in place of `workspace`. The remaining fields `query`, `limit`, `follow_gitignore`, `show_hidden`, `stream`, `include_globs`, and `exclude_globs` are the same as for [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `roots` | body | string[] | Required. 1–32 absolute directory paths; the first is the primary root |

The response, including the NDJSON form with `stream: true`, is the same as for [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest).

- `40001`: body validation failure, including a root that is not an absolute path
- `40409`: a root does not exist or is not a directory (`msg` names it)

### `GET /api/v1/fs:browse`

Lists the subdirectories of a host directory. This is the backend of the folder picker.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | Absolute directory path. Defaults to the user's home directory |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | The resolved directory |
| `parent` | string \| null | Parent directory; `null` at the filesystem root |
| `entries[].name` | string | Subdirectory name |
| `entries[].path` | string | Subdirectory path |
| `entries[].is_dir` | boolean | Always `true` |

- `40001`: `path` is not absolute
- `40409`: path not found or not a directory
- `40411`: permission denied

### `GET /api/v1/fs:home`

Returns the folder picker's landing data. No parameters.

On success, `data` is `{ home, recent_roots }`: `home` is the user's home directory, and `recent_roots` lists the roots of registered workspaces, at most 8.

### `GET /api/v1/fs:content`

Streams the raw bytes of any file on the host filesystem; with `environment_id`, reads that environment's file system instead. This endpoint is gated only by the API token (see [Authentication](./server-api.md#authentication)), so be careful when exposing the port. The response supports Range requests and ETag caching; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | Required. Absolute file path |
| `environment_id` | query | string | Id of the environment to read, available from [`GET /api/v1/sessions/{session_id}/environments`](./server-api-sessions.md#get-api-v1-sessions-session-id-environments). Default `local` (the machine running the server) |

- `40001`: `path` is missing or not absolute, or the path is neither a regular file nor a directory (such as a device file or socket)
- `40409`: path not found
- `40411`: permission denied
- `40420`: the environment given by `environment_id` not found
- `40906`: path is a directory
- `40926`: the environment given by `environment_id` is unavailable or does not provide the file system capability

### `POST /api/v1/fs:mkdir`

Creates one directory on the host filesystem by absolute path. This is the backend of the folder picker's "New folder" action; with `environment_id`, it creates the directory on that environment's file system instead. Non-recursive: the parent directory must already exist.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | body | string | Required. Absolute directory path |
| `environment_id` | body | string | Target environment id, available from [`GET /api/v1/sessions/{session_id}/environments`](./server-api-sessions.md#get-api-v1-sessions-session-id-environments). Default `local` (the machine running the server) |

On success, `data` is `{ path }`.

- `40001`: `path` is not absolute
- `40409`: parent path not found, or a component of the path is not a directory
- `40411`: permission denied
- `40420`: the environment given by `environment_id` not found
- `40919`: path already exists
- `40926`: the environment given by `environment_id` is unavailable or does not provide the file system capability

## Binary and streaming endpoints

The following endpoints return binary streams instead of a JSON payload. Their HTTP capabilities differ per endpoint:

| Method and path | Description | Range (206) | ETag / 304 |
| --- | --- | --- | --- |
| [`GET /api/v1/files/{file_id}`](./server-api-service.md#file-uploads) | Download an uploaded file | Yes | No (sends an `etag` header but ignores `If-None-Match`) |
| [`GET /api/v1/sessions/{session_id}/fs/{path}:download`](#get-api-v1-sessions-session-id-fs-path-download) | Download a session workspace file | Yes | Yes |
| [`GET /api/v1/fs:content`](#get-api-v1-fs-content) | Read any host file (gated only by the token; be careful when exposing the port) | Yes | Yes |
| [`POST /api/v1/sessions/{session_id}/export`](./server-api-sessions.md#post-api-v1-sessions-session-id-export) | Export the session with diagnostics (zip stream) | No | No |

Error semantics differ as well. `GET /api/v1/files/{file_id}`, `GET /api/v1/fs:content`, and session `:download` answer failures with real 4xx / 500 status codes, and the body is still the standard [response envelope](./server-api.md#response-envelope). Session export still reports errors in an HTTP 200 envelope. Ordinary JSON RPC endpoints keep the almost-always-200 convention, so clients must still check the envelope `code`.
