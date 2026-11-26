import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from '../src/business-membership';
import {
  buildManagedAccountProfile,
  fetchManagedAccountProfile,
  fetchManagedWorkspaces,
  kimiCodeWorkspacesUrl,
  parseManagedWorkspacesPayload,
} from '../src/managed-workspaces';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kimiCodeWorkspacesUrl', () => {
  it('appends /workspaces without adding an extra /v1 segment', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://coding.example.com/coding/v1/');
    expect(kimiCodeWorkspacesUrl()).toBe('https://coding.example.com/coding/v1/workspaces');
  });
});

describe('parseManagedWorkspacesPayload', () => {
  it('parses personal and duplicate-named business workspaces keyed by business.id', () => {
    const parsed = parseManagedWorkspacesPayload({
      workspaces: [
        {
          type: 'personal',
          roles: ['ROLE_OWNER'],
          user: { nickname: 'Alice' },
        },
        {
          type: 'business',
          business: { id: 'biz-1', name: 'Acme Corp', status: 'STATUS_ACTIVE' },
          roles: ['ROLE_OWNER'],
          current: true,
          user: { nickname: 'Alice' },
        },
        {
          type: 'business',
          business: { id: 'biz-2', name: 'Acme Corp', status: 'STATUS_DISABLED' },
          roles: ['ROLE_MEMBER'],
          user: { nickname: 'Alice' },
        },
      ],
    });

    expect(parsed).toEqual([
      {
        kind: 'personal',
        key: 'personal',
        target: { kind: 'personal' },
        name: 'Alice',
        kindLabel: 'Personal workspace',
        current: false,
        disabled: false,
        switchable: true,
        roles: ['ROLE_OWNER'],
      },
      {
        kind: 'business',
        key: 'business:biz-1',
        target: { kind: 'business', businessId: 'biz-1' },
        businessId: 'biz-1',
        name: 'Acme Corp',
        status: 'STATUS_ACTIVE',
        kindLabel: 'Business workspace',
        current: true,
        disabled: false,
        switchable: true,
        nickname: 'Alice',
        roles: ['ROLE_OWNER'],
      },
      {
        kind: 'business',
        key: 'business:biz-2',
        target: { kind: 'business', businessId: 'biz-2' },
        businessId: 'biz-2',
        name: 'Acme Corp',
        status: 'STATUS_DISABLED',
        kindLabel: 'Business workspace',
        current: false,
        disabled: true,
        switchable: false,
        nickname: 'Alice',
        roles: ['ROLE_MEMBER'],
      },
    ]);
  });

  it('supports SSO users with only business workspaces and no personal entry', () => {
    const parsed = parseManagedWorkspacesPayload({
      workspaces: [
        {
          type: 'business',
          business: { id: 'sso-biz', name: 'Enterprise SSO', status: 'STATUS_ACTIVE' },
          current: true,
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({
      kind: 'business',
      businessId: 'sso-biz',
      current: true,
    });
  });

  it('rejects malformed payloads with multiple current entries or duplicate business IDs', () => {
    expect(
      parseManagedWorkspacesPayload({
        workspaces: [
          { type: 'personal', current: true },
          {
            type: 'business',
            business: { id: 'biz-1', name: 'Acme', status: 'STATUS_ACTIVE' },
            current: true,
          },
        ],
      }),
    ).toBeNull();

    expect(
      parseManagedWorkspacesPayload({
        workspaces: [
          { type: 'business', business: { id: 'dup', name: 'A', status: 'STATUS_ACTIVE' } },
          { type: 'business', business: { id: 'dup', name: 'B', status: 'STATUS_ACTIVE' } },
        ],
      }),
    ).toBeNull();
  });
});

describe('buildManagedAccountProfile', () => {
  it('omits statusWorkspaceLine and planLabel for pure personal users', () => {
    const workspaces = parseManagedWorkspacesPayload({
      workspaces: [{ type: 'personal', current: true, user: { nickname: 'Bob' } }],
    })!;
    const profile = buildManagedAccountProfile(
      {
        user_id: 'u-bob',
        nickname: 'Bob',
        user_level_name: 'Go',
      },
      workspaces,
    );
    expect(profile).toMatchObject({
      userId: 'u-bob',
      nickname: 'Bob',
      userLevelName: 'Go',
      hasBusinessWorkspace: false,
      activeWorkspaceName: 'Personal workspace',
    });
    expect(profile?.statusWorkspaceLine).toBeUndefined();
    expect(profile?.planLabel).toBeUndefined();
  });

  it('formats nickname, workspaceName, and planLabel for enterprise users in business and personal modes', () => {
    const inBusiness = parseManagedWorkspacesPayload({
      workspaces: [
        { type: 'personal', user: { nickname: 'Alice' } },
        {
          type: 'business',
          business: { id: 'biz-1', name: 'Acme Org', status: 'STATUS_ACTIVE' },
          current: true,
        },
      ],
    })!;
    expect(
      buildManagedAccountProfile(
        {
          user_id: 'u-1',
          nickname: 'Alice',
          user_level_name: 'Premium',
          workspace_name: 'Acme Org',
        },
        inBusiness,
      ),
    ).toMatchObject({
      hasBusinessWorkspace: true,
      activeWorkspaceName: 'Acme Org',
      statusWorkspaceLine: 'Alice · Acme Org',
      planLabel: 'Premium',
    });

    const inPersonal = parseManagedWorkspacesPayload({
      workspaces: [
        { type: 'personal', current: true, user: { nickname: 'Alice' } },
        {
          type: 'business',
          business: { id: 'biz-1', name: 'Acme Org', status: 'STATUS_ACTIVE' },
        },
      ],
    })!;
    expect(
      buildManagedAccountProfile(
        {
          user_id: 'u-1',
          nickname: 'Alice',
          user_level_name: 'Go',
        },
        inPersonal,
      ),
    ).toMatchObject({
      hasBusinessWorkspace: true,
      activeWorkspaceName: 'Personal workspace',
      statusWorkspaceLine: 'Alice · Personal workspace',
      planLabel: 'Go',
    });
  });
});

describe('fetchManagedWorkspaces and fetchManagedAccountProfile', () => {
  it('surfaces REASON_BUSINESS_MEMBER_REMOVED with the normative message and errorCode', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'REASON_BUSINESS_MEMBER_REMOVED',
            message: 'server raw text',
            type: 'invalid_authentication_error',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedWorkspaces('https://api.example/workspaces', 'tok', { fetchImpl }),
    ).resolves.toEqual({
      kind: 'error',
      status: 401,
      errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });

    await expect(
      fetchManagedAccountProfile({
        userInfoUrl: 'https://api.example/me',
        workspacesUrl: 'https://api.example/workspaces',
        accessToken: 'tok',
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: 'error',
      status: 401,
      errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  });
});
