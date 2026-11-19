import multipleToolCalls from './multiple-tool-calls';
import textAndReasoning from './text-and-reasoning';
import toolArgumentsBeforeName from './tool-arguments-before-name';
import usageCacheMissing from './usage-cache-missing';
import usageCacheZero from './usage-cache-zero';
import usageChoice from './usage-choice';

export const openAIDecodeFixtures = [
  textAndReasoning,
  toolArgumentsBeforeName,
  multipleToolCalls,
  usageCacheMissing,
  usageCacheZero,
  usageChoice,
];
