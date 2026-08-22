import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  createProvider,
  expandHomePath,
  tryReadProjectIdFromServiceAccount,
  GoogleGenAIChatProvider,
  AnthropicChatProvider,
} from '../src';

describe('Vertex AI Service Account Support', () => {
  const tmpDir = join(homedir(), '.test-secrets-tmp');
  const saFileRel = '~/.test-secrets-tmp/test-sa.json';
  const saFileAbs = join(tmpDir, 'test-sa.json');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      saFileAbs,
      JSON.stringify({
        type: 'service_account',
        project_id: 'sa-project-123',
        private_key_id: 'key-id-456',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSlAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n',
        client_email: 'test-sa@sa-project-123.iam.gserviceaccount.com',
      }),
    );
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('expandHomePath', () => {
    it('expands ~ to home directory', () => {
      expect(expandHomePath('~')).toBe(homedir());
      expect(expandHomePath('~/my-folder/file.json')).toBe(join(homedir(), 'my-folder/file.json'));
      expect(expandHomePath('~/.secrets/sa.json')).toBe(join(homedir(), '.secrets/sa.json'));
    });

    it('returns absolute or relative paths unchanged', () => {
      expect(expandHomePath('/tmp/sa.json')).toBe('/tmp/sa.json');
      expect(expandHomePath('relative/sa.json')).toBe('relative/sa.json');
      expect(expandHomePath(undefined)).toBeUndefined();
      expect(expandHomePath('')).toBeUndefined();
    });
  });

  describe('tryReadProjectIdFromServiceAccount', () => {
    it('reads project_id from tilde-expanded service account path', () => {
      expect(tryReadProjectIdFromServiceAccount(saFileRel)).toBe('sa-project-123');
      expect(tryReadProjectIdFromServiceAccount(saFileAbs)).toBe('sa-project-123');
    });

    it('returns undefined for non-existent file or invalid JSON', () => {
      expect(tryReadProjectIdFromServiceAccount('/non-existent/file.json')).toBeUndefined();
      expect(tryReadProjectIdFromServiceAccount(undefined)).toBeUndefined();
    });
  });

  describe('google-vertex provider', () => {
    it('initializes GoogleGenAIChatProvider with serviceAccountFile and reads project_id', () => {
      const provider = createProvider({
        type: 'google-vertex',
        model: 'gemini-2.5-pro',
        serviceAccountFile: saFileRel,
        location: 'us-central1',
      });

      expect(provider).toBeInstanceOf(GoogleGenAIChatProvider);
      expect(provider.modelName).toBe('gemini-2.5-pro');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pAny = provider as any;
      expect(pAny._serviceAccountFile).toBe(saFileAbs);
      expect(pAny._project).toBe('sa-project-123');
      expect(pAny._googleAuthOptions).toEqual({
        keyFilename: saFileAbs,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    });
  });

  describe('google-vertex-anthropic provider', () => {
    it('initializes AnthropicChatProvider with vertexai and serviceAccountFile', () => {
      const provider = createProvider({
        type: 'google-vertex-anthropic',
        model: 'claude-sonnet-4-6',
        serviceAccountFile: saFileRel,
        location: 'us-east5',
      });

      expect(provider).toBeInstanceOf(AnthropicChatProvider);
      expect(provider.modelName).toBe('claude-sonnet-4-6');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pAny = provider as any;
      expect(pAny._vertexai).toBe(true);
      expect(pAny._serviceAccountFile).toBe(saFileAbs);
      expect(pAny._project).toBe('sa-project-123');
      expect(pAny._location).toBe('us-east5');
      expect(pAny._googleAuthOptions).toEqual({
        keyFilename: saFileAbs,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    });
  });
});
