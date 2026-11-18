import geminiNonStream from './gemini-non-stream';
import geminiStream from './gemini-stream';
import rateLimit from './rate-limit';
import vertexNonStream from './vertex-non-stream';
import vertexAdcNonStream from './vertex-adc-non-stream';

export const googleGenAITransportFixtures = [
  geminiStream,
  geminiNonStream,
  vertexNonStream,
  vertexAdcNonStream,
  rateLimit,
];
