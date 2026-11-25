import type { PrismaClient } from '@multizap/database';

/**
 * Uma pessoa respondeu pela Central: a IA se afasta desta conversa até o administrador
 * liberá-la de novo. Sem efeito se a IA não participa da conversa. Nunca falha o envio.
 */
export async function pauseAiForHuman(prisma: PrismaClient, conversationId: string): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { accountId: true, aiState: { select: { id: true } } },
    });
    if (!conv) return;
    const served =
      conv.aiState ||
      (await prisma.aiAgentAccount.findFirst({
        where: { accountId: conv.accountId, agent: { status: 'ACTIVE' } },
        select: { id: true },
      }));
    if (!served) return;
    // A trava por sinal de menor de idade não é trocada por "pessoa respondeu".
    const lock = await prisma.aiConversationState.findUnique({
      where: { conversationId },
      select: { paused: true, pausedBy: true },
    });
    if (lock?.paused && lock.pausedBy === 'minor') return;
    const at = new Date();
    const reason = 'Uma pessoa respondeu esta conversa';
    await prisma.aiConversationState.upsert({
      where: { conversationId },
      create: {
        conversationId,
        paused: true,
        pausedBy: 'human',
        pausedReason: reason,
        pausedAt: at,
      },
      update: { paused: true, pausedBy: 'human', pausedReason: reason, pausedAt: at },
    });
  } catch {
    /* o módulo de IA nunca atrapalha a resposta manual */
  }
}
