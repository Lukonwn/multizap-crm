import { cleanText, KNOWLEDGE_LIMITS } from '@multizap/ai';

/** Erro com mensagem própria para o administrador. */
export class ExtractError extends Error {}

export const KNOWLEDGE_FILE_TYPES = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;
const MAX_PDF_PAGES = 300;

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Extrai o texto de um arquivo enviado (PDF, DOCX, TXT, MD ou CSV). */
export async function extractText(buf: Buffer, fileName: string): Promise<string> {
  const ext = extOf(fileName);
  let text: string;
  try {
    if (ext === 'pdf') text = await fromPdf(buf);
    else if (ext === 'docx') text = await fromDocx(buf);
    else if (ext === 'txt' || ext === 'md' || ext === 'csv') text = buf.toString('utf8');
    else throw new ExtractError('Formato não suportado. Envie PDF, DOCX, TXT, MD ou CSV.');
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(
      'Não foi possível ler o arquivo. Verifique se ele não está corrompido nem protegido por senha.',
    );
  }
  text = cleanText(text);
  if (!text)
    throw new ExtractError(
      ext === 'pdf'
        ? 'O PDF não tem texto selecionável (parece ser uma imagem escaneada).'
        : 'O arquivo não tem texto.',
    );
  return text.slice(0, KNOWLEDGE_LIMITS.maxChars);
}

async function fromPdf(buf: Buffer): Promise<string> {
  const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > MAX_PDF_PAGES)
    throw new ExtractError(`O PDF tem páginas demais (máximo de ${MAX_PDF_PAGES}).`);
  const { text } = await pdfText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n\n') : text;
}

async function fromDocx(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const r = await mammoth.extractRawText({ buffer: buf });
  return r.value;
}
