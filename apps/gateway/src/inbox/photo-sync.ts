import { createHash } from 'node:crypto';
import type { PrismaClient } from '@multizap/database';
import type { StorageDriver } from '@multizap/storage';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface PhotoSource {
  profilePicture(accountId: string, jid: string): Promise<string | null>;
  connectedAccounts(): string[];
}

export interface PhotoSyncOptions {
  /** Conversas verificadas por rodada, por instância. */
  perRun?: number;
  /** Dias até verificar de novo a foto de uma conversa. */
  recheckDays?: number;
  /** Pausa entre consultas ao WhatsApp. */
  delayMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const DAY = 86_400_000;

/**
 * Busca a foto de perfil das conversas da Central (só de conversas que já existem
 * e tiveram movimento nos últimos 30 dias). Consulta devagar e poucas por vez;
 * ao receber limite de taxa do WhatsApp, para e só volta depois de um tempo.
 */
export class PhotoSync {
  private readonly o: Required<PhotoSyncOptions>;
  private pausedUntil = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver,
    private readonly source: PhotoSource,
    private readonly log: Log = () => undefined,
    opts: PhotoSyncOptions = {},
  ) {
    this.o = {
      perRun: opts.perRun ?? 8,
      recheckDays: opts.recheckDays ?? 7,
      delayMs: opts.delayMs ?? 2_500,
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      fetchImpl: opts.fetchImpl ?? fetch,
    };
  }

  start(intervalMs = 120_000): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.runAll()
        .catch((err: unknown) => this.log('Falha ao buscar fotos', { err: String(err) }))
        .finally(() => (running = false));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async runAll(): Promise<void> {
    for (const accountId of this.source.connectedAccounts()) await this.runAccount(accountId);
  }

  async runAccount(accountId: string): Promise<{ checked: number; saved: number }> {
    const out = { checked: 0, saved: 0 };
    if (Date.now() < this.pausedUntil) return out;
    const now = Date.now();
    const convs = await this.prisma.conversation.findMany({
      where: {
        accountId,
        lastMessageAt: { gte: new Date(now - 30 * DAY) },
        OR: [
          { photoCheckedAt: null },
          { photoCheckedAt: { lt: new Date(now - this.o.recheckDays * DAY) } },
        ],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: this.o.perRun,
    });
    for (const c of convs) {
      let url: string | null;
      try {
        url = await this.source.profilePicture(accountId, c.remoteJid);
      } catch (err) {
        const msg = String(err);
        if (/rate-overlimit|429|not connected|NotConnected/i.test(msg)) {
          this.pausedUntil = Date.now() + 30 * 60_000;
          this.log('Busca de fotos pausada', { accountId, motivo: msg.slice(0, 100) });
          return out;
        }
        this.log('Foto não obtida', { accountId, err: msg.slice(0, 120) });
        url = null;
      }
      let photoKey: string | null = null;
      if (url) {
        try {
          photoKey = await this.save(accountId, c.remoteJid, url);
        } catch (err) {
          this.log('Foto não baixada', { accountId, err: String(err).slice(0, 120) });
        }
      }
      await this.prisma.conversation.update({
        where: { id: c.id },
        data: { photoCheckedAt: new Date(), ...(photoKey && { photoKey }) },
      });
      out.checked++;
      if (photoKey) out.saved++;
      if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    }
    return out;
  }

  private async save(accountId: string, jid: string, url: string): Promise<string> {
    if (new URL(url).protocol !== 'https:') throw new Error('URL de foto não é https.');
    const res = await this.o.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new Error('Resposta não é uma imagem.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > this.o.maxBytes) throw new Error('Tamanho de foto inválido.');
    const key = `avatars/${accountId}/${createHash('sha1').update(jid).digest('hex')}.jpg`;
    await this.storage.put(key, buf, { contentType: type });
    return key;
  }
}
