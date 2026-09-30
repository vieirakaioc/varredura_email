import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { config, paths, ROOT_DIR } from './config.js';
import { get, insert, run } from './db/index.js';
import { autenticar, hashSenha } from './auth.js';
import { log } from './util/log.js';
import { tokenAleatorio } from './util/cripto.js';
import { sincronizarCatalogo } from './fiscal/motor.js';
import { iniciarAgendador } from './captura/index.js';
import { rotasAuth, rotasAuthPublicas } from './rotas/auth.js';
import { rotasDashboard } from './rotas/dashboard.js';
import { rotasDocumentos } from './rotas/documentos.js';
import { rotasEmails, rotasOauthPublicas } from './rotas/emails.js';
import { rotasCadastros } from './rotas/cadastros.js';
import { rotasRelatorios } from './rotas/relatorios.js';
import { rotasSefaz } from './rotas/sefaz.js';
import { rotasErpAdmin, rotasErpApi } from './rotas/erp.js';
import { rotasFinanceiro } from './rotas/financeiro.js';

// ------------------------------------------------------------------ inicialização
sincronizarCatalogo();

if (!get('SELECT 1 FROM usuarios LIMIT 1')) {
  const senha = process.env.ADMIN_SENHA || tokenAleatorio(9);
  const email = process.env.ADMIN_EMAIL || 'admin@validador.local';
  insert('usuarios', { nome: 'Administrador', email, perfil: 'admin', senha_hash: hashSenha(senha) });
  console.log(`\n==> Usuário administrador criado: ${email} / senha: ${process.env.ADMIN_SENHA ? '(definida em ADMIN_SENHA)' : senha}\n`);
}
for (const email of config.captura.caixasPadrao) {
  if (!get('SELECT 1 FROM caixas_email WHERE email = ?', [email])) insert('caixas_email', { email, provedor: 'zoho' });
}

// ------------------------------------------------------------------ app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '25mb' })); // exportação de tabelas envia as linhas filtradas
// Respostas JSON grandes (listas de notas do Senior) vão comprimidas: ~10x menos para baixar
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (corpo) => {
    const texto = JSON.stringify(corpo);
    if (texto.length < 8192 || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return json(corpo);
    zlib.gzip(texto, { level: 5 }, (erro, comprimido) => {
      if (erro || res.headersSent) return erro && !res.headersSent ? res.type('json').send(texto) : undefined;
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.type('json').send(comprimido);
    });
    return res;
  };
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Versão em execução (commit do git no momento em que o servidor subiu): mostra se a atualização entrou mesmo
const versao = (() => {
  try {
    const git = path.join(ROOT_DIR, '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { commit: head.slice(0, 7), branch: null };
    const ref = head.slice(5);
    let commit = null;
    if (fs.existsSync(path.join(git, ref))) commit = fs.readFileSync(path.join(git, ref), 'utf8').trim();
    else commit = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
    return { commit: commit?.slice(0, 7) ?? null, branch: ref.replace('refs/heads/', '') };
  } catch { return { commit: null, branch: null }; }
})();
const iniciadoEm = new Date().toLocaleString('sv-SE');
app.get('/api/saude', (req, res) => res.json({ ok: true, ia: config.ia.habilitada, versao: versao.commit, branch: versao.branch, iniciado_em: iniciadoEm }));
app.use('/api', rotasAuthPublicas, rotasOauthPublicas);
app.use('/api/erp/v1', rotasErpApi);
app.use('/api', autenticar, rotasAuth, rotasDashboard, rotasDocumentos, rotasEmails, rotasCadastros, rotasRelatorios, rotasFinanceiro, rotasErpAdmin, rotasSefaz);
app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));

// Front-end compilado (npm run build)
if (fs.existsSync(paths.webDist)) {
  app.use(express.static(paths.webDist, { index: false, maxAge: '1h' }));
  app.get('/{*caminho}', (req, res) => res.sendFile(path.join(paths.webDist, 'index.html')));
}

// Erros (Express 5 encaminha rejeições de handlers async)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log('erro', 'api', `${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  res.status(status).json({ erro: status >= 500 && !err.expose ? (err.message || 'Erro interno') : err.message });
});

app.listen(config.port, () => {
  log('info', 'api', `Validador Fiscal em ${config.publicUrl} (IA ${config.ia.habilitada ? 'habilitada' : 'desabilitada'})`);
  // Caixas que ficaram "sincronizando" por um reinício no meio da leitura voltam ao normal
  run("UPDATE caixas_email SET status = 'conectada' WHERE status = 'sincronizando' AND oauth_token_enc IS NOT NULL");
  iniciarAgendador();
});
