import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI as GenAIClient } from '@google/genai';
import type OpenAI from 'openai';

import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  kimiAnthropicRequester,
  kimiRequester,
  kimiResponsesRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '#/llm/builtin/provider/index';
import type {
  DefaultHeadersResolver,
  ProtocolEndpoint,
  ProtocolEndpointResolver,
  ProtocolEndpointSource,
} from '#/llm-requester/connection';

import {
  anthropicEndpoint,
  geminiEndpoint,
  googleGenAIEndpoint,
  KIMI_API_KEY_ENV,
  KIMI_BASE_URL_ENV,
  kimiEndpoint,
  openAIEndpoint,
  vertexEndpoint,
} from './endpoints';
import { createOpenAIRunRequester } from './openai';
import { createRunRequester } from './run';
import type { LlmClientContext, LlmErrorClassifier, LlmRequester } from './requester';

export {
  anthropicEndpoint,
  geminiEndpoint,
  googleGenAIEndpoint,
  KIMI_API_KEY_ENV,
  KIMI_BASE_URL_ENV,
  kimiEndpoint,
  openAIEndpoint,
  vertexEndpoint,
};
export type {
  DefaultHeadersResolver,
  ProtocolEndpoint,
  ProtocolEndpointResolver,
  ProtocolEndpointSource,
};

export interface OpenAIRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
  readonly reasoningKey?: string;
}

export function createOpenAIRequester(options?: OpenAIRequesterOptions): LlmRequester {
  return createOpenAIRunRequester(openAIRequester, {
    endpoint: options?.endpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.openai,
      reasoningKey: options?.reasoningKey,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}

export interface OpenAIResponsesRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
}

export function createOpenAIResponsesRequester(
  options?: OpenAIResponsesRequesterOptions,
): LlmRequester {
  return createRunRequester(openAIResponsesRequester, {
    endpoint: options?.endpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.responses,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}

export interface AnthropicRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => Anthropic;
  readonly betaApi?: boolean;
}

export function createAnthropicRequester(options?: AnthropicRequesterOptions): LlmRequester {
  return createRunRequester(anthropicRequester, {
    endpoint: options?.endpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      betaApi: options?.betaApi === true || config.model.betaApi === true ? true : undefined,
      extras: config.extraParams?.anthropic,
    }),
  });
}

export interface GoogleGenAIRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => GenAIClient;
  readonly vertexai?: boolean;
}

export function createGoogleGenAIRequester(options?: GoogleGenAIRequesterOptions): LlmRequester {
  return createRunRequester(options?.vertexai === true ? googleVertexRequester : googleGenAIRequester, {
    endpoint: options?.endpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      vertexai: options?.vertexai === true || config.model.vertexai === true ? true : undefined,
      extras: config.extraParams?.googleGenai,
    }),
  });
}

export interface KimiOpenAIRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
  readonly reasoningKey?: string;
}

export function createKimiOpenAIRequester(options?: KimiOpenAIRequesterOptions): LlmRequester {
  return createOpenAIRunRequester(kimiRequester, {
    endpoint: options?.endpoint ?? kimiEndpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.openai,
      reasoningKey: options?.reasoningKey,
      toolMessageConversion: config.toolMessageConversion ?? 'keep_parts',
    }),
  });
}

export interface KimiAnthropicRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => Anthropic;
  readonly betaApi?: boolean;
}

export function createKimiAnthropicRequester(
  options?: KimiAnthropicRequesterOptions,
): LlmRequester {
  return createRunRequester(kimiAnthropicRequester, {
    endpoint: options?.endpoint ?? kimiEndpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      betaApi: options?.betaApi ?? config.model.betaApi,
      extras: config.extraParams?.anthropic,
    }),
  });
}

export interface KimiResponsesRequesterOptions {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
}

export function createKimiResponsesRequester(options?: KimiResponsesRequesterOptions): LlmRequester {
  return createRunRequester(kimiResponsesRequester, {
    endpoint: options?.endpoint ?? kimiEndpoint,
    defaultHeaders: options?.defaultHeaders,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.responses,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}
