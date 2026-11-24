import type { PrismaClient } from '@multizap/database';
import type { CredentialCipher } from '@multizap/shared/crypto';
import { credsAad, keyAad } from './whatsapp/auth-store';

/** Versão da chave gravada no cabeçalho do blob (bytes 1-2). */
export const blobKeyVersion = (blob: Uint8Array) => Buffer.from(blob).readUInt16BE(1);

/**
 * Recriptografa com a chave atual todas as credenciais gravadas com chaves
 * antigas (rotação da CREDENTIALS_MASTER_KEY). Cada registro é lido com a
 * chave da sua versão e regravado com a atual; registros ilegíveis são
 * contados e mantidos como estão (nada é apagado).
 */
export async function reencryptCredentials(
  prisma: PrismaClient,
  cipher: CredentialCipher,
): Promise<{ updated: number; current: number; unreadable: number }> {
  const out = { updated: 0, current: 0, unreadable: 0 };
  const redo = (blob: Uint8Array, aad: string): Uint8Array<ArrayBuffer> | null => {
    if (blobKeyVersion(blob) === cipher.keyVersion) {
      out.current++;
      return null;
    }
    try {
      const plain = cipher.decrypt(Buffer.from(blob), aad);
      out.updated++;
      return new Uint8Array(cipher.encrypt(plain, aad));
    } catch {
      out.unreadable++;
      return null;
    }
  };

  for (const i of await prisma.integration.findMany({ where: { NOT: { credentialsEnc: null } } })) {
    const enc = redo(i.credentialsEnc!, credsAad(i.accountId));
    if (enc)
      await prisma.integration.update({
        where: { id: i.id },
        data: { credentialsEnc: enc, keyVersion: cipher.keyVersion },
      });
  }
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.integrationKey.findMany({
      take: 500,
      orderBy: { id: 'asc' },
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    });
    if (!rows.length) break;
    for (const r of rows) {
      const enc = redo(r.valueEnc, keyAad(r.accountId, r.type, r.keyId));
      if (enc) await prisma.integrationKey.update({ where: { id: r.id }, data: { valueEnc: enc } });
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return out;
}
