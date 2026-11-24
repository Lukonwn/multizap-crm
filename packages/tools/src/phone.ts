import {
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js/max';

/** DDD → UF (Anatel). */
export const DDD_UF: Record<string, string> = {
  '11': 'SP',
  '12': 'SP',
  '13': 'SP',
  '14': 'SP',
  '15': 'SP',
  '16': 'SP',
  '17': 'SP',
  '18': 'SP',
  '19': 'SP',
  '21': 'RJ',
  '22': 'RJ',
  '24': 'RJ',
  '27': 'ES',
  '28': 'ES',
  '31': 'MG',
  '32': 'MG',
  '33': 'MG',
  '34': 'MG',
  '35': 'MG',
  '37': 'MG',
  '38': 'MG',
  '41': 'PR',
  '42': 'PR',
  '43': 'PR',
  '44': 'PR',
  '45': 'PR',
  '46': 'PR',
  '47': 'SC',
  '48': 'SC',
  '49': 'SC',
  '51': 'RS',
  '53': 'RS',
  '54': 'RS',
  '55': 'RS',
  '61': 'DF',
  '62': 'GO',
  '64': 'GO',
  '63': 'TO',
  '65': 'MT',
  '66': 'MT',
  '67': 'MS',
  '68': 'AC',
  '69': 'RO',
  '71': 'BA',
  '73': 'BA',
  '74': 'BA',
  '75': 'BA',
  '77': 'BA',
  '79': 'SE',
  '81': 'PE',
  '87': 'PE',
  '82': 'AL',
  '83': 'PB',
  '84': 'RN',
  '85': 'CE',
  '88': 'CE',
  '86': 'PI',
  '89': 'PI',
  '91': 'PA',
  '93': 'PA',
  '94': 'PA',
  '92': 'AM',
  '97': 'AM',
  '95': 'RR',
  '96': 'AP',
  '98': 'MA',
  '99': 'MA',
};

const regionNames = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
export function countryName(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return regionNames.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

export type PhoneStatus = 'valid' | 'incomplete' | 'invalid' | 'empty';

export interface PhoneInfo {
  status: PhoneStatus;
  e164: string | null;
  country: string | null;
  countryCode: string | null;
  ddd: string | null;
  uf: string | null;
  type: 'celular' | 'fixo' | 'outro' | null;
  reason: string | null;
}

const TYPE_MAP: Record<string, PhoneInfo['type']> = {
  MOBILE: 'celular',
  FIXED_LINE: 'fixo',
  FIXED_LINE_OR_MOBILE: 'outro',
};

/**
 * Análise ESTRUTURAL de um telefone (formato, país, DDD, tipo).
 * Não verifica se o número existe nem se possui conta WhatsApp.
 */
export function analyzePhone(raw: string, defaultCountry = 'BR'): PhoneInfo {
  const empty: PhoneInfo = {
    status: 'empty',
    e164: null,
    country: null,
    countryCode: null,
    ddd: null,
    uf: null,
    type: null,
    reason: 'Sem telefone',
  };
  const input = (raw ?? '').trim();
  if (!input || !/\d/.test(input)) return empty;
  const cleaned = input.startsWith('00') ? `+${input.slice(2)}` : input;
  const dc = defaultCountry as CountryCode;
  const p = parsePhoneNumberFromString(cleaned, dc);
  if (!p || !p.isValid()) {
    const len = validatePhoneNumberLength(cleaned, dc);
    if (len === 'TOO_SHORT') return { ...empty, status: 'incomplete', reason: 'Número incompleto' };
    return {
      ...empty,
      status: 'invalid',
      reason: len === 'TOO_LONG' ? 'Número longo demais' : 'Formato inválido',
    };
  }
  const ddd = p.country === 'BR' ? p.nationalNumber.slice(0, 2) : null;
  return {
    status: 'valid',
    e164: p.number,
    country: p.country ?? null,
    countryCode: p.countryCallingCode,
    ddd,
    uf: ddd ? (DDD_UF[ddd] ?? null) : null,
    type: TYPE_MAP[p.getType() ?? ''] ?? 'outro',
    reason: null,
  };
}

/** Sequências que parecem telefones dentro de texto livre. */
export const PHONE_CANDIDATE_RE = /\+?\d[\d\s().\-]{6,}\d/g;
