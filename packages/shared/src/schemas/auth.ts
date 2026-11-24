import { z } from 'zod';
import { passwordPolicy } from '../password-policy';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido.').max(254),
  password: z.string().min(1, 'Informe a senha.').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual.').max(200),
    newPassword: passwordPolicy,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'A nova senha deve ser diferente da atual.',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
