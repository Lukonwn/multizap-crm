import { getPrisma } from '@multizap/database';
import { cipherFromEnv } from '@multizap/shared/crypto';
import { reencryptCredentials } from './reencrypt';

/**
 * Rotação da chave das credenciais (executar manualmente no multizap-gateway):
 *   node apps/gateway/dist/reencrypt-cli.js
 * Requer a chave nova em CREDENTIALS_MASTER_KEY (com CREDENTIALS_KEY_VERSION
 * incrementada) e a antiga em CREDENTIALS_MASTER_KEY_V<versão antiga>.
 */
const prisma = getPrisma();
try {
  const cipher = cipherFromEnv();
  const r = await reencryptCredentials(prisma, cipher);
  console.log(`Chave atual: versão ${cipher.keyVersion}.`);
  console.log(
    `Recriptografados: ${r.updated}. Já na versão atual: ${r.current}. Ilegíveis (mantidos): ${r.unreadable}.`,
  );
  if (r.unreadable) process.exitCode = 2;
} catch (err) {
  console.error(`Falha: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
