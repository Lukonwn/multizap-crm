import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { CampaignPreparer } from '../src/campaigns/preparer';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
const preparer = new CampaignPreparer(prisma);
afterAll(() => prisma.$disconnect());

let A: string;
let B: string;
beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
  A = (await prisma.account.create({ data: { name: 'A', connectionType: 'WHATSAPP_WEB' } })).id;
  B = (await prisma.account.create({ data: { name: 'B', connectionType: 'WHATSAPP_WEB' } })).id;
});

const contact = (accountId: string, phone: string, data: object = {}) =>
  prisma.contact.create({
    data: { accountId, phoneE164: phone, consentStatus: 'GRANTED', ...data },
  });

describe('preparação da fila', () => {
  it('inclui somente contatos autorizados, não descadastrados e da própria instância', async () => {
    const vip = await prisma.tag.create({ data: { accountId: A, name: 'vip' } });
    const c1 = await contact(A, '+5511900000001');
    await prisma.contactTag.create({ data: { contactId: c1.id, tagId: vip.id } });
    const c2 = await contact(A, '+5511900000002');
    await prisma.contactTag.create({ data: { contactId: c2.id, tagId: vip.id } });
    await contact(A, '+5511900000003'); // sem a etiqueta
    const pend = await contact(A, '+5511900000004', { consentStatus: 'PENDING' });
    await prisma.contactTag.create({ data: { contactId: pend.id, tagId: vip.id } });
    const out = await contact(A, '+5511900000005', {
      optedOutAt: new Date(),
      consentStatus: 'REVOKED',
    });
    await prisma.contactTag.create({ data: { contactId: out.id, tagId: vip.id } });
    // opt-out registrado mesmo com contato ainda "autorizado" (defesa extra)
    const ghost = await contact(A, '+5511900000006');
    await prisma.contactTag.create({ data: { contactId: ghost.id, tagId: vip.id } });
    await prisma.optOut.create({
      data: { accountId: A, phoneE164: '+5511900000006', source: 'x' },
    });
    await contact(B, '+5511900000001'); // mesmo telefone em outra instância

    const c = await prisma.campaign.create({
      data: { name: 'Promo', status: 'SCHEDULED', body: 'Oi', scheduledAt: new Date() },
    });
    await prisma.campaignAccount.create({
      data: { campaignId: c.id, accountId: A, audience: { tagIds: [vip.id] } },
    });
    const childB = await prisma.campaignAccount.create({
      data: { campaignId: c.id, accountId: B, audience: { tagIds: [] } },
    });

    expect(await preparer.due()).toEqual([c.id]);
    await preparer.prepare(c.id);

    const recipients = await prisma.campaignRecipient.findMany({
      include: { campaignAccount: true },
    });
    const phonesA = recipients
      .filter((r) => r.accountId === A)
      .map((r) => r.phoneE164)
      .sort();
    expect(phonesA).toEqual(['+5511900000001', '+5511900000002']);
    expect(recipients.filter((r) => r.campaignAccountId === childB.id)).toHaveLength(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('READY');
    expect(
      await prisma.systemNotification.count({
        where: { title: 'Campanha pronta para envio assistido' },
      }),
    ).toBe(1);
    // nenhuma mensagem foi criada: só a fila
    expect(await prisma.message.count()).toBe(0);
  });

  it('é idempotente e ignora campanhas não agendadas', async () => {
    await contact(A, '+5511900000001');
    const c = await prisma.campaign.create({
      data: { name: 'X', status: 'SCHEDULED', body: 'Oi', scheduledAt: new Date() },
    });
    await prisma.campaignAccount.create({ data: { campaignId: c.id, accountId: A } });
    await preparer.prepare(c.id);
    await preparer.prepare(c.id);
    expect(await prisma.campaignRecipient.count()).toBe(1);
    const draft = await prisma.campaign.create({
      data: { name: 'D', status: 'DRAFT', body: 'Oi' },
    });
    await preparer.prepare(draft.id);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'DRAFT',
    );
  });

  it('campanha sem destinatários elegíveis conclui imediatamente', async () => {
    const c = await prisma.campaign.create({
      data: { name: 'Vazia', status: 'SCHEDULED', body: 'Oi', scheduledAt: new Date() },
    });
    await prisma.campaignAccount.create({ data: { campaignId: c.id, accountId: A } });
    await preparer.prepare(c.id);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      'COMPLETED',
    );
  });

  it('não dispara campanhas agendadas para o futuro', async () => {
    await prisma.campaign.create({
      data: {
        name: 'F',
        status: 'SCHEDULED',
        body: 'Oi',
        scheduledAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await preparer.due()).toEqual([]);
  });
});
