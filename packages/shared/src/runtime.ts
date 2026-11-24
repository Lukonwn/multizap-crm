import { createServer, type Server } from 'node:http';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_SECONDS } from './constants';

// Utilitários de processo para serviços de segundo plano (somente servidor).

interface RedisLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Publica um heartbeat com TTL no Redis; a API usa isso para saber se o serviço está vivo. */
export function startHeartbeat(redis: RedisLike, key: string, payload: () => object = () => ({})) {
  const beat = () =>
    redis
      .set(
        key,
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...payload() }),
        'EX',
        HEARTBEAT_TTL_SECONDS,
      )
      .catch(() => undefined);
  void beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Servidor HTTP mínimo para o health check da Railway. */
export function startHealthServer(
  port: number,
  check: () => Promise<boolean> | boolean,
  name: string,
): Server {
  const server = createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const ok = await Promise.resolve(check()).catch(() => false);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', service: name }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

/** Registra encerramento gracioso (SIGTERM da Railway em cada deploy). */
export function onShutdown(
  fn: (signal: string) => Promise<void>,
  log: (msg: string) => void = console.log,
) {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`Recebido ${signal}, encerrando...`);
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    fn(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
