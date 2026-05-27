import { describe, expect, it } from 'vitest';

import { migrateV1_1ToV1_2 } from '../../../../src/agent/records/migration/v1.2';
import { runMigration } from './utils';

describe('1.1 to 1.2', () => {
  it('rewrites legacy approve-for-session records with session approval rules', () => {
    expect(
      runMigration(migrateV1_1ToV1_2, [
        {
          type: 'metadata',
          protocol_version: '1.1',
          created_at: 1,
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_bash_session',
          toolName: 'Bash',
          action: 'run command',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_once',
          toolName: 'Bash',
          action: 'run command',
          result: {
            decision: 'approved',
            selectedLabel: 'Approve once',
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_plan_bash',
          toolName: 'Bash',
          action: 'run command in plan mode',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_bg_bash',
          toolName: 'Bash',
          action: 'run background command',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_kept',
          toolName: 'Bash',
          action: 'run command',
          sessionApprovalRule: 'Bash(printf kept)',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 0,
          toolCallId: 'call_custom',
          toolName: 'mcp__github__search',
          action: 'call MCP tool: github:search',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                            { "protocol_version": "1.2", "created_at": "<time>" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash_session", "toolName": "Bash", "action": "run command", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" }, "sessionApprovalRule": "Bash" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_once", "toolName": "Bash", "action": "run command", "result": { "decision": "approved", "selectedLabel": "Approve once" } }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_plan_bash", "toolName": "Bash", "action": "run command in plan mode", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" } }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bg_bash", "toolName": "Bash", "action": "run background command", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" } }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_kept", "toolName": "Bash", "action": "run command", "sessionApprovalRule": "Bash(printf kept)", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" } }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_custom", "toolName": "mcp__github__search", "action": "call MCP tool: github:search", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" }, "sessionApprovalRule": "mcp__github__search" }
    `);
  });
});
