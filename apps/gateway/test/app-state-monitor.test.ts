import { describe, expect, it } from 'vitest';
import { AppStateMonitor, type AppStateEvent } from '../src/whatsapp/app-state-monitor';

const line = (o: object) => JSON.stringify({ level: 30, accountId: 'acc1', ...o });

function setup(forwardLevel = 40) {
  const events: AppStateEvent[] = [];
  const out: string[] = [];
  const m = new AppStateMonitor((e) => events.push(e), forwardLevel, {
    write: (s) => void out.push(s),
  });
  return { m, events, out };
}

describe('monitor da sincronização da agenda', () => {
  it('registra a coleção parada por falta de chave e a lembra para nova tentativa', () => {
    const { m, events } = setup();
    m.line(
      line({
        level: 40,
        name: 'critical_unblock_low',
        msg: 'critical_unblock_low blocked on missing key from v0, parking after 2 attempts',
      }),
    );
    m.line(
      line({
        level: 40,
        msg: 'regular blocked on missing key from v0, parking after 2 attempts',
        name: 'regular',
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['blocked', 'blocked']);
    expect(events[0]!.text).toContain('agenda e contatos');
    expect(events[0]).toMatchObject({ level: 'warn', accountId: 'acc1' });
    expect(m.blocked('acc1').sort()).toEqual(['critical_unblock_low', 'regular']);
    expect(m.blocked('outra')).toEqual([]);
  });

  it('chave recebida e coleção sincronizada tiram a coleção da lista de paradas', () => {
    const { m, events } = setup();
    m.line(
      line({
        level: 40,
        name: 'regular',
        msg: 'regular blocked on missing key from v0, parking after 2 attempts',
      }),
    );
    m.line(line({ msg: 'App state sync key arrived, triggering app state sync' }));
    m.line(line({ msg: 'synced regular to v12' }));
    m.line(
      line({ msg: 'restored state of critical_unblock_low from snapshot to v3 with mutations' }),
    );
    m.line(
      line({ msg: 'App state sync complete, transitioning to Online state and flushing buffer' }),
    );
    expect(events.map((e) => e.kind)).toEqual(['blocked', 'key', 'synced', 'synced', 'complete']);
    expect(m.blocked('acc1')).toEqual([]);
  });

  it('desistência vira aviso; linhas sem conta ou sem relação são ignoradas', () => {
    const { m, events } = setup();
    m.line(line({ level: 40, msg: 'failed to sync regular_low from v2, giving up' }));
    m.line(JSON.stringify({ level: 30, msg: 'synced regular to v1' })); // sem accountId
    m.line(line({ msg: 'opened connection to WA' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'gaveup', level: 'warn' });
  });

  it('não repete o mesmo aviso em menos de 1 minuto e limita por hora', () => {
    const { m, events } = setup();
    for (let i = 0; i < 5; i++)
      m.line(
        line({
          level: 40,
          name: 'regular',
          msg: 'regular blocked on missing key from v0, parking after 2 attempts',
        }),
      );
    expect(events).toHaveLength(1);
    const many = setup();
    for (let i = 0; i < 60; i++) many.m.line(line({ msg: `synced c${i} to v1` }));
    expect(many.events.length).toBe(40);
  });

  it('só repassa ao log o nível configurado', () => {
    const quiet = setup(40);
    quiet.m.line(line({ level: 30, msg: 'App state sync complete' }));
    quiet.m.line(line({ level: 40, msg: 'aviso qualquer' }));
    expect(quiet.out).toHaveLength(1);
    expect(quiet.out[0]).toContain('aviso qualquer');
    const verbose = setup(30);
    verbose.m.line(line({ level: 30, msg: 'App state sync complete' }));
    expect(verbose.out).toHaveLength(1);
    quiet.m.line('texto que não é JSON');
    expect(quiet.out).toHaveLength(2);
  });

  it('o destino do pino aceita linhas partidas em pedaços', async () => {
    const { m, events } = setup();
    const w = m.stream();
    const l = line({ msg: 'synced regular to v7' }) + '\n';
    w.write(l.slice(0, 20));
    w.write(l.slice(20));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
  });

  it('registra as tentativas de nova sincronização', () => {
    const { m, events } = setup();
    m.retry('acc1', 2, ['critical_unblock_low']);
    expect(events[0]).toMatchObject({ kind: 'retry' });
    expect(events[0]!.text).toContain('2ª');
  });
});
