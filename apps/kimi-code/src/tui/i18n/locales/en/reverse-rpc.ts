/**
 * English translations for the reverse-RPC approval & question panels.
 *
 * Keys follow the `reverseRpc.<panel>.<phrase>` convention used by
 * `i18n.t(...)`. Keyboard symbols (↑/↓, ↵, ←/→) and numeric shortcuts stay in
 * code — only the words around them live here.
 */

import type { MessageTree } from '../../i18n';

export const reverseRpc: MessageTree = {
  approval: {
    header: {
      bash: 'Run this command?',
      write: 'Write this file?',
      edit: 'Apply these edits?',
      taskStop: 'Stop this task?',
      exitPlanMode: 'Ready to build with this plan?',
      default: 'Approve {tool}?',
    },
    choice: {
      approveOnce: 'Approve once',
      approveSession: 'Approve for this session',
      reject: 'Reject',
      rejectWithFeedback: 'Reject with feedback',
      approve: 'Approve',
      revise: 'Revise',
    },
    danger: {
      recursiveDelete: 'recursive delete',
      sudo: 'sudo',
      pipeToShell: 'pipe to shell',
      ddWrite: 'dd write',
      mkfs: 'mkfs',
      rawDevice: 'write to raw device',
      chmod777: 'chmod 777',
      forkBomb: 'fork bomb',
    },
    dangerousPrefix: 'Dangerous: {label}',
    cwd: 'cwd: {path}',
    scope: 'scope: {scope}',
    moreLineHidden: '… {count} more line hidden (ctrl+e to preview)',
    moreLinesHidden: '… {count} more lines hidden (ctrl+e to preview)',
    hint: {
      select: 'select',
      choose: 'choose',
      confirm: 'confirm',
      preview: 'ctrl+e preview',
      feedback: 'Type feedback · ↵ submit.',
    },
  },
  question: {
    heading: 'question',
    other: 'Other',
    notAnswered: 'Not answered',
    reviewTitle: 'Review your answer before submit',
    submitPrompt: 'Ready to submit your answers?',
    unansweredWarning: 'Some questions are still unanswered.',
    submit: 'Submit',
    cancel: 'Cancel',
    otherInputHint: 'Type your answer, then press Enter to save.',
    showing: 'showing {start}-{end} of {total}',
    moreLines: '... {count} more lines',
    hint: {
      typeAnswer: 'type answer',
      save: '↵ save',
      tabSwitch: 'tab switch',
      escCancel: 'esc cancel',
      select: '↑↓ select',
      toggle: 'toggle',
      choose: 'choose',
      tabSwitchArrows: '←/→/tab switch',
      submitChoose: '1/2 choose',
      confirm: '↵ confirm',
    },
  },
  preview: {
    title: 'Preview',
    hint: {
      line: 'line',
      page: 'page',
      topBot: 'top/bot',
      cancel: 'cancel',
    },
  },
};
