export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (msg = 'Sessão inválida ou expirada.') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Acesso negado.') => new AppError(403, 'FORBIDDEN', msg),
  csrf: () =>
    new AppError(403, 'CSRF_INVALID', 'Token de segurança inválido. Recarregue a página.'),
  passwordChangeRequired: () =>
    new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Altere sua senha para continuar.'),
  notFound: (msg = 'Recurso não encontrado.') => new AppError(404, 'NOT_FOUND', msg),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.'),
  locked: () =>
    new AppError(423, 'ACCOUNT_LOCKED', 'Muitas tentativas. Tente novamente em alguns minutos.'),
};
