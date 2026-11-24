import {
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js';

export type { CountryCode };

export type PhoneResult =
  | { ok: true; e164: string; country?: string; nationalNumber: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'too_short' | 'too_long' };

/**
 * Normaliza um telefone para E.164. Valida apenas a ESTRUTURA do número —
 * não indica se existe uma conta WhatsApp associada.
 */
export function normalizePhone(input: string, defaultCountry: CountryCode = 'BR'): PhoneResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const cleaned = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    const len = validatePhoneNumberLength(cleaned, defaultCountry);
    if (len === 'TOO_SHORT') return { ok: false, reason: 'too_short' };
    if (len === 'TOO_LONG') return { ok: false, reason: 'too_long' };
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    e164: parsed.number,
    country: parsed.country,
    nationalNumber: parsed.nationalNumber,
  };
}

/** Somente dígitos, sem "+" (formato exigido pelo pareamento por número). */
export function e164Digits(e164: string): string {
  return e164.replace(/\D/g, '');
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

export const PHONE_REASON_LABEL: Record<'empty' | 'invalid' | 'too_short' | 'too_long', string> = {
  empty: 'Telefone ausente',
  invalid: 'Formato inválido',
  too_short: 'Número incompleto',
  too_long: 'Número longo demais',
};
