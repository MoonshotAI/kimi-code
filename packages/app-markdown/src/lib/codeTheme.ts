import { registerCustomTheme } from 'stream-diffs/pierre';

export const MARKDOWN_CODE_THEME = 'markdown-design';
export const MARKDOWN_CODE_THEME_DARK = 'markdown-design-dark';

export const MARKDOWN_CODE_THEME_DEFINITION = {
  name: MARKDOWN_CODE_THEME,
  type: 'light' as const,
  colors: {
    'editor.background': 'var(--markdown-code-background)',
    'editor.foreground': 'var(--markdown-text-color)',
  },
  tokenColors: [
    { scope: ['markup.heading'], settings: { foreground: 'var(--markdown-syntax-heading-color)', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { foreground: 'var(--markdown-syntax-keyword-color)', fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { foreground: 'var(--markdown-syntax-keyword-color)', fontStyle: 'italic' } },
    { scope: ['markup.strikethrough'], settings: { foreground: 'var(--markdown-syntax-comment-color)', fontStyle: 'strikethrough' } },
    { scope: ['string.other.link.title', 'markup.underline.link'], settings: { foreground: 'var(--markdown-link-color)' } },
    { scope: ['markup.inline.raw'], settings: { foreground: 'var(--markdown-syntax-string-color)' } },
    { scope: ['markup.quote'], settings: { foreground: 'var(--markdown-syntax-comment-color)' } },
    { scope: ['punctuation.definition.list.begin.markdown', 'punctuation.definition.markdown', 'fenced_code.block.language.markdown', 'punctuation.definition.link', 'punctuation.definition.metadata.markdown'], settings: { foreground: 'var(--markdown-syntax-keyword-color)' } },
    { scope: ['support.type.property-name.json'], settings: { foreground: 'var(--markdown-syntax-property-color)' } },
    { scope: ['string.quoted.double.json'], settings: { foreground: 'var(--markdown-syntax-string-color)' } },
    { scope: ['keyword', 'storage'], settings: { foreground: 'var(--markdown-syntax-keyword-color)' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--markdown-syntax-function-color)' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: 'var(--markdown-syntax-number-color)' } },
    { scope: ['comment'], settings: { foreground: 'var(--markdown-syntax-comment-color)' } },
  ],
};

registerCustomTheme(MARKDOWN_CODE_THEME, () => Promise.resolve(MARKDOWN_CODE_THEME_DEFINITION));
registerCustomTheme(MARKDOWN_CODE_THEME_DARK, () => Promise.resolve({ ...MARKDOWN_CODE_THEME_DEFINITION, name: MARKDOWN_CODE_THEME_DARK }));
