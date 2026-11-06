import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AUTO_REVIEW_FLAG_ID = 'auto_review';
export const AUTO_REVIEW_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AUTO_REVIEW';

export const autoReviewFlag: FlagDefinitionInput = {
  id: AUTO_REVIEW_FLAG_ID,
  title: 'Auto Review',
  description: 'Review tool calls that Always Ask mode would ask about with a separate model in Ask When Needed and Never Ask modes.',
  env: AUTO_REVIEW_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(autoReviewFlag);
