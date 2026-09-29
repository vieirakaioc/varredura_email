import { Router } from 'express';
import { all, get } from '../db/index.js';
import { hojeLocal } from '../util/data.js';

export const rotasDashboard = Router();

const STATUS_ACAO = "('PENDENTE','INCONSISTENTE','DUPLICADA','AGUARDANDO_XML','CORRECAO_SOLICITADA')";


rotasDashboard.get('/dashboard', (req, res) => {
  const emp = req.query.empresa_id ? Number(req.query.empresa_id) : null;
  const fEmp = emp ? 'AND d.empresa_id = :emp' : '';
  const p = emp ? { emp } : {};
  const hoje = hojeLocal();
  const mes = hoje.slice(0, 7);
  const k = get(`SELECT
      COUNT(*) AS recebidas,
      SUM(d.validado_em IS NOT NULL) AS processadas,
      SUM(d.status = 'PENDENTE') AS aguardando_validacao,
      SUM(d.status = 'APROVADA') AS aprovadas,
      SUM(d.status = 'INCONSISTENTE') AS inconsistentes,
      SUM(d.status = 'REJEITADA') AS rejeitadas,
      SUM(d.status = 'DUPLICADA') AS duplicadas,
      SUM(d.status = 'AGUARDANDO_XML') AS aguardando_xml,
      SUM(d.origem_dados <> 'xml' AND d.tipo <> 'NFSE') AS sem_xml, -- NFS-e em PDF é normal: não conta como "sem XML"
      SUM(d.status = 'CORRECAO_SOLICITADA') AS correcao_solicitada,
      SUM(d.status = 'NAO_FISCAL') AS nao_fiscal,
      SUM(d.status IN ${STATUS_ACAO}) AS aguardando_acao,
      SUM(substr(d.recebido_em,1,10) = :hoje) AS recebidas_hoje,
      SUM(substr(d.recebido_em,1,7) = :mes) AS recebidas_mes,
      SUM(substr(d.validado_em,1,10) = :hoje) AS processadas_hoje,
      SUM(substr(d.validado_em,1,7) = :mes) AS processadas_mes,
      SUM(d.status = 'APROVADA' AND substr(d.decidido_em,1,10) = :hoje) AS aprovadas_hoje,
      SUM(d.status IN ${STATUS_ACAO} AND d.prazo < :hoje) AS atrasadas,
      SUM(d.senior_status = 'nao_lancada' AND d.status IN ${STATUS_ACAO}) AS nao_lancadas_senior,
      SUM(d.senior_status = 'lancada') AS lancadas_senior,
      COALESCE(SUM(CASE WHEN d.status IN ${STATUS_ACAO} THEN d.v_total END), 0) AS valor_pendente
    FROM documentos d WHERE 1=1 ${fEmp}`, { ...p, hoje, mes });
  k.recebimentos_duplicados = get(`SELECT COUNT(*) AS n FROM recebimentos_duplicados r JOIN documentos d ON d.id = r.documento_id WHERE 1=1 ${fEmp}`, p).n;

  // Pendências prioritárias: documentos aguardando ação agrupados pelo tipo de problema
  const pendencias = [];
  const add = (titulo, filtro, n, severidade) => { if (n) pendencias.push({ titulo, filtro, quantidade: n, severidade }); };
  add('NFs sem XML', { sem_xml: '1', status: 'AGUARDANDO_XML' }, k.aguardando_xml, 'alerta');
  add('NFs potencialmente duplicadas', { status: 'DUPLICADA' }, k.duplicadas, 'erro');
  const porCategoria = all(`SELECT x.categoria, x.severidade, COUNT(DISTINCT x.documento_id) AS n FROM inconsistencias x
    JOIN documentos d ON d.id = x.documento_id WHERE x.status = 'aberta' AND d.status IN ${STATUS_ACAO} AND x.severidade IN ('erro','alerta') ${fEmp}
    AND x.regra_codigo NOT IN ('ORIGEM_PDF','NUMERO_SERIE_DUPLICADO') GROUP BY x.categoria, x.severidade`, p);
  const rotulo = { icms: 'com divergência de ICMS', cfop: 'com CFOP para revisão', valores: 'com divergência de valores', identificacao: 'com problema de identificação/chave', pis_cofins: 'com divergência de PIS/COFINS', ipi: 'com divergência de IPI', cadastro: 'com NCM/CEST inválido', servicos: 'com divergência de ISS', personalizada: 'violando regras personalizadas' };
  for (const c of porCategoria.filter((x) => x.severidade === 'erro').sort((a, b) => b.n - a.n)) add(`NFs ${rotulo[c.categoria] ?? c.categoria}`, { status: 'INCONSISTENTE', categoria: c.categoria }, c.n, 'erro');
  const cancel = get(`SELECT COUNT(*) AS n FROM documentos d WHERE d.situacao_sefaz = 'cancelada' AND d.status IN ${STATUS_ACAO} ${fEmp}`, p).n;
  add('NFs canceladas pelo emitente', { cancelada: '1' }, cancel, 'erro');
  add('NFs com prazo de validação vencido', { atrasadas: '1' }, k.atrasadas, 'alerta');
  const conf = get(`SELECT COUNT(DISTINCT x.documento_id) AS n FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id
    WHERE x.status = 'aberta' AND x.severidade = 'conferencia' AND x.origem = 'HISTORICO' AND d.status IN ${STATUS_ACAO} ${fEmp}`, p).n;
  add('NFs fora do padrão histórico do fornecedor (conferência)', { severidade: 'conferencia' }, conf, 'conferencia');

  const porDia = all(`SELECT substr(d.recebido_em,1,10) AS dia, COUNT(*) AS total,
      SUM(d.status = 'APROVADA') AS aprovadas, SUM(d.status = 'INCONSISTENTE') AS inconsistentes,
      SUM(d.status IN ('PENDENTE','AGUARDANDO_XML','CORRECAO_SOLICITADA')) AS pendentes, SUM(d.status IN ('DUPLICADA','REJEITADA','NAO_FISCAL')) AS outras
    FROM documentos d WHERE d.recebido_em >= date(:hoje, '-29 day') ${fEmp} GROUP BY dia ORDER BY dia`, { ...p, hoje });
  const porEmpresa = all(`SELECT COALESCE(e.nome_fantasia, e.razao_social, 'Não identificada') AS empresa, COUNT(*) AS total,
      COALESCE(SUM(d.v_total),0) AS valor, SUM(d.status = 'INCONSISTENTE') AS inconsistentes
    FROM documentos d LEFT JOIN empresas e ON e.id = d.empresa_id WHERE 1=1 ${fEmp} GROUP BY d.empresa_id ORDER BY total DESC`, p);
  const porTipoInconsistencia = all(`SELECT x.regra_codigo, r.nome, x.categoria, COUNT(*) AS total, COUNT(DISTINCT x.documento_id) AS documentos
    FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id LEFT JOIN regras_fiscais r ON r.codigo = x.regra_codigo
    WHERE x.status = 'aberta' AND x.severidade IN ('erro','alerta') ${fEmp} GROUP BY x.regra_codigo ORDER BY documentos DESC LIMIT 10`, p);
  const fornecedoresOcorrencias = all(`SELECT f.id, COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor, f.cnpj,
      COUNT(DISTINCT x.documento_id) AS documentos, COUNT(*) AS ocorrencias
    FROM inconsistencias x JOIN documentos d ON d.id = x.documento_id JOIN fornecedores f ON f.id = d.fornecedor_id
    WHERE x.status IN ('aberta','ignorada') AND x.severidade IN ('erro','alerta') ${fEmp}
    GROUP BY f.id ORDER BY documentos DESC, ocorrencias DESC LIMIT 10`, p);
  const emails = get(`SELECT COUNT(*) AS recebidos, SUM(status = 'processado') AS processados, SUM(status = 'sem_nf') AS sem_nf,
    SUM(status = 'erro') AS com_erro, SUM(status = 'aguardando') AS aguardando, SUM(status = 'duplicado') AS duplicados FROM emails`);
  const caixas = all('SELECT id, email, provedor, status, ultima_sincronizacao, ultimo_erro FROM caixas_email WHERE ativo = 1 ORDER BY email');

  res.json({ hoje, indicadores: k, pendencias, graficos: { porDia, porEmpresa, porTipoInconsistencia, fornecedoresOcorrencias }, emails, caixas });
});
