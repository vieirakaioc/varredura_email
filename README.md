# Validador Fiscal — Escrita Fiscal e Validador de NFs

Sistema web que lê as caixas **suprimentos@grupocomelli.com.br** e **suprimentos@comber.com.br**, identifica os documentos fiscais anexados (NF-e, NFC-e, CT-e, NFS-e, DANFE/DACTE em PDF, ZIP e eventos de cancelamento/CC-e), extrai os dados, executa um motor de regras fiscais e organiza tudo em uma fila de validação para a equipe de Escrita Fiscal, com um painel financeiro de contas a pagar.

**E-mail → Anexo → Identificação → Leitura → Validação → Status → Escrita Fiscal → (ERP)**

## Como rodar

Requisitos: Node.js 22.13+ (testado no 24). Não há banco externo: o sistema usa o SQLite embutido no Node (`node:sqlite`).

```bash
npm install
cp .env.example .env        # preencha APP_SECRET (obrigatório) e, quando tiver, as chaves do Zoho
npm run build               # compila o front-end
npm run seed -- --reset     # OPCIONAL: base de demonstração fictícia (~100 e-mails/NFs)
npm start                   # http://localhost:3000
```

Desenvolvimento com recarga automática: `npm run dev` (API na porta 3000 e front na 5173 com proxy).
Testes: `npm test`.

Sem o seed, o primeiro start cria o administrador `ADMIN_EMAIL` com a senha de `ADMIN_SENHA` (ou uma senha aleatória, que aparece no console).
Com o seed, os usuários de demonstração são `admin@`, `joao.fiscal@`, `maria.fiscal@`, `consulta@`, `auditor@` e `financeiro@validador.local`, todos com a senha `demo2026fiscal`.
**Não use o seed em produção.**

## Conectar as caixas de e-mail (Zoho Mail)

Os dois domínios usam **Zoho Mail** (o MX aponta para `mx.zoho.com`). O conector usa a API REST oficial com OAuth 2.0 e **escopos somente leitura**. O sistema nunca move, exclui ou marca e-mails.

1. Em https://api-console.zoho.com, crie um cliente **Server-based Application**.
2. Informe a URL de redirecionamento `PUBLIC_URL/api/oauth/zoho/callback` (ex.: `http://localhost:3000/api/oauth/zoho/callback`).
3. Coloque `ZOHO_CLIENT_ID` e `ZOHO_CLIENT_SECRET` no `.env`. Se a conta estiver em outro data center, ajuste `ZOHO_ACCOUNTS_URL` e `ZOHO_MAIL_API_URL`.
4. No sistema, abra **Caixas de entrada → Conectar (OAuth)** em cada caixa e autorize com o usuário daquela caixa.

O refresh token é gravado **cifrado com AES-256-GCM** (a chave vem de `APP_SECRET`). Nenhuma senha de e-mail vai para o banco. Depois de conectar, não troque o `APP_SECRET`: os tokens salvos ficariam ilegíveis.

Outras opções de conector:
- **IMAP somente leitura**, com senha de aplicativo definida no `.env`.
- **Pasta local**, que lê arquivos `.eml`, XML, PDF ou ZIP.
- **Upload manual**, pela tela *Importar arquivos*.

A leitura automática roda a cada `CAPTURA_INTERVALO_MIN` minutos. Não há reprocessamento duplicado: cada e-mail é identificado por caixa + ID no provedor, cada arquivo pelo SHA-256 e cada documento pela chave de acesso (com índice único).

## Arquitetura

```
server/src/
  captura/        E-mail: Zoho (OAuth), IMAP (readOnly), pasta local; agendador; deduplicação
  processamento/  Identificação (XML/PDF/ZIP), leitura de NF-e/CT-e/NFS-e (nacional e ABRASF)/eventos, DANFE via texto, ingestão
  fiscal/         Validadores (CNPJ numérico e alfanumérico, chave), tabelas, catálogo de regras, motor, histórico do fornecedor
  ia/             Camada auxiliar Claude: leitura de PDF escaneado, análise, explicação de alertas (somente sugestões)
  erp/            Adaptadores de saída (genérico; esboços para Senior e Sankhya)
  rotas/          API REST (documentos, fila, e-mails, cadastros, regras, relatórios, financeiro, auditoria, ERP)
  db/             Esquema SQLite, acesso e seed de demonstração
web/src/          React: painel executivo, fila, painel de validação, caixas, financeiro, cadastros, regras, relatórios
```

### Separação das camadas (rastreabilidade)

| Camada | Onde fica | Quem altera |
|---|---|---|
| **Dado extraído** | `documentos`, `documento_itens`, `item_impostos`, `documento_duplicatas` e o JSON imutável `dados_extraidos` | ninguém (só um reprocessamento do arquivo original) |
| **Validação automática** | `validacoes` (resultado de cada regra em cada execução) | motor |
| **Alerta** | `inconsistencias`: problema, regra violada, valor encontrado, valor esperado e ação sugerida | motor; o usuário só pode ignorar, sempre com justificativa |
| **Sugestão da IA** | `sugestoes_ia` | IA; nunca é aplicada automaticamente |
| **Decisão do usuário** | `decisoes`, `alteracoes_campo`, `logs_auditoria` | usuário, sempre com registro de quem, quando e por quê |

Os dados fiscais do documento (CFOP, CST, NCM, alíquotas, impostos) **nunca são alterados**. O que o usuário confirma é o **CFOP de entrada** para escrituração. Esse CFOP é sugerido pelo motor ou pela IA e só é gravado com confirmação e justificativa.

### Motor fiscal

São 44 regras nativas, com parâmetros e severidade configuráveis na tela *Regras fiscais*:

- **Identificação:** chave (DV e coerência), CNPJ, destinatário do grupo, IE, duplicidade de número e série, cancelamento e CC-e, correspondência entre XML e PDF, datas.
- **Valores:** soma dos itens, total da NF, quantidade × valor unitário, desconto, frete, totais dos tributos, duplicatas × fatura.
- **CFOP:** operação interna × interestadual, tipo de documento, transferência, devolução, industrialização, bonificação, ativo e uso e consumo, lista de permitidos e bloqueados.
- **ICMS:** CST/CSOSN × regime, cálculo, alíquota interestadual (4/7/12%), alíquota interna por UF, base de cálculo, ST e CEST, estimativa de DIFAL.
- **PIS/COFINS e IPI:** CST, alíquotas e cálculo. **ISS:** cálculo.
- **Histórico do fornecedor** (pontos de conferência, não erro definitivo): CFOP fora do padrão, NCM novo, valor atípico, alíquota diferente do habitual.

O administrador também pode criar **regras condicionais** sem programar (*quando… então exigir…*), por empresa ou para todas.

Status do documento:
- **APROVADA**, **PENDENTE**, **INCONSISTENTE**, **DUPLICADA** e **AGUARDANDO_XML**;
- e, por decisão do usuário: **REJEITADA**, **CORREÇÃO SOLICITADA** e **NÃO FISCAL**.

A prioridade na fila leva em conta erros, valor, cancelamento e **vencimento das duplicatas**. O prazo de validação nunca passa da véspera do primeiro vencimento.

### Perfis de acesso

| Perfil | Pode |
|---|---|
| Administrador | tudo (cadastros, regras, caixas, usuários, integrações) |
| Fiscal | visualizar, validar e aprovar, tratar alertas e escrituração, relatórios |
| Consulta | somente visualização (sem histórico) |
| Auditor | visualização, histórico, relatórios e trilha de auditoria |
| Financeiro | painel de contas a pagar e registro de programação/pagamento. Pagar título de NF não aprovada exige justificativa. |

### IA (opcional)

Com `ANTHROPIC_API_KEY` definido, a IA passa a ajudar em três pontos:
- lê PDFs escaneados ou pouco legíveis;
- analisa o documento;
- explica alertas.

O modelo padrão é o `claude-opus-5`, configurável em `IA_MODELO`. O conteúdo dos documentos é tratado como dado, nunca como instrução. Sem a chave, o sistema funciona normalmente, sem essa camada.

### Integração com ERP

Crie uma chave em *Integração ERP*. O ERP consome a API com o header `X-API-Key`:

```
GET  /api/erp/v1/documentos?status=APROVADA&erp_status=pendente
GET  /api/erp/v1/documentos/{id}
POST /api/erp/v1/documentos/{id}/confirmar   {"sucesso": true, "referencia": "..."}
```

## Antes de ir para produção

- **Validar o conector Zoho com as contas reais.** Ele foi implementado conforme a documentação da Zoho Mail API, mas ainda não foi testado com as caixas do grupo.
- **Cadastrar as empresas reais do grupo** (CNPJ e IE) e classificar os fornecedores. O tipo do fornecedor define a sugestão de CFOP de entrada e as regras de DIFAL e CIAP.
- **Revisar os parâmetros fiscais com a equipe:** alíquotas internas por UF (valores de referência de 2026), CFOPs bloqueados e tolerâncias.
- **Validar com cada fornecedor os mapeamentos dos adaptadores Senior e Sankhya.** Hoje são esboços.
- Publicar atrás de HTTPS, ajustar `PUBLIC_URL` e fazer backup da pasta `data/` (banco e anexos).
- Limitações conhecidas:
  - a leitura de DANFE por texto é heurística (a confiança aparece na tela) e não extrai itens nem duplicatas; a IA cobre esses casos;
  - arquivos de NFS-e com vários documentos no mesmo XML ainda leem só o primeiro.
