import { fileURLToPath } from 'node:url';

const targets = await fetch('http://127.0.0.1:9222/json/list').then((response) => response.json());
const target = targets.find((entry) => entry.type === 'page' && /\/screenshot\/index.html/.test(entry.url));
if (!target) throw new Error('Start KIMI_SCREENSHOT_FAKE_FRAME=1 pnpm dev:desktop:debug first');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
try {
  const path = fileURLToPath(new URL('../tests/renderer/screenshot-editor.browser.ts', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screenshot editor check timed out')), 30_000);
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    };
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `import(${JSON.stringify(`/@fs${path}`)}).then(module => module.checkScreenshotEditor())`,
      awaitPromise: true, returnByValue: true,
    } }));
  });
  console.log(result);
} finally {
  socket.close();
}
