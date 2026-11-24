import { getPrisma } from './client';
import { ensureBootstrapAdmin } from './admin';

const prisma = getPrisma();
const result = await ensureBootstrapAdmin(prisma, {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_INITIAL_PASSWORD,
});
console.log(
  {
    created: 'Administrador inicial criado (troca de senha obrigatória no primeiro login).',
    exists: 'Administrador já existe — nada alterado.',
    skipped: 'ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD não definidos — nada criado.',
  }[result],
);
await prisma.$disconnect();
