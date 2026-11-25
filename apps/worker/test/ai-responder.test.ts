import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, setOperationsPause, type PrismaClient } from '@multizap/database';
import { AI_KEY_AAD, type GatewayCommand } from '@multizap/shared';
import { CredentialCipher } from '@multizap/shared/crypto';
import { AiResponder } from '../src/ai/responder';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
afterAll(() => prisma.$disconnect());

const cipher = new CredentialCipher(new Map([[1, randomBytes(32)]]), 1);

const truncateAll = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
};

let sent: GatewayCommand[];
let chatCalls: { body: { messages: { role: string; content: string }[] } }[];
let chatStatus: number;

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/chat/completions')) {
    chatCalls.push({ body: JSON.parse(String(init?.body)) });
    if (chatStatus !== 200)
      return new Response(JSON.stringify({ error: { message: 'x' } }), { status: chatStatus });
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: 'Olá! Posso ajudar.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0002 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) as unknown as typeof fetch;

const responder = () =>
  new AiResponder({
    prisma,
    cipher,
    gateway: { send: async (c) => void sent.push(c) },
    fetchImpl: fakeFetch,
    sleep: async () => undefined,
  });

interface Ctx {
  accountId: string;
  conversationId: string;
  messageId: string;
  agentId: string;
}

async function setup(mode: 'REVIEW' | 'AUTO' = 'REVIEW', text = 'Oi, quero um café'): Promise<Ctx> {
  const acc = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const conv = await prisma.conversation.create({
    data: {
      accountId: acc.id,
      remoteJid: '5511977776666@s.whatsapp.net',
      phoneE164: '+5511977776666',
      title: 'Cliente',
      lastMessageAt: new Date(),
    },
  });
  const msg = await prisma.message.create({
    data: {
      accountId: acc.id,
      conversationId: conv.id,
      providerMessageId: `in-${randomBytes(4).toString('hex')}`,
      direction: 'INBOUND',
      type: 'text',
      body: text,
      status: 'RECEIVED',
      sentAt: new Date(),
    },
  });
  const persona = await prisma.aiPersona.create({ data: { name: 'Marina' } });
  const agent = await prisma.aiAgent.create({
    data: {
      name: 'Atendente',
      personaId: persona.id,
      model: 'openai/gpt-4o-mini',
      mode,
      status: 'ACTIVE',
      minIntervalSeconds: 0,
    },
  });
  const version = await prisma.aiAgentVersion.create({
    data: {
      agentId: agent.id,
      number: 1,
      snapshot: {
        agent: {
          name: 'Atendente',
          model: 'openai/gpt-4o-mini',
          temperature: null,
          maxTokens: 400,
          instructions: null,
          memoryEnabled: true,
          mode,
        },
        persona: { name: 'Marina' },
      },
    },
  });
  await prisma.aiAgent.update({
    where: { id: agent.id },
    data: { publishedVersionId: version.id },
  });
  await prisma.aiAgentAccount.create({ data: { agentId: agent.id, accountId: acc.id } });
  await prisma.aiCredential.create({
    data: {
      provider: 'openrouter',
      keyEnc: new Uint8Array(cipher.encrypt('sk-or-test-1234567890', AI_KEY_AAD)),
      keyVersion: 1,
      keyLast4: '7890',
    },
  });
  return { accountId: acc.id, conversationId: conv.id, messageId: msg.id, agentId: agent.id };
}

const run = (c: Ctx) =>
  responder().handle({
    accountId: c.accountId,
    conversationId: c.conversationId,
    messageId: c.messageId,
  });

beforeEach(async () => {
  await truncateAll();
  sent = [];
  chatCalls = [];
  chatStatus = 200;
});

describe('MultiZap AI: atendimento', () => {
  it('modo revisão: cria rascunho, registra uso real e não envia nada', async () => {
    const c = await setup('REVIEW');
    expect(await run(c)).toEqual({ status: 'drafted' });
    const d = await prisma.aiDraft.findMany();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: 'PENDING', autoSent: false, body: 'Olá! Posso ajudar.' });
    expect(sent).toEqual([]);
    expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(0);
    const u = await prisma.aiTokenUsage.findMany();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      context: 'LIVE',
      purpose: 'reply',
      promptTokens: 100,
      costConfirmed: true,
    });
    expect(u[0]!.accountId).toBe(c.accountId);
    // as regras fixas e a mensagem do contato chegaram ao modelo
    const msgs = chatCalls[0]!.body.messages;
    expect(msgs[0]!.content).toMatch(/não afirme ser humano/i);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'Oi, quero um café' });
  });

  it('é idempotente: o mesmo job repetido não gera segunda resposta', async () => {
    const c = await setup('REVIEW');
    await run(c);
    expect(await run(c)).toMatchObject({ status: 'skipped' });
    expect(await prisma.aiDraft.count()).toBe(1);
    expect(chatCalls).toHaveLength(1);
  });

  it('modo automático: grava a resposta marcada como da IA e manda o gateway enviar, com "digitando" só durante a geração', async () => {
    const c = await setup('AUTO');
    expect(await run(c)).toEqual({ status: 'sent' });
    const out = await prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
      include: { aiLink: true },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'PENDING', body: 'Olá! Posso ajudar.' });
    expect(out[0]!.providerMessageId.startsWith('pending:')).toBe(true);
    expect(out[0]!.aiLink).toMatchObject({ agentId: c.agentId, source: 'auto' });
    expect(sent.map((s) => s.type)).toEqual(['send-presence', 'send-presence', 'send-reply']);
    expect(sent[0]).toMatchObject({ state: 'composing' });
    expect(sent[1]).toMatchObject({ state: 'paused' });
    expect(sent[2]).toMatchObject({ messageId: out[0]!.id });
    expect(await prisma.aiDraft.findFirst()).toMatchObject({ status: 'SENT', autoSent: true });
  });

  it('o interruptor de modo vale na hora, sem nova publicação (versão publicada em revisão, agente em automático)', async () => {
    const c = await setup('REVIEW');
    await prisma.aiAgent.update({ where: { id: c.agentId }, data: { mode: 'AUTO' } });
    expect(await run(c)).toEqual({ status: 'sent' });
    expect(sent.map((x) => x.type)).toContain('send-reply');
    expect(await prisma.aiDraft.findFirst()).toMatchObject({ status: 'SENT', autoSent: true });
  });

  it('voltar para revisão humana interrompe o envio automático na hora', async () => {
    const c = await setup('AUTO');
    await prisma.aiAgent.update({ where: { id: c.agentId }, data: { mode: 'REVIEW' } });
    expect(await run(c)).toEqual({ status: 'drafted' });
    expect(sent).toEqual([]);
  });

  describe('base de conhecimento', () => {
    const addSource = async (agentId: string, name: string, content: string) => {
      const src = await prisma.aiKnowledgeSource.create({
        data: { name, kind: 'TEXT', content, status: 'READY', chunkCount: 1 },
      });
      await prisma.aiKnowledgeChunk.create({
        data: { sourceId: src.id, position: 0, title: name, content },
      });
      await prisma.aiAgentKnowledge.create({ data: { agentId, sourceId: src.id } });
      return src;
    };
    const systemPrompt = () => chatCalls[0]!.body.messages[0]!.content;

    it('usa os trechos relevantes no prompt e guarda em quais a resposta se baseou', async () => {
      const c = await setup('REVIEW', 'Vocês vendem café bourbon?');
      const src = await addSource(
        c.agentId,
        'Catálogo',
        'O café Bourbon amarelo custa R$ 42 o pacote de 250g.',
      );
      await addSource(c.agentId, 'Garantia', 'Garantia de um ano contra defeitos de fabricação.');
      expect(await run(c)).toEqual({ status: 'drafted' });
      expect(systemPrompt()).toContain('Informações da empresa');
      expect(systemPrompt()).toContain('R$ 42 o pacote');
      expect(systemPrompt()).not.toContain('defeitos de fabricação'); // trecho irrelevante fica de fora
      const draft = await prisma.aiDraft.findFirstOrThrow();
      expect(draft.sources).toEqual([
        expect.objectContaining({ sourceId: src.id, name: 'Catálogo' }),
      ]);
    });

    it('no modo automático o rascunho enviado também registra as fontes', async () => {
      const c = await setup('AUTO', 'Qual o prazo de entrega?');
      await addSource(c.agentId, 'Entrega', 'O prazo de entrega é de 3 dias úteis.');
      await run(c);
      const draft = await prisma.aiDraft.findFirstOrThrow();
      expect(draft).toMatchObject({ status: 'SENT', autoSent: true });
      expect((draft.sources as { name: string }[]).map((x) => x.name)).toEqual(['Entrega']);
    });

    it('sem trecho relevante, o agente é instruído a não inventar (e oferecer um atendente)', async () => {
      const c = await setup('REVIEW', 'Vocês aceitam pix?');
      await addSource(c.agentId, 'Garantia', 'Garantia de um ano contra defeitos de fabricação.');
      await run(c);
      expect(systemPrompt()).toMatch(/não traz nada sobre esta mensagem/);
      expect(systemPrompt()).toMatch(/cumprimentos e conversa em geral, responda normalmente/i);
      expect(systemPrompt()).not.toContain('Informações da empresa');
      expect((await prisma.aiDraft.findFirstOrThrow()).sources).toEqual([]);
    });

    it('saudação sem termos de busca ("Oi") não faz o agente tratar a base como lacuna nem empurrar para um atendente', async () => {
      const c = await setup('REVIEW', 'Oi');
      await addSource(
        c.agentId,
        'Catálogo',
        'O café Bourbon amarelo custa R$ 42 o pacote de 250g.',
      );
      await run(c);
      expect(systemPrompt()).not.toMatch(/não traz nada sobre esta mensagem/);
      expect(systemPrompt()).not.toContain('Informações da empresa');
    });

    it('agente sem base de conhecimento responde como antes (sem aviso de base vazia)', async () => {
      const c = await setup('REVIEW', 'Vocês aceitam pix?');
      await run(c);
      expect(systemPrompt()).not.toMatch(/base de conhecimento/i);
    });

    it('fonte desligada ou com erro não é usada', async () => {
      const c = await setup('REVIEW', 'Qual a garantia?');
      const src = await addSource(
        c.agentId,
        'Garantia',
        'Garantia de um ano para todos os produtos.',
      );
      await prisma.aiKnowledgeSource.update({ where: { id: src.id }, data: { enabled: false } });
      await run(c);
      expect(systemPrompt()).not.toContain('Garantia de um ano');
    });
  });

  describe('proteção de menor de idade', () => {
    const nextInbound = async (c: Ctx, text: string, afterMs = 5_000) => {
      const m = await prisma.message.create({
        data: {
          accountId: c.accountId,
          conversationId: c.conversationId,
          providerMessageId: `in-${randomBytes(4).toString('hex')}`,
          direction: 'INBOUND',
          type: 'text',
          body: text,
          status: 'RECEIVED',
          sentAt: new Date(Date.now() + afterMs),
        },
      });
      return { ...c, messageId: m.id };
    };

    it('revisão: sinal de menor pausa a conversa, avisa o administrador e não gera nem envia resposta', async () => {
      const c = await setup('REVIEW', 'Oi, tenho 15 anos');
      expect(await run(c)).toMatchObject({ status: 'skipped', reason: 'Possível menor de idade' });
      expect(chatCalls).toHaveLength(0);
      expect(sent).toEqual([]);
      expect(await prisma.aiDraft.count()).toBe(0);
      const st = await prisma.aiConversationState.findFirstOrThrow();
      expect(st).toMatchObject({ paused: true, pausedBy: 'minor' });
      expect(st.pausedReason).toMatch(/menor de idade.*15 anos/i);
      const n = await prisma.systemNotification.findFirstOrThrow();
      expect(n).toMatchObject({ category: 'SECURITY', severity: 'WARNING' });
      expect(await prisma.aiAgentEvent.count({ where: { category: 'AGENT', level: 'warn' } })).toBe(
        1,
      );
    });

    it('automático: manda uma única mensagem fixa e neutra, sem chamar o modelo', async () => {
      const c = await setup('AUTO', 'oi, sou menor de idade');
      await run(c);
      expect(chatCalls).toHaveLength(0);
      const out = await prisma.message.findMany({
        where: { direction: 'OUTBOUND' },
        include: { aiLink: true },
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        body: 'Não posso continuar esta conversa.',
        status: 'PENDING',
      });
      expect(out[0]!.aiLink).toMatchObject({ source: 'auto' });
      expect(sent.map((x) => x.type)).toEqual(['send-reply']);
      expect(await prisma.aiConversationState.findFirstOrThrow()).toMatchObject({
        paused: true,
        pausedBy: 'minor',
      });
    });

    it('depois do alerta a IA fica em silêncio, mesmo que o contato escreva de novo', async () => {
      const c = await setup('AUTO', 'tenho 14 anos');
      await run(c);
      const again = await nextInbound(c, 'e agora, vai responder?');
      expect(await run(again)).toMatchObject({ status: 'skipped' });
      expect(chatCalls).toHaveLength(0);
      expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(1); // só o aviso
    });

    it('o sinal vale mesmo em uma das últimas mensagens (a pessoa continua depois de dizer a idade)', async () => {
      const c = await setup('REVIEW', 'oi');
      await prisma.message.create({
        data: {
          accountId: c.accountId,
          conversationId: c.conversationId,
          providerMessageId: 'earlier',
          direction: 'INBOUND',
          type: 'text',
          body: 'tenho 16 aninhos',
          status: 'RECEIVED',
          sentAt: new Date(Date.now() - 30_000),
        },
      });
      await run(c);
      expect(chatCalls).toHaveLength(0);
      expect((await prisma.aiConversationState.findFirstOrThrow()).paused).toBe(true);
    });

    it('maior de idade e conversa comum não disparam nada', async () => {
      const c = await setup(
        'REVIEW',
        'tenho 25 anos e quero um café, a loja tem 10 anos de mercado?',
      );
      expect(await run(c)).toEqual({ status: 'drafted' });
      expect(await prisma.systemNotification.count()).toBe(0);
    });

    it('um sinal anterior ao reinício de contexto não conta', async () => {
      const c = await setup('REVIEW', 'quero um café');
      await prisma.message.create({
        data: {
          accountId: c.accountId,
          conversationId: c.conversationId,
          providerMessageId: 'old-minor',
          direction: 'INBOUND',
          type: 'text',
          body: 'tenho 15 anos',
          status: 'RECEIVED',
          sentAt: new Date(Date.now() - 3_600_000),
        },
      });
      await prisma.aiConversationState.create({
        data: { conversationId: c.conversationId, contextResetAt: new Date(Date.now() - 60_000) },
      });
      expect(await run(c)).toEqual({ status: 'drafted' });
    });

    describe('portão de idade (opcional)', () => {
      const enable = (c: Ctx) =>
        prisma.aiAgent.update({ where: { id: c.agentId }, data: { ageGate: true } });
      const question = 'Antes de continuar: você tem 18 anos ou mais? Responda sim ou não.';

      it('desligado por padrão: responde normalmente, sem perguntar a idade', async () => {
        const c = await setup('REVIEW', 'Oi');
        expect((await prisma.aiAgent.findUniqueOrThrow({ where: { id: c.agentId } })).ageGate).toBe(
          false,
        );
        await run(c);
        expect(chatCalls).toHaveLength(1);
        expect((await prisma.aiDraft.findFirstOrThrow()).body).not.toContain('18 anos');
      });

      it('ligado: pergunta primeiro (sem chamar o modelo); "sim" libera e a conversa segue', async () => {
        const c = await setup('AUTO', 'Oi');
        await enable(c);
        expect(await run(c)).toEqual({ status: 'sent' });
        expect(chatCalls).toHaveLength(0);
        expect(
          (await prisma.message.findFirstOrThrow({ where: { direction: 'OUTBOUND' } })).body,
        ).toBe(question);
        expect((await prisma.aiConversationState.findFirstOrThrow()).ageAskedAt).not.toBeNull();

        const yes = await nextInbound(c, 'sim');
        expect(await run(yes)).toEqual({ status: 'sent' });
        expect(chatCalls).toHaveLength(1);
        expect((await prisma.aiConversationState.findFirstOrThrow()).ageConfirmedAt).not.toBeNull();

        // confirmado uma vez: não pergunta de novo
        const more = await nextInbound(c, 'quero um café', 10_000);
        await run(more);
        expect(chatCalls).toHaveLength(2);
        const bodies = (await prisma.message.findMany({ where: { direction: 'OUTBOUND' } })).map(
          (m) => m.body,
        );
        expect(bodies.filter((b) => b === question)).toHaveLength(1);
      });

      it('ligado: "não" ou idade abaixo de 18 trava a conversa e encerra', async () => {
        for (const answer of ['não', 'tenho 16']) {
          await truncateAll();
          sent = [];
          chatCalls = [];
          const c = await setup('AUTO', 'Oi');
          await enable(c);
          await run(c);
          await run(await nextInbound(c, answer));
          const st = await prisma.aiConversationState.findFirstOrThrow();
          expect(st, answer).toMatchObject({ paused: true, pausedBy: 'minor' });
          const bodies = (
            await prisma.message.findMany({
              where: { direction: 'OUTBOUND' },
              orderBy: { sentAt: 'asc' },
            })
          ).map((m) => m.body);
          expect(bodies, answer).toEqual([question, 'Não posso continuar esta conversa.']);
          expect(chatCalls, answer).toHaveLength(0);
        }
      });

      it('ligado: resposta que não dá para entender repete a pergunta', async () => {
        const c = await setup('AUTO', 'Oi');
        await enable(c);
        await run(c);
        await run(await nextInbound(c, 'hm, depende'));
        const bodies = (await prisma.message.findMany({ where: { direction: 'OUTBOUND' } })).map(
          (m) => m.body,
        );
        expect(bodies).toEqual([question, question]);
        expect((await prisma.aiConversationState.findFirstOrThrow()).ageConfirmedAt).toBeNull();
        expect(chatCalls).toHaveLength(0);
      });

      it('ligado no modo revisão: a pergunta vira rascunho para o administrador aprovar', async () => {
        const c = await setup('REVIEW', 'Oi');
        await enable(c);
        expect(await run(c)).toEqual({ status: 'drafted' });
        expect((await prisma.aiDraft.findFirstOrThrow()).body).toBe(question);
        expect(sent).toEqual([]);
        expect(chatCalls).toHaveLength(0);
      });
    });
  });

  describe('reiniciar contexto da conversa', () => {
    /** Conversa "suja": pergunta antiga, resposta de pessoa e memória dizendo que aguarda atendente. */
    const dirty = async (c: Ctx) => {
      const mk = (id: string, direction: 'INBOUND' | 'OUTBOUND', body: string, ago: number) =>
        prisma.message.create({
          data: {
            accountId: c.accountId,
            conversationId: c.conversationId,
            providerMessageId: id,
            direction,
            type: 'text',
            body,
            status: direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
            sentAt: new Date(Date.now() - ago),
          },
        });
      await mk('old-in', 'INBOUND', 'Quanto custa o frete antigo?', 3 * 3_600_000);
      await mk('old-human', 'OUTBOUND', 'Vou chamar um atendente para você', 2 * 3_600_000);
      await prisma.aiConversationState.create({
        data: {
          conversationId: c.conversationId,
          memory: 'Contato aguarda atendente humano.',
          memoryAgentId: c.agentId,
          memoryUpdatedAt: new Date(Date.now() - 3_600_000),
        },
      });
    };

    it('controle: sem reinício, a resposta de pessoa recente faz a IA se afastar', async () => {
      const c = await setup('REVIEW', 'Oi, quero um café');
      await dirty(c);
      expect(await run(c)).toMatchObject({
        status: 'skipped',
        reason: 'Uma pessoa respondeu esta conversa',
      });
      expect(chatCalls).toHaveLength(0);
    });

    it('depois do reinício, a IA ignora histórico, memória e respostas humanas anteriores', async () => {
      const c = await setup('REVIEW', 'Oi, quero um café');
      await dirty(c);
      await prisma.aiConversationState.update({
        where: { conversationId: c.conversationId },
        data: {
          contextResetAt: new Date(Date.now() - 60_000),
          memory: null,
          memoryAgentId: null,
          memoryUpdatedAt: null,
        },
      });
      expect(await run(c)).toEqual({ status: 'drafted' });
      const msgs = chatCalls[0]!.body.messages;
      expect(msgs.slice(1).map((m) => m.content)).toEqual(['Oi, quero um café']);
      expect(msgs[0]!.content).not.toContain('aguarda atendente');
      expect(JSON.stringify(msgs)).not.toContain('frete antigo');
    });

    it('uma pessoa que responder DEPOIS do reinício ainda faz a IA se afastar', async () => {
      const c = await setup('REVIEW', 'Oi, quero um café');
      await prisma.aiConversationState.create({
        data: {
          conversationId: c.conversationId,
          contextResetAt: new Date(Date.now() - 3_600_000),
        },
      });
      await prisma.message.create({
        data: {
          accountId: c.accountId,
          conversationId: c.conversationId,
          providerMessageId: 'human-after-reset',
          direction: 'OUTBOUND',
          type: 'text',
          body: 'Oi, sou o João',
          status: 'SENT',
          sentAt: new Date(Date.now() - 1_800_000),
        },
      });
      expect(await run(c)).toMatchObject({
        status: 'skipped',
        reason: 'Uma pessoa respondeu esta conversa',
      });
    });
  });

  it('sem "digitando" quando o agente desliga o recurso', async () => {
    const c = await setup('AUTO');
    await prisma.aiAgent.update({ where: { id: c.agentId }, data: { showTyping: false } });
    await run(c);
    expect(sent.map((s) => s.type)).toEqual(['send-reply']);
  });

  it('não responde sem agente ativo (rascunho ou pausado)', async () => {
    const c = await setup('AUTO');
    await prisma.aiAgent.update({ where: { id: c.agentId }, data: { status: 'PAUSED' } });
    expect(await run(c)).toMatchObject({ status: 'skipped', reason: 'sem agente ativo' });
    expect(chatCalls).toHaveLength(0);
  });

  it('só a mensagem mais recente do contato responde, e o histórico entra no prompt', async () => {
    const c = await setup('REVIEW', 'Primeira');
    await prisma.message.create({
      data: {
        accountId: c.accountId,
        conversationId: c.conversationId,
        providerMessageId: 'in-2',
        direction: 'INBOUND',
        type: 'text',
        body: 'Segunda',
        status: 'RECEIVED',
        sentAt: new Date(Date.now() + 1000),
      },
    });
    expect(await run(c)).toMatchObject({ status: 'skipped', reason: 'mensagem mais nova' });
    const second = await prisma.message.findFirstOrThrow({ where: { providerMessageId: 'in-2' } });
    await responder().handle({ ...c, messageId: second.id });
    const roles = chatCalls[0]!.body.messages.slice(1).map((m) => m.content);
    expect(roles).toEqual(['Primeira', 'Segunda']);
  });

  it('descadastrado não é atendido; volta a ser se escrever depois do pedido', async () => {
    const c = await setup('REVIEW');
    await prisma.optOut.create({
      data: {
        accountId: c.accountId,
        phoneE164: '+5511977776666',
        source: 'keyword',
        createdAt: new Date(Date.now() + 5000),
      },
    });
    expect(await run(c)).toMatchObject({
      status: 'skipped',
      reason: 'O contato pediu descadastramento',
    });
    expect(chatCalls).toHaveLength(0);
    await prisma.optOut.deleteMany();
    await prisma.optOut.create({
      data: {
        accountId: c.accountId,
        phoneE164: '+5511977776666',
        source: 'keyword',
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    expect(await run(c)).toEqual({ status: 'drafted' });
  });

  it('contato que recebeu campanha não é atendido por 7 dias, salvo liberação manual', async () => {
    const c = await setup('REVIEW');
    const contact = await prisma.contact.create({
      data: { accountId: c.accountId, phoneE164: '+5511977776666', origin: 'MANUAL' },
    });
    const camp = await prisma.campaign.create({
      data: { name: 'Promo', body: 'Oi', status: 'RUNNING' },
    });
    const ca = await prisma.campaignAccount.create({
      data: { campaignId: camp.id, accountId: c.accountId },
    });
    const rec = await prisma.campaignRecipient.create({
      data: {
        campaignAccountId: ca.id,
        accountId: c.accountId,
        contactId: contact.id,
        phoneE164: '+5511977776666',
        status: 'SENT',
      },
    });
    await prisma.message.create({
      data: {
        accountId: c.accountId,
        conversationId: c.conversationId,
        providerMessageId: 'camp-1',
        direction: 'OUTBOUND',
        type: 'text',
        body: 'Promo!',
        status: 'SENT',
        sentAt: new Date(Date.now() - 2 * 24 * 3_600_000),
        campaignRecipientId: rec.id,
      },
    });
    expect(await run(c)).toMatchObject({ status: 'skipped' });
    expect((await prisma.aiConversationState.findFirstOrThrow()).lastSkip).toMatch(/campanha/i);
    expect(chatCalls).toHaveLength(0);

    await prisma.aiConversationState.update({
      where: { conversationId: c.conversationId },
      data: { enabledOverride: true },
    });
    expect(await run(c)).toEqual({ status: 'drafted' });
  });

  it('quando uma pessoa responde, a IA se afasta e pausa a conversa', async () => {
    const c = await setup('AUTO');
    await prisma.message.create({
      data: {
        accountId: c.accountId,
        conversationId: c.conversationId,
        providerMessageId: 'human-1',
        direction: 'OUTBOUND',
        type: 'text',
        body: 'Oi, aqui é o João',
        status: 'SENT',
        sentAt: new Date(Date.now() - 60_000),
      },
    });
    expect(await run(c)).toMatchObject({
      status: 'skipped',
      reason: 'Uma pessoa respondeu esta conversa',
    });
    const st = await prisma.aiConversationState.findFirstOrThrow();
    expect(st).toMatchObject({ paused: true, pausedBy: 'human' });
    expect(chatCalls).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('conversa pausada não é atendida, e áudio/imagem não geram resposta', async () => {
    const c = await setup('REVIEW');
    await prisma.aiConversationState.create({
      data: {
        conversationId: c.conversationId,
        paused: true,
        pausedBy: 'admin',
        pausedReason: 'IA pausada pelo administrador',
      },
    });
    expect(await run(c)).toMatchObject({
      status: 'skipped',
      reason: 'IA pausada pelo administrador',
    });

    await prisma.aiConversationState.deleteMany();
    await prisma.message.update({
      where: { id: c.messageId },
      data: { type: 'audio', body: null },
    });
    expect(await run(c)).toMatchObject({ status: 'skipped' });
    expect((await prisma.aiConversationState.findFirstOrThrow()).lastSkip).toMatch(/sem texto/i);
    expect(chatCalls).toHaveLength(0);
  });

  it('grupos nunca são atendidos', async () => {
    const c = await setup('REVIEW');
    await prisma.conversation.update({
      where: { id: c.conversationId },
      data: { remoteJid: '120363000000000000@g.us' },
    });
    expect(await run(c)).toMatchObject({ status: 'skipped', reason: 'não individual' });
  });

  it('pausa global das operações suspende a IA', async () => {
    const c = await setup('AUTO');
    await setOperationsPause(prisma, true, { reason: 'teste' });
    const out = await run(c);
    expect(out).toMatchObject({ status: 'skipped' });
    expect(chatCalls).toHaveLength(0);
  });

  it('limite de respostas por hora na conversa', async () => {
    const c = await setup('REVIEW');
    await prisma.aiAgent.update({ where: { id: c.agentId }, data: { maxRepliesPerHour: 1 } });
    const other = await prisma.message.create({
      data: {
        accountId: c.accountId,
        conversationId: c.conversationId,
        providerMessageId: 'old-in',
        direction: 'INBOUND',
        type: 'text',
        body: 'antes',
        status: 'RECEIVED',
        sentAt: new Date(Date.now() - 10_000),
      },
    });
    await prisma.aiDraft.create({
      data: {
        conversationId: c.conversationId,
        agentId: c.agentId,
        inboundMessageId: other.id,
        body: 'x',
        status: 'DISCARDED',
      },
    });
    expect(await run(c)).toMatchObject({
      status: 'skipped',
      reason: 'Limite de respostas por hora desta conversa',
    });
    expect(chatCalls).toHaveLength(0);
  });

  it('sem chave configurada: não responde e registra evento sem derrubar nada', async () => {
    const c = await setup('REVIEW');
    await prisma.aiCredential.deleteMany();
    expect(await run(c)).toMatchObject({ status: 'skipped' });
    expect(await prisma.aiAgentEvent.count({ where: { category: 'OPENROUTER' } })).toBe(1);
  });

  it('chave inválida ou sem créditos: registra o erro e para o agente (sem repetir o erro)', async () => {
    const c = await setup('AUTO');
    chatStatus = 401;
    expect(await run(c)).toMatchObject({ status: 'failed', reason: 'INVALID_KEY' });
    expect((await prisma.aiAgent.findUniqueOrThrow({ where: { id: c.agentId } })).status).toBe(
      'ERROR',
    );
    expect(await prisma.aiDraft.count()).toBe(0);
    // "digitando" é apagado mesmo com erro, e nada é enviado
    expect(sent.map((s) => (s.type === 'send-presence' ? s.state : s.type))).toEqual([
      'composing',
      'paused',
    ]);
    // com o agente em ERRO, as próximas mensagens nem chegam ao modelo
    expect(await run(c)).toMatchObject({ status: 'skipped', reason: 'sem agente ativo' });
  });

  it('erro temporário do provedor não para o agente', async () => {
    const c = await setup('REVIEW');
    chatStatus = 500;
    expect(await run(c)).toMatchObject({ status: 'failed' });
    expect((await prisma.aiAgent.findUniqueOrThrow({ where: { id: c.agentId } })).status).toBe(
      'ACTIVE',
    );
  });

  it('memória: resume a conversa depois de várias mensagens e usa o resumo nas próximas respostas', async () => {
    const c = await setup('AUTO');
    for (let i = 0; i < 12; i++)
      await prisma.message.create({
        data: {
          accountId: c.accountId,
          conversationId: c.conversationId,
          providerMessageId: `h-${i}`,
          direction: i % 2 ? 'OUTBOUND' : 'INBOUND',
          type: 'text',
          body: `msg ${i}`,
          status: i % 2 ? 'SENT' : 'RECEIVED',
          sentAt: new Date(Date.now() - 600_000 + i * 1000),
          ...(i % 2 ? {} : {}),
        },
      });
    // mensagens antigas do atendente contam como "pessoa" só se recentes; aqui são do passado remoto
    await prisma.message.updateMany({
      where: { providerMessageId: { startsWith: 'h-' }, direction: 'OUTBOUND' },
      data: { sentAt: new Date(Date.now() - 48 * 3_600_000) },
    });
    expect(await run(c)).toEqual({ status: 'sent' });
    const st = await prisma.aiConversationState.findFirstOrThrow();
    expect(st.memory).toBe('Olá! Posso ajudar.'); // o "modelo" falso devolve a mesma frase
    expect(st.memoryAgentId).toBe(c.agentId);
    const uses = await prisma.aiTokenUsage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(uses.map((u) => u.purpose)).toEqual(['reply', 'memory']);
  });
});
