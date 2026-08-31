import type { ContentPart, ToolCall } from '@moonshot-ai/kosong';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { createCommandKaos, testAgent } from './harness/agent';

it('creates an independent agent with a scoped experimental flag resolver', () => {
  const ctx = testAgent({
    experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
  });

  // No experimental flags are currently registered, so the scoped resolver
  // reports none enabled.
  expect(ctx.agent.experimentalFlags.enabledIds()).toEqual([]);
});

it('runs a text-only agent turn from prompt to completion', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
    [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
    [emit] thinking.delta              { "turnId": 0, "delta": "<think-1>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "<text-1>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "<text-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-1" }, "time": "<time>" }
    [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 11, "maxContextTokens": 1000000, "contextUsage": 0.000011, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  await ctx.expectResumeMatches();
});

it('forwards provider finish diagnostics on filtered steps', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextProviderResponse({
    parts: [{ type: 'text', text: 'blocked' }],
    finishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  await ctx.untilTurnEnd();

  const wireStepEnd = ctx.allEvents.find(
    (event) =>
      event.type === '[wire]' &&
      event.event === 'context.append_loop_event' &&
      (event.args as { event?: { type?: string } }).event?.type === 'step.end',
  );
  const rpcStepEnd = ctx.allEvents.find(
    (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
  );

  expect(wireStepEnd?.args).toMatchObject({
    event: {
      finishReason: 'filtered',
      providerFinishReason: 'filtered',
      rawFinishReason: 'content_filter',
    },
  });
  expect(rpcStepEnd?.args).toMatchObject({
    finishReason: 'filtered',
    providerFinishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.expectResumeMatches();
});

it('runs an agent turn through builtin tool approval and execution', async () => {
  const bashCall: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf lookup-result","timeout":60}',
  };
  const ctx = testAgent({ kaos: createCommandKaos('lookup-result') });
  ctx.configure({ tools: ['Bash'] });

  ctx.mockNextResponse({ type: 'text', text: 'I will run that.' }, bashCall);
  await ctx.rpc.prompt({
    input: [{ type: 'text', text: 'Run a command that prints lookup-result' }],
  });
  expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
    [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "I will run that." }
    [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf lookup-result\\",\\"timeout\\":60}" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run that." } }, "time": "<time>" }
    [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Bash
    messages:
      user: text "Run a command that prints lookup-result"
  `);

  ctx.mockNextResponse({ type: 'text', text: 'The command printed lookup-result.' });
  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
    [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
    [emit] tool.progress                       { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "lookup-result" } }
    [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "lookup-result" } }, "time": "<time>" }
    [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "lookup-result" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 33, "maxContextTokens": 1000000, "contextUsage": 0.000033, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
    [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
    [wire] llm.request                         { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999967, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
    [emit] assistant.delta                     { "turnId": 0, "delta": "The command printed lookup-result." }
    [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed lookup-result." } }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 50, "maxContextTokens": 1000000, "contextUsage": 0.00005, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will run that."  calls call_bash:Bash { "command": "printf lookup-result", "timeout": 60 }
      tool[call_bash]: text "lookup-result"
  `);
  await ctx.expectResumeMatches();
});

const VIDEO_CAPS = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 1000000,
} as const;

describe('prompt-attached video resolution', () => {
  // Minimal ISO-BMFF header: a 24-byte ftyp box with the `isom` brand, which
  // is all the media sniffer needs to classify the file as video/mp4.
  const FTYP_MP4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02,
    0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);

  function tempVideo(name = 'clip.mp4', bytes: Buffer = FTYP_MP4): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-video-'));
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  function fileUrl(path: string): string {
    return pathToFileURL(path).href;
  }

  function firstUserContent(ctx: ReturnType<typeof testAgent>): ContentPart[] {
    return ctx.agent.context.messages.find((m) => m.role === 'user')?.content ?? [];
  }

  interface StubFilesServer {
    url: string;
    requests: number;
    close: () => Promise<void>;
  }

  // Stubs the Moonshot files endpoint. `status` drives the ladder: 200 issues a
  // reference, 401 exercises the auth-rejection path, any other status is a
  // non-auth upload failure.
  async function stubFilesServer(status = 200): Promise<StubFilesServer> {
    const state = { requests: 0 };
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/files') {
        req.resume();
        req.on('end', () => {
          state.requests += 1;
          if (status === 200) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'stub-video-file',
                object: 'file',
                bytes: FTYP_MP4.length,
                created_at: 0,
                filename: 'clip.mp4',
                purpose: 'video',
              }),
            );
            return;
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stub upload failure' } }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${String(port)}`,
      get requests() {
        return state.requests;
      },
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function kimiProvider(baseUrl: string) {
    return { type: 'kimi', apiKey: 'test-key', model: 'mock-model', baseUrl } as const;
  }

  it('uploads a local file:// video and sends the issued ms:// reference to the model', async () => {
    const stub = await stubFilesServer();
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(tempVideo()) } }] });
      await ctx.untilTurnEnd();

      expect(firstUserContent(ctx)).toContainEqual({
        type: 'video_url',
        videoUrl: { url: 'ms://stub-video-file', id: 'stub-video-file' },
      });
      expect(stub.requests).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it('ends the turn as cancelled when the user aborts mid-upload, appending nothing', async () => {
    // A /files stub that never responds: the upload only settles when the
    // turn's abort signal tears the in-flight request down, so the rejection
    // reaching the resolver is whatever shape the HTTP client aborts with —
    // the aborted signal alone must classify it as a cancellation.
    let requestArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    const server = createServer((req) => {
      req.resume();
      requestArrived();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ctx = testAgent();
      ctx.configure({
        provider: kimiProvider(`http://127.0.0.1:${String(port)}`),
        modelCapabilities: VIDEO_CAPS,
      });

      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(tempVideo()) } }] });
      await arrived;
      await ctx.rpc.cancel({ turnId: 0 });
      const events = await ctx.untilTurnEnd();

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'cancelled' }),
        }),
      );
      // The cancelled prompt is not delivered at all: no user message enters
      // history, and in particular no inline-base64 degraded copy of it.
      expect(ctx.agent.context.data().history).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ends the turn as cancelled when the user aborts before the inline fallback', async () => {
    const ctx = testAgent();
    ctx.configure({
      // Anthropic: no upload channel, so resolution heads for the inline
      // fallback — the abort must beat the base64 encode.
      provider: { type: 'anthropic', apiKey: 'test-key', model: 'mock-model' },
      modelCapabilities: VIDEO_CAPS,
    });

    const path = tempVideo();
    const realReadBytes = ctx.agent.kaos.readBytes.bind(ctx.agent.kaos);
    vi.spyOn(ctx.agent.kaos, 'readBytes').mockImplementation(async (p, length) => {
      // The uncapped full-content read is the window the user cancels in.
      if (length === undefined) await ctx.rpc.cancel({ turnId: 0 });
      return realReadBytes(p, length);
    });

    await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(path) } }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([]);
  });

  it('degrades to a <video path> tag when the model lacks video_in (no upload)', async () => {
    const stub = await stubFilesServer();
    try {
      const ctx = testAgent();
      ctx.configure({
        provider: kimiProvider(stub.url),
        modelCapabilities: { ...VIDEO_CAPS, video_in: false },
      });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      const path = tempVideo();
      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(path) } }] });
      await ctx.untilTurnEnd();

      const text = firstUserContent(ctx)
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('');
      expect(text).toContain(`<video path="${path}">`);
      expect(firstUserContent(ctx).some((p) => p.type === 'video_url')).toBe(false);
      expect(stub.requests).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('falls back to an inline base64 part when the provider has no upload channel', async () => {
    const ctx = testAgent();
    ctx.configure({
      // Anthropic: no upload channel, but the wire carries inline data: video.
      provider: { type: 'anthropic', apiKey: 'test-key', model: 'mock-model' },
      modelCapabilities: VIDEO_CAPS,
    });
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(tempVideo()) } }] });
    await ctx.untilTurnEnd();

    const part = firstUserContent(ctx).find((p) => p.type === 'video_url');
    expect(part?.type === 'video_url' && part.videoUrl.url).toMatch(/^data:video\/mp4;base64,/);
  });

  it.each(['openai', 'openai_responses'] as const)(
    'degrades to a <video path> tag for a no-upload %s provider whose wire drops inline video',
    async (type) => {
      const ctx = testAgent();
      ctx.configure({
        provider: { type, apiKey: 'test-key', model: 'mock-model' },
        modelCapabilities: VIDEO_CAPS,
      });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      const path = tempVideo();
      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(path) } }] });
      await ctx.untilTurnEnd();

      const text = firstUserContent(ctx)
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('');
      expect(text).toContain(`<video path="${path}">`);
      expect(firstUserContent(ctx).some((p) => p.type === 'video_url')).toBe(false);
    },
  );

  it('falls back to an inline base64 part on a non-auth upload failure', async () => {
    const stub = await stubFilesServer(400);
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(tempVideo()) } }] });
      await ctx.untilTurnEnd();

      const part = firstUserContent(ctx).find((p) => p.type === 'video_url');
      expect(part?.type === 'video_url' && part.videoUrl.url).toMatch(/^data:video\/mp4;base64,/);
    } finally {
      await stub.close();
    }
  });

  it('fails the turn on an auth (401) upload rejection without poisoning history', async () => {
    const stub = await stubFilesServer(401);
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });

      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(tempVideo()) } }] });
      const events = await ctx.untilTurnEnd();

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({ reason: 'failed' }),
        }),
      );
      // The unresolved video is never appended to history.
      expect(ctx.agent.context.messages.some((m) => m.role === 'user')).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('degrades a non-video file to a tag (magic bytes win, no upload)', async () => {
    const stub = await stubFilesServer();
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      const path = tempVideo('notes.txt', Buffer.from('definitely not a video'));
      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(path) } }] });
      await ctx.untilTurnEnd();

      expect(firstUserContent(ctx).some((p) => p.type === 'video_url')).toBe(false);
      expect(stub.requests).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('degrades an oversize video (>100MB) to a tag (no upload)', async () => {
    const stub = await stubFilesServer();
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });
      ctx.mockNextResponse({ type: 'text', text: 'ok' });

      const path = tempVideo();
      // Sparse extend: the ftyp header stays so it sniffs as video, the size
      // crosses the cap.
      truncateSync(path, 100 * 1024 * 1024 + 1);
      await ctx.rpc.prompt({ input: [{ type: 'video_url', videoUrl: { url: fileUrl(path) } }] });
      await ctx.untilTurnEnd();

      expect(firstUserContent(ctx).some((p) => p.type === 'video_url')).toBe(false);
      expect(stub.requests).toBe(0);
    } finally {
      await stub.close();
    }
  }, 30000);

  it('resolves a video attached to a steer message', async () => {
    const stub = await stubFilesServer();
    try {
      const ctx = testAgent();
      ctx.configure({ provider: kimiProvider(stub.url), modelCapabilities: VIDEO_CAPS });
      // Two model steps: the first lets the steer buffer while the turn runs,
      // the second reacts to the flushed steer.
      ctx.mockNextResponse({ type: 'text', text: 'first' });
      ctx.mockNextResponse({ type: 'text', text: 'second' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
      const path = tempVideo();
      ctx.agent.turn.steer([{ type: 'video_url', videoUrl: { url: fileUrl(path) } }]);
      await ctx.untilTurnEnd();

      // The steer flush cannot await an upload, so the local video degrades to
      // an always-safe tag — no unresolved file:// reference reaches history.
      const steered = ctx.agent.context.messages.filter((m) => m.role === 'user');
      const hasFileUrl = steered.some((m) =>
        m.content.some((p) => p.type === 'video_url' && p.videoUrl.url.startsWith('file:')),
      );
      expect(hasFileUrl).toBe(false);
      const anyTag = steered.some((m) =>
        m.content.some((p) => p.type === 'text' && p.text.includes(`<video path="${path}">`)),
      );
      expect(anyTag).toBe(true);
    } finally {
      await stub.close();
    }
  });
});
