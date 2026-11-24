import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Criptografia de credenciais: AES-256-GCM.
 * Formato do blob: [versão do formato (1 byte)][versão da chave (2 bytes)][iv (12)][tag (16)][dados].
 * A versão da chave permite rotação sem perder dados antigos.
 */
const FORMAT_VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + 2 + IV_LEN + TAG_LEN;

export type Keyring = Map<number, Buffer>;

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new Error('A chave de criptografia deve ter exatamente 32 bytes (base64).');
  }
  return key;
}

export class CredentialCipher {
  constructor(
    private readonly keys: Keyring,
    private readonly currentVersion: number,
  ) {
    if (!keys.has(currentVersion)) throw new Error('Versão de chave atual ausente no keyring.');
  }

  get keyVersion(): number {
    return this.currentVersion;
  }

  encrypt(plaintext: Buffer | string, aad?: string): Buffer {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);
    const header = Buffer.alloc(3);
    header.writeUInt8(FORMAT_VERSION, 0);
    header.writeUInt16BE(this.currentVersion, 1);
    return Buffer.concat([header, iv, cipher.getAuthTag(), data]);
  }

  decrypt(blob: Buffer, aad?: string): Buffer {
    if (blob.length < HEADER_LEN) throw new Error('Blob criptografado inválido.');
    if (blob.readUInt8(0) !== FORMAT_VERSION) throw new Error('Formato de blob desconhecido.');
    const version = blob.readUInt16BE(1);
    const key = this.keys.get(version);
    if (!key) throw new Error(`Chave de criptografia versão ${version} indisponível.`);
    const iv = blob.subarray(3, 3 + IV_LEN);
    const tag = blob.subarray(3 + IV_LEN, HEADER_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(HEADER_LEN)), decipher.final()]);
  }

  encryptJson(value: unknown, aad?: string): Buffer {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(blob: Buffer, aad?: string): T {
    return JSON.parse(this.decrypt(blob, aad).toString('utf8')) as T;
  }
}

/**
 * Monta o keyring a partir do ambiente:
 *  CREDENTIALS_MASTER_KEY + CREDENTIALS_KEY_VERSION (atual)
 *  CREDENTIALS_MASTER_KEY_V<n> (versões anteriores, para leitura)
 */
export function cipherFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher {
  const current = Number(env.CREDENTIALS_KEY_VERSION ?? '1');
  if (!env.CREDENTIALS_MASTER_KEY) throw new Error('CREDENTIALS_MASTER_KEY não configurada.');
  const keys: Keyring = new Map([[current, parseKey(env.CREDENTIALS_MASTER_KEY)]]);
  for (const [name, value] of Object.entries(env)) {
    const m = /^CREDENTIALS_MASTER_KEY_V(\d+)$/.exec(name);
    if (m && value && Number(m[1]) !== current) keys.set(Number(m[1]), parseKey(value));
  }
  return new CredentialCipher(keys, current);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
