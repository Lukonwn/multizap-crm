import type { ZodType, ZodTypeDef } from 'zod';
import { AppError } from './errors';

/** Valida dados de entrada; lança erro 400 padronizado com mensagens por campo. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    (fields[key] ??= []).push(issue.message);
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos.', fields);
}
