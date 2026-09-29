// Consulta à SEFAZ: certificados digitais, Distribuição DF-e e notas canceladas.
import { Router } from 'express';
import multer from 'multer';
import { all, get, run } from '../db/index.js';
import { permitir } from '../auth.js';
import { auditar } from '../util/log.js';
import { dataHoraLocal } from '../util/data.js';
import { listarCertificados, salvarCertificado, removerCertificado, importarDaPasta } from '../fiscal/sefaz/certificados.js';
import { atualizarTodos, consultarCnpj, consultarChave } from '../fiscal/sefaz/dfe.js';
import { canceladasNaSefaz } from '../fiscal/sefaz/canceladas.js';

export const rotasSefaz = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

rotasSefaz.get('/sefaz', permitir('ver'), (req, res) => {
  const resumo = get(`SELECT COUNT(*) AS eventos,
      SUM(tp_evento IN ('110111','110112')) AS cancelamentos,
      SUM(tp_evento IN ('110111','110112') AND tratado_em IS NULL) AS cancelamentos_abertos,
      MAX(created_at) AS ultimo FROM sefaz_eventos`);
  res.json({
    ambiente: process.env.SEFAZ_AMBIENTE === 'homologacao' ? 'homologação' : 'produção',
    certificados: listarCertificados(),
    controle: all('SELECT * FROM dfe_controle ORDER BY cnpj'),
    resumo,
  });
});

rotasSefaz.post('/certificados', permitir('administrar'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .pfx do certificado A1' });
  if (!req.body?.senha) return res.status(400).json({ erro: 'Informe a senha do certificado' });
  const r = salvarCertificado({
    buffer: req.file.buffer, nomeArquivo: req.file.originalname, senha: String(req.body.senha),
    cnpjInformado: req.body.cnpj, empresaId: req.body.empresa_id ? Number(req.body.empresa_id) : null,
  });
  auditar(req.usuario.id, 'certificado.cadastrar', 'certificado', r.cnpj, { titular: r.titular, valido_ate: r.valido_ate, substituido: r.substituido }, req.ip);
  res.json(r);
});

// Importa todos os .pfx de uma pasta do servidor (útil para dezenas de CNPJs)
rotasSefaz.post('/certificados/importar', permitir('administrar'), (req, res) => {
  const r = importarDaPasta({
    pasta: String(req.body?.pasta ?? ''),
    senhas: Array.isArray(req.body?.senhas) ? req.body.senhas : String(req.body?.senhas ?? '').split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean),
    simular: Boolean(req.body?.simular),
  });
  auditar(req.usuario.id, r.simulacao ? 'certificado.importar_simular' : 'certificado.importar', 'certificado', null,
    { pasta: req.body?.pasta, arquivos: r.arquivos, importados: r.importados.length, sem_senha: r.sem_senha.length }, req.ip);
  res.json(r);
});

rotasSefaz.delete('/certificados/:id', permitir('administrar'), (req, res) => {
  const ok = removerCertificado(Number(req.params.id));
  auditar(req.usuario.id, 'certificado.remover', 'certificado', req.params.id, null, req.ip);
  res.json({ ok });
});

rotasSefaz.post('/sefaz/atualizar', permitir('decidir'), async (req, res) => {
  const r = req.body?.cnpj
    ? await consultarCnpj(String(req.body.cnpj).replace(/\D/g, ''), { forcar: true })
    : await atualizarTodos({ forcar: true });
  auditar(req.usuario.id, 'sefaz.distribuicao', 'sefaz', req.body?.cnpj ?? null, { novos: r.novos ?? null }, req.ip);
  res.json(r);
});

rotasSefaz.get('/sefaz/canceladas', permitir('ver'), async (req, res) => {
  res.json(await canceladasNaSefaz(req.query));
});

rotasSefaz.post('/sefaz/eventos/:id/tratar', permitir('decidir'), (req, res) => {
  const id = Number(req.params.id);
  const tratar = req.body?.desfazer ? [null, null, null] : [dataHoraLocal(), req.usuario.id, req.body?.observacao ?? null];
  run('UPDATE sefaz_eventos SET tratado_em = ?, tratado_por = ?, observacao = ? WHERE id = ?', [...tratar, id]);
  auditar(req.usuario.id, 'sefaz.evento_tratar', 'sefaz_evento', id, req.body, req.ip);
  res.json({ ok: true });
});

// Conferência pontual de uma chave (usa o certificado do CNPJ destinatário informado)
rotasSefaz.post('/sefaz/consultar-chave', permitir('decidir'), async (req, res) => {
  const chave = String(req.body?.chave ?? '').replace(/\D/g, '');
  const cnpj = String(req.body?.cnpj ?? '').replace(/\D/g, '');
  if (chave.length !== 44) return res.status(400).json({ erro: 'Informe a chave de acesso com 44 dígitos' });
  if (cnpj.length !== 14) return res.status(400).json({ erro: 'Informe o CNPJ da empresa destinatária (com certificado cadastrado)' });
  const r = await consultarChave(cnpj, chave);
  auditar(req.usuario.id, 'sefaz.consultar_chave', 'sefaz', chave, { status: r.status }, req.ip);
  res.json(r);
});
