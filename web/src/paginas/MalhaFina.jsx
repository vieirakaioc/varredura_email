import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../api.js';
import { BotaoResumo } from '../resumo.jsx';
import { useAuth } from '../contexto.jsx';
import { numeroNfse } from '../nfse.js';
import { brl, BotaoExportar, Cartao, Carregando, cnpj as fmtCnpj, data, Erro, Kpi, numero, useDados, useToast } from '../ui.jsx';

const MODELOS = { 55: 'NF-e', 57: 'CT-e', 65: 'NFC-e', 58: 'MDF-e', 59: 'SAT', 67: 'CT-e OS' };

const eixo = { fontSize: 11, fill: 'var(--texto-3)' };

function DicaRanking({ active, payload }) {
  if (!active || !payload?.length) return null;
  const x = payload[0].payload;
  return (
    <div className="tooltip-grafico">
      <div className="t">{x._texto}</div>
      <div>Não lançadas: <strong>{numero(payload[0].value)}</strong></div>
      <div>Valor: <strong>{brl(x.valor)}</strong></div>
    </div>
  );
}

/** Altura de um ranking com n barras. Os dois cartões usam a maior das duas, para ficarem iguais. */
const alturaRanking = (n) => Math.max(160, n * 30 + 36);

/**
 * Ranking de notas não lançadas em barras. Antes era uma linha fina por item: com um prestador
 * concentrando quase tudo, as barras pequenas viravam risco e não dava para comparar. Continua
 * clicável para filtrar, e o item filtrado fica cheio enquanto os outros desbotam.
 */
function RankingBarras({ dados, campo, rotulo, onClique, ativo, altura }) {
  const d = dados.map((x) => {
    const texto = rotulo(x);
    return { ...x, _texto: texto, _rotulo: texto.length > 30 ? `${texto.slice(0, 29)}…` : texto };
  });
  return (
    <ResponsiveContainer width="100%" height={altura ?? alturaRanking(d.length)}>
      <BarChart data={d} layout="vertical" margin={{ left: 8, right: 52, top: 4, bottom: 4 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke="var(--grade)" />
        <XAxis type="number" tick={eixo} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="_rotulo" width={200} tick={{ ...eixo, fill: 'var(--texto-2)' }}
          axisLine={{ stroke: 'var(--eixo)' }} tickLine={false} interval={0} />
        <Tooltip cursor={{ fill: 'var(--superficie-3)' }} content={<DicaRanking />} />
        <Bar isAnimationActive={false} dataKey={campo} name="Não lançadas" fill="var(--serie-1)"
          radius={[0, 4, 4, 0]} maxBarSize={18} style={{ cursor: 'pointer' }}
          onClick={(e) => onClique((e?.payload ?? e).chave)}>
          {d.map((x) => <Cell key={x.chave} fillOpacity={!ativo || ativo === x.chave ? 1 : 0.35} />)}
          <LabelList dataKey={campo} position="right" offset={6} style={eixo} formatter={(v) => numero(v)} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Cor de cada resultado da conferência. É o centro da tela: dá para bater o olho e ver o que falta lançar.
const CORES = {
  lancada: { cor: 'var(--status-bom)', fundo: 'color-mix(in srgb, var(--status-bom) 12%, transparent)', rotulo: 'Lançada' },
  nao_lancada: { cor: 'var(--status-critico)', fundo: 'color-mix(in srgb, var(--status-critico) 14%, transparent)', rotulo: 'NÃO lançada' },
  valor_divergente: { cor: 'var(--status-atencao)', fundo: 'color-mix(in srgb, var(--status-atencao) 14%, transparent)', rotulo: 'Valor não bate' },
  conferir: { cor: '#b26a00', fundo: 'color-mix(in srgb, #b26a00 16%, transparent)', rotulo: 'CONFERIR' },
  so_saida: { cor: 'var(--serie-1)', fundo: 'color-mix(in srgb, var(--serie-1) 10%, transparent)', rotulo: 'Emitida, sem entrada' },
  cancelada_senior: { cor: 'var(--dup)', fundo: 'color-mix(in srgb, var(--dup) 12%, transparent)', rotulo: 'Entrada cancelada' },
  fora_escopo: { cor: 'var(--texto-3)', fundo: 'color-mix(in srgb, var(--texto-3) 10%, transparent)', rotulo: 'Fora do escopo' },
  cancelada_prefeitura: { cor: 'var(--texto-fraco)', fundo: 'transparent', rotulo: 'Cancelada na prefeitura' },
  nao_conferida: { cor: 'var(--texto-fraco)', fundo: 'transparent', rotulo: 'Não conferida' },
};

const COLUNAS_EXPORTAR = [
  { titulo: 'Situação', valor: (n) => CORES[n.situacao]?.rotulo ?? n.situacao },
  { titulo: 'Competência', tipo: 'data', valor: (n) => n.competencia },
  { titulo: 'Prestador', valor: (n) => n.prestador },
  { titulo: 'CNPJ prestador', valor: (n) => n.cnpj_prestador },
  { titulo: 'NFS-e', valor: (n) => numeroNfse(n.numero) },
  { titulo: 'Município', valor: (n) => n.municipio_prestador },
  { titulo: 'Tomador (planilha)', valor: (n) => n.empresa },
  // Vazio em vez do travessão: na planilha, célula em branco filtra melhor que texto
  { titulo: 'CNPJ do tomador', valor: (n) => (n.cnpj_empresa ? fmtCnpj(n.cnpj_empresa) : null) },
  { titulo: 'Valor da planilha', tipo: 'moeda', valor: (n) => n.valor },
  { titulo: 'Entrada no Senior', valor: (n) => n.entrada_numero },
  { titulo: 'Empresa da entrada', valor: (n) => n.entrada_empresa },
  { titulo: 'Empresa/filial no Senior', valor: (n) => n.entrada_empresa_chave },
  { titulo: 'Data de entrada', tipo: 'data', valor: (n) => n.entrada_data },
  { titulo: 'Lançada em', tipo: 'data', valor: (n) => n.entrada_lancada_em },
  { titulo: 'Quem lançou', valor: (n) => n.entrada_usuario },
  { titulo: 'Valor no Senior', tipo: 'moeda', valor: (n) => n.entrada_valor },
  { titulo: 'Diferença', tipo: 'moeda', valor: (n) => n.diferenca_valor },
  { titulo: 'Explicação da diferença', valor: (n) => n.retencao },
  { titulo: 'Alerta do casamento', valor: (n) => n.alerta },
  { titulo: 'Retenções na planilha', tipo: 'moeda', valor: (n) => n.retencoes_planilha },
  { titulo: 'Link da NFS-e', valor: (n) => n.link },
  { titulo: 'Linha na planilha', tipo: 'numero', valor: (n) => n.linha },
];

const COLUNAS_EFD = [
  { titulo: 'Situação', valor: (n) => CORES[n.situacao]?.rotulo ?? n.situacao },
  { titulo: 'Apontamento da contabilidade', valor: (n) => n.status_planilha },
  { titulo: 'Emissão', tipo: 'data', valor: (n) => n.emissao },
  { titulo: 'Modelo', valor: (n) => n.modelo },
  { titulo: 'Série', valor: (n) => n.serie },
  { titulo: 'Número', valor: (n) => n.numero },
  { titulo: 'CFOP', valor: (n) => n.cfop },
  { titulo: 'Chave de acesso', valor: (n) => n.chave },
  { titulo: 'Emitente', valor: (n) => n.prestador },
  { titulo: 'CNPJ do emitente', valor: (n) => n.cnpj_prestador },
  { titulo: 'Valor', tipo: 'moeda', valor: (n) => n.valor },
  { titulo: 'Saída no Senior', valor: (n) => n.saida_numero },
  { titulo: 'Empresa da saída', valor: (n) => n.saida_empresa },
  { titulo: 'Entrada no Senior', valor: (n) => n.entrada_numero },
  { titulo: 'Empresa da entrada', valor: (n) => n.entrada_empresa },
  { titulo: 'Data de entrada', tipo: 'data', valor: (n) => n.entrada_data },
  { titulo: 'Linha na planilha', tipo: 'numero', valor: (n) => n.linha },
];

/** Sumário executivo da malha fina. Muda conforme o layout da planilha importada. */
function resumoMalha(d) {
  const k = d.indicadores;
  const efd = d.lote.tipo === 'efd';
  const situacao = (chave) => d.por_situacao.find((s) => s.chave === chave) ?? { qtd: 0, valor: 0 };
  const lancadas = situacao('lancada');
  const visao = [];

  if (efd) {
    const soSaida = situacao('so_saida');
    const naoAchadas = situacao('nao_lancada');
    const noSenior = lancadas.qtd + soSaida.qtd;
    visao.push(`A contabilidade apontou ${numero(d.lote.notas)} documento(s) que o fisco tem e a escrituração não.`);
    visao.push(`${numero(noSenior)} deles ESTÃO no Senior (${numero(lancadas.qtd)} com nota de entrada e ${numero(soSaida.qtd)} só como emissão): `
      + 'nesses, o problema é de escrituração, não de lançamento.');
    if (naoAchadas.qtd) visao.push(`${numero(naoAchadas.qtd)} documento(s) NÃO estão no Senior (${brl(naoAchadas.valor)}) — esses ninguém lançou.`);
    else visao.push('Nenhum documento ficou de fora do Senior.');
  } else {
    visao.push(`A planilha trouxe ${numero(d.lote.notas)} NFS-e tomadas; ${numero(lancadas.qtd)} já estão lançadas no Senior.`);
    if (k.nao_lancadas) visao.push(`${numero(k.nao_lancadas)} nota(s) não foram lançadas, somando ${brl(k.valor_nao_lancado)}.`);
    else visao.push('Nenhuma nota ficou sem lançamento.');
    if (d.pj?.ocultos) {
      visao.push(`${numero(d.pj.ocultos)} nota(s) de prestadores PJ ficaram fora da conta${d.pj.nao_lancadas ? `, sendo ${numero(d.pj.nao_lancadas)} não lançadas (${brl(d.pj.valor)})` : ''}.`);
    }
    const divergentes = situacao('valor_divergente');
    if (divergentes.qtd) {
      visao.push(`${numero(divergentes.qtd)} nota(s) foram lançadas com valor que nenhuma alíquota de retenção explica — valem conferência.`);
    }
  }

  const kpis = [
    { rotulo: efd ? 'Documentos apontados' : 'Notas na planilha', valor: numero(d.lote.notas), detalhe: d.lote.competencia ? `competência ${d.lote.competencia}` : '', tom: 'neutro' },
    { rotulo: 'NÃO estão no Senior', valor: numero(k.nao_lancadas), detalhe: brl(k.valor_nao_lancado), tom: k.nao_lancadas ? 'critico' : 'bom' },
    { rotulo: efd ? 'Com nota de entrada' : 'Lançadas', valor: numero(lancadas.qtd), detalhe: brl(lancadas.valor), tom: 'bom' },
  ];
  if (efd) kpis.push({ rotulo: 'Só como emissão', valor: numero(situacao('so_saida').qtd), detalhe: 'venda sem entrada no grupo', tom: 'neutro' });
  else {
    kpis.push({ rotulo: 'Valor não bate', valor: numero(situacao('valor_divergente').qtd), detalhe: 'fora da faixa de retenção', tom: situacao('valor_divergente').qtd ? 'alerta' : 'bom' });
    if (d.pj?.cadastrados) kpis.push({ rotulo: 'PJ fora da conta', valor: numero(d.pj.ocultos), detalhe: `${numero(d.pj.cadastrados)} prestadores na lista`, tom: 'neutro' });
  }

  const destaques = efd
    ? d.notas.filter((n) => n.situacao === 'nao_lancada').slice(0, 5)
      .map((n) => ({ rotulo: `${n.prestador ?? fmtCnpj(n.cnpj_prestador)} · nº ${n.numero}`, valor: brl(n.valor), tom: 'critico' }))
    : (d.por_prestador ?? []).slice(0, 5)
      .map((p) => ({ rotulo: p.rotulo, valor: `${numero(p.qtd)} · ${brl(p.valor)}`, tom: 'critico' }));

  return {
    titulo: efd ? 'Malha fina · documentos fora da EFD' : 'Malha fina · serviços tomados',
    periodo: `${d.lote.arquivo}${d.lote.competencia ? ` · competência ${d.lote.competencia}` : ''}`,
    kpis,
    visao,
    secoes: [
      {
        tipo: 'barras', titulo: 'Resultado da conferência', sub: 'cada nota da planilha', largura_rotulo: 340,
        itens: d.por_situacao.map((s) => ({
          rotulo: s.rotulo, valor: s.qtd, detalhe: brl(s.valor),
          cor: { lancada: '#1a7f4b', nao_lancada: '#c0392b', valor_divergente: '#d9a300', conferir: '#b26a00', so_saida: '#2b6cb0' }[s.chave] ?? '#8d98a5',
        })),
      },
      { tipo: 'lista', titulo: efd ? 'Documentos que não estão no Senior' : 'Prestadores com mais notas não lançadas', itens: destaques },
    ],
    rodape: `Conferido contra as notas do Senior${d.lote.conferido_em ? ` em ${data(d.lote.conferido_em, true)}` : ''}`,
  };
}

export default function MalhaFina() {
  const { pode } = useAuth();
  const editar = pode('decidir');
  const [params, setParams] = useSearchParams();
  const f = {
    lote: params.get('lote') ?? '', situacao: params.get('situacao') ?? '',
    busca: params.get('busca') ?? '', empresa: params.get('empresa') ?? '',
    com_pj: params.get('com_pj') ?? '',
  };
  const [vendoPj, setVendoPj] = useState(false);
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ aba: 'malha', ...f, [k]: v }).filter(([, x]) => x)));
  const avisar = useToast();
  const [enviando, setEnviando] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const campoArquivo = useRef(null);

  const lotes = useDados(() => api.get('/malha-fina'), [], { automatico: false });
  const listaPj = useDados(() => api.get('/malha-fina/pj'), [], { automatico: false });
  const loteId = f.lote || lotes.dados?.lotes?.[0]?.id || '';
  const painel = useDados(
    () => (loteId ? api.get(`/malha-fina/${loteId}${qs({ situacao: f.situacao, busca: f.busca, empresa: f.empresa, com_pj: f.com_pj })}`) : Promise.resolve(null)),
    [loteId, f.situacao, f.busca, f.empresa, f.com_pj], { automatico: false },
  );

  const enviar = async (arquivo) => {
    if (!editar || !arquivo) return;
    setEnviando(true);
    try {
      const corpo = new FormData();
      corpo.append('arquivo', arquivo);
      const r = await api.upload('/malha-fina', corpo);
      avisar(`${r.reimportado ? 'Planilha atualizada' : 'Planilha importada'}: ${numero(r.notas_lidas)} nota(s)`
        + `${r.duplicadas ? ` (${numero(r.duplicadas)} linha(s) repetida(s) ignorada(s))` : ''}, `
        + `${numero(r.resumo?.nao_lancada ?? 0)} ainda não lançada(s)`, 'ok');
      setParams({ aba: 'malha', lote: String(r.lote_id) });
      lotes.recarregar();
    } catch (e) {
      avisar(e.message, 'erro');
    } finally {
      setEnviando(false);
      if (campoArquivo.current) campoArquivo.current.value = '';
    }
  };

  const conferir = async () => {
    if (!editar) return;
    setConferindo(true);
    try {
      const r = await api.post(`/malha-fina/${loteId}/conferir`);
      avisar(`Conferência refeita: ${numero(r.resumo?.nao_lancada ?? 0)} não lançada(s) de ${numero(r.conferidas)}`, 'ok');
      painel.recarregar(); lotes.recarregar();
    } catch (e) { avisar(e.message, 'erro'); } finally { setConferindo(false); }
  };

  const marcarPj = async (nota) => {
    if (!editar) return;
    await api.post('/malha-fina/pj', { cnpj: nota.cnpj_prestador, nome: nota.prestador });
    avisar(`${nota.prestador} entrou na lista de PJ e saiu da conferência`, 'ok');
    painel.recarregar(); listaPj.recarregar();
  };
  const tirarPj = async (cnpj, nome) => {
    if (!editar) return;
    await api.del(`/malha-fina/pj/${cnpj}`);
    avisar(`${nome ?? cnpj} voltou para a conferência`, 'ok');
    painel.recarregar(); listaPj.recarregar();
  };

  const apagar = async (id) => {
    if (!editar) return;
    await api.del(`/malha-fina/${id}`);
    avisar('Planilha removida', 'ok');
    setParams({ aba: 'malha' });
    lotes.recarregar();
  };

  const d = painel.dados;
  const k = d?.indicadores;
  const efd = d?.lote?.tipo === 'efd';

  return (
    <>
      <Cartao titulo="Planilha da contabilidade" sub="serviços tomados (NFS-e) que o fisco já sabe que recebemos">
        {editar && <div
          onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
          onDragLeave={() => setArrastando(false)}
          onDrop={(e) => { e.preventDefault(); setArrastando(false); enviar(e.dataTransfer.files?.[0]); }}
          style={{
            border: `2px dashed ${arrastando ? 'var(--serie-1)' : 'var(--grade)'}`, borderRadius: 10,
            padding: 18, textAlign: 'center', background: arrastando ? 'var(--superficie-2)' : 'transparent',
          }}>
          <input ref={campoArquivo} type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }}
            onChange={(e) => enviar(e.target.files?.[0])} />
          <div style={{ marginBottom: 8 }}>
            <strong>Arraste aqui a planilha</strong> da contabilidade, ou
            {' '}<button className="btn pequeno" disabled={enviando} onClick={() => campoArquivo.current?.click()}>
              {enviando ? 'Lendo a planilha…' : 'escolher arquivo'}
            </button>
          </div>
          <div className="muted pequeno">
            Dois relatórios são reconhecidos, pelo cabeçalho da primeira linha: <strong>serviços tomados</strong>
            (com “Número NFe” e “Cnpj/Cpf Prestador”) e <strong>EFD</strong> (com “Status” e “Chave”). As colunas são
            achadas pelo nome, então a ordem pode mudar. A planilha fica guardada aqui: dá para reconferir quando
            quiser, sem reenviar.
          </div>
        </div>}

        {Boolean(lotes.dados?.lotes?.length) && (
          <div className="linha" style={{ gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <select value={loteId} onChange={(e) => setParams({ aba: 'malha', lote: e.target.value })} aria-label="Planilha">
              {lotes.dados.lotes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.competencia ?? 's/ competência'} · {l.tipo === 'efd' ? 'EFD' : 'serviços tomados'} · {l.arquivo} · {numero(l.notas)} notas
                  {l.nao_lancadas ? ` · ${numero(l.nao_lancadas)} não lançadas` : ''}
                </option>
              ))}
            </select>
            {editar && <button className="btn pequeno" onClick={conferir} disabled={conferindo || !loteId}>
              {conferindo ? 'Conferindo no Senior…' : 'Atualizar conferência'}
            </button>}
            {d && <BotaoResumo resumo={() => resumoMalha(d)} />}
            {d?.lote?.conferido_em && <span className="muted pequeno">conferido em {data(d.lote.conferido_em, true)}</span>}
            <span className="espaco" />
            {editar && loteId && <button className="btn pequeno ghost" onClick={() => apagar(loteId)}>Remover esta planilha</button>}
          </div>
        )}
      </Cartao>

      <Erro erro={lotes.erro ?? painel.erro} />

      {!lotes.dados?.lotes?.length && !lotes.carregando && (
        <Cartao><p className="muted" style={{ margin: 0 }}>Nenhuma planilha importada ainda.{editar ? ' Envie o arquivo acima para começar.' : ''}</p></Cartao>
      )}

      {painel.carregando && !d ? <Carregando /> : d && (
        <>
          <div className="grade grade-kpi monetario">
            <Kpi rotulo="Notas na planilha" valor={numero(d.lote.notas)}
              detalhe={d.lote.competencia ? `competência ${d.lote.competencia}` : null} />
            <Kpi rotulo="NÃO lançadas no Senior" valor={numero(k.nao_lancadas)} detalhe={brl(k.valor_nao_lancado)}
              cor="var(--status-critico)" onClick={() => setFiltro('situacao', f.situacao === 'nao_lancada' ? '' : 'nao_lancada')} />
            {d.por_situacao.filter((s) => s.chave !== 'nao_lancada').map((s) => (
              <Kpi key={s.chave} rotulo={CORES[s.chave]?.rotulo ?? s.rotulo} valor={numero(s.qtd)} detalhe={brl(s.valor)}
                cor={CORES[s.chave]?.cor} onClick={() => setFiltro('situacao', f.situacao === s.chave ? '' : s.chave)} />
            ))}
          </div>

          {!efd && <Cartao>
            <div className="linha" style={{ gap: 10, flexWrap: 'wrap' }}>
              <label className="linha" style={{ gap: 6 }} title="PJ = prestador de serviço continuado da empresa; a nota existe, mas não é compra a lançar pela escrita fiscal">
                <input type="checkbox" checked={!d.pj.com_pj} onChange={() => setFiltro('com_pj', d.pj.com_pj ? '' : '1')} />
                <strong>Tirar os PJ da conferência</strong>
              </label>
              <span className="muted pequeno">
                {d.pj.cadastrados} prestador(es) na lista
                {d.pj.com_pj
                  ? ' · sendo mostrados'
                  : d.pj.ocultos
                    ? ` · ${numero(d.pj.ocultos)} nota(s) fora da conta${d.pj.nao_lancadas ? `, ${numero(d.pj.nao_lancadas)} delas não lançadas (${brl(d.pj.valor)})` : ''}`
                    : ' · nenhuma nota deles nesta planilha'}
              </span>
              <span className="espaco" />
              <button className="btn pequeno ghost" onClick={() => setVendoPj((x) => !x)}>
                {vendoPj ? 'Fechar a lista' : editar ? 'Ver/editar a lista de PJ' : 'Ver a lista de PJ'}
              </button>
            </div>
            {vendoPj && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '4px 12px', marginTop: 10 }}>
                {(listaPj.dados?.pj ?? []).map((p) => (
                  <div key={p.cnpj} className="linha entre pequeno" style={{ gap: 6 }}>
                    <span className="truncar" title={fmtCnpj(p.cnpj)}>{p.nome ?? fmtCnpj(p.cnpj)}</span>
                    {editar && <button className="btn pequeno ghost" title="Tirar da lista e voltar a conferir" onClick={() => tirarPj(p.cnpj, p.nome)}>✕</button>}
                  </div>
                ))}
                {!listaPj.dados?.pj?.length && <span className="muted pequeno">Nenhum PJ cadastrado.</span>}
              </div>
            )}
          </Cartao>}

          {(() => {
            const empresas = d.por_empresa.filter((x) => x.nao_lancadas);
            const prestadores = efd ? [] : d.por_prestador;
            if (!empresas.length && !prestadores.length) return null;
            // Mesma altura nos dois: lado a lado, alturas diferentes deixam o par torto
            const altura = alturaRanking(Math.max(empresas.length, prestadores.length));
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12, alignItems: 'start' }}>
                {Boolean(empresas.length) && (
                  <Cartao titulo="Empresas com notas não lançadas" sub="clique na barra para filtrar" semPadding>
                    <div style={{ padding: '12px 12px 4px' }}>
                      <RankingBarras dados={empresas} campo="nao_lancadas" ativo={f.empresa} altura={altura}
                        rotulo={(x) => (x.chave !== '—' ? `${x.chave} ${x.rotulo}` : x.rotulo)}
                        onClique={(chave) => setFiltro('empresa', f.empresa === chave ? '' : chave)} />
                    </div>
                  </Cartao>
                )}
                {Boolean(prestadores.length) && (
                  <Cartao titulo="Prestadores com mais notas não lançadas" sub="clique na barra para filtrar" semPadding>
                    <div style={{ padding: '12px 12px 4px' }}>
                      <RankingBarras dados={prestadores} campo="qtd" ativo={f.busca} altura={altura}
                        rotulo={(p) => p.rotulo}
                        onClique={(chave) => setFiltro('busca', f.busca === chave ? '' : chave)} />
                    </div>
                  </Cartao>
                )}
              </div>
            );
          })()}

          <Cartao titulo="Notas da planilha" sub={`${numero(d.total)} linha(s)${f.situacao ? ` · ${CORES[f.situacao]?.rotulo}` : ''}`} semPadding
            acoes={<div className="linha" style={{ gap: 8 }}>
              <input placeholder={efd ? 'emitente, CNPJ, número ou chave' : 'prestador, CNPJ ou número'} value={f.busca} onChange={(e) => setFiltro('busca', e.target.value)} style={{ width: 210 }} />
              <select value={f.empresa} onChange={(e) => setFiltro('empresa', e.target.value)} aria-label="Empresa">
                <option value="">Todas as empresas</option>
                {d.por_empresa.map((x) => (
                  <option key={x.chave} value={x.chave}>
                    {x.chave !== '—' ? `${x.chave} · ` : ''}{x.rotulo} ({numero(x.qtd)}{x.nao_lancadas ? ` · ${numero(x.nao_lancadas)} sem lançar` : ''})
                  </option>
                ))}
              </select>
              <select value={f.situacao} onChange={(e) => setFiltro('situacao', e.target.value)} aria-label="Situação">
                <option value="">Todas as situações</option>
                {d.por_situacao.map((s) => <option key={s.chave} value={s.chave}>{CORES[s.chave]?.rotulo ?? s.rotulo} ({numero(s.qtd)})</option>)}
              </select>
              <BotaoExportar titulo={`Malha fina ${d.lote.competencia ?? ''}`} linhas={d.notas} colunas={efd ? COLUNAS_EFD : COLUNAS_EXPORTAR} />
            </div>}>
            <div className="tabela-wrap">
              <table className="tabela">
                <thead>
                  <tr>
                    {efd
                      ? <><th>Situação</th><th>Emissão</th><th>Documento</th><th>Emitente</th><th className="num">Valor</th><th>No Senior</th></>
                      : <><th>Situação</th><th>Competência</th><th>Empresa</th><th>Prestador</th><th>NFS-e</th>
                        <th className="num">Valor da planilha</th><th>No Senior</th><th className="num">Valor no Senior</th></>}
                  </tr>
                </thead>
                <tbody>
                  {d.notas.map((n) => {
                    const c = CORES[n.situacao] ?? CORES.nao_conferida;
                    if (efd) {
                      return (
                        <tr key={n.id} style={{ background: c.fundo }}>
                          <td>
                            <span className="badge" style={{ background: c.cor, color: '#fff' }}>{c.rotulo}</span>
                            {n.status_planilha ? <div className="muted pequeno">{n.status_planilha}</div> : null}
                          </td>
                          <td>{data(n.emissao)}</td>
                          <td>
                            {MODELOS[n.modelo] ?? `Modelo ${n.modelo}`} {n.serie ? `série ${n.serie} ` : ''}nº {n.numero}
                            <div className="muted pequeno" title={n.chave}>CFOP {n.cfop ?? '—'} · …{String(n.chave ?? '').slice(-12)}</div>
                          </td>
                          <td>
                            <div className="truncar" style={{ maxWidth: 220 }}>{n.prestador ?? fmtCnpj(n.cnpj_prestador)}</div>
                            <div className="muted pequeno">
                              {fmtCnpj(n.cnpj_prestador)} · {n.saida_empresa ? 'do grupo' : 'de fora do grupo'}
                            </div>
                          </td>
                          <td className="num">{brl(n.valor)}</td>
                          <td>
                            {n.saida_numero && <div><code className="muted">{n.saida_empresa_chave}</code> saída nº {n.saida_numero}</div>}
                            {n.entrada_numero && <div><code className="muted">{n.entrada_empresa_chave}</code> entrada nº {n.entrada_numero} · {data(n.entrada_data)}</div>}
                            {!n.saida_numero && !n.entrada_numero && <span className="muted">não está no Senior</span>}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={n.id} style={{ background: c.fundo }}>
                        <td><span className="badge" style={{ background: c.cor, color: '#fff' }}>{c.rotulo}</span></td>
                        <td>{data(n.competencia)}</td>
                        <td>
                          {n.entrada_empresa
                            ? <><code className="muted">{n.entrada_empresa_chave}</code> {n.entrada_empresa}</>
                            : <span className="muted" title={n.empresa ?? ''}>sem entrada no Senior</span>}
                        </td>
                        <td>
                          <div className="linha" style={{ gap: 6 }}>
                            <span className="truncar" style={{ maxWidth: 240 }}>{n.prestador ?? '—'}</span>
                            {editar && <button className="btn pequeno ghost" style={{ padding: '0 6px', lineHeight: 1.6 }}
                              title={`Marcar ${n.prestador ?? 'este prestador'} como PJ e tirar da conferência`}
                              onClick={() => marcarPj(n)}>+PJ</button>}
                          </div>
                          <div className="muted pequeno">{fmtCnpj(n.cnpj_prestador)}{n.municipio_prestador ? ` · ${n.municipio_prestador}` : ''}</div>
                        </td>
                        <td>
                          {n.link
                            ? <a href={n.link} target="_blank" rel="noopener noreferrer" title={`Abrir a nota no site da prefeitura · Número original: ${n.numero}`}>{numeroNfse(n.numero)} ↗</a>
                            : <span title={`Número original: ${n.numero}`}>{numeroNfse(n.numero)}</span>}
                          <div className="muted pequeno">linha {n.linha}</div>
                        </td>
                        <td className="num">{brl(n.valor)}</td>
                        <td>
                          {n.entrada_numero
                            ? <>NF {n.entrada_numero}<div className="muted pequeno">
                              {n.entrada_empresa} · {data(n.entrada_data)}{n.entrada_usuario ? ` · ${n.entrada_usuario}` : ''}</div></>
                            : <span className="muted">—</span>}
                          {n.alerta && <div className="pequeno" style={{ color: CORES.conferir.cor, fontWeight: 600 }}>⚠ {n.alerta}</div>}
                        </td>
                        <td className="num">
                          {n.entrada_valor != null ? brl(n.entrada_valor) : '—'}
                          {n.diferenca_valor
                            ? <div className="muted pequeno" title={n.retencao ? 'Diferença explicada por retenção na fonte' : 'Nenhuma alíquota de retenção explica esta diferença'}>
                              −{brl(n.diferenca_valor)} · {n.retencao ?? 'sem explicação'}
                            </div>
                            : null}
                        </td>
                      </tr>
                    );
                  })}
                  {!d.notas.length && <tr><td colSpan={efd ? 6 : 8} className="muted" style={{ padding: 16 }}>Nenhuma nota com esse filtro.</td></tr>}
                </tbody>
              </table>
            </div>
            {d.total > d.notas.length && (
              <div className="paginacao"><span>Exibindo {numero(d.notas.length)} de {numero(d.total)} — use os filtros ou exporte para Excel</span></div>
            )}
          </Cartao>

          {efd ? (
            <p className="muted pequeno">
              Como a conferência é feita: cada linha é procurada no Senior pela <strong>chave de acesso</strong>, nos documentos
              que o grupo emitiu (E140IDE) e nas notas de entrada (E440NFC). Em transferência entre filiais a nota aparece dos
              dois lados. Achar a nota no Senior e a contabilidade dizer que ela não está na EFD aponta para a
              <strong> escrituração</strong>, não para o lançamento — já “não está no Senior” é nota que ninguém lançou.
            </p>
          ) : (
          <p className="muted pequeno">
            Como a conferência é feita: cada linha da planilha é procurada nas notas de entrada do Senior pelo
            <strong> CNPJ do prestador + número da nota</strong>, preferindo a entrada da mesma empresa tomadora. O Senior guarda o
            <strong>“Lançada” só aparece quando quatro coisas batem</strong>: a entrada é da mesma empresa que a planilha aponta como
            tomador, foi lançada como nota de serviço (e não como NF-e ou CT-e com o mesmo número), tem data compatível com a
            competência, e não há duas entradas com esse número e valores diferentes. Falhando qualquer uma, a nota vai para
            <strong> CONFERIR</strong> com o motivo escrito — nunca para “lançada”. O Senior guarda o
            com uma alíquota de retenção de verdade — IRRF 1,5%, CSRF 4,65%, ISS, INSS 11% e suas somas, com folga de centavos.
            O que nenhuma alíquota explica fica marcado como <strong>valor não bate</strong>, porque aí não é retenção: é lançamento
            com valor diferente do documento.
          </p>
          )}
        </>
      )}
    </>
  );
}
