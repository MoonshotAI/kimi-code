export type Language = 'en' | 'zh';

export interface Translations {
  readonly language: {
    readonly label: string;
    readonly en: string;
    readonly zh: string;
  };
  readonly settings: {
    readonly title: string;
    readonly model: string;
    readonly modelDescription: string;
    readonly permission: string;
    readonly permissionDescription: string;
    readonly theme: string;
    readonly themeDescription: string;
    readonly editor: string;
    readonly editorDescription: string;
    readonly experiments: string;
    readonly experimentsDescription: string;
    readonly upgrade: string;
    readonly upgradeDescription: string;
    readonly usage: string;
    readonly usageDescription: string;
    readonly language: string;
    readonly languageDescription: string;
  };
  readonly theme: {
    readonly title: string;
    readonly auto: string;
    readonly dark: string;
    readonly light: string;
    readonly custom: string;
  };
  readonly footer: {
    readonly context: string;
  };
  readonly welcome: {
    readonly title: string;
    readonly loggedOutHint: string;
    readonly loggedInHint: string;
    readonly notSet: string;
    readonly directory: string;
    readonly session: string;
    readonly model: string;
    readonly version: string;
    readonly mcp: string;
  };
  readonly common: {
    readonly navigate: string;
    readonly page: string;
    readonly select: string;
    readonly cancel: string;
    readonly typeToSearch: string;
    readonly noMatches: string;
    readonly current: string;
  };
}

export type TranslationKey = FlattenKeys<Translations>;

type FlattenKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends Record<string, unknown>
    ? FlattenKeys<T[K], `${Prefix}${Prefix extends '' ? '' : '.'}${K}`>
    : `${Prefix}${Prefix extends '' ? '' : '.'}${K}`;
}[keyof T & string];
