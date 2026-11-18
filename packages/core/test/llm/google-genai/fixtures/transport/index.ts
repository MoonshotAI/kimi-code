import geminiNonStream from './gemini-non-stream';
import geminiStream from './gemini-stream';
import rateLimit from './rate-limit';
import vertexNonStream from './vertex-non-stream';

export const googleGenAITransportFixtures = [
  geminiStream,
  geminiNonStream,
  vertexNonStream,
  rateLimit,
];
