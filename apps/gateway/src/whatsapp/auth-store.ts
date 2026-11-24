import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import type { PrismaClient } from '@multizap/database';
import type { CredentialCipher } from '@multizap/shared/crypto';
import type { AuthStoreLike } from '../session/types';

export const PROVIDER_ID = 'whatsapp-web';

/**
 * Estado de autenticação da sessão persistido no PostgreSQL, sempre
 * criptografado (AES-256-GCM, com AAD vinculando cada valor à instância).
 *
 * Substitui o useMultiFileAuthState do Baileys: nada é gravado no filesystem
 * do container, então reinícios e novos deploys não perdem a sessão.
 */
export class DbAuthStore implements AuthStoreLike {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: CredentialCipher,
  ) {}

  private credsAad = (accountId: string) => `account:${accountId}:creds`;
  private keyAad = (accountId: string, type: string, id: string) =>
    `account:${accountId}:key:${type}:${id}`;

  private encrypt(value: unknown, aad: string): Uint8Array<ArrayBuffer> {
    // Cópia em um ArrayBuffer próprio (tipo exigido pelo Prisma para colunas Bytes).
    return new Uint8Array(this.cipher.encrypt(JSON.stringify(value, BufferJSON.replacer), aad));
  }

  private decrypt<T>(blob: Uint8Array, aad: string): T {
    return JSON.parse(
      this.cipher.decrypt(Buffer.from(blob), aad).toString('utf8'),
      BufferJSON.reviver,
    ) as T;
  }

  async load(
    accountId: string,
  ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const integration = await this.prisma.integration.findUnique({ where: { accountId } });
    const creds: AuthenticationCreds = integration?.credentialsEnc
      ? this.decrypt<AuthenticationCreds>(integration.credentialsEnc, this.credsAad(accountId))
      : initAuthCreds();

    const keys: AuthenticationState['keys'] = {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const rows = await this.prisma.integrationKey.findMany({
          where: { accountId, type, keyId: { in: ids } },
        });
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const row of rows) {
          let value = this.decrypt<unknown>(row.valueEnc, this.keyAad(accountId, type, row.keyId));
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          out[row.keyId] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: async (data) => {
        const ops = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [keyId, value] of Object.entries(entries ?? {})) {
            if (value === null || value === undefined) {
              ops.push(
                this.prisma.integrationKey.deleteMany({ where: { accountId, type, keyId } }),
              );
            } else {
              const valueEnc = this.encrypt(value, this.keyAad(accountId, type, keyId));
              ops.push(
                this.prisma.integrationKey.upsert({
                  where: { accountId_type_keyId: { accountId, type, keyId } },
                  create: { accountId, type, keyId, valueEnc, keyVersion: this.cipher.keyVersion },
                  update: { valueEnc, keyVersion: this.cipher.keyVersion },
                }),
              );
            }
          }
        }
        if (ops.length) await this.prisma.$transaction(ops);
      },
    };

    const saveCreds = async () => {
      const credentialsEnc = this.encrypt(creds, this.credsAad(accountId));
      await this.prisma.integration.upsert({
        where: { accountId },
        create: {
          accountId,
          provider: PROVIDER_ID,
          credentialsEnc,
          keyVersion: this.cipher.keyVersion,
        },
        update: { credentialsEnc, keyVersion: this.cipher.keyVersion },
      });
    };

    return { state: { creds, keys }, saveCreds };
  }

  async clear(accountId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.integrationKey.deleteMany({ where: { accountId } }),
      this.prisma.integration.updateMany({
        where: { accountId },
        data: { credentialsEnc: null, pairedAt: null, waJid: null, deviceName: null },
      }),
    ]);
  }
}
