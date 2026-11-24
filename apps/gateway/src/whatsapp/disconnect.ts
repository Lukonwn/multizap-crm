import type { CloseReason } from '../session/types';

/** Traduz o código de encerramento do WhatsApp para um motivo do domínio. */
export function mapDisconnect(statusCode: number | undefined, message = ''): CloseReason {
  if (/QR refs attempts ended/i.test(message)) return 'qr_timeout';
  switch (statusCode) {
    case 401:
      return 'logged_out';
    case 515:
      return 'restart_required';
    case 440:
      return 'connection_replaced';
    case 500:
      return 'bad_session';
    case 411:
      return 'multidevice_mismatch';
    case 403:
      return 'forbidden';
    case 503:
      return 'unavailable';
    case 408:
    case 428:
      return 'connection_lost';
    default:
      return 'unknown';
  }
}
