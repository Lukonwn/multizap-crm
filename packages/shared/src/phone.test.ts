import { describe, expect, it } from 'vitest';
import { e164Digits, normalizePhone } from './phone';
import { createAccountSchema, startPairingSchema } from './accounts';
import { formatPairingCode } from './gateway';

describe('normalizePhone', () => {
  it('normaliza números brasileiros com DDD', () => {
    expect(normalizePhone('(11) 98765-4321')).toMatchObject({
      ok: true,
      e164: '+5511987654321',
      country: 'BR',
    });
    expect(normalizePhone('11987654321')).toMatchObject({ ok: true, e164: '+5511987654321' });
  });
  it('aceita formato internacional e prefixo 00', () => {
    expect(normalizePhone('+1 415 555 2671')).toMatchObject({
      ok: true,
      e164: '+14155552671',
      country: 'US',
    });
    expect(normalizePhone('00351912345678')).toMatchObject({ ok: true, e164: '+351912345678' });
  });
  it('rejeita números incompletos ou vazios', () => {
    expect(normalizePhone('12345')).toEqual({ ok: false, reason: 'too_short' });
    expect(normalizePhone('  ')).toEqual({ ok: false, reason: 'empty' });
  });
  it('extrai dígitos', () => {
    expect(e164Digits('+5511987654321')).toBe('5511987654321');
  });
});

describe('schemas de instância', () => {
  it('exige telefone para aparelho externo', () => {
    expect(
      createAccountSchema.safeParse({ name: 'Loja', connectionType: 'EXTERNAL_DEVICE' }).success,
    ).toBe(false);
    expect(
      createAccountSchema.safeParse({ name: 'Loja', connectionType: 'WHATSAPP_WEB' }).success,
    ).toBe(true);
  });
  it('normaliza telefone no pareamento por número', () => {
    const r = startPairingSchema.parse({ method: 'pairing-code', phone: '11 98765-4321' });
    expect(r).toEqual({ method: 'pairing-code', phone: '+5511987654321' });
    expect(startPairingSchema.safeParse({ method: 'pairing-code', phone: '123' }).success).toBe(
      false,
    );
  });
  it('formata o código de pareamento', () => {
    expect(formatPairingCode('abcd1234')).toBe('ABCD-1234');
  });
});
