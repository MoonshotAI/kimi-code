import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ArtexNotificationDispatcher,
  DestinationChangedWithoutCredentialsError,
  EVENT_FINDING_CREATED,
  EVENT_FINDING_STATUS_CHANGED,
  FEISHU_ENVELOPE_BYTES,
  FEISHU_MAX_CARD_BYTES,
  MASKED_PREFIX,
  MAX_DIGEST_BATCH_SIZE,
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_BACKOFF_MS,
  NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK,
  NOTIFY_UNLIMITED_BURST_PER_TICK,
  TELEGRAM_TEXT_LIMIT,
  WECOM_MARKDOWN_LIMIT,
  atLeastSeverity,
  buildEmailMessage,
  classifySmtpStageError,
  digestTickPlan,
  dingTalkChannel,
  dingTalkSignedUrl,
  doHttpJson,
  emailChannel,
  feishuCard,
  feishuChannel,
  feishuSign,
  getNotifyChannel,
  htmlBody,
  isBlockedNotifyIp,
  isMasked,
  isPermanentNotificationError,
  isValidNotifyKind,
  listNotifyKinds,
  markdownBody,
  markdownEscape,
  maskConfig,
  maskedValue,
  matchesFilter,
  mergeConfig,
  parseFilter,
  prepareConfigUpdate,
  redactRequestTarget,
  redactTransportError,
  redactUrlsInText,
  renderWebhookBody,
  statusLabel,
  telegramChannel,
  telegramHtml,
  truncateBytes,
  truncateHtml,
  truncateRunes,
  validateFilter,
  validateHttpUrl,
  weComChannel,
  webhookChannel,
  type NotifyMessage,
  type NotifySnapshot,
} from './index';

function singleMessage(): NotifyMessage {
  return {
    items: [
      {
        findingId: 42,
        name: 'login page "SQL injection" risk',
        vulnclass: 'SQL injection',
        severity: 'high',
        summary: 'param id\nunfiltered leads to injection',
        assets: ['a.example.com', 'b.example.com'],
        detailUrl: 'https://artex.example.test/function/findings/detail?id=42',
      },
    ],
  };
}

function batchMessage(count: number): NotifyMessage {
  return {
    batch: true,
    windowMinutes: 30,
    homeUrl: 'https://artex.example.test/function/findings',
    items: Array.from({ length: count }, (_, i) => ({
      findingId: i + 1,
      name: `vuln${String(i + 1)}`,
      vulnclass: 'XSS',
      severity: 'medium',
      summary: 'reflected cross-site scripting',
      assets: ['target.example.com'],
    })),
  };
}

interface StartedHttpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, bodyRaw: Buffer, res: http.ServerResponse) => void,
): Promise<StartedHttpServer> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handler(req, Buffer.concat(chunks), res);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => {
          resolve();
        });
      }),
  };
}

interface FakeSmtpServer {
  readonly host: string;
  readonly port: number;
  readonly commands: string[];
  readonly getBody: () => string;
  readonly close: () => Promise<void>;
}

async function startFakeSmtpServer(options?: {
  readonly mailReply?: string;
  readonly rcptReply?: string;
  readonly advertiseAuth?: boolean;
}): Promise<FakeSmtpServer> {
  const commands: string[] = [];
  let data = '';
  const mailReply = options?.mailReply ?? '250 OK';
  const rcptReply = options?.rcptReply ?? '250 OK';
  const advertiseAuth = options?.advertiseAuth ?? false;

  const server = net.createServer((socket) => {
    socket.write('220 fake.example.test ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    let dataBuf = '';

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (inData) {
          if (line === '.') {
            inData = false;
            data = dataBuf;
            socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');
          } else {
            dataBuf += `${line}\r\n`;
          }
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          socket.write('250-fake.example.test\r\n');
          if (advertiseAuth) socket.write('250-AUTH PLAIN\r\n');
          socket.write('250 8BITMIME\r\n');
        } else if (line.startsWith('AUTH')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (line.startsWith('MAIL FROM')) {
          socket.write(`${mailReply}\r\n`);
        } else if (line.startsWith('RCPT TO')) {
          socket.write(`${rcptReply}\r\n`);
        } else if (line === 'DATA') {
          inData = true;
          dataBuf = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    host: '127.0.0.1',
    port: addr.port,
    commands,
    getBody: () => data,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

describe('artex 6-channel SSRF-hardened notification engine', () => {
  describe('registry & signatures', () => {
    it('registers all 6 channels in lexicographic order', () => {
      expect(listNotifyKinds()).toEqual([
        'dingtalk',
        'email',
        'feishu',
        'telegram',
        'webhook',
        'wecom',
      ]);
      for (const kind of listNotifyKinds()) {
        expect(isValidNotifyKind(kind)).toBe(true);
        const ch = getNotifyChannel(kind);
        expect(ch?.kind).toBe(kind);
        expect(ch?.secretKeys().length).toBeGreaterThan(0);
        expect(ch?.destinationKeys().length).toBeGreaterThan(0);
      }
      expect(isValidNotifyKind('unknown')).toBe(false);
    });

    it('matches OpenSSL reference signatures for DingTalk and Feishu', () => {
      const ts = 1700000000000;
      const secret = 'SECtest123';
      const dingUrl = dingTalkSignedUrl(
        'https://oapi.dingtalk.com/robot/send?access_token=tok',
        secret,
        ts,
      );
      const parsed = new URL(dingUrl);
      expect(parsed.searchParams.get('sign')).toBe('w3RMHXzixTMdzr8OHJUmVLS4IoPJVdu+Ut1LE48MePE=');
      expect(parsed.searchParams.get('timestamp')).toBe('1700000000000');
      expect(parsed.searchParams.get('access_token')).toBe('tok');

      const feishuSig = feishuSign('1700000000000', secret);
      expect(feishuSig).toBe('Hd4xFWQU6R6ad4nzy4ETIznzlqebqH7xcTFVmONTudo=');
      expect(feishuSig).not.toBe(parsed.searchParams.get('sign'));
    });
  });

  describe('rendering, UTF-8 byte truncation, and HTML/Markdown escaping', () => {
    it('truncates UTF-8 bytes without splitting multi-byte characters or exceeding maxBytes', () => {
      const inputs = ['éééééé', 'mixed éé content', '🔴🟠🟡🔵', '中文漏洞摘要内容'.repeat(20)];
      for (const input of inputs) {
        const totalBytes = Buffer.byteLength(input, 'utf8');
        for (let max = 1; max <= totalBytes + 2; max += 1) {
          const got = truncateBytes(input, max);
          expect(Buffer.byteLength(got, 'utf8')).toBeLessThanOrEqual(max);
          expect(got.includes('\uFFFD')).toBe(false);
          if (totalBytes <= max) expect(got).toBe(input);
        }
      }
      expect(truncateRunes('🔴🟠🟡🔵🟢', 3)).toBe('🔴🟠…');
    });

    it('never cuts HTML tags or entities in half', () => {
      const s = '<b>Title</b>body&amp;text<a href="https://example.com/long">View</a>';
      const total = Array.from(s).length;
      for (let max = 1; max <= total + 2; max += 1) {
        const got = truncateHtml(s, max);
        expect(Array.from(got).length).toBeLessThanOrEqual(max);
        const lt = got.lastIndexOf('<');
        if (lt >= 0) expect(got.slice(lt).includes('>')).toBe(true);
        const amp = got.lastIndexOf('&');
        if (amp >= 0) expect(got.slice(amp).includes(';')).toBe(true);
      }
    });

    it('escapes untrusted markdown content backslash-first without leaking escapes into Telegram HTML', () => {
      expect(markdownEscape('a\\b*c')).toBe('a\\\\b\\*c');
      const { body } = markdownBody(
        {
          items: [
            {
              findingId: 1,
              name: 'SQLi\n[click](http://attacker.example)',
              vulnclass: 'SQLi',
              severity: 'high',
              summary: '`code` | pipe',
              assets: ['a.example.com/*bold*>q'],
            },
          ],
        },
        0,
      );
      expect(body).toContain('\\[click\\]\\(http://attacker.example\\)');
      expect(body).not.toContain('\n[click');
      expect(body).toContain('\\`code\\` \\| pipe');

      const { html } = telegramHtml({
        items: [
          {
            findingId: 1,
            name: 'alert(1) *important* <script>',
            vulnclass: 'XSS',
            severity: 'high',
            summary: 'a & b < c',
            assets: [],
          },
        ],
      });
      expect(html).not.toContain('\\(');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('a &amp; b &lt; c');
    });
  });

  describe('all 6 channel adapters', () => {
    it('delivers DingTalk ActionCard for single finding with detailUrl and markdown for batch', async () => {
      const received: Record<string, unknown>[] = [];
      const srv = await startHttpServer((_req, raw, res) => {
        received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
      cleanups.push(srv.close);

      const keptSingle = await dingTalkChannel.send(
        { webhook: `${srv.url}/robot/send?access_token=YOUR_API_KEY`, secret: 'SECtest123' },
        singleMessage(),
        { allowPrivateTargets: true },
      );
      expect(keptSingle).toBe(1);
      expect(received[0]!['msgtype']).toBe('actionCard');

      const keptBatch = await dingTalkChannel.send(
        { webhook: `${srv.url}/robot/send?access_token=YOUR_API_KEY` },
        batchMessage(3),
        { allowPrivateTargets: true },
      );
      expect(keptBatch).toBe(3);
      expect(received[1]!['msgtype']).toBe('markdown');
    });

    it('delivers Feishu interactive card with signature and keeps digest within 16KB limit', async () => {
      const payloads: Record<string, unknown>[] = [];
      const srv = await startHttpServer((_req, raw, res) => {
        payloads.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"code":0,"msg":"success"}');
      });
      cleanups.push(srv.close);

      const bigBatch = batchMessage(400);
      const { card, kept } = feishuCard(bigBatch);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(400);
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8') + FEISHU_ENVELOPE_BYTES).toBeLessThanOrEqual(
        FEISHU_MAX_CARD_BYTES,
      );

      const sent = await feishuChannel.send(
        { webhook: `${srv.url}/open-apis/bot/v2/hook/YOUR_API_KEY`, secret: 'SECtest123' },
        bigBatch,
        { allowPrivateTargets: true },
      );
      expect(sent).toBe(kept);
      expect(payloads[0]!['msg_type']).toBe('interactive');
      expect(payloads[0]!['sign']).toBeTypeOf('string');
      expect(payloads[0]!['timestamp']).toBeTypeOf('string');
    });

    it('delivers WeCom within 4096-byte UTF-8 limit and classifies 45009 retryable vs 93000 permanent', async () => {
      let bodyBytes = 0;
      const okSrv = await startHttpServer((_req, raw, res) => {
        const parsed = JSON.parse(raw.toString('utf8')) as { markdown: { content: string } };
        bodyBytes = Buffer.byteLength(parsed.markdown.content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
      cleanups.push(okSrv.close);

      const kept = await weComChannel.send(
        { webhook: `${okSrv.url}/cgi-bin/webhook/send?key=YOUR_API_KEY` },
        batchMessage(200),
        { allowPrivateTargets: true },
      );
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(200);
      expect(bodyBytes).toBeGreaterThan(0);
      expect(bodyBytes).toBeLessThanOrEqual(WECOM_MARKDOWN_LIMIT);

      const rateSrv = await startHttpServer((_req, _raw, res) => {
        res.end('{"errcode":45009,"errmsg":"api freq out of limit"}');
      });
      cleanups.push(rateSrv.close);
      await expect(
        weComChannel.send({ webhook: rateSrv.url }, singleMessage(), { allowPrivateTargets: true }),
      ).rejects.toSatisfy((err: unknown) => err instanceof Error && !isPermanentNotificationError(err));

      const badKeySrv = await startHttpServer((_req, _raw, res) => {
        res.end('{"errcode":93000,"errmsg":"invalid key"}');
      });
      cleanups.push(badKeySrv.close);
      await expect(
        weComChannel.send({ webhook: badKeySrv.url }, singleMessage(), { allowPrivateTargets: true }),
      ).rejects.toSatisfy((err: unknown) => isPermanentNotificationError(err));
    });

    it('delivers Telegram HTML within 4096 runes and classifies 429 retryable vs 403 permanent', async () => {
      const sentTexts: string[] = [];
      const okSrv = await startHttpServer((_req, raw, res) => {
        const parsed = JSON.parse(raw.toString('utf8')) as { text: string; parse_mode: string };
        expect(parsed.parse_mode).toBe('HTML');
        sentTexts.push(parsed.text);
        res.end('{"ok":true}');
      });
      cleanups.push(okSrv.close);

      const kept = await telegramChannel.send(
        { bot_token: 'YOUR_API_KEY', chat_id: '-100', base_url: okSrv.url },
        batchMessage(200),
        { allowPrivateTargets: true },
      );
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(200);
      expect(Array.from(sentTexts[0]!).length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);

      const rlSrv = await startHttpServer((_req, _raw, res) => {
        res.end('{"ok":false,"error_code":429,"description":"Too Many Requests"}');
      });
      cleanups.push(rlSrv.close);
      await expect(
        telegramChannel.send(
          { bot_token: 'YOUR_API_KEY', chat_id: '1', base_url: rlSrv.url },
          singleMessage(),
          { allowPrivateTargets: true },
        ),
      ).rejects.toSatisfy((err: unknown) => err instanceof Error && !isPermanentNotificationError(err));

      const forbidSrv = await startHttpServer((_req, _raw, res) => {
        res.end('{"ok":false,"error_code":403,"description":"forbidden"}');
      });
      cleanups.push(forbidSrv.close);
      await expect(
        telegramChannel.send(
          { bot_token: 'YOUR_API_KEY', chat_id: '1', base_url: forbidSrv.url },
          singleMessage(),
          { allowPrivateTargets: true },
        ),
      ).rejects.toSatisfy((err: unknown) => isPermanentNotificationError(err));
    });

    it('renders Webhook default and custom JSON templates safely and rejects non-JSON/unknown fields', async () => {
      const received: { header?: string; body: Record<string, unknown> }[] = [];
      const srv = await startHttpServer((req, raw, res) => {
        received.push({
          header: req.headers['x-token'] as string | undefined,
          body: JSON.parse(raw.toString('utf8')) as Record<string, unknown>,
        });
        res.end('{"ok":true}');
      });
      cleanups.push(srv.close);

      const kept = await webhookChannel.send(
        {
          url: srv.url,
          headers: { 'X-Token': 'YOUR_API_KEY' },
          body_template:
            '{"msg": {{json (printf "%d items" .Count)}}, "first": {{json (index .Items 0).Name}}}',
        },
        batchMessage(3),
        { allowPrivateTargets: true },
      );
      expect(kept).toBe(3);
      expect(received[0]!.header).toBe('YOUR_API_KEY');
      expect(received[0]!.body).toEqual({ msg: '3 items', first: 'vuln1' });

      expect(() =>
        renderWebhookBody('{"x": {{.Environment}}}', singleMessage()),
      ).toThrow();
      try {
        renderWebhookBody('{"x": {{.Environment}}}', singleMessage());
      } catch (error) {
        expect((error as Error).message).not.toContain('SQL injection');
      }

      await expect(
        webhookChannel.send(
          { url: 'https://example.com/hook', body_template: 'not json' },
          singleMessage(),
        ),
      ).rejects.toSatisfy((err: unknown) => isPermanentNotificationError(err));
    });

    it('delivers Email over SMTP and classifies 4xx retryable vs 5xx permanent', async () => {
      const built = buildEmailMessage(
        'artex@example.com',
        ['a@example.com', 'b@example.com'],
        singleMessage(),
      );
      expect(built).toContain('From: artex@example.com\r\n');
      expect(built).toContain('To: a@example.com, b@example.com\r\n');
      expect(built).toContain('Subject: =?utf-8?B?');
      expect(built).toContain('Content-Transfer-Encoding: base64\r\n');

      const smtp = await startFakeSmtpServer({ advertiseAuth: true });
      cleanups.push(smtp.close);

      const kept = await emailChannel.send(
        {
          host: smtp.host,
          port: smtp.port,
          from: 'artex@example.com',
          to: ['a@example.com', 'b@example.com'],
          username: 'artex',
          password: 'YOUR_API_KEY',
        },
        singleMessage(),
        { allowPrivateTargets: true },
      );
      expect(kept).toBe(1);
      expect(smtp.commands).toContain('MAIL FROM:<artex@example.com>');
      expect(smtp.commands).toContain('RCPT TO:<a@example.com>');
      expect(smtp.commands).toContain('DATA');
      expect(smtp.getBody()).toContain('Content-Type: text/html');

      expect(isPermanentNotificationError(classifySmtpStageError('rcpt', new Error('450 greylist')))).toBe(false);
      expect(isPermanentNotificationError(classifySmtpStageError('rcpt', new Error('550 unknown user')))).toBe(true);

      const reject550 = await startFakeSmtpServer({ rcptReply: '550 5.1.1 User unknown' });
      cleanups.push(reject550.close);
      await expect(
        emailChannel.send(
          {
            host: reject550.host,
            port: reject550.port,
            from: 'artex@example.com',
            to: ['bad@example.com'],
          },
          singleMessage(),
          { allowPrivateTargets: true },
        ),
      ).rejects.toSatisfy((err: unknown) => isPermanentNotificationError(err));
    });
  });

  describe('filter matching and masking', () => {
    it('evaluates minSeverity, taskIds, assetIds, includeCategories, excludeCategories, and onStatusChange', () => {
      const snap: NotifySnapshot = {
        kind: EVENT_FINDING_CREATED,
        findingId: 1,
        taskId: 7,
        vulnclass: 'SQL injection',
        name: 'SQLi',
        severity: 'high',
        summary: 's',
        assetIds: [10, 20],
      };

      expect(matchesFilter({}, snap)).toBe(true);
      expect(matchesFilter({ minSeverity: 'critical' }, snap)).toBe(false);
      expect(matchesFilter({ minSeverity: 'high' }, snap)).toBe(true);
      expect(atLeastSeverity('', 'low')).toBe(false);
      expect(matchesFilter({ taskIds: [8] }, snap)).toBe(false);
      expect(matchesFilter({ taskIds: [7, 8] }, snap)).toBe(true);
      expect(matchesFilter({ assetIds: [99] }, snap)).toBe(false);
      expect(matchesFilter({ assetIds: [20, 99] }, snap)).toBe(true);
      expect(matchesFilter({ includeCategories: ['sql'] }, snap)).toBe(true);
      expect(matchesFilter({ includeCategories: ['xss'] }, snap)).toBe(false);
      expect(
        matchesFilter({ includeCategories: ['sql'], excludeCategories: ['injection'] }, snap),
      ).toBe(false);
      expect(matchesFilter({ includeCategories: [' ', ''] }, snap)).toBe(false);

      const statusSnap: NotifySnapshot = {
        ...snap,
        kind: EVENT_FINDING_STATUS_CHANGED,
        fromStatus: 'pending',
        toStatus: 'fixed',
      };
      expect(matchesFilter({ minSeverity: 'low' }, statusSnap)).toBe(false);
      expect(matchesFilter({ onStatusChange: true }, statusSnap)).toBe(true);
      expect(statusLabel('fixed')).toBe('Fixed');

      expect(parseFilter('{not json')).toEqual({});
      expect(() => {
        validateFilter({ minSeverity: 'hgih' });
      }).toThrow(/low.*critical/);
    });

    it('masks secrets and blocks destination swap without re-declaring credentials', () => {
      expect(maskedValue('short')).toBe(MASKED_PREFIX);
      expect(maskedValue('https://oapi.dingtalk.com/robot/send?access_token=abcdef123456')).toBe(
        `${MASKED_PREFIX}:…123456`,
      );
      expect(isMasked(maskedValue('longsecret'))).toBe(true);

      const masked = maskConfig('dingtalk', {
        webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abcdef123456',
        secret: 'SEC1234567890',
        extra: 'kept',
      });
      expect(isMasked(String(masked['webhook']))).toBe(true);
      expect(isMasked(String(masked['secret']))).toBe(true);
      expect(masked['extra']).toBe('kept');

      const merged = mergeConfig(
        { webhook: 'https://real.example.com/h', secret: 'REALSEC' },
        { webhook: maskedValue('https://real.example.com/h'), secret: '' },
      );
      expect(merged['webhook']).toBe('https://real.example.com/h');
      expect('secret' in merged).toBe(false);

      expect(() =>
        prepareConfigUpdate(
          'webhook',
          { url: 'https://legit.example.com/hook', headers: { Authorization: 'Bearer REAL' } },
          { url: 'https://attacker.example.test/hook' },
        ),
      ).toThrow(DestinationChangedWithoutCredentialsError);

      expect(() =>
        prepareConfigUpdate(
          'webhook',
          { url: 'https://legit.example.com/hook', headers: { Authorization: 'Bearer REAL' } },
          { headers: { Authorization: MASKED_PREFIX } },
        ),
      ).toThrow();
    });
  });

  describe('SSRF protection, DNS rebinding guard, redirect guard, and credential redaction', () => {
    it('blocks private, loopback, link-local, metadata, and IPv4-mapped IPv6 targets', () => {
      const blocked = [
        '127.0.0.1',
        '127.255.255.254',
        '10.0.0.1',
        '10.255.1.2',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.0.1',
        '192.168.1.100',
        '169.254.169.254',
        '169.254.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '::1',
        '::',
        'fc00::1',
        'fd12:3456::1',
        'fe80::1',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        '::ffff:172.16.0.1',
        '::ffff:192.168.1.1',
        '::ffff:169.254.169.254',
        '::ffff:7f00:1',
        '::ffff:a9fe:a9fe',
      ];
      for (const ip of blocked) {
        expect(isBlockedNotifyIp(ip), `${ip} must be blocked`).toBe(true);
      }

      const publicIps = ['8.8.8.8', '1.1.1.1', '172.15.255.254', '172.32.0.1', '2606:4700::1111'];
      for (const ip of publicIps) {
        expect(isBlockedNotifyIp(ip), `${ip} must be allowed`).toBe(false);
      }

      for (const url of [
        'http://127.0.0.1:8080/hook',
        'http://10.0.0.5/hook',
        'http://172.16.3.4/hook',
        'http://192.168.1.10/hook',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]:8080/hook',
        'http://[fc00::1]/hook',
        'http://[fe80::1]/hook',
        'http://[::ffff:127.0.0.1]/hook',
        'http://localhost:3000/hook',
        'file:///etc/passwd',
      ]) {
        expect(() => validateHttpUrl(url)).toThrow();
      }
    });

    it('blocks dial-time DNS resolution returning private/metadata IPs (DNS rebinding protection)', async () => {
      await expect(
        doHttpJson(
          'POST',
          'https://rebind.example.com/hook?token=SECRET',
          undefined,
          { ok: true },
          {
            dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
          },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        return msg.includes('169.254.169.254') && !msg.includes('SECRET');
      });

      const smtp = await startFakeSmtpServer();
      cleanups.push(smtp.close);
      await expect(
        emailChannel.send(
          {
            host: '127.0.0.1',
            port: smtp.port,
            from: 'a@example.com',
            to: ['b@example.com'],
          },
          singleMessage(),
        ),
      ).rejects.toThrow(/ARTEX_NOTIFY_ALLOW_LOCAL/);
      expect(smtp.commands).toHaveLength(0);
    });

    it('refuses cross-host HTTP redirects while allowing same-host redirects', async () => {
      let targetHit = false;
      const target = await startHttpServer((_req, _raw, res) => {
        targetHit = true;
        res.end('{"errcode":0}');
      });
      cleanups.push(target.close);

      const redirector = await startHttpServer((req, _raw, res) => {
        if (req.url?.startsWith('/cross')) {
          res.writeHead(307, {
            Location: `${target.url}/robot/send?access_token=YOUR_API_KEY`,
          });
          res.end();
          return;
        }
        if (req.url === '/same') {
          res.writeHead(307, { Location: '/same/' });
          res.end();
          return;
        }
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
      cleanups.push(redirector.close);

      await expect(
        dingTalkChannel.send(
          { webhook: `${redirector.url}/cross?access_token=YOUR_API_KEY` },
          singleMessage(),
          { allowPrivateTargets: true },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        return msg.includes('cross-host redirect') && !msg.includes('YOUR_API_KEY');
      });
      expect(targetHit).toBe(false);

      const ok = await dingTalkChannel.send(
        { webhook: `${redirector.url}/same?access_token=YOUR_API_KEY` },
        singleMessage(),
        { allowPrivateTargets: true },
      );
      expect(ok).toBe(1);
    });

    it('redacts webhook credentials in all URL, transport, and fallback error helpers', () => {
      const secret = 'LEAKPROBE_SECRET_TOKEN_12345';
      expect(redactRequestTarget(`https://api.telegram.org/bot${secret}/sendMessage`)).toBe(
        'https://api.telegram.org/…',
      );
      expect(redactRequestTarget('not a url')).toBe('(unparseable address)');

      const transportErr = redactTransportError(
        'POST',
        `https://oapi.dingtalk.com/robot/send?access_token=${secret}`,
        new Error('connection refused'),
      );
      expect(transportErr).toContain('oapi.dingtalk.com');
      expect(transportErr).not.toContain(secret);

      const fallback = redactUrlsInText(
        `refusing redirect to https://evil.example.test/bot${secret}/send`,
      );
      expect(fallback).toContain('https://evil.example.test/…');
      expect(fallback).not.toContain(secret);
    });
  });

  describe('ArtexNotificationDispatcher', () => {
    it('implements token-bucket rate limiting and decouples digest batch size from send budget', () => {
      const plan = digestTickPlan();
      expect(plan.tokens).toBe(1);
      expect(plan.claimLimit).toBe(MAX_DIGEST_BATCH_SIZE);
      expect(plan.claimLimit).toBeGreaterThan(NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK);

      const dispatcher = new ArtexNotificationDispatcher();
      const t0 = 1_700_000_000_000;
      expect(dispatcher.takeTokens(1, 1, NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK, t0)).toBe(1);
      expect(dispatcher.takeTokens(1, 1, NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK, t0 + 1)).toBe(0);
      expect(dispatcher.takeTokens(1, 1, NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK, t0 + 30_000)).toBe(0);
      expect(dispatcher.takeTokens(1, 1, NOTIFY_MAX_SENDS_PER_CHANNEL_PER_TICK, t0 + 60_000)).toBe(1);
      expect(dispatcher.takeTokens(2, 0, NOTIFY_UNLIMITED_BURST_PER_TICK + 10, t0)).toBe(
        NOTIFY_UNLIMITED_BURST_PER_TICK,
      );

      // Does not drain unused burst capacity
      expect(dispatcher.takeTokens(3, 100, 5, t0)).toBe(5);
      expect(dispatcher.takeTokens(3, 100, 95, t0)).toBe(95);
      expect(dispatcher.takeTokens(3, 100, 1, t0)).toBe(0);
    });

    it('segments oversized WeCom digest batches without consuming retry budget and converges across rounds', async () => {
      const bodies: string[] = [];
      const srv = await startHttpServer((_req, raw, res) => {
        const parsed = JSON.parse(raw.toString('utf8')) as { markdown: { content: string } };
        bodies.push(parsed.markdown.content);
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
      cleanups.push(srv.close);

      let now = 1_700_000_000_000;
      const dispatcher = new ArtexNotificationDispatcher({
        digestIntervalMinutes: 30,
        nowMs: () => now,
        transport: { allowPrivateTargets: true },
        resolveAssetNames: (ids) => ids.map((id) => `host${String(id)}.example.com`),
      });

      dispatcher.upsertChannel({
        id: 1,
        name: 'wecom digest',
        kind: 'wecom',
        enabled: true,
        mode: 'digest',
        config: { webhook: `${srv.url}/cgi-bin/webhook/send?key=YOUR_API_KEY` },
        filter: { minSeverity: 'high' },
      });

      const total = 50;
      for (let i = 0; i < total; i += 1) {
        dispatcher.enqueue({
          kind: EVENT_FINDING_CREATED,
          findingId: i + 1,
          taskId: 1,
          vulnclass: 'SQLi',
          name: `${'very_long_vulnerability_name_'.repeat(5)}${String(i + 1)}`,
          severity: 'high',
          summary: 'summary',
          assetIds: [1],
        });
      }
      // Below-threshold event is filtered out
      dispatcher.enqueue({
        kind: EVENT_FINDING_CREATED,
        findingId: 999,
        taskId: 1,
        vulnclass: 'Info',
        name: 'low risk',
        severity: 'low',
        summary: 's',
        assetIds: [1],
      });
      expect(dispatcher.listDeliveries(1)).toHaveLength(total);

      // Not due yet
      await dispatcher.step(now);
      expect(bodies).toHaveLength(0);

      // Advance past 30-minute digest window -> first chunk sent, remainder deferred with attempts=0
      now += 31 * 60_000;
      await dispatcher.step(now);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('remaining');

      const afterFirst = dispatcher.listDeliveries(1);
      const sentFirst = afterFirst.filter((d) => d.state === 'sent');
      const pendingFirst = afterFirst.filter((d) => d.state === 'pending');
      expect(sentFirst.length).toBeGreaterThan(0);
      expect(pendingFirst.length).toBeGreaterThan(0);
      expect(sentFirst.length + pendingFirst.length).toBe(total);
      expect(pendingFirst.every((d) => d.attempts === 0)).toBe(true);

      // Subsequent ticks deliver remaining items until all are sent
      let rounds = 0;
      while (dispatcher.listDeliveries(1).some((d) => d.state !== 'sent')) {
        rounds += 1;
        now += 60_000;
        await dispatcher.step(now);
        if (rounds > 20) throw new Error('digest segmentation did not converge');
      }
      expect(bodies.length).toBeGreaterThan(1);
      expect(dispatcher.listDeliveries(1).every((d) => d.state === 'sent')).toBe(true);
    });

    it('retries transient errors with backoff, stops on MAX_NOTIFY_ATTEMPTS, and redacts logged URLs', async () => {
      const logs: string[] = [];
      let status = 503;
      const srv = await startHttpServer((_req, _raw, res) => {
        res.writeHead(status);
        res.end('{"error":"temporarily down"}');
      });
      cleanups.push(srv.close);

      let now = 1_700_000_000_000;
      const dispatcher = new ArtexNotificationDispatcher({
        nowMs: () => now,
        transport: { allowPrivateTargets: true },
        logger: (_level, msg) => logs.push(msg),
      });

      const secretToken = 'SUPER_SECRET_TOKEN_XYZ';
      dispatcher.upsertChannel({
        id: 10,
        name: 'failing webhook',
        kind: 'dingtalk',
        enabled: true,
        mode: 'realtime',
        config: { webhook: `${srv.url}/robot/send?access_token=${secretToken}` },
      });

      const masked = dispatcher.listChannels();
      expect(isMasked(String(masked[0]!.config['webhook']))).toBe(true);
      expect(String(masked[0]!.config['webhook'])).not.toContain(secretToken);

      dispatcher.enqueue({
        kind: EVENT_FINDING_CREATED,
        findingId: 1,
        taskId: 1,
        vulnclass: 'XSS',
        name: 'XSS',
        severity: 'high',
        summary: 'x',
        assetIds: [],
      });

      for (let attempt = 1; attempt <= MAX_NOTIFY_ATTEMPTS; attempt += 1) {
        await dispatcher.step(now);
        const dl = dispatcher.listDeliveries(10)[0]!;
        if (attempt < MAX_NOTIFY_ATTEMPTS) {
          expect(dl.state).toBe('pending');
          now += (NOTIFY_BACKOFF_MS[attempt] ?? 30_000) + 1;
        } else {
          expect(dl.state).toBe('failed');
          expect(dl.lastError).toContain('still failing');
        }
      }

      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain(secretToken);
      }

      // Permanent failure does not retry
      status = 403;
      const dl2 = dispatcher.enqueue({
        kind: EVENT_FINDING_CREATED,
        findingId: 2,
        taskId: 1,
        vulnclass: 'XSS',
        name: 'XSS2',
        severity: 'high',
        summary: 'x',
        assetIds: [],
      })[0]!;
      await dispatcher.step(now);
      expect(dl2.state).toBe('failed');
      expect(dl2.attempts).toBe(1);
    });
  });
});
