import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '../src/i18n';
import { STORAGE_KEYS, safeGetString } from '../src/lib/storage';
import {
  approvalNotificationCopy,
  completionNotificationCopy,
  questionNotificationCopy,
  useNotification,
} from '../src/composables/client/useNotification';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys()).at(index) ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// Singleton — module-level refs + setters. The OS Notification API is absent in
// the test env, so the *enable* path is a no-op; the disable path and the
// load-from-storage defaults are what we exercise here.
const {
  notifyOnComplete,
  notifyOnQuestion,
  notifyOnApproval,
  setNotifyOnComplete,
  setNotifyOnQuestion,
  setNotifyOnApproval,
} = useNotification();
const importedCompleteDefault = notifyOnComplete.value;
const importedQuestionDefault = notifyOnQuestion.value;
const importedApprovalDefault = notifyOnApproval.value;

describe('useNotification preferences', () => {
  beforeEach(() => {
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('completion notifications default to on', () => {
    expect(importedCompleteDefault).toBe(true);
  });

  it('question notifications default to off so question text stays behind an explicit opt-in', () => {
    expect(importedQuestionDefault).toBe(false);
  });

  it('approval notifications default to off', () => {
    expect(importedApprovalDefault).toBe(false);
  });

  it('disabling question notifications persists "0" and updates the ref', () => {
    void setNotifyOnQuestion(false);
    expect(notifyOnQuestion.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.notifyOnQuestion)).toBe('0');
  });

  it('disabling completion notifications persists "0" and updates the ref', () => {
    void setNotifyOnComplete(false);
    expect(notifyOnComplete.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.notifyOnComplete)).toBe('0');
  });

  it('disabling approval notifications persists "0" and updates the ref', () => {
    void setNotifyOnApproval(false);
    expect(notifyOnApproval.value).toBe(false);
    expect(safeGetString(STORAGE_KEYS.notifyOnApproval)).toBe('0');
  });
});

describe('notification copy', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en';
  });

  it('uses an event title and session-title body for completion notifications', () => {
    expect(completionNotificationCopy('Refactor auth flow')).toEqual({
      title: 'Kimi Code · Turn finished',
      body: 'Refactor auth flow',
    });
  });

  it('falls back to a result hint when there is no session title', () => {
    expect(completionNotificationCopy('  ')).toEqual({
      title: 'Kimi Code · Turn finished',
      body: 'View result',
    });
  });

  it('prefers the question preview in question notifications', () => {
    expect(questionNotificationCopy('Storage migration', 'Which database?')).toEqual({
      title: 'Kimi Code · Needs answer',
      body: 'Which database?',
    });
  });

  it('falls back to the session title before the generic question line', () => {
    expect(questionNotificationCopy('Storage migration', ' ')).toEqual({
      title: 'Kimi Code · Needs answer',
      body: 'Storage migration',
    });
  });

  it('uses tool name in approval notifications', () => {
    expect(approvalNotificationCopy('Refactor auth flow', 'bash')).toEqual({
      title: 'Kimi Code · Approval required',
      body: 'bash',
    });
  });

  it('falls back to session title and then generic approval line', () => {
    expect(approvalNotificationCopy('Refactor auth flow', ' ')).toEqual({
      title: 'Kimi Code · Approval required',
      body: 'Refactor auth flow',
    });
    expect(approvalNotificationCopy('  ', '  ')).toEqual({
      title: 'Kimi Code · Approval required',
      body: 'A tool needs your approval',
    });
  });

  it('localizes approval notification copy', () => {
    i18n.global.locale.value = 'zh';
    expect(approvalNotificationCopy('', '')).toEqual({
      title: 'Kimi Code · 等待审批',
      body: '有工具等待你审批',
    });
  });

  it('localizes the notification copy', () => {
    i18n.global.locale.value = 'zh';

    expect(completionNotificationCopy('')).toEqual({
      title: 'Kimi Code · 回合完成',
      body: '点击查看结果',
    });
    expect(questionNotificationCopy('', '')).toEqual({
      title: 'Kimi Code · 待回答',
      body: '有提问等待你回答',
    });
  });
});
