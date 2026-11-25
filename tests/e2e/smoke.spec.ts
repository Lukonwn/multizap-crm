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
  ['/ai/agentes', 'MultiZap AI'],
  ['/ai/atendimentos', 'MultiZap AI'],
  ['/ai/conhecimento', 'MultiZap AI'],
  ['/ai/gerador', 'MultiZap AI'],
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

test('Nova conversa: digitar um número abre a conversa, sem criar contato nem enviar nada', async () => {
  // Instância de dispositivo conectado criada pela API (sem iniciar pareamento: não há gateway no teste).
  const csrf = (await page.context().cookies()).find((c) => c.name === 'mz_csrf')!.value;
  const created = await page.request.post('/api/accounts', {
    headers: { 'x-csrf-token': csrf },
    data: { name: 'Web E2E', connectionType: 'WHATSAPP_WEB' },
  });
  expect(created.status()).toBe(201);

  await page.goto('/mensagens');
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await page.getByLabel('Instância da conversa').selectOption({ label: 'Web E2E (desconectada)' });
  await page.getByLabel('Pesquisar contatos').fill('(11) 91234-5678');
  await page.getByRole('button', { name: /Conversar com/ }).click();
  await expect(page.getByRole('heading', { name: 'Nova conversa' })).toHaveCount(0);
  await expect(page.getByText(/91234.?5678/).first()).toBeVisible();
  await expect(page.getByText('A instância não está conectada.')).toBeVisible();
});

test('MultiZap AI: persona, agente, publicação e laboratório sem enviar nada', async () => {
  await page.goto('/ai/configuracoes');
  await expect(page.getByText('Nenhuma chave configurada')).toBeVisible();

  await page.goto('/ai/personas');
  await page.getByRole('link', { name: 'Nova persona' }).click();
  // Menu aberto dos campos de seleção: opções com fundo escuro e letra clara (não a lista branca do navegador).
  const optionColors = await page.getByLabel('Formalidade').evaluate((el) => {
    const o = (el as HTMLSelectElement).options[0]!;
    const st = getComputedStyle(o);
    return { bg: st.backgroundColor, fg: st.color };
  });
  expect(optionColors).toEqual({ bg: 'rgb(23, 32, 42)', fg: 'rgb(245, 247, 250)' });
  await page.getByLabel('Nome', { exact: true }).fill('Ana E2E');
  await page.getByLabel('Tom de voz').fill('Acolhedor e direto');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByText('Persona salva.')).toBeVisible();
  await page.getByLabel('Tom de voz').fill('Acolhedor, direto e simpático');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByText(/Alterado: .*tom de voz/i)).toBeVisible();

  // Gerador de Persona: sem chave da OpenRouter o pedido é recusado com a mensagem certa.
  await page.goto('/ai/gerador');
  await page
    .getByLabel('Descreva o negócio e como o agente deve ser')
    .fill('Loja de cafés especiais, atendimento informal.');
  await page.getByLabel('Modelo do gerador').fill('openai/gpt-4o-mini');
  await page.getByRole('button', { name: 'Gerar pacote' }).click();
  await expect(page.getByText(/Configure a chave da OpenRouter/).first()).toBeVisible();

  // Base de conhecimento: o worker real lê a fonte e ela fica pronta para uso.
  await page.goto('/ai/conhecimento');
  await expect(page.getByText('Nenhum conhecimento ainda')).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar conhecimento' }).first().click();
  await page.getByRole('tab', { name: 'Pergunta e resposta' }).click();
  await page.getByLabel('Pergunta').fill('Qual o prazo de entrega?');
  await page.getByLabel('Resposta').fill('Entregamos em até 3 dias úteis.');
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.locator('span', { hasText: /^Pronta$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Qual o prazo de entrega?').first()).toBeVisible();

  await page.goto('/ai/agentes');
  await page.getByRole('button', { name: 'Novo agente' }).click();
  await page.getByLabel('Nome do agente').fill('Atendente E2E');
  await page.getByLabel('Persona').selectOption({ label: 'Ana E2E' });
  await page.getByLabel('Modelo').fill('openai/gpt-4o-mini');
  await page.getByRole('button', { name: 'Criar agente' }).click();
  await expect(page.getByRole('heading', { name: 'Atendente E2E' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Revisão humana' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: /Ativar/ })).toBeDisabled();

  await page.getByRole('checkbox', { name: /Qual o prazo de entrega/ }).check();
  await page.getByRole('button', { name: 'Salvar conhecimento' }).click();
  await expect(page.getByText('Salvo.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await expect(page.getByText('Publicada: v1')).toBeVisible();

  // Sem chave da OpenRouter o agente não pode ser ativado (e nada chega ao WhatsApp).
  await page.getByRole('button', { name: 'Ativar agente' }).click();
  await expect(page.getByText(/Configure a chave da OpenRouter/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pausar agente' })).toHaveCount(0);

  await page.goto('/ai/atendimentos');
  await expect(page.getByText('Nenhuma conversa')).toBeVisible();
  await page.goBack();

  await page.getByRole('link', { name: 'Testar no laboratório' }).click();
  await expect(page.getByText('Simulação', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nova conversa de teste' }).click();
  await page.getByLabel('Mensagem de teste').fill('Olá, tudo bem?');
  await page.getByRole('button', { name: 'Enviar mensagem de teste' }).click();
  await expect(page.getByText('Configure a chave da OpenRouter')).toBeVisible();
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
  // 409 na tela do agente: recusa esperada ao ativar sem chave da OpenRouter.
  const unexpected = pageErrors.filter(
    (e) =>
      !/401|Unauthorized|status of 401/.test(e) &&
      !/\/ai\/(agentes\/|gerador).*status of 409/.test(e),
  );
  expect(unexpected).toEqual([]);
});
