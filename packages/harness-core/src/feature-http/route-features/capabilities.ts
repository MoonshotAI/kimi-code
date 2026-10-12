import type { Request, Response } from 'express';

import { useInject } from '@moonshot-ai/agent-core';

import {
  CapabilitiesRef,
  CapabilityError,
  type CapabilitiesFace,
} from '#/features/capabilities/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const CAPABILITY_ACTIONS = ['install'] as const;

export function useCapabilitiesRoutes(prefix: string): void {
  useHttpRoute({
    id: 'capabilities.list',
    method: 'GET',
    path: `${prefix}/capabilities`,
    handler: async (request, response) => {
      const face = capabilitiesFacade(request, response);
      if (face === undefined) return;
      sendOk(request, response, { capabilities: await face.list() });
    },
  });

  useHttpRoute({
    id: 'capabilities.get',
    method: 'GET',
    path: `${prefix}/capabilities/:capability_id`,
    handler: async (request, response) => {
      const capabilityId = param(request, 'capability_id');
      if (capabilityId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'capability_id is required');
        return;
      }
      const face = capabilitiesFacade(request, response);
      if (face === undefined) return;
      try {
        sendOk(request, response, await face.get(capabilityId));
      } catch (error) {
        if (sendCapabilityErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'capabilities.action',
    method: 'POST',
    path: `${prefix}/capabilities/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'capability id is required');
        return;
      }
      const parsed = parseActionSuffix({
        tail,
        allowedActions: CAPABILITY_ACTIONS,
        resourceLabel: 'capability',
      });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const face = capabilitiesFacade(request, response);
      if (face === undefined) return;
      try {
        sendOk(request, response, await face.install(parsed.id));
      } catch (error) {
        if (sendCapabilityErr(request, response, error)) return;
        throw error;
      }
    },
  });
}

function capabilitiesFacade(request: Request, response: Response): CapabilitiesFace | undefined {
  const face = useInject(CapabilitiesRef).value;
  if (face === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.CAPABILITIES_UNAVAILABLE,
      'capabilities are unavailable (capabilities feature is not installed)',
    );
  }
  return face;
}

function sendCapabilityErr(request: Request, response: Response, error: unknown): boolean {
  if (error instanceof CapabilityError) {
    if (error.code === 'capability.not_found') {
      sendErr(request, response, ErrorCode.CAPABILITY_NOT_FOUND, error.message);
      return true;
    }
    if (error.code === 'capability.unsupported') {
      sendErr(request, response, ErrorCode.CAPABILITY_UNSUPPORTED, error.message);
      return true;
    }
    sendErr(request, response, ErrorCode.CAPABILITY_INSTALL_IN_PROGRESS, error.message);
    return true;
  }
  sendErr(
    request,
    response,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  );
  return true;
}
