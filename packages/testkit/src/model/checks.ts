import type { ReplyStep, ToolCallSpec, ViewMessage, ViewTool } from '#/model/types';

export function messageProblems(messages: readonly ViewMessage[]): string[] {
  const problems: string[] = [];
  const pendingCalls = new Set<string>();
  messages.forEach((message, index) => {
    const where = `messages[${index}] (${message.role})`;
    if (message.role === 'user' && message.text.trim() === '' && message.parts.every((part) => part.type === 'text')) {
      problems.push(`${where} is empty`);
    }
    if (message.role === 'assistant' && message.text.trim() === '' && message.calls.length === 0 && (message.reasoning ?? '') === '') {
      problems.push(`${where} has neither text nor tool calls`);
    }
    const previous = messages[index - 1];
    if (previous !== undefined && message.role === 'user' && previous.role === 'user' && previous.text === message.text && message.text !== '') {
      problems.push(`${where} duplicates the previous user message`);
    }
    if (message.role === 'tool') {
      if (message.callId === undefined || !pendingCalls.delete(message.callId)) {
        problems.push(`${where} answers unknown tool call ${String(message.callId)}`);
      }
    } else if (pendingCalls.size > 0) {
      problems.push(`${where} arrives before the results of tool calls ${[...pendingCalls].join(', ')}`);
    }
    for (const toolCall of message.calls) {
      if (pendingCalls.has(toolCall.id)) problems.push(`${where} repeats pending tool call ID ${toolCall.id}`);
      pendingCalls.add(toolCall.id);
    }
  });
  for (const id of pendingCalls) problems.push(`tool call ${id} has no result`);
  return problems;
}

export function callProblems(step: ReplyStep, tools: readonly ViewTool[]): string[] {
  const problems: string[] = [];
  for (const part of step.parts) {
    if (part.type !== 'call' || part.call.invalid === true) continue;
    const args = checkableArguments(part.call);
    if (args === undefined) continue;
    const where = `scripted call ${JSON.stringify(part.call.name)}`;
    const tool = tools.find((candidate) => candidate.name === part.call.name);
    if (tool === undefined) {
      const offered = tools.length === 0 ? 'the request offered no tools' : `the request offered ${tools.map((candidate) => candidate.name).join(', ')}`;
      problems.push(`${where} names a tool the request did not offer (${offered}); pass { invalid: true } if that is intended`);
      continue;
    }
    const issues = argumentIssues(args, tool.parameters);
    if (issues.length > 0) {
      problems.push(`${where} does not match the schema the request offered: ${issues.join('; ')}; pass { invalid: true } if that is intended`);
    }
  }
  return problems;
}

function checkableArguments(call: ToolCallSpec): Readonly<Record<string, unknown>> | undefined {
  if (call.rawArguments === undefined) return call.args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.rawArguments);
  } catch {
    return undefined;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

function argumentIssues(args: Readonly<Record<string, unknown>>, schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const properties = isPlainObject(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'].filter((key): key is string => typeof key === 'string') : [];
  const issues = required.filter((key) => args[key] === undefined).map((key) => `missing required argument ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const property = properties[key];
    if (!isPlainObject(property)) {
      if (schema['additionalProperties'] === false) issues.push(`unknown argument ${key} (allowed: ${Object.keys(properties).join(', ')})`);
      continue;
    }
    const types = typeNames(property['type']);
    if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
      issues.push(`argument ${key} should be ${types.join(' or ')}, got ${JSON.stringify(value)}`);
    }
    const allowed = property['enum'];
    if (Array.isArray(allowed) && !allowed.includes(value)) {
      issues.push(`argument ${key} should be one of ${allowed.map((option) => JSON.stringify(option)).join(', ')}, got ${JSON.stringify(value)}`);
    }
  }
  return issues;
}

function typeNames(type: unknown): string[] {
  const names = Array.isArray(type) ? type : [type];
  return names.filter((name): name is string => typeof name === 'string').map((name) => name.toLowerCase());
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
