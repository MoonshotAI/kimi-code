import { t } from '#/i18n';

export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 *
 * Built lazily (never at module load) so the translated text reflects the
 * locale that is active when the footer renders, not the English default that
 * would be captured at import time before tui.toml's locale is applied.
 */
export function getWorkingTips(): readonly ToolbarTip[] {
  return [
    { text: t('tui.chrome.tips.ctrlSAddGuidance'), priority: 2, solo: true },
    { text: t('tui.chrome.tips.tasksCheckProgress'), priority: 2 },
    { text: t('tui.chrome.tips.initGenerateAgents'), priority: 2 },
    { text: t('tui.chrome.tips.tryDance') },
    { text: t('tui.chrome.tips.pluginsSuperpowers'), solo: true, priority: 3 },
    {
      text: t('tui.chrome.tips.pluginsKimiDatasource'),
      solo: true,
      priority: 3,
    },
    { text: t('tui.chrome.tips.scheduleTasks'), solo: true, priority: 3 },
    { text: t('tui.chrome.tips.sessionsBrowse'), solo: true },
    { text: t('tui.chrome.tips.goalMultiStep'), priority: 2, solo: true },
    { text: t('tui.chrome.tips.goalNext'), solo: true },
    { text: t('tui.chrome.tips.webUi'), solo: true },
    { text: t('tui.chrome.tips.mentionFiles'), priority: 2 },
    { text: t('tui.chrome.tips.runShellCommand'), priority: 2 },
  ];
}

export function getAllTips(): readonly ToolbarTip[] {
  return [
    ...getWorkingTips(),
    { text: t('tui.chrome.tips.shiftEnterNewline') },
    { text: t('tui.chrome.tips.ctrlCCancel') },
    { text: t('tui.chrome.tips.themeSwitch') },
    { text: t('tui.chrome.tips.autoMode') },
    { text: t('tui.chrome.tips.yoloMode') },
    { text: t('tui.chrome.tips.helpCommands') },
    { text: t('tui.chrome.tips.compactContext'), priority: 2 },
    { text: t('tui.chrome.tips.ctrlOToolOutput'), priority: 2 },
    { text: t('tui.chrome.tips.shiftTabPlanMode'), priority: 2 },
    { text: t('tui.chrome.tips.modelSwitch'), priority: 2 },
  ];
}
