import { z } from 'zod';

/** Política de senha administrativa (compartilhada entre web e api). */
export const passwordPolicy = z
  .string()
  .min(12, 'A senha deve ter pelo menos 12 caracteres.')
  .max(200, 'A senha é longa demais.')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Use letras maiúsculas e minúsculas.')
  .refine((v) => /\d/.test(v), 'Inclua ao menos um número.')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Inclua ao menos um símbolo.');
