import type { Request, Response } from 'express';
import { z } from 'zod';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import { OAuthTokensRef, type OAuthTokens } from '#/features/kimi/oauth/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, sendErr, sendOk } from '../route/http';

const loginStartBodySchema = z.object({
  provider: z.string().min(1).optional(),
  region: z.enum(['mainland-cn', 'global']).optional(),
});

const logoutBodySchema = z.object({
  provider: z.string().min(1).optional(),
});

const loginQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});

export function useAuthRoutes(prefix: string): void {
  const tokens = useInject(OAuthTokensRef);

  const oauthFacade = (request: Request, response: Response): OAuthTokens | undefined => {
    if (tokens.value === undefined) {
      sendErr(
        request,
        response,
        ErrorCode.OAUTH_UNAVAILABLE,
        'oauth is unavailable (oauth feature is not installed)',
      );
    }
    return tokens.value;
  };

  useHttpRoute({
    id: 'auth.summary',
    method: 'GET',
    path: `${prefix}/auth`,
    handler: async (request, response) => {
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, await facade.summary());
    },
  });

  useHttpRoute({
    id: 'oauth.login.start',
    method: 'POST',
    path: `${prefix}/oauth/login`,
    handler: async (request, response) => {
      const parsed = loginStartBodySchema.safeParse(request.body);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.loginStart(parsed.data));
      } catch (error) {
        sendErr(request, response, ErrorCode.INTERNAL_ERROR, messageOf(error));
      }
    },
  });

  useHttpRoute({
    id: 'oauth.login.poll',
    method: 'GET',
    path: `${prefix}/oauth/login`,
    handler: async (request, response) => {
      const parsed = loginQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, facade.loginStatus(parsed.data.provider) ?? null);
    },
  });

  useHttpRoute({
    id: 'oauth.login.cancel',
    method: 'DELETE',
    path: `${prefix}/oauth/login`,
    handler: async (request, response) => {
      const parsed = loginQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, facade.loginCancel(parsed.data.provider));
    },
  });

  useHttpRoute({
    id: 'oauth.logout',
    method: 'POST',
    path: `${prefix}/oauth/logout`,
    handler: async (request, response) => {
      const parsed = logoutBodySchema.safeParse(request.body);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.logout(parsed.data.provider));
      } catch (error) {
        sendErr(request, response, ErrorCode.INTERNAL_ERROR, messageOf(error));
      }
    },
  });

  useHttpRoute({
    id: 'oauth.usage',
    method: 'GET',
    path: `${prefix}/oauth/usage`,
    handler: async (request, response) => {
      const parsed = loginQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, await facade.usage(parsed.data.provider));
    },
  });

  useHttpRoute({
    id: 'oauth.userinfo',
    method: 'GET',
    path: `${prefix}/oauth/userinfo`,
    handler: async (request, response) => {
      const parsed = loginQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, firstIssue(parsed.error));
        return;
      }
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, await facade.userinfo(parsed.data.provider));
    },
  });

  useHttpRoute({
    id: 'oauth.region',
    method: 'GET',
    path: `${prefix}/oauth/region`,
    handler: async (request, response) => {
      const facade = oauthFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, { region: facade.region() });
    },
  });
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'validation failed';
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
