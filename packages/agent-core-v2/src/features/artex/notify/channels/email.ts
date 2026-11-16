import net, { isIP, type LookupFunction } from 'node:net';
import tls from 'node:tls';

import { htmlBody, htmlTitle } from '../html';
import {
  createSafeLookup,
  isBlockedNotifyIp,
  isPrivateTargetAllowed,
  stripIpBrackets,
} from '../ssrf';
import {
  ALLOW_LOCAL_TARGETS_ENV,
  cfgBool,
  cfgInt,
  cfgString,
  cfgStrings,
  permanentError,
  type NotifyChannel,
  type NotifyMessage,
  type NotifyTransportOptions,
} from '../types';

export const EMAIL_DIAL_TIMEOUT_MS = 10_000;
export const EMAIL_SESSION_TIMEOUT_MS = 45_000;

export function encodeRfc2047Subject(subject: string): string {
  const b64 = Buffer.from(subject, 'utf8').toString('base64');
  return `=?utf-8?B?${b64}?=`;
}

function wrapBase64(b64: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) {
    lines.push(b64.slice(i, i + width));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildEmailMessage(
  from: string,
  to: readonly string[],
  message: NotifyMessage,
): string {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeRfc2047Subject(htmlTitle(message))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
  ].join('\r\n');
  const encodedBody = Buffer.from(htmlBody(message, 0), 'utf8').toString('base64');
  return `${headers}\r\n${wrapBase64(encodedBody)}`;
}

export function smtpReplyCode(text: string): number {
  if (text.length < 3) return 0;
  const prefix = text.slice(0, 3);
  if (!/^\d{3}$/.test(prefix)) return 0;
  return Number.parseInt(prefix, 10);
}

export function classifySmtpStageError(what: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code = smtpReplyCode(msg);
  if (code >= 500 && code < 600) {
    return permanentError(`${what}: ${msg}`);
  }
  return new Error(`${what}: ${msg}`);
}

interface SmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
  readonly text: string;
}

class SmtpLineReader {
  private buffer = '';
  private readonly waiters: {
    readonly resolve: (line: string) => void;
    readonly reject: (err: Error) => void;
  }[] = [];
  private readonly queuedLines: string[] = [];
  private closedError: Error | undefined;
  private socket: net.Socket | tls.TLSSocket;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  replaceSocket(socket: tls.TLSSocket): void {
    this.buffer = '';
    this.queuedLines.length = 0;
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      while (true) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
          waiter.resolve(line);
        } else {
          this.queuedLines.push(line);
        }
      }
    });

    const failAll = (err: Error) => {
      if (this.closedError !== undefined) return;
      this.closedError = err;
      while (this.waiters.length > 0) {
        this.waiters.shift()!.reject(err);
      }
    };

    socket.on('error', (err) => {
      failAll(err);
    });
    socket.on('close', () => {
      failAll(new Error('unexpected EOF'));
    });
    socket.on('timeout', () => {
      const err = new Error('SMTP session timed out');
      socket.destroy(err);
      failAll(err);
    });
  }

  private nextLine(): Promise<string> {
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closedError !== undefined) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const line = await this.nextLine();
      lines.push(line);
      if (line.length >= 4 && /^\d{3} /.test(line)) {
        return {
          code: Number.parseInt(line.slice(0, 3), 10),
          lines,
          text: lines.join('\n'),
        };
      }
      if (/^\d{3}$/.test(line)) {
        return {
          code: Number.parseInt(line, 10),
          lines,
          text: lines.join('\n'),
        };
      }
    }
  }

  sendCommand(cmd: string): Promise<SmtpResponse> {
    this.socket.write(`${cmd}\r\n`);
    return this.readResponse();
  }
}

function isLocalhostName(host: string): boolean {
  const lower = stripIpBrackets(host).toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1';
}

function connectSmtpSocket(
  host: string,
  port: number,
  implicitTls: boolean,
  options?: NotifyTransportOptions,
): Promise<net.Socket | tls.TLSSocket> {
  const cleanHost = stripIpBrackets(host);
  if (!isPrivateTargetAllowed(options)) {
    if (isIP(cleanHost) !== 0 && isBlockedNotifyIp(cleanHost)) {
      return Promise.reject(
        new Error(
          `refusing to deliver to private/loopback/link-local address ${cleanHost} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
        ),
      );
    }
    const lower = cleanHost.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
      return Promise.reject(
        new Error(
          `refusing to deliver to loopback host ${cleanHost} (if you really need to deliver to a local service, set ${ALLOW_LOCAL_TARGETS_ENV}=1)`,
        ),
      );
    }
  }

  const dialTimeout = options?.timeoutMs ?? EMAIL_DIAL_TIMEOUT_MS;
  const safeLookup = createSafeLookup(options) as unknown as LookupFunction;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error, sock?: net.Socket | tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== undefined) {
        reject(new Error(`failed to connect to the SMTP server: ${err.message}`));
        return;
      }
      resolve(sock!);
    };

    const socket = implicitTls
      ? tls.connect({
          host: cleanHost,
          port,
          servername: cleanHost,
          minVersion: 'TLSv1.2',
          lookup: safeLookup,
        })
      : net.createConnection({
          host: cleanHost,
          port,
          lookup: safeLookup,
        });

    const timer = setTimeout(() => {
      socket.destroy();
      done(new Error(`dial timed out after ${String(dialTimeout)}ms`));
    }, dialTimeout);

    const readyEvent = implicitTls ? 'secureConnect' : 'connect';
    socket.once(readyEvent, () => {
      socket.setTimeout(EMAIL_SESSION_TIMEOUT_MS);
      done(undefined, socket);
    });
    socket.once('error', (err) => {
      done(err);
    });
  });
}

function upgradeStartTls(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({
      socket,
      servername: stripIpBrackets(host),
      minVersion: 'TLSv1.2',
    });
    tlsSock.once('secureConnect', () => {
      tlsSock.setTimeout(EMAIL_SESSION_TIMEOUT_MS);
      resolve(tlsSock);
    });
    tlsSock.once('error', (err) => {
      reject(err);
    });
  });
}

export const emailChannel: NotifyChannel = {
  kind: 'email',

  defaultRatePerMin(): number {
    return 60;
  },

  secretKeys(): readonly string[] {
    return ['password'];
  },

  destinationKeys(): readonly string[] {
    return ['host', 'port', 'tls'];
  },

  validate(cfg: Readonly<Record<string, unknown>>): void {
    if (cfgString(cfg, 'host') === '') {
      throw new Error('missing SMTP server address');
    }
    const port = cfgInt(cfg, 'port');
    if (port <= 0 || port > 65535) {
      throw new Error('invalid SMTP port (should be 1-65535)');
    }
    if (cfgString(cfg, 'from') === '') {
      throw new Error('missing sender address');
    }
    if (cfgStrings(cfg, 'to').length === 0) {
      throw new Error('at least one recipient address is required');
    }
  },

  async send(
    cfg: Readonly<Record<string, unknown>>,
    message: NotifyMessage,
    options?: NotifyTransportOptions,
  ): Promise<number> {
    try {
      this.validate(cfg, options);
    } catch (error) {
      throw permanentError(error);
    }

    const host = cfgString(cfg, 'host');
    const port = cfgInt(cfg, 'port');
    const from = cfgString(cfg, 'from');
    const to = cfgStrings(cfg, 'to');
    const username = cfgString(cfg, 'username');
    const password = cfgString(cfg, 'password');
    const implicitTls = cfgBool(cfg, 'tls');

    const rawEmail = buildEmailMessage(from, to, message);
    let socket = await connectSmtpSocket(host, port, implicitTls, options);
    const reader = new SmtpLineReader(socket);

    try {
      const greeting = await reader.readResponse();
      if (greeting.code < 200 || greeting.code >= 300) {
        throw new Error(`SMTP handshake failed: ${greeting.text}`);
      }

      let ehlo = await reader.sendCommand('EHLO artex.local');
      if (ehlo.code < 200 || ehlo.code >= 300) {
        ehlo = await reader.sendCommand('HELO artex.local');
        if (ehlo.code < 200 || ehlo.code >= 300) {
          throw new Error(`SMTP EHLO failed: ${ehlo.text}`);
        }
      }

      let isEncrypted = implicitTls;
      const supportsStartTls = ehlo.lines.some((line) =>
        line.toUpperCase().includes('STARTTLS'),
      );
      if (!implicitTls && supportsStartTls) {
        const startTlsResp = await reader.sendCommand('STARTTLS');
        if (startTlsResp.code !== 220) {
          throw new Error(`STARTTLS failed: ${startTlsResp.text}`);
        }
        const tlsSocket = await upgradeStartTls(socket, host);
        socket = tlsSocket;
        reader.replaceSocket(tlsSocket);
        isEncrypted = true;
        ehlo = await reader.sendCommand('EHLO artex.local');
        if (ehlo.code < 200 || ehlo.code >= 300) {
          throw new Error(`SMTP EHLO after STARTTLS failed: ${ehlo.text}`);
        }
      }

      if (username !== '') {
        if (!isEncrypted && !isLocalhostName(host)) {
          throw permanentError(
            'refusing to send credentials: the connection is not encrypted. Enable TLS, or use port 465 (implicit TLS), or tick the "Enable TLS" checkbox (unencrypted connection)',
          );
        }
        const token = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
        const authResp = await reader.sendCommand(`AUTH PLAIN ${token}`);
        if (authResp.code !== 235) {
          throw permanentError(`SMTP authentication failed: ${authResp.text}`);
        }
      }

      const mailResp = await reader.sendCommand(`MAIL FROM:<${from}>`);
      if (mailResp.code < 200 || mailResp.code >= 300) {
        throw classifySmtpStageError(`sender ${from} rejected`, new Error(mailResp.text));
      }

      for (const rcpt of to) {
        const rcptResp = await reader.sendCommand(`RCPT TO:<${rcpt}>`);
        if (rcptResp.code < 200 || rcptResp.code >= 300) {
          throw classifySmtpStageError(`recipient ${rcpt} rejected`, new Error(rcptResp.text));
        }
      }

      const dataResp = await reader.sendCommand('DATA');
      if (dataResp.code !== 354) {
        throw new Error(`SMTP DATA failed: ${dataResp.text}`);
      }

      socket.write(`${rawEmail}\r\n.\r\n`);
      const submitResp = await reader.readResponse();
      if (submitResp.code < 200 || submitResp.code >= 300) {
        throw classifySmtpStageError('failed to submit the email', new Error(submitResp.text));
      }

      try {
        await reader.sendCommand('QUIT');
      } catch {
        // Peer has already accepted the message.
      }
      return message.items.length;
    } finally {
      socket.destroy();
    }
  },
};
