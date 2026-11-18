import functionCallFragments from './function-call-fragments';
import incomplete from './incomplete';
import invalidFunctionArguments from './invalid-function-arguments';
import multipleFunctionCalls from './multiple-function-calls';
import streamError from './stream-error';
import textAndReasoning from './text-and-reasoning';

export const openAIResponsesDecodeFixtures = [
  textAndReasoning,
  functionCallFragments,
  multipleFunctionCalls,
  incomplete,
  streamError,
  invalidFunctionArguments,
];
