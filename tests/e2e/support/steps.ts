import { wantedOutput, type Product, type ToolExpectation, type ToolStatus, type Verb } from './verbs';

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

export const STEP_TITLES: { readonly [Name in Verb]: (...args: Parameters<Product[Name]>) => string } = {
  send: (text) => `用户发送${quote(text)}`,
  approve: () => '用户批准',
  reject: () => '用户拒绝',
  stop: () => '用户停止回合',
  waitIdle: () => '等回合结束',
  expectTool: toolCheck,
  expectReply: (text) => `检查回复里有${quote(text)}`,
};

export const DISK_TITLES = {
  file: (path: string, content: string): string => `检查磁盘：${quote(path)}的内容是${quote(content.replaceAll('\n', String.raw`\n`))}`,
  missing: (path: string): string => `检查磁盘：${quote(path)}不存在`,
};
