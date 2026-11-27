import { describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { createKimiI18n, KimiI18nKey, useKimiI18n } from '../src';

describe('createKimiI18n', () => {
  it('returns the Chinese message for locale "zh"', () => {
    const i18n = createKimiI18n({ locale: 'zh' });
    expect(i18n.global.t('filePreview.copyCode')).toBe('复制代码');
  });

  it('returns the English message for locale "en"', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('filePreview.copyCode')).toBe('Copy code');
  });

  it('names the conversation being submitted and reports rating and attachment failures in Chinese', () => {
    const { t } = createKimiI18n({ locale: 'zh' }).global;
    expect(t('feedback.uploadConversation')).toBe('同时提交本次会话记录');
    expect(t('feedback.undoFailed')).toBe('取消评价失败');
    expect(t('feedback.uploadFailed', { names: '诊断日志' })).toBe('诊断日志提交失败');
    expect(t('feedback.retryUpload')).toBe('重试提交');
  });

  it('provides paste-image auto-mention settings copy in en and zh', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('settings.composerSection')).toBe('Composer');
    expect(i18n.global.t('settings.pasteImageAutoMention')).toBe('Auto-mention pasted images');
    expect(i18n.global.t('settings.pasteImageAutoMentionHint')).toBe('Add an @ mention when you paste an image into the composer');
    i18n.global.locale.value = 'zh';
    expect(i18n.global.t('settings.composerSection')).toBe('输入框');
    expect(i18n.global.t('settings.pasteImageAutoMention')).toBe('粘贴图片时自动提及');
    expect(i18n.global.t('settings.pasteImageAutoMentionHint')).toBe('在输入框中粘贴图片时自动添加 @ 提及');
  });

  it('renders effort switch confirmation titles in en and zh', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('model.switchEffortConfirmTitle', { from: 'high', to: 'max' })).toBe(
      'Confirm effort switch from high to max?',
    );
    i18n.global.locale.value = 'zh';
    expect(i18n.global.t('model.switchEffortConfirmTitle', { from: 'high', to: 'max' })).toBe(
      '确认把思考强度由 high 切换到 max？',
    );
  });

  it('renders the /goal description in full (pipe chars are escaped literals, not plural separators)', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('commands.goal.desc')).toBe(
      'Create/control a goal: /goal <objective>, /goal pause|resume|cancel',
    );
  });

  it('renders cron field labels in en and zh', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('tools.cron.field.id')).toBe('ID');
    expect(i18n.global.t('tools.cron.field.cron')).toBe('Cron expression');
    i18n.global.locale.value = 'zh';
    expect(i18n.global.t('tools.cron.field.id')).toBe('标识符');
    expect(i18n.global.t('tools.cron.field.cron')).toBe('Cron 表达式');
  });

  it('provides auto-continue card and settings copy without banned quota terminology in en and zh', () => {
    const i18n = createKimiI18n({ locale: 'en' });
    expect(i18n.global.t('conversation.quotaAutoContinueLabel')).toBe('Auto-continue when limits reset');
    expect(i18n.global.t('conversation.quotaAutoResumeScheduled', { time: '7:34 PM' })).toBe('Auto-resuming at 7:34 PM');
    expect(i18n.global.t('settings.quotaAutoContinue')).toBe('Auto-continue when limits reset');
    expect(i18n.global.t('settings.quotaAutoContinueHint')).toBe(
      'Automatically continue interrupted sessions when your credits reset, synced across all sessions',
    );
    i18n.global.locale.value = 'zh';
    expect(i18n.global.t('conversation.quotaAutoContinueLabel')).toBe('额度恢复后自动继续');
    expect(i18n.global.t('conversation.quotaAutoResumeScheduled', { time: '19:34' })).toBe('将于 19:34 自动继续');
    expect(i18n.global.t('settings.quotaAutoContinue')).toBe('额度恢复后自动继续');
    expect(i18n.global.t('settings.quotaAutoContinueHint')).toBe('因额度耗尽中断的会话，会在额度恢复后自动继续，对所有会话同步生效');
  });
});

describe('useKimiI18n', () => {
  it('prefers the app-provided KimiI18nKey over the global vue-i18n', () => {
    const globalI18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { filePreview: { copyCode: 'GLOBAL' } } },
    });
    const app = createApp({});
    app.use(globalI18n);
    app.provide(KimiI18nKey, { t: (key: string) => `INJECTED:${key}` });

    let resolved = '';
    app.runWithContext(() => {
      resolved = useKimiI18n().t('filePreview.copyCode');
    });
    expect(resolved).toBe('INJECTED:filePreview.copyCode');
  });
});
