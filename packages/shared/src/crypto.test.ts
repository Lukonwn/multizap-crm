import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialCipher, cipherFromEnv, parseKey, safeEqual, sha256 } from './crypto';

const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe('CredentialCipher', () => {
  it('criptografa e descriptografa (ida e volta)', () => {
    const c = new CredentialCipher(new Map([[1, k1]]), 1);
    const blob = c.encryptJson({ token: 'segredo', n: 1 }, 'account:abc');
    expect(blob.toString('utf8')).not.toContain('segredo');
    expect(c.decryptJson(blob, 'account:abc')).toEqual({ token: 'segredo', n: 1 });
  });

  it('gera IV aleatório (blobs diferentes para o mesmo texto)', () => {
    const c = new CredentialCipher(new Map([[1, k1]]), 1);
    expect(c.encrypt('x').equals(c.encrypt('x'))).toBe(false);
  });

  it('rejeita dados adulterados', () => {
    const c = new CredentialCipher(new Map([[1, k1]]), 1);
    const blob = c.encrypt('valor');
    blob[blob.length - 1]! ^= 0xff;
    expect(() => c.decrypt(blob)).toThrow();
  });

  it('rejeita AAD diferente (impede mover credenciais entre instâncias)', () => {
    const c = new CredentialCipher(new Map([[1, k1]]), 1);
    const blob = c.encrypt('valor', 'account:A');
    expect(() => c.decrypt(blob, 'account:B')).toThrow();
  });

  it('lê blobs de versões antigas após rotação de chave', () => {
    const old = new CredentialCipher(new Map([[1, k1]]), 1);
    const blob = old.encrypt('antigo');
    const rotated = new CredentialCipher(
      new Map([
        [1, k1],
        [2, k2],
      ]),
      2,
    );
    expect(rotated.decrypt(blob).toString()).toBe('antigo');
    expect(rotated.encrypt('novo').readUInt16BE(1)).toBe(2);
  });

  it('monta keyring a partir do ambiente', () => {
    const c = cipherFromEnv({
      CREDENTIALS_MASTER_KEY: k2.toString('base64'),
      CREDENTIALS_KEY_VERSION: '2',
      CREDENTIALS_MASTER_KEY_V1: k1.toString('base64'),
    });
    const legacy = new CredentialCipher(new Map([[1, k1]]), 1).encrypt('x');
    expect(c.decrypt(legacy).toString()).toBe('x');
    expect(c.keyVersion).toBe(2);
  });

  it('valida tamanho da chave', () => {
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('utilitários', () => {
  it('sha256 e comparação segura', () => {
    expect(sha256('a')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
