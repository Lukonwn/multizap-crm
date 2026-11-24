import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WAMessage } from 'baileys';
import type { StorageDriver } from '@multizap/storage';
import { InboxIngest } from '../src/inbox/ingest';
import { normalizeMessage } from '../src/whatsapp/normalize';
import { PENDING_CONTENT_TEXT, type IncomingMessage } from '../src/session/types';
import { resetDb, testPrisma } from './helpers';

const prisma = testPrisma();
let accountId: string;

const PN = '5511987654321@s.whatsapp.net';
const wa = (message: object): WAMessage =>
  ({ key: { id: 'X', remoteJid: PN }, messageTimestamp: 1_790_000_000, message }) as WAMessage;
const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'M1',
  chatJid: PN,
  phoneE164: '+5511987654321',
  fromMe: false,
  timestamp: new Date(),
  type: 'text',
  text: 'Olá',
  pushName: null,
  ...over,
});
const fakeStorage = () => {
  const files = new Map<string, { body: Buffer; type?: string }>();
  return {
    files,
    put: async (k: string, b: Buffer, o?: { contentType?: string }) =>
      void files.set(k, { body: b, type: o?.contentType }),
  } as unknown as StorageDriver & { files: Map<string, { body: Buffer; type?: string }> };
};

beforeEach(async () => {
  await resetDb(prisma);
  accountId = (
    await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
});
afterAll(() => prisma.$disconnect());

describe('mensagens de empresa (modelos, botões e listas)', () => {
  it('modelo (templateMessage) mostra título, texto, rodapé e botões', () => {
    const n = normalizeMessage(
      wa({
        templateMessage: {
          hydratedTemplate: {
            hydratedTitleText: 'Sua corrida',
            hydratedContentText: 'O motorista chegou ao local.',
            hydratedFooterText: 'Equipe 99',
            hydratedButtons: [
              { quickReplyButton: { displayText: 'Ver corrida' } },
              { urlButton: { displayText: 'Abrir app' } },
            ],
          },
        },
      }),
    )!;
    expect(n.type).toBe('text');
    expect(n.text).toBe(
      'Sua corrida\nO motorista chegou ao local.\nEquipe 99\nBotões: Ver corrida · Abrir app',
    );
  });

  it('mensagem interativa, botões e lista', () => {
    expect(
      normalizeMessage(
        wa({
          interactiveMessage: {
            header: { title: 'Pedido' },
            body: { text: 'Confirme o pagamento' },
            nativeFlowMessage: {
              buttons: [
                { buttonParamsJson: '{"display_text":"Pagar"}' },
                { buttonParamsJson: 'inválido' },
              ],
            },
          },
        }),
      )!.text,
    ).toBe('Pedido\nConfirme o pagamento\nBotões: Pagar');
    expect(
      normalizeMessage(
        wa({
          buttonsMessage: {
            contentText: 'Quer receber?',
            buttons: [{ buttonText: { displayText: 'Sim' } }],
          },
        }),
      )!.text,
    ).toBe('Quer receber?\nBotões: Sim');
    expect(
      normalizeMessage(
        wa({ listMessage: { title: 'Menu', description: 'Escolha', buttonText: 'Abrir' } }),
      )!.text,
    ).toBe('Menu\nEscolha\nLista: Abrir');
  });

  it('modelo sem texto legível continua identificado pelo nome do tipo', () => {
    expect(normalizeMessage(wa({ templateMessage: {} }))).toMatchObject({
      type: 'other',
      text: '(templateMessage)',
      kind: 'templateMessage',
    });
  });

  it('áudio guarda tipo e duração; marcador pendente é identificado', () => {
    expect(
      normalizeMessage(
        wa({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true } }),
      ),
    ).toMatchObject({ type: 'audio', mimetype: 'audio/ogg; codecs=opus', seconds: 12 });
    expect(normalizeMessage(wa({ placeholderMessage: {} }))).toMatchObject({
      type: 'other',
      pending: true,
      text: PENDING_CONTENT_TEXT,
    });
  });
});

describe('mensagem reenviada pelo celular (mesmo ID)', () => {
  it('substitui o marcador pelo conteúdo real, sem duplicar nem mexer nas não lidas', async () => {
    const ingest = new InboxIngest(prisma, null);
    await ingest.ingest(
      accountId,
      [msg({ id: 'P1', type: 'other', text: PENDING_CONTENT_TEXT, pending: true })],
      false,
    );
    let c = await prisma.conversation.findFirstOrThrow();
    expect(c.lastMessagePreview).toBe(PENDING_CONTENT_TEXT.slice(0, 120));
    expect(c.unreadCount).toBe(1);

    // reenvio ainda sem conteúdo: nada muda
    await ingest.ingest(
      accountId,
      [msg({ id: 'P1', type: 'other', text: PENDING_CONTENT_TEXT, pending: true })],
      false,
    );
    expect((await prisma.message.findFirstOrThrow()).type).toBe('other');

    await ingest.ingest(accountId, [msg({ id: 'P1', text: 'Quero comprar 2 unidades' })], false);
    const m = await prisma.message.findMany();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ type: 'text', body: 'Quero comprar 2 unidades' });
    c = await prisma.conversation.findFirstOrThrow();
    expect(c.lastMessagePreview).toBe('Quero comprar 2 unidades');
    expect(c.unreadCount).toBe(1);
  });

  it('corrige mensagens antigas gravadas como "tipo não tratado" quando o WhatsApp as entrega de novo', async () => {
    const ingest = new InboxIngest(prisma, null);
    await ingest.ingest(
      accountId,
      [msg({ id: 'T1', type: 'other', text: '(templateMessage)', kind: 'templateMessage' })],
      true,
    );
    await ingest.ingest(
      accountId,
      [msg({ id: 'T1', type: 'text', text: 'Seu código é 1234' })],
      true,
    );
    expect(await prisma.message.findFirstOrThrow()).toMatchObject({
      type: 'text',
      body: 'Seu código é 1234',
    });
  });

  it('não altera mensagens de texto já gravadas', async () => {
    const ingest = new InboxIngest(prisma, null);
    await ingest.ingest(accountId, [msg({ id: 'K1', text: 'original' })], false);
    await ingest.ingest(accountId, [msg({ id: 'K1', text: 'outro texto' })], false);
    expect((await prisma.message.findFirstOrThrow()).body).toBe('original');
  });

  it('"SAIR" que chega atrasado, no lugar do marcador, ainda descadastra o contato', async () => {
    const ingest = new InboxIngest(prisma, null);
    await prisma.contact.create({
      data: { accountId, phoneE164: '+5511987654321', name: 'Joana', consentStatus: 'GRANTED' },
    });
    await ingest.ingest(
      accountId,
      [msg({ id: 'S1', type: 'other', text: PENDING_CONTENT_TEXT, pending: true })],
      false,
    );
    expect((await prisma.contact.findFirstOrThrow()).optedOutAt).toBeNull();
    await ingest.ingest(accountId, [msg({ id: 'S1', text: 'SAIR' })], false);
    const c = await prisma.contact.findFirstOrThrow();
    expect(c.optedOutAt).not.toBeNull();
    expect(c.consentStatus).toBe('REVOKED');
    expect(await prisma.optOut.count()).toBe(1);
  });
});

describe('áudios', () => {
  const audio = (over: Partial<IncomingMessage> = {}, bytes = Buffer.from([1, 2, 3])) =>
    msg({
      id: 'A1',
      type: 'audio',
      text: null,
      mimetype: 'audio/ogg; codecs=opus',
      download: async () => bytes,
      ...over,
    });

  it('áudio recebido ao vivo é guardado e fica disponível para tocar', async () => {
    const storage = fakeStorage();
    await new InboxIngest(prisma, storage).ingest(accountId, [audio()], false);
    const m = await prisma.message.findFirstOrThrow();
    expect(m.mediaKey).toBe(`media/${accountId}/A1.ogg`);
    expect(storage.files.get(m.mediaKey!)).toEqual({
      body: Buffer.from([1, 2, 3]),
      type: 'audio/ogg; codecs=opus',
    });
  });

  it('áudio do histórico é baixado em segundo plano; falha ou arquivo grande não perdem a mensagem', async () => {
    const storage = fakeStorage();
    const ingest = new InboxIngest(prisma, storage);
    await ingest.ingest(
      accountId,
      [
        audio({ id: 'H1' }),
        audio({ id: 'H2', download: async () => Promise.reject(new Error('404 expirado')) }),
        audio({ id: 'H3' }, Buffer.alloc(9 * 1024 * 1024)),
      ],
      true,
    );
    await ingest.mediaIdle();
    const byId = Object.fromEntries(
      (await prisma.message.findMany()).map((m) => [m.providerMessageId, m.mediaKey]),
    );
    expect(byId).toEqual({ H1: `media/${accountId}/H1.ogg`, H2: null, H3: null });
    expect([...storage.files.keys()]).toEqual([`media/${accountId}/H1.ogg`]);
  });

  it('escolhe a extensão pelo tipo do áudio', async () => {
    const storage = fakeStorage();
    await new InboxIngest(prisma, storage).ingest(
      accountId,
      [audio({ id: 'E1', mimetype: 'audio/mpeg' }), audio({ id: 'E2', mimetype: 'audio/mp4' })],
      false,
    );
    expect([...storage.files.keys()].sort()).toEqual([
      `media/${accountId}/E1.mp3`,
      `media/${accountId}/E2.m4a`,
    ]);
  });
});
