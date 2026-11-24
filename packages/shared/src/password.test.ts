import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { passwordPolicy } from './password-policy';
import { changePasswordSchema } from './schemas/auth';

describe('senhas', () => {
  it('gera hash argon2id e verifica', async () => {
    const hash = await hashPassword('Senha-Forte-123');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Senha-Forte-123')).toBe(true);
    expect(await verifyPassword(hash, 'errada')).toBe(false);
  });

  it('retorna false para hash corrompido', async () => {
    expect(await verifyPassword('lixo', 'x')).toBe(false);
  });

  it('aplica a política de senha', () => {
    expect(passwordPolicy.safeParse('curta').success).toBe(false);
    expect(passwordPolicy.safeParse('semnumeroSEMSIMBOLO').success).toBe(false);
    expect(passwordPolicy.safeParse('Senha-Forte-123').success).toBe(true);
  });

  it('exige nova senha diferente da atual', () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: 'Senha-Forte-123',
      newPassword: 'Senha-Forte-123',
    });
    expect(r.success).toBe(false);
  });
});
