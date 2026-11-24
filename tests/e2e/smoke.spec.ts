import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './playwright.config';

/**
 * Fumaça de ponta a ponta: o caminho principal do administrador com os
 * serviços reais (API, worker, painel, PostgreSQL e Redis).
 * Os testes rodam em sequência e compartilham a mesma sessão do navegador.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${page.url()}: ${m.text()}`);
  });
});
test.afterAll(async () => page.close());

const MODULES = [
  ['/', 'Dashboard'],
  ['/conexoes', 'Conexões'],
  ['/contatos', 'Contatos'],
  ['/ferramentas', 'Ferramentas'],
  ['/criativos', 'Biblioteca de criativos'],
  ['/campanhas', 'Campanhas'],
  ['/relatorios', 'Relatórios'],
  ['/system-health', 'System Health'],
  ['/configuracoes', 'Configurações'],
] as const;

test('rotas protegidas exigem login e a API recusa acesso sem sessão', async ({ request }) => {
  await page.goto('/contatos');
  await expect(page).toHaveURL(/\/login/);
  const r = await request.get('/api/system/status');
  expect(r.status()).toBe(401);
});

test('primeiro acesso: login com a senha inicial e troca obrigatória', async () => {
  await page.goto('/login');
  await page.locator('input[type=email]').fill(ADMIN.email);
  await page.locator('input[type=password]').fill('senha-errada-123');
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.locator('input[type=password]').fill(ADMIN.initial);
  await page.locator('button[type=submit]').click();
  await expect(page.getByText('Defina uma nova senha')).toBeVisible();
  await page.getByLabel('Senha atual').fill(ADMIN.initial);
  await page.getByLabel('Nova senha', { exact: true }).fill(ADMIN.final);
  await page.getByLabel('Confirmar nova senha').fill(ADMIN.final);
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('todas as telas abrem sem erros, no computador e no celular', async () => {
  for (const [path, title] of MODULES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, title] of MODULES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `rolagem lateral em ${path}`).toBeLessThanOrEqual(0);
  }
  // menu em gaveta
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('link', { name: 'Conexões' }).click();
  await expect(page).toHaveURL(/\/conexoes$/);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('cadastra uma instância e um contato com consentimento', async () => {
  await page.goto('/conexoes');
  await page.getByRole('button', { name: 'Nova instância' }).first().click();
  await page.getByLabel('Nome da instância').fill('Loja E2E');
  await page.getByText('Aparelho externo cadastrado').click();
  await page.getByLabel('Número do aparelho').fill('(11) 98888-7777');
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.getByText('Loja E2E').first()).toBeVisible();

  await page.goto('/contatos');
  await page.getByRole('button', { name: 'Novo contato' }).first().click();
  await page.getByLabel('Nome').fill('Cliente E2E');
  await page.getByLabel('Telefone').fill('(11) 97777-6666');
  await page.getByText('Registrar consentimento agora').click();
  await page.getByLabel('Como o consentimento foi obtido?').fill('Pediu contato no balcão');
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.getByText('Cliente E2E')).toBeVisible();
});

test('Central de mensagens: "Nova conversa" abre a escolha de contatos da instância', async () => {
  await page.goto('/mensagens');
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await expect(page.getByRole('heading', { name: 'Nova conversa' })).toBeVisible();
  await expect(page.getByLabel('Instância da conversa')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Celular' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Nova conversa' })).toHaveCount(0);
});

test('higienizador processa uma lista e gera arquivo para download', async () => {
  await page.goto('/ferramentas/sanitize');
  await page.locator('input[type=file]').setInputFiles(resolve(__dirname, 'fixtures/lista.csv'));
  await page.getByRole('button', { name: 'Processar' }).click();
  const download = page.getByRole('link', { name: /Baixar/ }).first();
  await expect(download).toBeVisible({ timeout: 30_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/\.(csv|xlsx|zip)$/);
});

test('pausa global com motivo, aviso em todas as telas e retomada', async () => {
  await page.goto('/system-health');
  await page.getByRole('button', { name: 'Pausar operações' }).click();
  await page.getByPlaceholder('Ex.: número em análise').fill('Teste automatizado');
  await page.getByRole('button', { name: 'Pausar agora' }).click();
  await expect(page.getByText('Operações pausadas', { exact: true })).toBeVisible();
  await page.goto('/campanhas');
  await expect(
    page.getByText(/Envios de campanha, respostas e início de agendamentos estão suspensos/),
  ).toBeVisible();
  await page.goto('/system-health');
  await page.getByRole('button', { name: 'Retomar operações' }).click();
  await expect(page.getByText('Operações ativas')).toBeVisible();
});

test('backup manual é concluído e aparece no histórico', async () => {
  await page.goto('/system-health');
  const button = page.getByRole('button', { name: 'Fazer backup agora' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  // O worker pode ter iniciado o backup automático do dia: espera terminar.
  await expect(page.getByText('Em andamento')).toHaveCount(0, { timeout: 30_000 });
  await button.click();
  const manual = page.locator('tr', { hasText: 'Manual' }).first();
  await expect(manual).toContainText('Concluído', { timeout: 45_000 });
});

test('relatórios mostram os dados cadastrados e exportam CSV', async () => {
  await page.goto('/relatorios');
  await expect(page.getByText('Novos contatos no período')).toBeVisible();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'CSV' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^relatorio-.*\.csv$/);
});

test('auditoria registra as ações administrativas', async () => {
  await page.goto('/configuracoes');
  await page.getByLabel('Filtrar ações').selectOption('operations.');
  await expect(page.getByText('Operações pausadas', { exact: true })).toBeVisible();
  await expect(page.getByText('Operações retomadas', { exact: true })).toBeVisible();
});

test('logout encerra a sessão', async () => {
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('nenhum erro de JavaScript ou de console durante o percurso', () => {
  // 401 esperados (rota protegida antes do login, senha errada) não são erros de página.
  const unexpected = pageErrors.filter((e) => !/401|Unauthorized|status of 401/.test(e));
  expect(unexpected).toEqual([]);
});
