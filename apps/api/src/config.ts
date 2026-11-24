import { z } from 'zod';

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'Deve ter 32 bytes em base64.');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().optional(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().optional(),
    WEB_ORIGIN: z.string().url(),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
    SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
    ADMIN_EMAIL: z.string().email().optional().or(z.literal('')),
    ADMIN_INITIAL_PASSWORD: z.string().optional(),
    CREDENTIALS_MASTER_KEY: base64Key.optional().or(z.literal('')),
    INTERNAL_API_TOKEN: z.string().optional(),
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    MAX_IMPORT_MB: z.coerce.number().int().positive().max(1024).default(100),
    BULLMQ_PREFIX: z.string().min(1).default('bull'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.CREDENTIALS_MASTER_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_MASTER_KEY'],
        message: 'Obrigatória em produção.',
      });
    if (!env.INTERNAL_API_TOKEN || env.INTERNAL_API_TOKEN.length < 32)
      ctx.addIssue({
        code: 'custom',
        path: ['INTERNAL_API_TOKEN'],
        message: 'Mínimo de 32 caracteres em produção.',
      });
    if (!env.REDIS_URL)
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Obrigatória em produção.' });
  });

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  redisUrl?: string;
  webOrigin: string;
  sessionTtlMs: number;
  sessionIdleMs: number;
  bootstrapAdmin: { email?: string; password?: string };
  internalApiToken?: string;
  logLevel: string;
  loginRateLimitPerMinute: number;
  queuePrefix: string;
  maxImportBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT ?? e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL || undefined,
    webOrigin: e.WEB_ORIGIN.replace(/\/$/, ''),
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3_600_000,
    bootstrapAdmin: {
      email: e.ADMIN_EMAIL || undefined,
      password: e.ADMIN_INITIAL_PASSWORD || undefined,
    },
    internalApiToken: e.INTERNAL_API_TOKEN || undefined,
    logLevel: e.LOG_LEVEL,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    queuePrefix: e.BULLMQ_PREFIX,
    maxImportBytes: e.MAX_IMPORT_MB * 1024 * 1024,
  };
}
