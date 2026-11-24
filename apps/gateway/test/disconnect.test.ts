import { describe, expect, it } from 'vitest';
import { mapDisconnect } from '../src/whatsapp/disconnect';

describe('mapDisconnect', () => {
  it('traduz os códigos do WhatsApp', () => {
    expect(mapDisconnect(401)).toBe('logged_out');
    expect(mapDisconnect(515)).toBe('restart_required');
    expect(mapDisconnect(440)).toBe('connection_replaced');
    expect(mapDisconnect(500)).toBe('bad_session');
    expect(mapDisconnect(411)).toBe('multidevice_mismatch');
    expect(mapDisconnect(403)).toBe('forbidden');
    expect(mapDisconnect(408)).toBe('connection_lost');
    expect(mapDisconnect(428)).toBe('connection_lost');
    expect(mapDisconnect(undefined)).toBe('unknown');
  });
  it('distingue a expiração do QR de uma queda de conexão (ambos 408)', () => {
    expect(mapDisconnect(408, 'QR refs attempts ended')).toBe('qr_timeout');
  });
});
