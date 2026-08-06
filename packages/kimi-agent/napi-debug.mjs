import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('./kimi_agent.node');

function handleCallback(handler) {
  return (callbackId) => {
    const payload = m.getCallbackPayload(callbackId);
    console.log('  cb: id=', callbackId, 'payload type:', typeof payload, 'len:', payload?.length);
    try {
      const result = handler(payload);
      if (result instanceof Promise) {
        result.then(
          (res) => m.resolveCallback(callbackId, null, res),
          (err) => m.resolveCallback(callbackId, err?.message ?? String(err), null),
        );
      } else {
        m.resolveCallback(callbackId, null, result);
      }
    } catch (err) {
      m.resolveCallback(callbackId, err?.message ?? String(err), null);
    }
  };
}

async function test() {
  // Test 1: synchronous callback
  console.log('Test 1: sync callback');
  try {
    const r = await m.runTurnRust(
      { turnId: 't1', systemPrompt: 's', modelName: 'm', messages: [], tools: [], maxSteps: 1 },
      handleCallback((_req) => '{"tool_calls":[],"finish_reason":"stop","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}'),
      handleCallback((_req) => '{"content":"","is_error":false}'),
    );
    console.log('Result:', JSON.stringify(r));
  } catch(e) { console.log('Error:', e.message); }

  // Test 2: async callback
  console.log('\nTest 2: async callback');
  try {
    const r = await m.runTurnRust(
      { turnId: 't2', systemPrompt: 's', modelName: 'm', messages: [], tools: [], maxSteps: 1 },
      handleCallback(async (_req) => '{"tool_calls":[],"finish_reason":"stop","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}'),
      handleCallback(async (_req) => '{"content":"","is_error":false}'),
    );
    console.log('Result:', JSON.stringify(r));
  } catch(e) { console.log('Error:', e.message); }

  // Test 3: delayed callback
  console.log('\nTest 3: delayed callback');
  try {
    const r = await m.runTurnRust(
      { turnId: 't3', systemPrompt: 's', modelName: 'm', messages: [], tools: [], maxSteps: 1 },
      (callbackId) => {
        setTimeout(() => {
          m.resolveCallback(callbackId, null, '{"tool_calls":[],"finish_reason":"stop","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}');
        }, 100);
      },
      (callbackId) => {
        m.resolveCallback(callbackId, null, '{"content":"","is_error":false}');
      },
    );
    console.log('Result:', JSON.stringify(r));
  } catch(e) { console.log('Error:', e.message); }

  // Test 4: error propagation
  console.log('\nTest 4: error propagation');
  try {
    const r = await m.runTurnRust(
      { turnId: 't4', systemPrompt: 's', modelName: 'm', messages: [], tools: [], maxSteps: 1 },
      (callbackId) => {
        m.resolveCallback(callbackId, 'LLM service unavailable', null);
      },
      (callbackId) => {
        m.resolveCallback(callbackId, null, '{"content":"","is_error":false}');
      },
    );
    console.log('Result:', JSON.stringify(r));
  } catch(e) { console.log('Error:', e.message); }
}
await test();