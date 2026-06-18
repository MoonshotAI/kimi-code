/**
 * Simplified Chinese translations for the reverse-RPC approval & question
 * panels.
 *
 * Mirrors the namespace structure and keys of `locales/en/reverse-rpc.ts`.
 */

import type { MessageTree } from '../../i18n';

export const reverseRpc: MessageTree = {
  approval: {
    header: {
      bash: '运行此命令？',
      write: '写入此文件？',
      edit: '应用这些修改？',
      taskStop: '停止此任务？',
      exitPlanMode: '准备好按此计划开始了吗？',
      default: '批准 {tool}？',
    },
    choice: {
      approveOnce: '批准一次',
      approveSession: '本次会话内批准',
      reject: '拒绝',
      rejectWithFeedback: '拒绝并反馈',
      approve: '批准',
      revise: '修订',
    },
    danger: {
      recursiveDelete: '递归删除',
      sudo: 'sudo',
      pipeToShell: '管道传给 shell',
      ddWrite: 'dd 写入',
      mkfs: '格式化文件系统',
      rawDevice: '写入裸设备',
      chmod777: 'chmod 777',
      forkBomb: 'fork 炸弹',
    },
    dangerousPrefix: '危险：{label}',
    cwd: 'cwd：{path}',
    scope: '范围：{scope}',
    moreLineHidden: '… 还有 {count} 行已隐藏（ctrl+e 预览）',
    moreLinesHidden: '… 还有 {count} 行已隐藏（ctrl+e 预览）',
    hint: {
      select: '选择',
      choose: '选择',
      confirm: '确认',
      preview: 'ctrl+e 预览',
      feedback: '输入反馈 · ↵ 提交。',
    },
  },
  question: {
    heading: '问题',
    other: '其他',
    notAnswered: '未回答',
    reviewTitle: '提交前请检查你的回答',
    submitPrompt: '确认提交你的回答？',
    unansweredWarning: '仍有问题尚未回答。',
    submit: '提交',
    cancel: '取消',
    otherInputHint: '输入你的回答，然后按回车保存。',
    showing: '显示第 {start}-{end} 项，共 {total} 项',
    moreLines: '... 还有 {count} 行',
    hint: {
      typeAnswer: '输入回答',
      save: '↵ 保存',
      tabSwitch: 'tab 切换',
      escCancel: 'esc 取消',
      select: '↑↓ 选择',
      toggle: '切换',
      choose: '选择',
      tabSwitchArrows: '←/→/tab 切换',
      submitChoose: '1/2 选择',
      confirm: '↵ 确认',
    },
  },
  preview: {
    title: '预览',
    hint: {
      line: '行',
      page: '翻页',
      topBot: '顶部/底部',
      cancel: '取消',
    },
  },
};
