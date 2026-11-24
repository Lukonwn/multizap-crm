import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WAMessage } from 'baileys';
import { InboxIngest, previewOf } from '../src/inbox/ingest';
import { PhotoSync } from '../src/inbox/photo-sync';
import { normalizeMessage } from '../src/whatsapp/normalize';
import type { IncomingMessage } from '../src/session/types';
import { resetDb, testPrisma } from './helpers';

const prisma = testPrisma();
const ingest = new InboxIngest(prisma, null);
const identities = ingest.identities;
let accountId: string;

const LID = '188123456789012@lid';
const PN = '5511987654321@s.whatsapp.net';

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `M${Math.random().toString(36).slice(2)}`,
  chatJid: LID,
  phoneE164: null,
  fromMe: false,
  timestamp: new Date(),
  type: 'text',
  text: 'Olá!',
  pushName: null,
  ...over,
});

beforeEach(async () => {
  await resetDb(prisma);
  accountId = (
    await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
});
afterAll(() => prisma.$disconnect());

describe('conversas por LID (como o WhatsApp entrega hoje)', () => {
  it('sem informação nenhuma, a conversa aparece sem nome nem telefone', async () => {
    await ingest.ingest(accountId, [msg()], false);
    const c = await prisma.conversation.findFirstOrThrow();
    expect(c.remoteJid).toBe(LID);
    expect(c.title).toBeNull();
    expect(c.phoneE164).toBeNull();
  });

  it('quando o WhatsApp informa nome e telefone, a conversa passa a mostrá-los', async () => {
    await ingest.ingest(accountId, [msg({ text: 'primeira' })], false);
    const n = await identities.apply(accountId, [
      { id: LID, lid: LID, phoneJid: PN, savedName: 'Joana (cliente)', pushName: 'Joana L.' },
    ]);
    expect(n).toBe(1);
    const c = await prisma.conversation.findFirstOrThrow();
    expect(c.remoteJid).toBe(PN); // endereço migrado para o telefone
    expect(c.phoneE164).toBe('+5511987654321');
    expect(c.title).toBe('Joana (cliente)'); // nome da agenda vence o nome de perfil
    expect(await prisma.message.count({ where: { conversationId: c.id } })).toBe(1);
  });

  it('nome de perfil serve enquanto não há nome salvo, e o salvo o substitui depois', async () => {
    await ingest.ingest(accountId, [msg({ pushName: 'Joana L.' })], false);
    expect((await prisma.conversation.findFirstOrThrow()).title).toBe('Joana L.');
    await identities.apply(accountId, [{ id: LID, savedName: 'Joana Lima' }]);
    expect((await prisma.conversation.findFirstOrThrow()).title).toBe('Joana Lima');
  });

  it('une a conversa por LID e a do telefone, sem perder mensagens', async () => {
    await ingest.ingest(
      accountId,
      [
        msg({ id: 'L1', text: 'antiga', timestamp: new Date(Date.now() - 3_600_000) }),
        msg({ id: 'P1', chatJid: PN, phoneE164: '+5511987654321', text: 'nova' }),
      ],
      false,
    );
    expect(await prisma.conversation.count()).toBe(2);
    await identities.apply(accountId, [{ lid: LID, phoneJid: PN }]);
    const convs = await prisma.conversation.findMany();
    expect(convs).toHaveLength(1);
    expect(convs[0]!.remoteJid).toBe(PN);
    expect(convs[0]!.unreadCount).toBe(2);
    expect(convs[0]!.lastMessagePreview).toBe('nova');
    expect(await prisma.message.count({ where: { conversationId: convs[0]!.id } })).toBe(2);
  });

  it('mensagens seguintes por LID já caem na conversa do telefone conhecido', async () => {
    await identities.apply(accountId, [{ lid: LID, phoneJid: PN, savedName: 'Joana Lima' }]);
    await ingest.ingest(accountId, [msg()], false);
    const c = await prisma.conversation.findFirstOrThrow();
    expect(c.remoteJid).toBe(PN);
    expect(c.phoneE164).toBe('+5511987654321');
    expect(c.title).toBe('Joana Lima');
  });

  it('não cria contatos do CRM (só vincula os que já existem)', async () => {
    await ingest.ingest(accountId, [msg()], false);
    await identities.apply(accountId, [{ lid: LID, phoneJid: PN, savedName: 'Joana Lima' }]);
    expect(await prisma.contact.count()).toBe(0);
    const existing = await prisma.contact.create({
      data: { accountId, phoneE164: '+5511987654321', name: 'Joana CRM' },
    });
    await identities.apply(accountId, [{ lid: LID, phoneJid: PN, pushName: 'Outro nome' }]);
    expect((await prisma.conversation.findFirstOrThrow()).contactId).toBe(existing.id);
    expect(await prisma.contact.count()).toBe(1);
  });

  it('isola as identidades por instância e ignora dados sem utilidade', async () => {
    const other = (
      await prisma.account.create({ data: { name: 'Suporte', connectionType: 'WHATSAPP_WEB' } })
    ).id;
    await ingest.ingest(other, [msg()], false);
    await identities.apply(accountId, [{ lid: LID, phoneJid: PN, savedName: 'Só da Vendas' }]);
    expect((await prisma.conversation.findFirstOrThrow()).title).toBeNull();
    expect(await identities.apply(accountId, [{ id: LID }])).toBe(0); // sem nome nem telefone
    expect(
      await identities.apply(accountId, [{ lid: LID, phoneJid: PN, savedName: 'Só da Vendas' }]),
    ).toBe(0); // repetido
  });
});

describe('resiliência', () => {
  it('falha ao registrar identidade nunca impede a gravação da mensagem', async () => {
    const broken = new InboxIngest(prisma, null);
    broken.identities.apply = async () => {
      throw new Error('tabela indisponível');
    };
    broken.identities.lookup = async () => {
      throw new Error('tabela indisponível');
    };
    await broken.ingest(accountId, [msg({ id: 'R1', pushName: 'Joana' })], false);
    expect(await prisma.message.count({ where: { providerMessageId: 'R1' } })).toBe(1);
    expect((await prisma.conversation.findFirstOrThrow()).title).toBe('Joana');
  });
});

describe('leitura das mensagens', () => {
  const wa = (m: object): WAMessage =>
    ({ key: { id: 'X', remoteJid: LID }, messageTimestamp: 1_790_000_000, ...m }) as WAMessage;

  it('usa o telefone conhecido pela correspondência e guarda o LID original', () => {
    const n = normalizeMessage(wa({ message: { conversation: 'oi' } }), PN);
    expect(n).toMatchObject({ chatJid: PN, lidJid: LID, phoneE164: '+5511987654321' });
    expect(normalizeMessage(wa({ message: { conversation: 'oi' } }))).toMatchObject({
      chatJid: LID,
      phoneE164: null,
    });
  });

  it('entende mais tipos e mostra o nome técnico dos que ainda não trata', () => {
    expect(
      normalizeMessage(wa({ message: { pollCreationMessage: { name: 'Almoço?' } } })),
    ).toMatchObject({
      type: 'other',
      text: 'Enquete: Almoço?',
    });
    expect(
      normalizeMessage(wa({ message: { listResponseMessage: { title: 'Opção 2' } } })),
    ).toMatchObject({
      type: 'text',
      text: 'Opção 2',
    });
    expect(normalizeMessage(wa({ message: { ptvMessage: {} } }))).toMatchObject({ type: 'video' });
    const unknown = normalizeMessage(wa({ message: { orderMessage: {} } }))!;
    expect(unknown).toMatchObject({ type: 'other', kind: 'orderMessage', text: '(orderMessage)' });
    expect(previewOf(unknown)).toBe('(orderMessage)');
    expect(previewOf({ type: 'audio', text: null })).toBe('[Áudio]');
  });

  it('tipo não tratado gera um evento (uma vez por tipo) para diagnóstico', async () => {
    const u = normalizeMessage(wa({ message: { orderMessage: {} } }))!;
    await ingest.ingest(accountId, [{ ...u, id: 'U1' }], false);
    await ingest.ingest(accountId, [{ ...u, id: 'U2' }], false);
    const ev = await prisma.systemEvent.findMany({ where: { type: 'unhandled_message_kind' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toContain('orderMessage');
  });
});

describe('fotos de perfil', () => {
  const png = Buffer.from([1, 2, 3, 4]);
  const okFetch = (async () =>
    new Response(png, { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;
  const store = () => {
    const files = new Map<string, Buffer>();
    return {
      files,
      put: async (k: string, b: Buffer) => void files.set(k, b),
    } as unknown as import('@multizap/storage').StorageDriver & { files: Map<string, Buffer> };
  };

  it('guarda a foto das conversas recentes e só reverifica depois de alguns dias', async () => {
    await ingest.ingest(accountId, [msg({ chatJid: PN, phoneE164: '+5511987654321' })], false);
    const calls: string[] = [];
    const storage = store();
    const sync = new PhotoSync(
      prisma,
      storage,
      {
        connectedAccounts: () => [accountId],
        profilePicture: async (_a, jid) => {
          calls.push(jid);
          return 'https://pps.whatsapp.net/foto.jpg';
        },
      },
      undefined,
      { delayMs: 0, fetchImpl: okFetch },
    );
    expect(await sync.runAccount(accountId)).toEqual({ checked: 1, saved: 1 });
    const c = await prisma.conversation.findFirstOrThrow();
    expect(c.photoKey).toMatch(/^avatars\/.+\.jpg$/);
    expect(storage.files.get(c.photoKey!)).toEqual(png);
    expect(await sync.runAccount(accountId)).toEqual({ checked: 0, saved: 0 });
    expect(calls).toEqual([PN]);
  });

  it('sem foto ou foto privada não é erro; limite de taxa pausa a busca', async () => {
    await ingest.ingest(accountId, [msg({ chatJid: PN, phoneE164: '+5511987654321' })], false);
    const none = new PhotoSync(
      prisma,
      store(),
      { connectedAccounts: () => [accountId], profilePicture: async () => null },
      undefined,
      { delayMs: 0 },
    );
    expect(await none.runAccount(accountId)).toEqual({ checked: 1, saved: 0 });
    expect((await prisma.conversation.findFirstOrThrow()).photoKey).toBeNull();
    expect((await prisma.conversation.findFirstOrThrow()).photoCheckedAt).not.toBeNull();

    await prisma.conversation.updateMany({ data: { photoCheckedAt: null } });
    let calls = 0;
    const limited = new PhotoSync(
      prisma,
      store(),
      {
        connectedAccounts: () => [accountId],
        profilePicture: async () => {
          calls++;
          throw new Error('rate-overlimit');
        },
      },
      undefined,
      { delayMs: 0 },
    );
    expect(await limited.runAccount(accountId)).toEqual({ checked: 0, saved: 0 });
    expect(await limited.runAccount(accountId)).toEqual({ checked: 0, saved: 0 }); // pausada
    expect(calls).toBe(1);
  });

  it('recusa foto que não seja imagem https', async () => {
    await ingest.ingest(accountId, [msg({ chatJid: PN, phoneE164: '+5511987654321' })], false);
    const bad = (async () =>
      new Response('<html>', {
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const sync = new PhotoSync(
      prisma,
      store(),
      { connectedAccounts: () => [accountId], profilePicture: async () => 'https://x/y' },
      undefined,
      { delayMs: 0, fetchImpl: bad },
    );
    expect(await sync.runAccount(accountId)).toEqual({ checked: 1, saved: 0 });
    const http = new PhotoSync(
      prisma,
      store(),
      { connectedAccounts: () => [accountId], profilePicture: async () => 'http://x/y' },
      undefined,
      { delayMs: 0, fetchImpl: okFetch },
    );
    await prisma.conversation.updateMany({ data: { photoCheckedAt: null } });
    expect(await http.runAccount(accountId)).toEqual({ checked: 1, saved: 0 });
  });
});
