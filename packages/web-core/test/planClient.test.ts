import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
    projectorFactory: () => {
      throw new Error('projector not needed for REST-only tests');
    },
  });
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }));
}

describe('DaemonKimiWebApi.getSessionPlans', () => {
  it('maps persisted plan content and its final review', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({
      agent_id: 'main',
      plans: [{
        tool_call_id: 'call_plan',
        turn_id: 'turn_3',
        source: 'interaction',
        plan: '# Complete plan',
        path: '/tmp/plan.md',
        options: [{ label: 'Approach A', description: 'Small change' }],
        review: {
          state: 'approved',
          selected_option: 'Approach A',
          feedback: 'Keep it focused',
        },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getSessionPlans('session/with space', {
      agentId: 'main',
      toolCallId: 'call_plan',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://test.local/api/v1/sessions/session%2Fwith%20space/transcript/plan?agent_id=main&tool_call_id=call_plan',
    );
    expect(init.method).toBe('GET');
    expect(result).toEqual([{
      agentId: 'main',
      toolCallId: 'call_plan',
      turnId: 'turn_3',
      source: 'interaction',
      plan: '# Complete plan',
      path: '/tmp/plan.md',
      options: [{ label: 'Approach A', description: 'Small change' }],
      review: {
        state: 'approved',
        selectedOption: 'Approach A',
        feedback: 'Keep it focused',
      },
    }]);
  });

  it('supports auto-mode plans without a review record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({
      agent_id: 'main',
      plans: [{
        tool_call_id: 'call_auto',
        turn_id: 'turn_4',
        source: 'output',
        plan: '# Auto plan',
      }],
    })));

    const result = await makeApi().getSessionPlans('session_1', { agentId: 'main' });

    expect(result[0]?.review).toBeUndefined();
    expect(result[0]?.plan).toBe('# Auto plan');
  });
});
