import filtered from './filtered';
import functionCall from './function-call';
import textAndThoughtSignatures from './text-and-thought-signatures';
import usageAndFinish from './usage-and-finish';
import usageWithoutFinish from './usage-without-finish';
import usageWithThinking from './usage-with-thinking';
import usageWithZeroThinking from './usage-with-zero-thinking';

export const googleGenAIDecodeFixtures = [
  textAndThoughtSignatures,
  functionCall,
  usageAndFinish,
  usageWithoutFinish,
  usageWithThinking,
  usageWithZeroThinking,
  filtered,
];
