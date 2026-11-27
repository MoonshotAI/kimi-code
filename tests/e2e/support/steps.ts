import { PERMISSION_MODE_NAMES, wantedOutput, type Actions, type ToolExpectation, type ToolStatus, type Verb } from './verbs';

const LONGEST_QUOTE = 60;

export const TOOL_STATUS_WORDS: Readonly<Record<ToolStatus, string>> = {
  done: '已完成',
  failed: '失败',
  rejected: '被拒绝',
  running: '运行中',
};

export function quote(text: string): string {
  return `「${text.length > LONGEST_QUOTE ? `${text.slice(0, LONGEST_QUOTE)}…` : text}」`;
}

function toolCheck(expectation: ToolExpectation): string {
  const output = wantedOutput(expectation);
  const printed = output === undefined ? '' : `，输出里有${quote(output)}`;
  return `检查工具卡：${expectation.name}${quote(expectation.target)}${TOOL_STATUS_WORDS[expectation.status]}${printed}`;
}

export const STEP_TITLES: { readonly [Name in Verb]: (...args: Parameters<Actions[Name]>) => string } = {
  send: (text) => `用户发送${quote(text)}`,
  queue: (text) => `用户趁回合还在进行，把${quote(text)}排进队列`,
  steer: (text) => `用户趁回合还在进行，插话${quote(text)}`,
  approve: (options) => (options?.for === 'session' ? '用户批准，本会话内同样的操作不再询问' : '用户批准'),
  reject: () => '用户拒绝',
  rejectWithFeedback: (feedback) => `用户拒绝，并说明理由${quote(feedback)}`,
  expectApproval: ({ name, target }) => `检查审批：${name}${quote(target)}`,
  answer: (option) => `用户回答问题，选${quote(option)}`,
  answerOther: (text) => `用户回答问题，自己填${quote(text)}`,
  dismissQuestion: () => '用户关掉问题，不回答',
  setPermissionMode: (mode) => `用户把权限模式切到${quote(PERMISSION_MODE_NAMES[mode])}`,
  stop: () => '用户停止回合',
  waitIdle: () => '等回合结束',
  waitForUsageUpdates: (count) => `等 ACP 编辑器收到 ${count} 次用量更新`,
  expectTool: toolCheck,
  expectReply: (text) => `检查回复里有${quote(text)}`,
  expectError: (text) => `检查回合失败了，错误里有${quote(text)}`,
  expectAbsent: (text) => `检查回复里没有${quote(text)}`,
  continue: () => '用户点「继续」，让失败的回合接着做',
  restart: () => '用户关掉产品再打开，回到原来的会话',
  restartDuringTurn: () => '用户在回合进行中关掉产品，再打开，回到原来的会话',
  undo: () => '用户撤销最近一条消息',
  recallPrevious: () => '用户在输入框里按上键，调回上一条提示',
  submit: (text) => `用户把输入框里的${quote(text)}发出去`,
  expectComposer: (text) => (text === '' ? '检查输入框是空的' : `检查输入框里是${quote(text)}`),
  newSession: () => '用户新建一个会话',
  compact: () => '用户手动压缩上下文（/compact）',
  resize: (size) => (size === 'narrow' ? '用户把窗口拉窄' : '用户把窗口拉回原来的大小'),
  expectTranscript: (text) => `检查整段对话里有${quote(text)}`,
  exit: () => '用户退出，回到原来的 shell',
  expectTerminalRestored: () => '检查终端回到了正常的输入模式',
  openSession: (title) => `用户回到之前标题为${quote(title)}的会话`,
  reload: () => '用户重新加载会话（/reload）',
  init: () => '用户用 /init 生成 AGENTS.md',
  useSkill: (name) => `用户使用技能${quote(name)}`,
  switchModel: (name) => `用户把模型换成${quote(name)}`,
  setThinkingEffort: (effort) => `用户把思考强度调成${quote(effort)}`,
};

export const DISK_TITLES = {
  write: (path: string, content: string): string => `用户在磁盘上把${quote(path)}写成${quote(content.replaceAll('\n', String.raw`\n`))}`,
  file: (path: string, content: string): string => `检查磁盘：${quote(path)}的内容是${quote(content.replaceAll('\n', String.raw`\n`))}`,
  missing: (path: string): string => `检查磁盘：${quote(path)}不存在`,
};

export const CLOCK_TITLE = (time: string): string => `本机的时间变成${quote(time)}`;

export const GIT_TITLE = (args: readonly string[]): string => `用户在终端里运行${quote(['git', ...args].join(' '))}`;

export const MCP_TITLES = {
  addTool: (server: string, tool: string): string => `MCP 服务${quote(server)}新增工具${quote(tool)}，等产品重新读取工具清单`,
  updateTool: (server: string, tool: string): string => `MCP 服务${quote(server)}修改工具${quote(tool)}，等产品重新读取工具清单`,
  removeTool: (server: string, tool: string): string => `MCP 服务${quote(server)}删除工具${quote(tool)}，等产品重新读取工具清单`,
  disconnect: (server: string): string => `MCP 服务${quote(server)}断开所有连接，等产品重新连上并读取工具清单`,
};
