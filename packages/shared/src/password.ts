import argon2 from 'argon2';

// Somente servidor (dependência nativa). Não importar no frontend.

/** Parâmetros argon2id (OWASP: m=19MiB, t=2, p=1 como mínimo). */
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
