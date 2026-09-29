-- =====================================================================
-- Validador Fiscal - esquema do banco (SQLite)
-- Camadas separadas para rastreabilidade (item 19 da especificação):
--   DADO EXTRAÍDO        -> documentos, documento_itens, item_impostos (+ dados_extraidos imutável)
--   VALIDAÇÃO AUTOMÁTICA -> validacoes
--   ALERTA               -> inconsistencias
--   SUGESTÃO DA IA       -> sugestoes_ia
--   DECISÃO DO USUÁRIO   -> decisoes, alteracoes_campo
-- =====================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  ie TEXT,
  uf TEXT NOT NULL,
  municipio TEXT,
  regime_tributario TEXT CHECK (regime_tributario IN ('simples','presumido','real')),
  perfil_fiscal TEXT,               -- comercio | industria | servicos | misto
  regras_especificas TEXT,          -- JSON livre com parâmetros por empresa
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','fiscal','consulta','auditor','financeiro')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS fornecedores (
  id INTEGER PRIMARY KEY,
  cnpj TEXT NOT NULL UNIQUE,
  razao_social TEXT,
  nome_fantasia TEXT,
  ie TEXT,
  uf TEXT,
  municipio TEXT,
  crt TEXT,                         -- código de regime tributário informado no XML
  regime_tributario TEXT,
  tipo_fornecedor TEXT,             -- revenda | insumo | uso_consumo | ativo | servico | transporte | outros
  observacoes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Caixas de e-mail monitoradas. Nenhuma senha é armazenada: apenas o refresh token
-- OAuth, cifrado com AES-256-GCM (chave derivada de APP_SECRET).
CREATE TABLE IF NOT EXISTS caixas_email (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  provedor TEXT NOT NULL DEFAULT 'zoho' CHECK (provedor IN ('zoho','imap','pasta','manual')),
  empresa_id INTEGER REFERENCES empresas(id),
  oauth_token_enc TEXT,
  provedor_conta_id TEXT,
  pastas TEXT,                      -- JSON: nomes/ids das pastas lidas (padrão: Inbox)
  status TEXT NOT NULL DEFAULT 'desconectada',  -- desconectada | conectada | erro | sincronizando
  ultima_sincronizacao TEXT,
  sincronizar_desde TEXT,
  ultimo_erro TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  caixa_id INTEGER NOT NULL REFERENCES caixas_email(id),
  id_provedor TEXT NOT NULL,        -- ID do e-mail no provedor
  internet_message_id TEXT,         -- Message-ID RFC 5322 (detecta o mesmo e-mail em duas caixas)
  pasta TEXT,
  remetente TEXT,
  remetente_nome TEXT,
  destinatarios TEXT,
  cc TEXT,
  assunto TEXT,
  data_recebimento TEXT,
  qtd_anexos INTEGER NOT NULL DEFAULT 0,
  relevancia_fiscal TEXT,           -- provavel | possivel | improvavel
  status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','processado','sem_nf','erro','duplicado')),
  erro TEXT,
  processado_em TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (caixa_id, id_provedor)
);
CREATE INDEX IF NOT EXISTS ix_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS ix_emails_msgid ON emails(internet_message_id);
CREATE INDEX IF NOT EXISTS ix_emails_data ON emails(data_recebimento);

CREATE TABLE IF NOT EXISTS anexos (
  id INTEGER PRIMARY KEY,
  email_id INTEGER REFERENCES emails(id),
  nome_arquivo TEXT NOT NULL,
  mime TEXT,
  tamanho INTEGER,
  sha256 TEXT NOT NULL,
  caminho TEXT NOT NULL,            -- relativo a data/anexos
  origem TEXT NOT NULL DEFAULT 'email',   -- email | upload | pasta | zip
  anexo_pai_id INTEGER REFERENCES anexos(id),  -- arquivo extraído de um ZIP
  tipo_detectado TEXT,              -- nfe_xml | cte_xml | nfse_xml | evento_xml | danfe_pdf | dacte_pdf | nfse_pdf | pdf_desconhecido | zip | outro
  documento_id INTEGER REFERENCES documentos(id),
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | processado | duplicado | ignorado | erro
  mensagem TEXT,
  texto_extraido TEXT,              -- texto do PDF (para conferência XML x PDF)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_anexos_sha ON anexos(sha256);
CREATE INDEX IF NOT EXISTS ix_anexos_email ON anexos(email_id);
CREATE INDEX IF NOT EXISTS ix_anexos_doc ON anexos(documento_id);

CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL,               -- NFE | NFCE | CTE | NFSE | OUTRO
  modelo TEXT,
  origem_dados TEXT NOT NULL,       -- xml | pdf_texto | pdf_ia | manual
  chave_acesso TEXT,                -- índice único abaixo
  numero TEXT,
  serie TEXT,
  data_emissao TEXT,
  data_entrada TEXT,
  natureza_operacao TEXT,
  tipo_operacao TEXT,               -- 0 entrada | 1 saída (tpNF do emitente)
  finalidade TEXT,                  -- finNFe 1 normal | 2 complementar | 3 ajuste | 4 devolução
  protocolo TEXT,
  situacao_sefaz TEXT,              -- autorizada | cancelada | desconhecida
  emitente_cnpj TEXT,
  emitente_nome TEXT,
  emitente_ie TEXT,
  emitente_uf TEXT,
  emitente_municipio TEXT,
  emitente_crt TEXT,
  destinatario_cnpj TEXT,
  destinatario_nome TEXT,
  destinatario_ie TEXT,
  destinatario_uf TEXT,
  empresa_id INTEGER REFERENCES empresas(id),
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  v_prod REAL, v_frete REAL, v_seguro REAL, v_desconto REAL, v_outro REAL,
  v_bc_icms REAL, v_icms REAL, v_icms_deson REAL, v_bc_st REAL, v_icms_st REAL, v_fcp REAL, v_fcp_st REAL,
  v_ipi REAL, v_ipi_devol REAL, v_ii REAL, v_pis REAL, v_cofins REAL, v_servicos REAL, v_iss REAL,
  v_total REAL,
  qtd_itens INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN
    ('PENDENTE','APROVADA','INCONSISTENTE','DUPLICADA','AGUARDANDO_XML','REJEITADA','CORRECAO_SOLICITADA','NAO_FISCAL')),
  bloqueada INTEGER NOT NULL DEFAULT 0,
  responsavel_id INTEGER REFERENCES usuarios(id),
  prioridade INTEGER NOT NULL DEFAULT 3,   -- 1 (alta) .. 5 (baixa)
  prazo TEXT,
  duplicado_de_id INTEGER REFERENCES documentos(id),
  qtd_recebimentos INTEGER NOT NULL DEFAULT 1,  -- quantas vezes o mesmo documento chegou
  xml_anexo_id INTEGER REFERENCES anexos(id),
  pdf_anexo_id INTEGER REFERENCES anexos(id),
  email_id INTEGER REFERENCES emails(id),   -- primeiro e-mail em que o documento chegou
  dados_extraidos TEXT NOT NULL,     -- JSON imutável do que foi lido do arquivo
  confianca_extracao REAL,           -- 1.0 para XML; menor para PDF/IA
  recebido_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  validado_em TEXT,
  decidido_em TEXT,
  erp_status TEXT,                   -- null | pendente | integrado | erro
  erp_referencia TEXT,
  erp_integrado_em TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_chave ON documentos(chave_acesso) WHERE chave_acesso IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_documentos_status ON documentos(status);
CREATE INDEX IF NOT EXISTS ix_documentos_emitente ON documentos(emitente_cnpj, numero, serie);
CREATE INDEX IF NOT EXISTS ix_documentos_empresa ON documentos(empresa_id);
CREATE INDEX IF NOT EXISTS ix_documentos_fornecedor ON documentos(fornecedor_id);
CREATE INDEX IF NOT EXISTS ix_documentos_recebido ON documentos(recebido_em);

-- Registro de cada vez que o mesmo documento (mesma chave) chegou novamente.
CREATE TABLE IF NOT EXISTS recebimentos_duplicados (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  anexo_id INTEGER REFERENCES anexos(id),
  email_id INTEGER REFERENCES emails(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Eventos fiscais recebidos (cancelamento, carta de correção...). documento_id nulo = documento ainda não recebido.
CREATE TABLE IF NOT EXISTS documento_eventos (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER REFERENCES documentos(id) ON DELETE CASCADE,
  chave_acesso TEXT NOT NULL,
  tp_evento TEXT NOT NULL,
  descricao TEXT,
  texto TEXT,
  data_evento TEXT,
  anexo_id INTEGER REFERENCES anexos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (chave_acesso, tp_evento, data_evento)
);
CREATE INDEX IF NOT EXISTS ix_eventos_chave ON documento_eventos(chave_acesso);

-- Duplicatas (parcelas de cobrança) lidas do XML: base do painel financeiro / contas a pagar.
-- numero/vencimento/valor são DADO EXTRAÍDO; status_pagamento é controle do usuário.
CREATE TABLE IF NOT EXISTS documento_duplicatas (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  numero TEXT,
  vencimento TEXT,
  valor REAL,
  status_pagamento TEXT NOT NULL DEFAULT 'aberta' CHECK (status_pagamento IN ('aberta','programada','paga','cancelada')),
  data_pagamento TEXT,
  atualizado_por INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  UNIQUE (documento_id, numero)
);
CREATE INDEX IF NOT EXISTS ix_duplicatas_venc ON documento_duplicatas(vencimento, status_pagamento);

-- Títulos a pagar do Senior (E501TCP) vinculados à nota: vencimento e pagamento oficiais.
CREATE TABLE IF NOT EXISTS senior_titulos (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  codemp TEXT, codfil TEXT, numtit TEXT NOT NULL, codtpt TEXT,
  situacao TEXT,              -- código do Senior (AB, PE, LQ, LS, LM, CA...)
  situacao_grupo TEXT,        -- aberto | em_pagamento | pago | baixado_sem_pagamento | cancelado
  vencimento TEXT, valor REAL, valor_aberto REAL, data_pagamento TEXT,
  atualizado_em TEXT,
  UNIQUE (documento_id, codemp, codfil, numtit, codtpt)
);

-- Certificados digitais A1 (.pfx) usados para consultar a SEFAZ. O arquivo fica no disco (data/certificados)
-- e a senha é guardada cifrada com o APP_SECRET, nunca em texto puro nem devolvida pela API.
CREATE TABLE IF NOT EXISTS certificados_digitais (
  id INTEGER PRIMARY KEY,
  cnpj TEXT NOT NULL UNIQUE,
  empresa_id INTEGER REFERENCES empresas(id),
  titular TEXT,
  arquivo TEXT NOT NULL,            -- caminho relativo em data/certificados
  senha_enc TEXT NOT NULL,
  valido_de TEXT, valido_ate TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_erro TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Controle da Distribuição DF-e por CNPJ (NSU = numeração sequencial dos documentos na SEFAZ)
CREATE TABLE IF NOT EXISTS dfe_controle (
  cnpj TEXT PRIMARY KEY,
  ult_nsu TEXT NOT NULL DEFAULT '0',
  max_nsu TEXT,
  ultima_consulta TEXT,
  proxima_consulta TEXT,            -- respeita o bloqueio da SEFAZ por consumo indevido
  ultimo_status TEXT,                -- último retorno efetivo (137 nada novo / 138 documentos localizados)
  ultimo_aviso TEXT,                 -- 656 "consumo indevido": a SEFAZ pede 1 h entre consultas, não é erro
  ultimo_erro TEXT,
  documentos INTEGER NOT NULL DEFAULT 0
);

-- Eventos e resumos recebidos da SEFAZ (cancelamento, carta de correção, resumo de NF-e contra o CNPJ)
CREATE TABLE IF NOT EXISTS sefaz_eventos (
  id INTEGER PRIMARY KEY,
  chave TEXT NOT NULL,
  cnpj_destinatario TEXT NOT NULL,
  tipo TEXT NOT NULL,               -- resumo | evento
  tp_evento TEXT,                   -- 110111 cancelamento, 110110 CC-e, 210200 confirmação...
  descricao TEXT,
  data_evento TEXT,
  protocolo TEXT,
  justificativa TEXT,
  emitente_cnpj TEXT, emitente_nome TEXT, numero TEXT, serie TEXT, valor REAL, data_emissao TEXT,
  nsu TEXT,
  tratado_em TEXT, tratado_por INTEGER REFERENCES usuarios(id), observacao TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (chave, tp_evento, nsu)
);
CREATE INDEX IF NOT EXISTS idx_sefaz_eventos_chave ON sefaz_eventos (chave);

-- De-para mantido pelo fiscal: CFOPs de entrada permitidos para cada transação do Senior
CREATE TABLE IF NOT EXISTS transacao_cfop (
  id INTEGER PRIMARY KEY,
  codtns TEXT NOT NULL UNIQUE,
  cfops TEXT NOT NULL,            -- lista "1556, 2556"
  observacao TEXT,
  atualizado_por INTEGER REFERENCES usuarios(id),
  atualizado_em TEXT
);

CREATE TABLE IF NOT EXISTS documento_itens (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  n_item INTEGER NOT NULL,
  codigo TEXT,
  ean TEXT,
  descricao TEXT,
  ncm TEXT,
  cest TEXT,
  cfop TEXT,
  unidade TEXT,
  quantidade REAL,
  valor_unitario REAL,
  valor_total REAL,
  v_desconto REAL, v_frete REAL, v_seguro REAL, v_outro REAL,
  -- Escrituração: CFOP de entrada sugerido pelo motor x confirmado pelo usuário
  cfop_entrada_sugerido TEXT,
  cfop_entrada TEXT,
  UNIQUE (documento_id, n_item)
);

CREATE TABLE IF NOT EXISTS item_impostos (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES documento_itens(id) ON DELETE CASCADE,
  tributo TEXT NOT NULL,            -- ICMS | ICMSST | IPI | PIS | COFINS | ISS | FCP | DIFAL
  cst TEXT,                         -- CST ou CSOSN
  origem TEXT,
  modalidade_bc TEXT,
  base REAL,
  aliquota REAL,
  valor REAL,
  reducao_bc REAL,
  mva REAL,
  UNIQUE (item_id, tributo)
);

CREATE TABLE IF NOT EXISTS regras_fiscais (
  id INTEGER PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  descricao TEXT,
  categoria TEXT NOT NULL,          -- identificacao | valores | cfop | icms | pis_cofins | ipi | historico | cadastro | personalizada
  tipo TEXT NOT NULL DEFAULT 'nativa', -- nativa (implementada no motor) | condicional (definida pelo administrador)
  severidade TEXT NOT NULL DEFAULT 'erro' CHECK (severidade IN ('erro','alerta','conferencia')),
  parametros TEXT,                  -- JSON
  definicao TEXT,                   -- JSON da regra condicional
  empresa_id INTEGER REFERENCES empresas(id),  -- null = todas
  ativo INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES usuarios(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Resultado de cada regra executada em cada execução do motor.
CREATE TABLE IF NOT EXISTS validacoes (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  execucao INTEGER NOT NULL,        -- número sequencial da execução do motor para o documento
  regra_codigo TEXT NOT NULL,
  resultado TEXT NOT NULL CHECK (resultado IN ('ok','falha','nao_aplicavel')),
  detalhe TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_validacoes_doc ON validacoes(documento_id, execucao);

CREATE TABLE IF NOT EXISTS inconsistencias (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  execucao INTEGER NOT NULL,
  origem TEXT NOT NULL DEFAULT 'MOTOR' CHECK (origem IN ('MOTOR','HISTORICO')),
  regra_codigo TEXT NOT NULL,
  severidade TEXT NOT NULL,
  categoria TEXT,
  n_item INTEGER,
  problema TEXT NOT NULL,
  regra_violada TEXT NOT NULL,
  valor_encontrado TEXT,
  valor_esperado TEXT,
  contexto TEXT,
  acao_sugerida TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','ignorada','resolvida')),
  tratada_por INTEGER REFERENCES usuarios(id),
  justificativa TEXT,
  tratada_em TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_incons_doc ON inconsistencias(documento_id, status);

-- Sugestões da IA: nunca aplicadas automaticamente.
CREATE TABLE IF NOT EXISTS sugestoes_ia (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,               -- analise | explicacao | extracao_pdf | classificacao
  inconsistencia_id INTEGER REFERENCES inconsistencias(id) ON DELETE SET NULL,
  conteudo TEXT NOT NULL,           -- JSON
  modelo TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aceita','descartada','informativa')),
  decidido_por INTEGER REFERENCES usuarios(id),
  decidido_em TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Decisões do usuário (aprovação, reprovação, encaminhamento...). Histórico imutável.
CREATE TABLE IF NOT EXISTS decisoes (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,               -- APROVAR | REPROVAR | SOLICITAR_CORRECAO | NAO_FISCAL | IGNORAR_ALERTA | OBSERVACAO | ENCAMINHAR | REPROCESSAR | ALTERAR_CAMPO | ACEITAR_SUGESTAO_IA | DESCARTAR_SUGESTAO_IA | REABRIR | SISTEMA
  justificativa TEXT,
  dados TEXT,                       -- JSON
  status_anterior TEXT,
  status_novo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_decisoes_doc ON decisoes(documento_id);

-- Alterações em dados fiscais feitas por usuário (valor original preservado em dados_extraidos).
CREATE TABLE IF NOT EXISTS alteracoes_campo (
  id INTEGER PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES documento_itens(id) ON DELETE CASCADE,
  campo TEXT NOT NULL,
  valor_anterior TEXT,
  valor_novo TEXT,
  origem TEXT NOT NULL DEFAULT 'USUARIO',   -- USUARIO | SUGESTAO_IA_ACEITA | SUGESTAO_MOTOR_ACEITA
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  justificativa TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS logs_auditoria (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  entidade TEXT,
  entidade_id TEXT,
  detalhes TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_auditoria_data ON logs_auditoria(created_at);

CREATE TABLE IF NOT EXISTS logs_processamento (
  id INTEGER PRIMARY KEY,
  nivel TEXT NOT NULL,
  modulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  contexto TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Chaves de API para integração com ERP (armazenado apenas o hash).
CREATE TABLE IF NOT EXISTS integracoes_erp (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  sistema TEXT NOT NULL,            -- generico | senior | sankhya | outro
  chave_hash TEXT NOT NULL UNIQUE,
  chave_prefixo TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_uso TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
