import type { Request, Response } from 'express';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import {
  CapabilitiesRef,
  CapabilityError,
  type CapabilitiesFace,
} from '#/features/capabilities/index';

import { useHttpRoute } from '../scope';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const CAPABILITY_ACTIONS = ['install'] as const;

export function useCapabilitiesRoutes(prefix: string): void {
  const face = useInject(CapabilitiesRef);

  const capabilitiesFacade = (request: Request, response: Response): CapabilitiesFace | undefined => {
    if (face.value === undefined) {
      sendErr(
        request,
        response,
        ErrorCode.CAPABILITIES_UNAVAILABLE,
        'capabilities are unavailable (capabilities feature is not installed)',
      );
    }
    return face.value;
  };

  useHttpRoute({
    id: 'capabilities.list',
    method: 'GET',
    path: `${prefix}/capabilities`,
    handler: async (request, response) => {
      const facade = capabilitiesFacade(request, response);
      if (facade === undefined) return;
      sendOk(request, response, { capabilities: await facade.list() });
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
      const facade = capabilitiesFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.get(capabilityId));
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
      const facade = capabilitiesFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.install(parsed.id));
      } catch (error) {
        if (sendCapabilityErr(request, response, error)) return;
        throw error;
      }
    },
  });
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
