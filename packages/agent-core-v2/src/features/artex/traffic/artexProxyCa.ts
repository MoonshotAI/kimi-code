import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import forge from 'node-forge';

import { artexTrafficCaDir } from '#/features/artex/store/paths';

export const ARTEX_CA_CERT_FILE = 'artex-proxy-ca-cert.pem';
export const ARTEX_CA_KEY_FILE = 'artex-proxy-ca-key.pem';

const CA_COMMON_NAME = 'ARTEX Recording Proxy CA';
const LEAF_RSA_BITS = 2048;

export interface ArtexLeafCredentials {
  readonly key: string;
  readonly cert: string;
}

/**
 * A locally-generated certificate authority whose leaf certs let the recording
 * proxy terminate TLS for the worker subprocesses that trust it. The CA is
 * persisted so the same root survives restarts; leaf certs are minted on demand
 * from one shared keypair (avoiding a slow RSA generation per host) and cached.
 */
export class ArtexProxyCa {
  readonly certPem: string;
  readonly certPath: string;
  private readonly caCert: forge.pki.Certificate;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  private readonly leafKeys: forge.pki.KeyPair;
  private readonly leafKeyPem: string;
  private readonly leafCache = new Map<string, ArtexLeafCredentials>();

  private constructor(
    certPem: string,
    certPath: string,
    caCert: forge.pki.Certificate,
    caKey: forge.pki.rsa.PrivateKey,
  ) {
    this.certPem = certPem;
    this.certPath = certPath;
    this.caCert = caCert;
    this.caKey = caKey;
    this.leafKeys = forge.pki.rsa.generateKeyPair(LEAF_RSA_BITS);
    this.leafKeyPem = forge.pki.privateKeyToPem(this.leafKeys.privateKey);
  }

  /** Loads the persisted CA, generating and persisting a fresh one on first use. */
  static async load(workspaceRoot: string): Promise<ArtexProxyCa> {
    const dir = artexTrafficCaDir(workspaceRoot);
    const certPath = join(dir, ARTEX_CA_CERT_FILE);
    const keyPath = join(dir, ARTEX_CA_KEY_FILE);
    const existingCert = await readFile(certPath, 'utf8').catch(() => undefined);
    const existingKey = await readFile(keyPath, 'utf8').catch(() => undefined);
    if (existingCert !== undefined && existingKey !== undefined) {
      try {
        return new ArtexProxyCa(
          existingCert,
          certPath,
          forge.pki.certificateFromPem(existingCert),
          forge.pki.privateKeyFromPem(existingKey) as forge.pki.rsa.PrivateKey,
        );
      } catch {
        // Fall through and regenerate a corrupt or unreadable CA.
      }
    }
    const generated = generateCa();
    await mkdir(dir, { recursive: true });
    await writeFile(certPath, generated.certPem, 'utf8');
    await writeFile(keyPath, generated.keyPem, 'utf8');
    return new ArtexProxyCa(
      generated.certPem,
      certPath,
      forge.pki.certificateFromPem(generated.certPem),
      forge.pki.privateKeyFromPem(generated.keyPem) as forge.pki.rsa.PrivateKey,
    );
  }

  /** Mints (and caches) a leaf certificate valid for one host. */
  leafFor(host: string): ArtexLeafCredentials {
    const cached = this.leafCache.get(host);
    if (cached !== undefined) return cached;
    const cert = forge.pki.createCertificate();
    cert.publicKey = this.leafKeys.publicKey;
    cert.serialNumber = serialNumber();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    const altType = isIP(host) === 0 ? 2 : 7;
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: altType, value: host, ip: altType === 7 ? host : undefined }] },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    const credentials: ArtexLeafCredentials = {
      key: this.leafKeyPem,
      cert: forge.pki.certificateToPem(cert),
    };
    this.leafCache.set(host, credentials);
    return credentials;
  }
}

function generateCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(LEAF_RSA_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: CA_COMMON_NAME }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function serialNumber(): string {
  return `00${randomBytes(8).toString('hex')}`;
}
