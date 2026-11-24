import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type DecipherGCM,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Criptografia dos backups (AES-256-GCM em streaming).
 * Formato: "MZB1" (4 bytes) + iv (12) + dados cifrados + tag (16).
 */
const MAGIC = Buffer.from('MZB1');
const IV_LEN = 12;
const TAG_LEN = 16;

export function parseBackupKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error('BACKUP_ENCRYPTION_KEY não configurada.');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY deve ter 32 bytes (base64).');
  return key;
}

/** Identifica a chave sem revelá-la (para conferir antes de restaurar). */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update('multizap-backup:').update(key).digest('hex').slice(0, 16);
}

export function encryptStream(key: Buffer, aad: string): Transform {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, iv]));
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/** Retém os últimos 16 bytes (tag) e só libera o final depois de validá-la. */
export function decryptStream(key: Buffer, aad: string): Transform {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!decipher) {
          header = Buffer.concat([header, chunk]);
          if (header.length < MAGIC.length + IV_LEN) return cb();
          if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('Arquivo de backup inválido.');
          decipher = createDecipheriv('aes-256-gcm', key, header.subarray(4, 4 + IV_LEN));
          decipher.setAAD(Buffer.from(aad));
          chunk = header.subarray(4 + IV_LEN);
        }
        const buf = Buffer.concat([tail, chunk]);
        const cut = Math.max(0, buf.length - TAG_LEN);
        tail = buf.subarray(cut);
        cb(null, cut > 0 ? decipher.update(buf.subarray(0, cut)) : undefined);
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!decipher || tail.length !== TAG_LEN) throw new Error('Arquivo de backup incompleto.');
        decipher.setAuthTag(tail);
        this.push(decipher.final());
        cb();
      } catch {
        cb(new Error('Falha ao descriptografar o backup (chave incorreta ou arquivo corrompido).'));
      }
    },
  });
}
