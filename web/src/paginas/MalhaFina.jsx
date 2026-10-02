import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { brl, BotaoExportar, Cartao, Carregando, cnpj as fmtCnpj, data, Erro, Kpi, numero, useDados, useToast } from '../ui.jsx';

// Cor de cada resultado da conferência. É o centro da tela: dá para bater o olho e ver o que falta lançar.
const CORES = {
  lancada: { cor: 'var(--status-bom)', fundo: 'color-mix(in srgb, var(--status-bom) 12%, transparent)', rotulo: 'Lançada' },
  nao_lancada: { cor: 'var(--status-critico)', fundo: 'color-mix(in srgb, var(--status-critico) 14%, transparent)', rotulo: 'NÃO lançada' },
  valor_divergente: { cor: 'var(--status-atencao)', fundo: 'color-mix(in srgb, var(--status-atencao) 14%, transparent)', rotulo: 'Valor não bate' },
  cancelada_senior: { cor: 'var(--dup)', fundo: 'color-mix(in srgb, var(--dup) 12%, transparent)', rotulo: 'Entrada cancelada' },
  cancelada_prefeitura: { cor: 'var(--texto-fraco)', fundo: 'transparent', rotulo: 'Cancelada na prefeitura' },
  nao_conferida: { cor: 'var(--texto-fraco)', fundo: 'transparent', rotulo: 'Não conferida' },
};

const COLUNAS_EXPORTAR = [
  { titulo: 'Situação', valor: (n) => CORES[n.situacao]?.rotulo ?? n.situacao },
  { titulo: 'Competência', tipo: 'data', valor: (n) => n.competencia },
  { titulo: 'Prestador', valor: (n) => n.prestador },
  { titulo: 'CNPJ prestador', valor: (n) => n.cnpj_prestador },
  { titulo: 'NFS-e', valor: (n) => n.numero },
  { titulo: 'Município', valor: (n) => n.municipio_prestador },
  { titulo: 'Empresa (planilha)', valor: (n) => n.empresa },
  { titulo: 'Valor da planilha', tipo: 'moeda', valor: (n) => n.valor },
  { titulo: 'Entrada no Senior', valor: (n) => n.entrada_numero },
  { titulo: 'Empresa da entrada', valor: (n) => n.entrada_empresa },
  { titulo: 'Data de entrada', tipo: 'data', valor: (n) => n.entrada_data },
  { titulo: 'Lançada em', tipo: 'data', valor: (n) => n.entrada_lancada_em },
  { titulo: 'Quem lançou', valor: (n) => n.entrada_usuario },
  { titulo: 'Valor no Senior', tipo: 'moeda', valor: (n) => n.entrada_valor },
  { titulo: 'Diferença', tipo: 'moeda', valor: (n) => n.diferenca_valor },
  { titulo: 'Explicação da diferença', valor: (n) => n.retencao },
  { titulo: 'Retenções na planilha', tipo: 'moeda', valor: (n) => n.retencoes_planilha },
  { titulo: 'Linha na planilha', tipo: 'numero', valor: (n) => n.linha },
];

export default function MalhaFina() {
  const [params, setParams] = useSearchParams();
  const f = {
    lote: params.get('lote') ?? '', situacao: params.get('situacao') ?? '',
    busca: params.get('busca') ?? '', empresa: params.get('empresa') ?? '',
  };
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ aba: 'malha', ...f, [k]: v }).filter(([, x]) => x)));
  const avisar = useToast();
  const [enviando, setEnviando] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const campoArquivo = useRef(null);

  const lotes = useDados(() => api.get('/malha-fina'), [], { automatico: false });
  const loteId = f.lote || lotes.dados?.lotes?.[0]?.id || '';
  const painel = useDados(
    () => (loteId ? api.get(`/malha-fina/${loteId}${qs({ situacao: f.situacao, busca: f.busca, empresa: f.empresa })}`) : Promise.resolve(null)),
    [loteId, f.situacao, f.busca, f.empresa], { automatico: false },
  );

  const enviar = async (arquivo) => {
    if (!arquivo) return;
    setEnviando(true);
    try {
      const corpo = new FormData();
      corpo.append('arquivo', arquivo);
      const r = await api.upload('/malha-fina', corpo);
      avisar(`${r.reimportado ? 'Planilha atualizada' : 'Planilha importada'}: ${numero(r.notas_lidas)} nota(s), `
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
    setConferindo(true);
    try {
      const r = await api.post(`/malha-fina/${loteId}/conferir`);
      avisar(`Conferência refeita: ${numero(r.resumo?.nao_lancada ?? 0)} não lançada(s) de ${numero(r.conferidas)}`, 'ok');
      painel.recarregar(); lotes.recarregar();
    } catch (e) { avisar(e.message, 'erro'); } finally { setConferindo(false); }
  };

  const apagar = async (id) => {
    await api.del(`/malha-fina/${id}`);
    avisar('Planilha removida', 'ok');
    setParams({ aba: 'malha' });
    lotes.recarregar();
  };

  const d = painel.dados;
  const k = d?.indicadores;

  return (
    <>
      <Cartao titulo="Planilha da contabilidade" sub="serviços tomados (NFS-e) que o fisco já sabe que recebemos">
        <div
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
            Relatório de serviços tomados em .xlsx, com o cabeçalho original. As colunas são achadas pelo nome —
            precisa ter pelo menos “Número NFe” e “Cnpj/Cpf Prestador”. A planilha fica guardada aqui: dá para
            reconferir quando quiser, sem reenviar.
          </div>
        </div>

        {Boolean(lotes.dados?.lotes?.length) && (
          <div className="linha" style={{ gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <select value={loteId} onChange={(e) => setParams({ aba: 'malha', lote: e.target.value })} aria-label="Planilha">
              {lotes.dados.lotes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.competencia ?? 's/ competência'} · {l.arquivo} · {numero(l.notas)} notas
                  {l.nao_lancadas ? ` · ${numero(l.nao_lancadas)} não lançadas` : ''}
                </option>
              ))}
            </select>
            <button className="btn pequeno" onClick={conferir} disabled={conferindo || !loteId}>
              {conferindo ? 'Conferindo no Senior…' : 'Atualizar conferência'}
            </button>
            {d?.lote?.conferido_em && <span className="muted pequeno">conferido em {data(d.lote.conferido_em, true)}</span>}
            <span className="espaco" />
            {loteId && <button className="btn pequeno ghost" onClick={() => apagar(loteId)}>Remover esta planilha</button>}
          </div>
        )}
      </Cartao>

      <Erro erro={lotes.erro ?? painel.erro} />

      {!lotes.dados?.lotes?.length && !lotes.carregando && (
        <Cartao><p className="muted" style={{ margin: 0 }}>Nenhuma planilha importada ainda. Envie o arquivo acima para começar.</p></Cartao>
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

          {Boolean(d.por_empresa.filter((x) => x.nao_lancadas).length) && (
            <Cartao titulo="Empresas com notas não lançadas" sub="clique para filtrar" semPadding>
              <div style={{ padding: 12 }}>
                {d.por_empresa.filter((x) => x.nao_lancadas).map((x) => {
                  const max = Math.max(...d.por_empresa.map((y) => y.nao_lancadas), 1);
                  const ativo = f.empresa === x.chave;
                  return (
                    <button key={x.chave} className="linha entre" onClick={() => setFiltro('empresa', ativo ? '' : x.chave)}
                      style={{ width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', opacity: !f.empresa || ativo ? 1 : 0.5 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="linha entre pequeno">
                          <span className="truncar">{x.chave !== '—' ? <code className="muted">{x.chave}</code> : null} {x.rotulo}</span>
                          <strong>{numero(x.nao_lancadas)} · {brl(x.valor)}</strong>
                        </div>
                        <div className="barra-progresso"><div style={{ width: `${(x.nao_lancadas / max) * 100}%`, background: 'var(--status-critico)' }} /></div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Cartao>
          )}

          {Boolean(d.por_prestador.length) && (
            <Cartao titulo="Prestadores com mais notas não lançadas" sub="clique para filtrar" semPadding>
              <div style={{ padding: 12 }}>
                {d.por_prestador.map((p) => {
                  const max = Math.max(...d.por_prestador.map((x) => x.qtd), 1);
                  return (
                    <button key={p.chave} className="linha entre" onClick={() => setFiltro('busca', f.busca === p.chave ? '' : p.chave)}
                      style={{ width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="linha entre pequeno">
                          <span className="truncar">{p.rotulo}</span>
                          <strong>{numero(p.qtd)} · {brl(p.valor)}</strong>
                        </div>
                        <div className="barra-progresso"><div style={{ width: `${(p.qtd / max) * 100}%`, background: 'var(--status-critico)' }} /></div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Cartao>
          )}

          <Cartao titulo="Notas da planilha" sub={`${numero(d.total)} linha(s)${f.situacao ? ` · ${CORES[f.situacao]?.rotulo}` : ''}`} semPadding
            acoes={<div className="linha" style={{ gap: 8 }}>
              <input placeholder="prestador, CNPJ ou número" value={f.busca} onChange={(e) => setFiltro('busca', e.target.value)} style={{ width: 210 }} />
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
              <BotaoExportar titulo={`Malha fina ${d.lote.competencia ?? ''}`} linhas={d.notas} colunas={COLUNAS_EXPORTAR} />
            </div>}>
            <div className="tabela-wrap">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Situação</th><th>Competência</th><th>Empresa</th><th>Prestador</th><th>NFS-e</th>
                    <th className="num">Valor da planilha</th><th>No Senior</th><th className="num">Valor no Senior</th>
                  </tr>
                </thead>
                <tbody>
                  {d.notas.map((n) => {
                    const c = CORES[n.situacao] ?? CORES.nao_conferida;
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
                          <div className="truncar" style={{ maxWidth: 260 }}>{n.prestador ?? '—'}</div>
                          <div className="muted pequeno">{fmtCnpj(n.cnpj_prestador)}{n.municipio_prestador ? ` · ${n.municipio_prestador}` : ''}</div>
                        </td>
                        <td>{n.numero}<div className="muted pequeno">linha {n.linha}</div></td>
                        <td className="num">{brl(n.valor)}</td>
                        <td>
                          {n.entrada_numero
                            ? <>NF {n.entrada_numero}<div className="muted pequeno">
                              {n.entrada_empresa} · {data(n.entrada_data)}{n.entrada_usuario ? ` · ${n.entrada_usuario}` : ''}</div></>
                            : <span className="muted">—</span>}
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
                  {!d.notas.length && <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>Nenhuma nota com esse filtro.</td></tr>}
                </tbody>
              </table>
            </div>
            {d.total > d.notas.length && (
              <div className="paginacao"><span>Exibindo {numero(d.notas.length)} de {numero(d.total)} — use os filtros ou exporte para Excel</span></div>
            )}
          </Cartao>

          <p className="muted pequeno">
            Como a conferência é feita: cada linha da planilha é procurada nas notas de entrada do Senior pelo
            <strong> CNPJ do prestador + número da nota</strong>, preferindo a entrada da mesma empresa tomadora. O Senior guarda o
            valor líquido (já com ISS, IRRF, INSS e CSRF retidos) e a planilha traz o bruto. A diferença só é aceita quando bate
            com uma alíquota de retenção de verdade — IRRF 1,5%, CSRF 4,65%, ISS, INSS 11% e suas somas, com folga de centavos.
            O que nenhuma alíquota explica fica marcado como <strong>valor não bate</strong>, porque aí não é retenção: é lançamento
            com valor diferente do documento.
          </p>
        </>
      )}
    </>
  );
}
