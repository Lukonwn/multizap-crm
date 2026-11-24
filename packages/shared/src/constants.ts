/** Limite fixo de instâncias WhatsApp do MultiZap. */
export const MAX_ACCOUNTS = 10;

export const SESSION_COOKIE = 'mz_session';
export const CSRF_COOKIE = 'mz_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Tentativas de login antes do bloqueio temporário. */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;

export const HEARTBEAT_KEYS = {
  worker: 'multizap:heartbeat:worker',
  gateway: 'multizap:heartbeat:gateway',
} as const;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TTL_SECONDS = 45;

export const SETTING_KEYS = {
  operationsPaused: 'operations_paused',
} as const;
