import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

describe('Composer command argument hint for assistive technology', () => {
  it.each([
    ['en', 'commands.btw.argHint', 'Type [question] after /btw'],
    ['zh', 'commands.btw.argHint', '在 /btw 后输入[问题]'],
    ['en', 'commands.compact.argHint', 'Type [instructions] after /compact'],
    ['zh', 'commands.compact.argHint', '在 /compact 后输入[说明]'],
  ] as const)('reads the %s hint %s as a sentence', (locale, hintKey, expected) => {
    const { t } = createKimiI18n({ locale }).global;
    const command = hintKey === 'commands.btw.argHint' ? '/btw' : '/compact';
    expect(t('composer.commandArgumentHint', { command, argument: t(hintKey) })).toBe(expected);
  });
});
