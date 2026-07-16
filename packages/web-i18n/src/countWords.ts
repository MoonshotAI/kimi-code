const COUNT_WORD_KEYS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

/** Returns a localized word for one through ten, and digits outside that range. */
export function formatCountNumber(count: number, translate: (key: string) => string): string {
  const key = COUNT_WORD_KEYS[count - 1];
  return key ? translate(`common.countWords.${key}`) : String(count);
}
