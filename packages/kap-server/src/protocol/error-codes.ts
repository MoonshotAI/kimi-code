/**
 * The numeric wire error-code table carried in envelope `code` fields.
 *
 * Integer namespaces:
 *   - 0          success
 *   - 4xxxx      client errors (HTTP-4xx analog)
 *   - 5xxxx      server internal errors
 *   - 6xxxx      tool runtime
 *   - 7xxxx      LLM provider passthrough (msg = original upstream text)
 *   - 8xxxx      MCP server passthrough (msg = original upstream text)
 *   - 9xxxx      reserved
 *
 * Domain `KimiError` string codes are mapped onto these numbers at the
 * transport boundary (`transport/errors.ts`, route-level `sendMappedError`).
 */

export const ErrorCode = {
  /** 成功 */
  SUCCESS: 0,

  /** Zod 校验失败，`details` 含字段路径列表 */
  VALIDATION_FAILED: 40001,
  /** JSON 解析失败、字段类型错 */
  REQUEST_MALFORMED: 40002,

  /** daemon 没有任何 provider 配置 */
  AUTH_PROVISIONING_REQUIRED: 40110,
  /** provider 存在但 token / api_key 缺失 */
  AUTH_TOKEN_MISSING: 40111,
  /** 刷新 token 收到 401（用户撤销了授权） */
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  /** 默认 / 请求的 model 解析不到 provider */
  AUTH_MODEL_NOT_RESOLVED: 40113,

  /** session_id 不存在 */
  SESSION_NOT_FOUND: 40401,
  /** prompt_id 不存在 */
  PROMPT_NOT_FOUND: 40402,
  /** message_id 不存在 */
  MESSAGE_NOT_FOUND: 40403,
  /** approval_id 不存在 */
  APPROVAL_NOT_FOUND: 40404,
  /** question_id 不存在 */
  QUESTION_NOT_FOUND: 40405,
  /** task_id 不存在 */
  TASK_NOT_FOUND: 40406,
  /** file_id 不存在 */
  FILE_NOT_FOUND: 40407,
  /** mcp_server_id 不存在 */
  MCP_SERVER_NOT_FOUND: 40408,
  /** fs path 不存在 */
  FS_PATH_NOT_FOUND: 40409,
  /** workspace_id 不存在 */
  WORKSPACE_NOT_FOUND: 40410,
  /** fs 路径存在但当前进程无权限读取 */
  FS_PERMISSION_DENIED: 40411,
  /** provider_id 不存在 */
  PROVIDER_NOT_FOUND: 40412,
  /** model_id 不存在 */
  MODEL_NOT_FOUND: 40413,
  /** terminal_id 不存在 */
  TERMINAL_NOT_FOUND: 40414,
  /** skill_name 不存在 */
  SKILL_NOT_FOUND: 40415,
  /** tool_call_id 不存在，或该调用没有对应的 plan（非 ExitPlanMode） */
  TOOL_CALL_NOT_FOUND: 40416,

  /** session 有正在进行的 prompt，拒绝新请求 */
  SESSION_BUSY: 40901,
  /** approval 已被其他 client 应答 */
  APPROVAL_ALREADY_RESOLVED: 40902,
  /** prompt 已结束（abort 幂等返回 0） */
  PROMPT_ALREADY_COMPLETED: 40903,
  /** task 已完结，无法取消 */
  TASK_ALREADY_FINISHED: 40904,
  /** mcp restart 时若已在 connecting/connected */
  MCP_ALREADY_CONNECTED: 40905,
  /** fs.read 请求 file，但 path 是目录 */
  FS_IS_DIRECTORY: 40906,
  /** fs.read 请求 utf-8，但 path 是二进制；client 改走 `:download` */
  FS_IS_BINARY: 40907,
  /** fs.git_status 但 session.cwd 不是 git repo */
  FS_GIT_UNAVAILABLE: 40908,
  /** 用户 ESC / 关闭面板放弃整组（client 调 `:dismiss`） */
  QUESTION_DISMISSED: 40909,
  /** 当前历史没有可 compact 的前缀 */
  COMPACTION_UNABLE: 40910,
  /** 当前历史没有足够的用户提示词可撤回 */
  SESSION_UNDO_UNAVAILABLE: 40911,
  /** skill 存在但类型不支持用户激活（如 reference 类型） */
  SKILL_NOT_ACTIVATABLE: 40912,

  /** 当前会话已存在活跃 goal */
  GOAL_ALREADY_EXISTS: 40913,
  /** 目标不存在 */
  GOAL_NOT_FOUND: 40914,
  /** goal 状态不允许该操作 */
  GOAL_STATUS_INVALID: 40915,
  /** goal 当前状态不可恢复 */
  GOAL_NOT_RESUMABLE: 40916,
  /** goal objective 为空 */
  GOAL_OBJECTIVE_EMPTY: 40917,
  /** goal objective 超过长度限制 */
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  /** fs.mkdir 目标路径已存在（文件或目录） */
  FS_ALREADY_EXISTS: 40919,
  /** goal 只允许主 agent 使用 */
  GOAL_UNSUPPORTED_AGENT: 40920,

  /** approval 60s 超时 */
  APPROVAL_EXPIRED: 41001,
  /** question 60s 超时 */
  QUESTION_EXPIRED: 41002,
  /** 临时文件已过期 */
  FILE_EXPIRED: 41003,

  /** 上传超 50MB */
  FILE_TOO_LARGE: 41301,
  /** fs.read 超 10MB */
  FS_TOO_LARGE: 41302,
  /** fs.list / fs.search / fs.grep 命中超上限 */
  FS_TOO_MANY_RESULTS: 41303,
  /** path 越出 session cwd 边界 */
  FS_PATH_ESCAPES_SESSION: 41304,
  /** fs.grep 执行 >30s */
  FS_GREP_TIMEOUT: 41305,

  /** WS 单连接 watch_paths > 100 */
  FS_WATCH_LIMIT_EXCEEDED: 42902,

  /** 兜底 */
  INTERNAL_ERROR: 50001,
  /** 写入 session 持久化失败 */
  PERSISTENCE_FAILURE: 50003,

  /** tool 执行抛错 */
  TOOL_EXECUTION_FAILED: 60001,
  /** tool 在此 session 未启用 */
  TOOL_NOT_AVAILABLE: 60002,

  /** provider.* — provider 原 code 含义保留；`msg` 字段透传上游错误文本。 */
  /** mcp.* — mcp server 原 code 含义保留；`msg` 字段透传上游错误文本。 */
} as const;

/**
 * Reserved (intentionally unallocated; do NOT reuse for new variants):
 *   - 40101 auth.invalid_token        (daemon's own token; future)
 *   - 40102 auth.missing_token        (daemon's own token; future)
 *   - 40103 auth.forbidden_origin     (daemon's own token; future)
 *   - 42901 rate.limited
 *   - 50002 protocol.version_mismatch
 *
 * (`ErrorCodeReason` 不随本表迁移：server 侧没有消费方；数字码到字符串
 * reason 的映射仍由 protocol 包为 v1 链路和 server-e2e 持有。)
 */

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
