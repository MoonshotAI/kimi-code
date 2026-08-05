// apps/kimi-web/src/lib/markdownMath.ts
// Markdown math-rule policy for chat rendering.
//
// `$$…$$` display math (the `math_block` rule) is always left enabled.
// The single-`$` inline `math` rule is OPT-IN: bare `$` appears constantly in
// prices, env vars, and shell paths (`$5`, `$PATH`, `$HOME/bin`), and the rule
// will misdetect those as math and swallow them into a broken formula. Users
// who want inline `$…$` LaTeX enable it in Settings; everyone else keeps
// literal `$` text. The toggle is consumed in components/chat/Markdown.vue.

import type { MarkdownIt } from 'markstream-vue';

export interface MathRuleOptions {
  /** Render `$…$` spans as inline KaTeX. See the misdetection note above. */
  inline: boolean;
}

export function configureMathRules(md: MarkdownIt, opts: MathRuleOptions): MarkdownIt {
  if (opts.inline) {
    md.inline.ruler.enable('math');
  } else {
    md.inline.ruler.disable('math');
  }
  return md;
}
