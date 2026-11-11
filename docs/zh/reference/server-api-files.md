# 文件接口

本页列出服务端的文件接口：会话文件系统、工作区文件系统、本机文件接口，以及返回二进制流的端点各自的 HTTP 行为。[鉴权](./server-api.md#鉴权)、[响应信封](./server-api.md#响应信封) 和 [错误码](./server-api.md#错误码) 等通用约定见 [服务 API](./server-api.md)，会话本身的接口见 [会话接口](./server-api-sessions.md)。

::: danger 警告
`GET /api/v1/fs:content` 能读取本机任意文件的原始字节，只受 API token 保护。把服务端口暴露到本机以外时务必谨慎。
:::

## 共同规则

以下约定适用于本页的多个接口，各接口下不再重复。

- **会话文件操作的请求形式**：会话内的文件操作统一走 `POST /api/v1/sessions/{session_id}/fs:{action}`，请求体为 JSON。动作包括 `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `git_status:batch` / `pull_request` / `pull_request:batch` / `diff` / `open` / `open-in` / `reveal`。
- **执行环境**：动作在会话创建时所在的环境上执行。`open`、`open-in` 与 `reveal` 仅对 `local` 环境上的会话可用，会话在其他环境上时返回 `50001`。
- **会话文件操作的共同错误码**：每个 `fs:{action}` 接口都可能返回以下错误码，各接口的错误码列表不再列出。`fs:search` 的 `40401` 含义更宽，见 [该接口](#post-api-v1-sessions-session-id-fs-search)。
  - `40001`：请求体校验失败，或 `fs:` 后的动作名不受支持
  - `40401`：会话不存在
  - `40420`：会话所在的环境不存在
  - `40926`：会话所在的环境不可用，或不具备动作需要的能力。所有动作都需要文件系统能力，`search`、`grep`、`git_status`、`pull_request`、`diff` 及其批量形式还需要执行进程的能力
  - `40930`：会话需要更新版本的服务端才能读取
- **工作区文件操作的共同错误码**：`/api/v1/workspace/fs:*` 下的三个接口都会返回 `40001`（请求体校验失败）和 `40410`（工作区不存在，且不是可用的绝对路径），各接口的错误码列表不再列出这两项。

### 条目对象

`fs:list`、`fs:list_many`、`fs:stat`、`fs:stat_many`、`fs:mkdir` 和 `POST /api/v1/workspace/fs:list` 都用条目对象描述一个文件系统路径：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 条目路径 |
| `name` | string | 条目名称 |
| `kind` | string | `file` / `directory` / `symlink`。软链接本身为 `symlink`，不按目标类型判断 |
| `size` | integer | 文件大小（字节），仅 `kind` 为 `file` 时存在 |
| `modified_at` | string | 修改时间，ISO 8601 格式 |
| `etag` | string | 条目的 ETag |
| `mime` | string | MIME 类型，仅 `fs:stat` 返回文件条目时存在 |
| `language_id` | string | 语言标识，仅 `fs:stat` 返回文件条目、且能从文件名识别语言时存在 |
| `is_directory` | boolean | 仅列目录的接口返回：条目是指向目录的软链接时为 `true`，否则省略。目标在工作区外的软链接，只有请求中 `allow_external_symlinks: true` 时才算指向目录 |

条目对象的 schema 还声明了 `is_binary`、`is_symlink_to`、`git_status` 和 `child_count`，当前实现不会返回这些字段。

## 会话文件系统

在会话的工作区内列目录、读文件、搜索、查询 Git 状态，以及在宿主机上打开文件。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/fs:list` | 列出目录条目，可递归 |
| `POST /api/v1/sessions/{session_id}/fs:read` | 以文本或 base64 读取文件的一段内容 |
| `POST /api/v1/sessions/{session_id}/fs:list_many` | 一次列出多个目录 |
| `POST /api/v1/sessions/{session_id}/fs:stat` | 查询单个路径的元信息 |
| `POST /api/v1/sessions/{session_id}/fs:stat_many` | 一次查询多个路径的元信息 |
| `POST /api/v1/sessions/{session_id}/fs:mkdir` | 创建目录 |
| `POST /api/v1/sessions/{session_id}/fs:search` | 按名称模糊搜索文件和目录 |
| `POST /api/v1/sessions/{session_id}/fs:grep` | 搜索文件内容 |
| `POST /api/v1/sessions/{session_id}/fs:git_status` | 读取 Git 状态 |
| `POST /api/v1/sessions/{session_id}/fs:git_status:batch` | 一次读取多个目录的 Git 状态 |
| `POST /api/v1/sessions/{session_id}/fs:pull_request` | 读取目录关联的 Pull Request |
| `POST /api/v1/sessions/{session_id}/fs:pull_request:batch` | 一次读取多个目录关联的 Pull Request |
| `POST /api/v1/sessions/{session_id}/fs:diff` | 返回单个文件的 unified git diff |
| `POST /api/v1/sessions/{session_id}/fs:open` | 用编辑器或默认程序打开文件（仅限 `local` 环境） |
| `POST /api/v1/sessions/{session_id}/fs:open-in` | 在指定应用中打开文件或目录（仅限 `local` 环境） |
| `POST /api/v1/sessions/{session_id}/fs:reveal` | 在文件管理器中显示文件（仅限 `local` 环境） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载文件（二进制流） |

### `POST /api/v1/sessions/{session_id}/fs:list`

列出会话工作区中某个目录下的条目，可选递归子目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 要列出的目录，相对于会话工作目录。默认 `.` |
| `depth` | body | integer | 递归深度，1–10。默认 `1` |
| `limit` | body | integer | `items` 的最大条目数，1–1000。默认 `200`。子目录的条目不受此限制 |
| `show_hidden` | body | boolean | 是否包含点文件。默认 `false` |
| `follow_gitignore` | body | boolean | 是否跳过 gitignore 的路径。默认 `true` |
| `exclude_globs` | body | string[] | 额外要跳过的 glob |
| `allow_ignored_globs` | body | string[] | 即使被 gitignore 也放行的 glob（如 `.tmp`）。命中项被忽略的祖先目录会自动保留，保证命中项可达。放行以点开头的路径时，还需同时传 `show_hidden: true` |
| `allow_external_symlinks` | body | boolean | 为 `true` 时，允许 `path` 经软链接指向工作区外，并把目标在工作区外的软链接目录当作目录处理（标记 `is_directory` 并递归进入）。默认 `false` |
| `sort` | body | string | `type_first`（默认）/ `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | 当前实现忽略该字段，条目不会带 `git_status`。默认 `false` |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | object[] | 第一层的 [条目对象](#条目对象) 列表 |
| `truncated` | boolean | 为 `true` 时表示 `items` 被 `limit` 截断，或经软链接目录展开的条目超过 10000 条 |
| `children_by_path` | object | 仅 `depth` 大于 1 且展开了子目录时存在。键为展开的子目录路径，值为该目录下的条目列表 |

- `40409`：路径不存在（包括 `path` 不是目录的情况）
- `40411`：宿主文件系统拒绝访问
- `41303`：会话位于远程环境，且某个目录的条目超过 50000 个
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:read`

以文本或 base64 读取会话文件的一段内容。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。文件路径，相对于会话工作目录 |
| `offset` | body | integer | 起始字节偏移。默认 `0` |
| `length` | body | integer | 读取字节数，1–10485760（10 MiB）。默认 `1048576`（1 MiB） |
| `encoding` | body | string | `auto`（默认）/ `utf-8` / `base64` |
| `allow_external_symlinks` | body | boolean | 为 `true` 时，允许读取经软链接指向工作区外的文件。默认 `false` |

`encoding` 为 `auto` 时，文本以 `utf-8` 返回（非 UTF-8 文本会被转码），二进制内容以 `base64` 返回。`encoding` 为 `utf-8` 时，服务端强制按文本读取，并拒绝二进制文件。

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 文件路径，相对于会话工作目录 |
| `content` | string | 读取到的内容 |
| `encoding` | string | 实际使用的编码：`utf-8` / `base64` |
| `size` | integer | 文件的完整大小（字节） |
| `truncated` | boolean | 为 `true` 时表示本次读取的范围之后还有内容 |
| `etag` | string | 文件的 ETag |
| `mime` | string | MIME 类型 |
| `language_id` | string | 语言标识，仅以 `utf-8` 返回、且能从文件名识别语言时存在 |
| `line_count` | integer | 返回内容的行数，仅以 `utf-8` 返回时存在 |
| `is_binary` | boolean | 是否为二进制文件 |

- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `40906`：路径是目录
- `40907`：文件是二进制文件，但指定了 `encoding: "utf-8"`
- `41302`：文件大于 10 MiB（按文件完整大小判断，与 `offset`、`length` 无关）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:list_many`

一次列出多个会话目录。某个路径失败时，错误放进响应里，整个请求仍然成功。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `paths` | body | string[] | 必填。要列出的目录，1–100 条 |

其余请求体字段 `depth`、`limit`、`show_hidden`、`follow_gitignore`、`exclude_globs`、`sort`、`include_git_status` 的类型、取值范围与默认值同 [`fs:list`](#post-api-v1-sessions-session-id-fs-list)。`depth` 大于 1 时服务端仍会递归遍历，但响应只包含每个目录的第一层条目。

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `results` | object | 每个成功列出的路径到其第一层 [条目对象](#条目对象) 列表的映射 |
| `truncated_paths` | string[] | 达到 `limit` 的路径。没有时省略 |
| `partial_errors` | object | 失败路径到其错误 `{ code, msg }` 的映射。没有失败时省略 |

- `41304`：某个路径越出会话工作区（整个请求失败）

### `POST /api/v1/sessions/{session_id}/fs:stat`

查询会话工作区内单个路径的元信息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。要查询的路径，相对于会话工作目录 |

成功时 `data` 为该路径的 [条目对象](#条目对象)。

- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:stat_many`

一次查询多个会话路径的元信息。无法读取的路径返回 `null`，不会让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `paths` | body | string[] | 必填。要查询的路径，1–1000 条 |

成功时 `data.entries` 把每个请求路径映射到其 [条目对象](#条目对象)，路径无法读取（包括不存在）时为 `null`。

- `41304`：某个路径越出会话工作区（整个请求失败）

### `POST /api/v1/sessions/{session_id}/fs:mkdir`

在会话工作区内创建目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。要创建的目录，相对于会话工作目录 |
| `recursive` | body | boolean | 是否创建缺失的父目录。默认 `false` |

成功时 `data` 为新建目录的 [条目对象](#条目对象)。`recursive: true` 且目录已存在时，同样成功并返回该目录的条目对象。

- `40409`：父目录不存在（非递归创建），或路径中某一级不是目录
- `40411`：宿主文件系统拒绝访问
- `40919`：路径已存在（`recursive: true` 时，仅当已存在的不是目录）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:search`

在会话工作区内按名称模糊搜索文件和目录。`query` 为空字符串时，改为列出顶层条目。

`{session_id}` 位置也可以传工作区引用（[已注册工作区](./server-api-service.md#工作区) 的 id 或绝对根路径），此时服务端在该工作区上搜索。这一形式供尚未创建的草稿会话使用；正式的无会话接口是 [`POST /api/v1/workspace/fs:search`](#post-api-v1-workspace-fs-search)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id，或工作区引用 |
| `query` | body | string | 必填。搜索文本；传 `""` 时列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配其中任一 glob 的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 的路径。默认 `false` |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items[].path` | string | 命中路径 |
| `items[].name` | string | 命中名称 |
| `items[].kind` | string | `file` / `directory` / `symlink` |
| `items[].score` | number | 模糊匹配得分，0 到 1 之间 |
| `items[].match_positions` | integer[] | 匹配到的字符偏移 |
| `truncated` | boolean | 为 `true` 时表示超出 `limit` 的命中被丢弃 |

命中优先按匹配质量排序；匹配质量相同时，普通命中排在忽略命中之前。包含忽略命中时，服务端可能执行一次补充扫描。

- `40401`：该引用既不是会话，也不是可解析的工作区（取代 [共同错误码](#共同规则) 中「会话不存在」的含义）
- `40409`：`query` 为空，且工作区根目录不存在
- `40411`：`query` 为空，且宿主文件系统拒绝读取工作区根目录
- `41303`：会话位于远程环境，且某个目录的条目超过 50000 个

### `POST /api/v1/sessions/{session_id}/fs:grep`

在会话工作区内搜索文件内容。默认按字面字符串匹配，`regex: true` 时按正则表达式匹配。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `pattern` | body | string | 必填。要搜索的文本或正则表达式 |
| `regex` | body | boolean | 是否把 `pattern` 视为正则表达式。默认 `false` |
| `case_sensitive` | body | boolean | 是否区分大小写。默认 `true` |
| `include_globs` | body | string[] | 只保留匹配其中任一 glob 的文件 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的文件 |
| `follow_gitignore` | body | boolean | 是否跳过 gitignore 的路径。默认 `true` |
| `max_files` | body | integer | 最多扫描的文件数，1–10000。默认 `200` |
| `max_matches_per_file` | body | integer | 每个文件保留的匹配数，1–10000。默认 `50` |
| `max_total_matches` | body | integer | 总共保留的匹配数，1–100000。默认 `5000` |
| `context_lines` | body | integer | 每个匹配携带的上下文行数，0–10。默认 `2` |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `files[].path` | string | 文件路径 |
| `files[].matches[].line` | integer | 匹配所在行 |
| `files[].matches[].col` | integer | 匹配所在列 |
| `files[].matches[].text` | string | 匹配行的文本 |
| `files[].matches[].before` | string[] | 匹配之前的上下文，最多 `context_lines` 行 |
| `files[].matches[].after` | string[] | 匹配之后的上下文，最多 `context_lines` 行 |
| `files_scanned` | integer | 已扫描的文件数 |
| `truncated` | boolean | 为 `true` 时表示某个匹配配额截断了结果 |
| `elapsed_ms` | integer | 耗时（毫秒） |

- `41305`：搜索超时

### `POST /api/v1/sessions/{session_id}/fs:git_status`

读取 Git 状态，可选限定在一组路径内。提供 `root` 时，返回条目的路径相对于该目录；省略时查询整个 Git worktree，条目路径相对于仓库根目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `root` | body | string | 要限定查询范围的工作区目录，相对路径从会话工作目录解析。省略时查询整个 Git worktree |
| `paths` | body | string[] | 把状态限定在这些路径。提供 `root` 时，相对路径从该目录解析；否则从会话工作目录解析 |
| `include_pull_request` | body | boolean | 是否包含关联的 Pull Request。默认 `true` |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `branch` | string | 当前分支名。处于 detached HEAD 状态时为空字符串 |
| `ahead` | integer | 相对上游分支领先的提交数，没有上游分支时为 `0` |
| `behind` | integer | 相对上游分支落后的提交数，没有上游分支时为 `0` |
| `entries` | object | 每个变更路径到其状态的映射，状态为 `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted` |
| `additions` | integer | 工作树相对 `HEAD` 新增的行数（含已暂存和未暂存的改动，不含未跟踪文件），按 `root` 和 `paths` 限定范围。没有改动或仓库还没有提交时为 `0` |
| `deletions` | integer | 工作树相对 `HEAD` 删除的行数，统计方式同 `additions` |
| `pullRequest` | object \| null | 关联的 Pull Request，结构与取值规则同 [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request)。`include_pull_request: false` 时为 `null` |

- `40908`：git 不可用（不是仓库，或没有 git 可执行文件），或 `root` 不存在、不是目录
- `41304`：路径越出会话工作区，或提供 `root` 时 `paths` 中的路径越出该目录

### `POST /api/v1/sessions/{session_id}/fs:git_status:batch`

一次读取多个工作区目录的 Git 状态。某个目录失败时，错误放进 `errors`，整个请求仍然成功。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `roots` | body | string[] | 必填。要查询的工作区目录，1–32 条 |
| `include_pull_request` | body | boolean | 是否在每项结果中包含关联的 Pull Request。默认 `true` |

成功时 `data` 为 `{ results, errors }`。`results` 把每个成功的 root 映射到与 [`fs:git_status`](#post-api-v1-sessions-session-id-fs-git-status) 相同的状态对象；`errors` 把每个失败的 root 映射到其错误 `{ code, msg }`，错误码与单目录接口一致。

除 [共同错误码](#共同规则) 外没有其他错误码。

### `POST /api/v1/sessions/{session_id}/fs:pull_request`

读取会话工作区中指定目录关联的 Pull Request。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `root` | body | string | 要查询的工作区目录，相对路径从会话工作目录解析。默认为会话工作目录 |

成功时 `data` 为 `{ number, state, url }`，`state` 为 `open` / `merged` / `closed` / `draft`；未找到 Pull Request 时为 `null`。

服务端用 `gh`（GitHub 的命令行工具）查询当前分支的 Pull Request，结果按目录和分支缓存 60 秒。当前不在任何分支上、`gh` 不可用或查询失败时，同样返回 `null`。

- `40908`：git 不可用（不是仓库，或没有 git 可执行文件），或 `root` 不存在、不是目录
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:pull_request:batch`

一次读取多个工作区目录关联的 Pull Request。某个目录失败时，错误放进 `errors`，整个请求仍然成功。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `roots` | body | string[] | 必填。要查询的工作区目录，1–32 条 |

成功时 `data` 为 `{ results, errors }`。`results` 把每个成功的 root 映射到与 [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request) 相同的对象或 `null`；`errors` 把每个失败的 root 映射到其错误 `{ code, msg }`。

除 [共同错误码](#共同规则) 外没有其他错误码。

### `POST /api/v1/sessions/{session_id}/fs:diff`

返回会话工作区中指定目录内单个文件的 unified git diff。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。要 diff 的文件，相对于 `root` |
| `root` | body | string | 要查询的工作区目录，相对路径从会话工作目录解析。默认为会话工作目录 |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 文件路径，相对于 `root` |
| `diff` | string | unified diff 文本。未跟踪的文件按新增文件输出 |
| `truncated` | boolean | 为 `true` 时表示 diff 文本超过 1048576 个字符，已截断到该长度 |

- `40409`：文件不存在，且在 Git 中没有对应改动
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件），或 `root` 不存在、不是目录
- `41304`：路径越出会话工作区，或 `path` 越出 `root`

### `POST /api/v1/sessions/{session_id}/fs:open`

在宿主机上打开会话文件。仅限 `local` 环境。

服务端进程设置了环境变量 `KIMI_CODE_EDITOR`、`VISUAL` 或 `EDITOR` 时，按此顺序取第一个非空值作为编辑器命令打开文件；都未设置时，用宿主操作系统的默认程序打开。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。要打开的文件，相对于会话工作目录 |
| `line` | body | integer | 要跳转到的行号（正整数）。仅当编辑器命令是 `code`、`cursor` 或 `windsurf` 时生效 |

成功时 `data` 为 `{ opened: true }`。

- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `41304`：路径越出会话工作区
- `50001`：会话不在 `local` 环境上，或无法启动打开程序

### `POST /api/v1/sessions/{session_id}/fs:open-in`

在指定的宿主应用程序中打开会话文件或目录。仅限 `local` 环境。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `app_id` | body | string | 必填。目标应用：`finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | 必填。要打开的文件或目录，相对于会话工作目录 |
| `line` | body | integer | 要跳转到的行号（正整数）。仅 `app_id` 为 `cursor` 或 `vscode` 时生效 |

成功时 `data` 为 `{ opened: true }`。

- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `41304`：路径越出会话工作区
- `50001`：会话不在 `local` 环境上，或应用启动失败

### `POST /api/v1/sessions/{session_id}/fs:reveal`

在宿主操作系统的文件管理器中显示会话文件。仅限 `local` 环境。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | body | string | 必填。要显示的文件，相对于会话工作目录 |

成功时 `data` 为 `{ revealed: true }`。

- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `41304`：路径越出会话工作区
- `50001`：会话不在 `local` 环境上，或无法启动文件管理器

### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

从会话工作区下载文件。`{path}` 是相对于会话工作目录的文件路径，后接字面量 `:download` 后缀。响应是支持 Range 与 ETag 的二进制流，见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `path` | path | string | 必填。相对于会话工作目录的文件路径，加 `:download` 后缀 |
| `allow_external_symlinks` | query | string | `true` / `false`。为 `true` 时允许下载经软链接指向工作区外的文件。默认 `false` |

- `40001`：路径为空、缺少 `:download` 后缀，或 `allow_external_symlinks` 不是 `true` / `false`
- `40401`：会话不存在
- `40409`：路径不存在
- `40411`：宿主文件系统拒绝访问
- `40420`：会话所在的环境不存在
- `40906`：路径是目录
- `40926`：会话所在的环境不可用
- `40930`：会话需要更新版本的服务端才能读取
- `41304`：路径越出会话工作区

## 工作区文件系统

不需要会话，直接在指定工作区内列目录、搜索文件和给出 `@` 文件补全候选。工作区由请求体的 `workspace` 字段指定，而不是由 URL 携带。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/workspace/fs:list` | 无会话的工作区目录列举 |
| `POST /api/v1/workspace/fs:search` | 无会话的工作区搜索 |
| `POST /api/v1/workspace/fs:suggest` | 无会话的文件补全候选（用于 `@` 文件提及） |

### `POST /api/v1/workspace/fs:list`

[`fs:list`](#post-api-v1-sessions-session-id-fs-list) 的无会话形式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | 必填。[已注册工作区](./server-api-service.md#工作区) 的 id，或绝对根路径（当场注册） |
| `path` | body | string | 要列出的目录，相对于工作区根目录。默认 `.` |
| `depth` | body | integer | 递归深度，1–10。默认 `1` |
| `limit` | body | integer | `items` 的最大条目数，1–1000。默认 `200`。子目录的条目不受此限制 |
| `show_hidden` | body | boolean | 是否包含点文件。默认 `false` |
| `follow_gitignore` | body | boolean | 是否跳过 gitignore 的路径。默认 `true` |
| `exclude_globs` | body | string[] | 额外要跳过的 glob |
| `allow_ignored_globs` | body | string[] | 即使被 gitignore 也要显示的 glob |
| `allow_external_symlinks` | body | boolean | 为 `true` 时，允许 `path` 经软链接指向工作区外，并把目标在工作区外的软链接目录当作目录处理（标记 `is_directory` 并递归进入）。默认 `false` |
| `sort` | body | string | `type_first`（默认）/ `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |

成功时 `data` 的结构与 [`fs:list`](#post-api-v1-sessions-session-id-fs-list) 相同。

- `40409`：路径不存在或不是目录
- `40411`：宿主文件系统拒绝访问
- `41304`：路径越出工作区，包括经软链接越出且未启用 `allow_external_symlinks`

### `POST /api/v1/workspace/fs:search`

[`fs:search`](#post-api-v1-sessions-session-id-fs-search) 的无会话形式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | 必填。[已注册工作区](./server-api-service.md#工作区) 的 id，或绝对根路径（当场注册） |
| `query` | body | string | 必填。搜索文本；传 `""` 时列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配其中任一 glob 的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 的路径。默认 `false` |

成功时 `data` 为 `{ items, truncated }`，命中结构与排序同 [`fs:search`](#post-api-v1-sessions-session-id-fs-search)。

- `40409`：`query` 为空，且工作区根目录不存在
- `40411`：`query` 为空，且宿主文件系统拒绝读取工作区根目录

### `POST /api/v1/workspace/fs:suggest`

在没有会话时给出工作区内的文件和目录补全候选，是输入框中 `@` 文件提及的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | 必填。[已注册工作区](./server-api-service.md#工作区) 的 id，或绝对根路径（当场注册） |
| `query` | body | string | 必填。要补全的部分路径文本 |
| `limit` | body | integer | 最大候选数，1–200。默认 `50`；fd 搜索最多返回 `20` 条 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 的路径。默认 `false` |
| `show_hidden` | body | boolean | 是否包含点文件。默认 `false`；fd 搜索始终包含 |
| `stream` | body | boolean | 为 `true` 时以 NDJSON 返回 preview / final 事件。默认 `false` |
| `include_globs` | body | string[] | 只保留匹配其中任一 glob 的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |

成功时 `data` 为 `{ items, truncated }`，每项为 `{ path, name, kind, score, match_positions }`，结构同 [`fs:search`](#post-api-v1-sessions-session-id-fs-search) 的命中项。候选优先按匹配质量排序；匹配质量相同时，普通候选排在忽略候选之前。

fd（一个文件查找命令行工具）可用时，服务端采用与本地 `@` 补全相同的策略：始终包含隐藏路径，每个 root 每轮最多扫描 100 条，最多返回 20 条。超出扫描上限的匹配可能遗漏。包含忽略候选时，可能执行一次 `--no-ignore-vcs` 补充扫描。fd 不可用时，回退到 ripgrep / Node 实现。

`stream: true` 时，响应改为 NDJSON（每行一个 JSON 对象），而不是单个 JSON 对象。每个响应包的 `data` 包含 `phase`（`preview` / `final` / `error`）以及与上面相同的结果字段。preview 携带普通 fd 候选，且 `truncated: true`；忽略扫描完成后的 final 用于替换 preview。关闭连接会取消搜索。

流开始后出错时，服务端写入一行 `phase: "error"` 的响应包后结束，信封的 `code` 仍为 `0`。错误放在 `data.error` 中，为 `{ code, message }`：`code` 是服务端内部的字符串错误标识（如 `fs.path_not_found`），无法识别的异常为数字 `50001`。

除 [共同错误码](#共同规则) 外没有其他错误码。

## 本机文件

不需要会话或工作区，直接按绝对路径访问服务端所在机器的文件系统，用于跨目录的文件补全和文件夹选择器。`fs:content` 和 `fs:mkdir` 还可以通过 `environment_id` 访问其他已注册环境的文件系统。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/fs:suggest` | 跨一个或多个绝对路径根目录的文件补全候选 |
| `GET /api/v1/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/v1/fs:home` | 用户主目录与最近工作区 |
| `GET /api/v1/fs:content` | 读取本机任意文件的原始字节（仅受 token 保护，谨慎暴露端口） |
| `POST /api/v1/fs:mkdir` | 按绝对路径创建目录 |

### `POST /api/v1/fs:suggest`

在一个或多个绝对路径根目录中给出文件和目录补全候选，不需要会话或工作区，也不会登记任何东西。第一个根目录是主根：主根下的候选以相对路径返回，其他根目录下的候选以绝对路径返回。互相重叠的根目录只搜索一次。

请求体用 `roots` 代替 `workspace`，其余字段 `query`、`limit`、`follow_gitignore`、`show_hidden`、`stream`、`include_globs`、`exclude_globs` 与 [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest) 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `roots` | body | string[] | 必填。1–32 个绝对目录路径，第一个是主根 |

响应（包括 `stream: true` 时的 NDJSON 形式）与 [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest) 相同。

- `40001`：请求体校验失败，包括根目录不是绝对路径
- `40409`：根目录不存在或不是目录（`msg` 中写明是哪一个）

### `GET /api/v1/fs:browse`

列出某个本机目录的子目录，是文件夹选择器的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | 绝对目录路径。默认为用户主目录 |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 解析后的目录 |
| `parent` | string \| null | 父目录，位于文件系统根时为 `null` |
| `entries[].name` | string | 子目录名称 |
| `entries[].path` | string | 子目录路径 |
| `entries[].is_dir` | boolean | 恒为 `true` |

- `40001`：`path` 不是绝对路径
- `40409`：路径不存在或不是目录
- `40411`：权限不足

### `GET /api/v1/fs:home`

返回文件夹选择器的落地数据。无参数。

成功时 `data` 为 `{ home, recent_roots }`：`home` 是用户主目录，`recent_roots` 列出已注册工作区的根目录，最多 8 个。

### `GET /api/v1/fs:content`

以流式返回本机文件系统上任意文件的原始字节；传 `environment_id` 时改为读取该环境的文件系统。这个接口只受 API token（见 [鉴权](./server-api.md#鉴权)）保护，暴露端口时务必谨慎。响应支持 Range 请求与 ETag 缓存，见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | 必填。绝对文件路径 |
| `environment_id` | query | string | 要读取的环境 id，可从 [`GET /api/v1/sessions/{session_id}/environments`](./server-api-sessions.md#get-api-v1-sessions-session-id-environments) 获取。默认 `local`（服务端所在机器） |

- `40001`：`path` 缺失或不是绝对路径，或路径既不是普通文件也不是目录（如设备文件、套接字）
- `40409`：路径不存在
- `40411`：权限不足
- `40420`：`environment_id` 指定的环境不存在
- `40906`：路径是目录
- `40926`：`environment_id` 指定的环境不可用，或不提供文件系统能力

### `POST /api/v1/fs:mkdir`

按绝对路径在本机文件系统上创建一个目录，是文件夹选择器「新建文件夹」的后端；传 `environment_id` 时改为在该环境的文件系统上创建。不递归创建，父目录必须已存在。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | body | string | 必填。绝对目录路径 |
| `environment_id` | body | string | 目标环境 id，可从 [`GET /api/v1/sessions/{session_id}/environments`](./server-api-sessions.md#get-api-v1-sessions-session-id-environments) 获取。默认 `local`（服务端所在机器） |

成功时 `data` 为 `{ path }`。

- `40001`：`path` 不是绝对路径
- `40409`：父路径不存在，或路径中某一级不是目录
- `40411`：权限不足
- `40420`：`environment_id` 指定的环境不存在
- `40919`：路径已存在
- `40926`：`environment_id` 指定的环境不可用，或不提供文件系统能力

## 二进制与流式端点

以下端点返回二进制流，而不是 JSON 载荷。各端点支持的 HTTP 能力不同：

| 方法与路径 | 说明 | Range 分段（206） | ETag / 304 |
| --- | --- | --- | --- |
| [`GET /api/v1/files/{file_id}`](./server-api-service.md#文件上传) | 下载已上传文件 | 支持 | 不支持（会发送 `etag` 头，但不处理 `If-None-Match`） |
| [`GET /api/v1/sessions/{session_id}/fs/{path}:download`](#get-api-v1-sessions-session-id-fs-path-download) | 下载会话工作区文件 | 支持 | 支持 |
| [`GET /api/v1/fs:content`](#get-api-v1-fs-content) | 读取本机任意文件（仅受 token 保护，谨慎暴露端口） | 支持 | 支持 |
| [`POST /api/v1/sessions/{session_id}/export`](./server-api-sessions.md#post-api-v1-sessions-session-id-export) | 导出会话与诊断信息（zip 流） | 不支持 | 不支持 |

错误语义也不同。`GET /api/v1/files/{file_id}`、`GET /api/v1/fs:content` 与会话 `:download` 失败时返回真实的 4xx / 500 状态码，响应体仍是标准 [响应信封](./server-api.md#响应信封)。会话导出仍以 HTTP 200 返回错误信封。普通 JSON RPC 端点继续保持几乎总是 200 的约定，客户端仍需检查信封中的 `code`。
