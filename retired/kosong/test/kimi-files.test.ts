import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { KimiChatProvider } from '#/providers/kimi';
import { KimiFiles } from '#/providers/kimi-files';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function createProvider(): KimiChatProvider {
  return new KimiChatProvider({
    model: 'kimi-k2-turbo-preview',
    apiKey: 'test-key',
  });
}

describe('KimiFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-files-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('exposure on KimiChatProvider', () => {
    it('exposes files property returning a KimiFiles instance', () => {
      const provider = createProvider();
      const files = provider.files;
      expect(files).toBeInstanceOf(KimiFiles);
      expect(typeof files.uploadVideo).toBe('function');
    });

    it('memoizes the files property', () => {
      const provider = createProvider();
      const a = provider.files;
      const b = provider.files;
      expect(a).toBe(b);
    });
  });

  describe('uploadVideo from a file path', () => {
    it('uploads the file and returns a VideoURLPart', async () => {
      const provider = createProvider();

      const videoPath = path.join(tmpDir, 'video.mp4');
      fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3, 4]));

      let captured: unknown;
      const mockCreate = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_abc123',
          object: 'file',
          bytes: 5,
          created_at: 1,
          filename: 'video.mp4',
          purpose: 'video',
        });
      });
      provider.files['_client']!.files.create = mockCreate as never;

      const part = await provider.files.uploadVideo(videoPath);

      expect(mockCreate).toHaveBeenCalledOnce();
      const call = captured as { file: File; purpose: string };
      expect(call.purpose).toBe('video');
      expect(call.file).toBeInstanceOf(File);

      expect(part.type).toBe('video_url');
      expect(part.videoUrl.url).toBe('ms://file_abc123');
      expect(part.videoUrl.id).toBe('file_abc123');
    });

    it('throws when the file does not exist', async () => {
      const provider = createProvider();
      const missing = path.join(tmpDir, 'does-not-exist.mp4');
      await expect(provider.files.uploadVideo(missing)).rejects.toThrow();
    });

    it('rejects a non-video file path (e.g. .txt)', async () => {
      const provider = createProvider();
      const notVideo = path.join(tmpDir, 'note.txt');
      fs.writeFileSync(notVideo, 'hello');

      const mockCreate = vi.fn();
      provider.files['_client']!.files.create = mockCreate as never;

      await expect(provider.files.uploadVideo(notVideo)).rejects.toThrow(/video/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects a file with no extension', async () => {
      const provider = createProvider();
      const noExt = path.join(tmpDir, 'mystery');
      fs.writeFileSync(noExt, 'hello');

      const mockCreate = vi.fn();
      provider.files['_client']!.files.create = mockCreate as never;

      await expect(provider.files.uploadVideo(noExt)).rejects.toThrow(/video/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['clip.mp4', 'video/mp4'],
      ['clip.webm', 'video/webm'],
      ['clip.mov', 'video/quicktime'],
    ])('accepts %s and infers %s', async (filename, expectedMime) => {
      const provider = createProvider();
      const videoPath = path.join(tmpDir, filename);
      fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3]));

      let captured: unknown;
      provider.files['_client']!.files.create = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_ext_ok',
          object: 'file',
          bytes: 4,
          created_at: 1,
          filename,
          purpose: 'video',
        });
      }) as never;

      const part = await provider.files.uploadVideo(videoPath);
      expect(part.videoUrl.id).toBe('file_ext_ok');
      const call = captured as { file: File };
      expect(call.file.type).toBe(expectedMime);
    });
  });

  describe('uploadVideo from a Buffer', () => {
    it('passes request-scoped auth to the client factory', async () => {
      const auths: unknown[] = [];
      const client = {
        files: {
          create: vi.fn().mockResolvedValue({ id: 'file_auth' }),
        },
      };
      const files = new KimiFiles({
        baseUrl: 'https://api.example/v1',
        clientFactory: (auth) => {
          auths.push(auth);
          return client as never;
        },
      });

      await files.uploadVideo(
        { data: Buffer.from([1, 2, 3]), mimeType: 'video/mp4' },
        { auth: { apiKey: 'request-token' } },
      );

      expect(auths).toEqual([{ apiKey: 'request-token' }]);
      expect(client.files.create).toHaveBeenCalledOnce();
    });

    it('uploads raw bytes and returns a VideoURLPart', async () => {
      const provider = createProvider();
      const bytes = Buffer.from([10, 20, 30, 40]);

      let captured: unknown;
      provider.files['_client']!.files.create = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_buf_456',
          object: 'file',
          bytes: bytes.length,
          created_at: 1,
          filename: 'upload.mp4',
          purpose: 'video',
        });
      }) as never;

      const part = await provider.files.uploadVideo({
        data: bytes,
        mimeType: 'video/mp4',
      });

      const call = captured as { file: File; purpose: string };
      expect(call.purpose).toBe('video');
      expect(call.file).toBeInstanceOf(File);
      expect(part.type).toBe('video_url');
      expect(part.videoUrl.url).toBe('ms://file_buf_456');
      expect(part.videoUrl.id).toBe('file_buf_456');
    });

    it('rejects a non-video mime type', async () => {
      const provider = createProvider();
      await expect(
        provider.files.uploadVideo({
          data: Buffer.from([1, 2, 3]),
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(/video/i);
    });
  });
});
