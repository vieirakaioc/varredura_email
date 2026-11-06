import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../contexto.jsx';
import { BotaoExportar, COR_CATEGORIA, Cartao, Carregando, data, Erro, Kpi, numero, useDados, useToast } from '../ui.jsx';
import Carteira from './Carteira.jsx';

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const dataConsulta = (v) => {
  if (!v) return '—';
  const instante = new Date(v);
  return Number.isNaN(instante.getTime()) ? '—' : instante.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
};
const COR = { titular: 'var(--serie-1)', apoio: 'var(--status-atencao)' };
const BLOCO = { fiscal: 'Escrita Fiscal', supervisao: 'Supervisão', outros: 'Outros' };

/**
 * Operação por fila de tipo de nota (piloto de 16 a 30/10/2026).
 * Duas coisas que não existem no Senior e moram aqui, agregadas: a alocação das pessoas por tipo
 * e o compromisso de produção do dia. Nada vira status ou apontamento por nota no ERP.
 */
export default function Filas() {
  const [visao, setVisao] = useState('carteira');
  return <>
    <div className="linha" style={{ gap: 8, marginBottom: 12 }}>
      <button className={`btn pequeno ${visao === 'carteira' ? '' : 'ghost'}`} onClick={() => setVisao('carteira')}>Carteira de notas</button>
      <button className={`btn pequeno ${visao === 'compromissos' ? '' : 'ghost'}`} onClick={() => setVisao('compromissos')}>Dashboard</button>
    </div>
    {visao === 'carteira' ? <Carteira /> : <Compromissos />}
  </>;
}

function Compromissos() {
  const { pode } = useAuth();
  const editar = pode('decidir');
  const [params, setParams] = useSearchParams();
  const dia = params.get('dia') || hoje();
  const avisar = useToast();
  const [editando, setEditando] = useState(false);
  const [verDetalhe, setVerDetalhe] = useState(false);

  const filas = useDados(() => api.get('/filas'), [], { automatico: false });
  const painel = useDados(({ forcar } = {}) => api.get(`/filas/dia${qs({ dia, forcar: forcar ? '1' : '' })}`), [dia], { automatico: false, memoria: 'filas-dia' });
  const [linhas, setLinhas] = useState(null);     // compromisso em edição
  const [sugestao, setSugestao] = useState(null);

  useEffect(() => { setLinhas(null); setSugestao(null); }, [dia]);

  const sugerir = async () => {
    if (!editar) return;
    try {
      const s = await api.get(`/filas/sugestao${qs({ dia })}`);
      setSugestao(s);
      setLinhas(s.itens.map((i) => ({ ...i, quantidade: i.sugerido })));
      avisar(`Sugestão para ${data(dia)}: ${numero(s.itens.reduce((t, i) => t + i.sugerido, 0))} notas`, 'ok');
    } catch (e) { avisar(e.message, 'erro'); }
  };
  const gravar = async () => {
    if (!editar) return;
    try {
      const r = await api.put('/filas/dia', { dia, itens: linhas ?? [] });
      avisar(`Compromisso de ${data(dia)} gravado (${numero(r.gravados)} linha(s))`, 'ok');
      setLinhas(null); setSugestao(null); painel.recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };

  const d = painel.dados;
  const k = d?.indicadores;
  const producaoOk = d?.dashboard?.notas_lancadas?.estado === 'ok';
  const doTime = (d?.linhas ?? []).filter((l) => l.equipe === 'fiscal');
  const foraDaFila = doTime.filter((l) => l.compromisso == null && l.realizado > 0);

  // Quadro: uma coluna por fila, uma barra por pessoa. É o que fica projetado na reunião de 10 minutos.
  const quadro = (filas.dados?.categorias ?? [])
    .map((c) => {
      const pessoas = doTime.filter((l) => l.categoria === c.chave && (l.compromisso != null || l.realizado > 0))
        .map((l) => ({ ...l, pct: l.compromisso ? Math.round((l.realizado / l.compromisso) * 100) : null }))
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.realizado - a.realizado);
      return {
        ...c, pessoas,
        combinado: pessoas.reduce((s, l) => s + (l.compromisso ?? 0), 0),
        feito: pessoas.reduce((s, l) => s + l.realizado, 0),
        em_aberto: sugestao?.em_aberto?.[c.chave] ?? null,
      };
    })
    .filter((c) => c.pessoas.length);
  const falta = k?.compromisso != null ? Math.max(0, k.compromisso - doTime.reduce((s, l) => s + Math.min(l.realizado, l.compromisso ?? 0), 0)) : null;

  return (
    <>
      <Cartao>
        <div className="linha" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="linha" style={{ gap: 6 }}>
            <strong className="muted pequeno">Dia</strong>
            <input type="date" value={dia} onChange={(e) => { const p = new URLSearchParams(params); p.set('dia', e.target.value || hoje()); setParams(p); }} />
          </label>
          {editar && <button className="btn pequeno" onClick={sugerir}>Sugerir compromisso</button>}
          {editar && linhas && <button className="btn pequeno" onClick={gravar}>Gravar compromisso</button>}
          {linhas && <button className="btn pequeno ghost" onClick={() => { setLinhas(null); setSugestao(null); }}>Cancelar</button>}
          <button className="btn pequeno ghost" onClick={() => painel.recarregar()}>Atualizar</button>
          <span className="espaco" />
          <button className="btn pequeno ghost" onClick={() => setVerDetalhe((x) => !x)}>
            {verDetalhe ? 'Esconder o detalhe' : 'Ver detalhe e exportar'}
          </button>
          {editar && <button className="btn pequeno ghost" onClick={() => setEditando((x) => !x)}>
            {editando ? 'Fechar a configuração' : 'Configurar filas'}
          </button>}
        </div>
        {d && (
          <div className="muted pequeno" style={{ marginTop: 8 }}>
            Produção de {data(dia)} · pendências na consulta atual. Atualizado em {dataConsulta(d.atualizado_em)} (horário de Brasília).
            {!d.dia_util && ' Atenção: este dia não é dia útil.'}
          </div>
        )}
      </Cartao>

      <Erro erro={filas.erro ?? painel.erro} />
      {editar && editando && <ConfiguracaoFilas filas={filas} avisar={avisar} />}

      {painel.carregando && !d ? <Carregando /> : d && (
        <>
          <IndicadoresDashboard painel={d} dia={dia} />
          <Placar k={k} falta={falta} fora={foraDaFila.reduce((s, l) => s + l.realizado, 0)} disponivel={producaoOk} />

          {sugestao && (
            <Cartao titulo="Sugestão do dia" sub="distribui as pendências em aberto pela capacidade de cada pessoa">
              <div className="aviso pequeno" style={{ marginBottom: 10 }}>
                {sugestao.premissas.aviso} Capacidade: {sugestao.premissas.calculo} = {numero(sugestao.premissas.meta_dia_padrao)} notas/dia.
                Pendências do time no momento da consulta: <strong>{numero(sugestao.pendentes_total)}</strong>.
              </div>
            </Cartao>
          )}

          {!linhas && producaoOk && Boolean(quadro.length) && (
            <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', alignItems: 'start' }}>
              {quadro.map((c) => <ColunaFila key={c.chave} fila={c} />)}
            </div>
          )}

          {!linhas && (!quadro.length || !producaoOk) && (
            <Cartao><p className="muted" style={{ margin: 0 }}>
              {producaoOk
                ? <>Nada combinado nem lançado pelo time em {data(dia)}.</>
                : 'A produção está indisponível no momento.'}
              {editar && <> Use <strong>Sugerir compromisso</strong> para montar o quadro do dia.</>}
            </p></Cartao>
          )}

          {(linhas || verDetalhe) && <Cartao titulo={linhas ? `Compromisso de ${data(dia)} (ajuste antes de gravar)` : `Detalhe de ${data(dia)}`}
            semPadding
            acoes={!linhas && <BotaoExportar titulo={`Compromisso ${dia}`} linhas={d.linhas} rotulo="Excel"
              colunas={[
                { titulo: 'Pessoa', valor: (l) => l.usuario },
                { titulo: 'Bloco', valor: (l) => ({ fiscal: 'Escrita Fiscal', supervisao: 'Supervisão', outros: 'Outros' }[l.equipe] ?? l.equipe) },
                { titulo: 'Tipo de nota', valor: (l) => l.categoria_rotulo },
                { titulo: 'Compromisso', tipo: 'numero', valor: (l) => l.compromisso },
                { titulo: 'Realizado', tipo: 'numero', valor: (l) => producaoOk ? l.realizado : null },
                { titulo: 'Diferença', tipo: 'numero', valor: (l) => producaoOk ? l.diferenca : null },
                { titulo: 'Observação', valor: (l) => l.observacao },
              ]} />}>
            <div className="tabela-wrap">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Pessoa</th><th>Tipo de nota</th>
                    {linhas ? <><th className="num">Capacidade</th><th className="num">Fila em aberto</th><th className="num">Compromisso</th></>
                      : <><th className="num">Compromisso</th><th className="num">Realizado</th><th className="num">Diferença</th><th>Observação</th></>}
                  </tr>
                </thead>
                <tbody>
                  {(linhas ?? doTime).map((l, n) => (
                    <tr key={`${l.usuario}|${l.categoria}`}>
                      <td>{l.usuario}{l.papel === 'apoio' && <span className="tag" style={{ marginLeft: 6 }}>apoio</span>}</td>
                      <td>{l.categoria_rotulo}</td>
                      {linhas ? (
                        <>
                          <td className="num muted">{numero(l.capacidade)}</td>
                          <td className="num muted">{numero(l.fila_em_aberto)}</td>
                          <td className="num">
                            <input type="number" min="0" value={l.quantidade} style={{ width: 80 }}
                              onChange={(e) => setLinhas(linhas.map((x, i) => (i === n ? { ...x, quantidade: Number(e.target.value) } : x)))} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="num">{l.compromisso != null ? <strong>{numero(l.compromisso)}</strong> : <span className="muted">A definir</span>}</td>
                          <td className="num">{producaoOk ? numero(l.realizado) : '—'}</td>
                          <td className="num" style={{ color: l.diferenca == null ? undefined : l.diferenca >= 0 ? 'var(--status-bom)' : 'var(--status-critico)' }}>
                            {!producaoOk || l.diferenca == null ? <span className="muted">—</span> : `${l.diferenca > 0 ? '+' : ''}${numero(l.diferenca)}`}
                          </td>
                          <td className="muted pequeno">{l.observacao ?? ''}</td>
                        </>
                      )}
                    </tr>
                  ))}
                  {!(linhas ?? doTime).length && (
                    <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>
                      Nada combinado nem lançado neste dia. Use “Sugerir compromisso”.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {linhas && (
              <div className="linha pequeno" style={{ padding: '8px 12px', gap: 10 }}>
                <strong>Total combinado: {numero(linhas.reduce((t, x) => t + (Number(x.quantidade) || 0), 0))}</strong>
                <span className="muted">A quantidade é o que a pessoa combinou entregar no tipo dela. Lançamentos fora da fila aparecem à parte.</span>
              </div>
            )}
          </Cartao>}

          {Boolean(foraDaFila.length) && !linhas && verDetalhe && (
            <Cartao titulo="Lançado fora da fila combinada" sub="não é descumprimento: é trabalho que saiu do tipo acordado">
              <div className="tabela-wrap">
                <table className="tabela">
                  <thead><tr><th>Pessoa</th><th>Tipo de nota</th><th className="num">Notas</th></tr></thead>
                  <tbody>
                    {foraDaFila.map((l) => (
                      <tr key={`${l.usuario}|${l.categoria}`}>
                        <td>{l.usuario}</td><td>{l.categoria_rotulo}</td><td className="num">{numero(l.realizado)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Cartao>
          )}
        </>
      )}
    </>
  );
}

/** Os dados do dia e a fotografia atual da fila têm períodos diferentes, identificados em cada bloco. */
function IndicadoresDashboard({ painel, dia }) {
  const [todasPessoas, setTodasPessoas] = useState(false);
  const d = painel.dashboard ?? {};
  const producao = d.notas_lancadas ?? {};
  const pendencias = d.pendencias ?? {};
  const antigos = d.antigos ?? {};
  const producaoOk = producao.estado === 'ok';
  const pendenciasOk = pendencias.estado === 'ok';
  const antigosOk = antigos.estado === 'ok';
  const k = painel.indicadores;
  const cumprimento = producaoOk ? k.cumprimento : null;
  const maisAntiga = (antigos.itens ?? []).filter((i) => i.recebido_em).slice()
    .sort((a, b) => String(a.recebido_em).localeCompare(String(b.recebido_em)))[0];
  const pessoas = (painel.linhas ?? []).slice().sort((a, b) => b.realizado - a.realizado
    || a.usuario.localeCompare(b.usuario, 'pt-BR') || a.categoria_rotulo.localeCompare(b.categoria_rotulo, 'pt-BR'));
  const colunasPessoas = [
    { titulo: 'Pessoa', valor: (i) => i.usuario },
    { titulo: 'Bloco', valor: (i) => BLOCO[i.equipe] ?? i.equipe },
    { titulo: 'Tipo de nota', valor: (i) => i.categoria_rotulo },
    { titulo: 'Notas lançadas', tipo: 'numero', valor: (i) => i.realizado },
    { titulo: 'Compromisso', tipo: 'numero', valor: (i) => i.compromisso },
    { titulo: 'Diferença', tipo: 'numero', valor: (i) => i.diferenca },
    { titulo: 'Cumprimento (%)', tipo: 'numero', valor: (i) => i.compromisso > 0 ? Math.round(i.realizado / i.compromisso * 100) : null },
  ];
  const colunasAntigos = [
    { titulo: 'Nota', valor: (i) => i.numero },
    { titulo: 'Fornecedor', valor: (i) => i.fornecedor },
    { titulo: 'Empresa / filial', valor: (i) => i.empresa },
    { titulo: 'Tipo de nota', valor: (i) => i.categoria_rotulo },
    { titulo: 'Recebimento no VIA', tipo: 'data', valor: (i) => i.recebido_em },
    { titulo: 'Dias de espera', tipo: 'numero', valor: (i) => i.dias },
  ];
  useEffect(() => { setTodasPessoas(false); }, [dia]);

  return (
    <>
      {(d.avisos ?? []).map((aviso, i) => <div key={i} className="aviso pequeno" role="status" style={{ marginBottom: 12 }}>{aviso}</div>)}
      <div className="grade grade-kpi">
        <Kpi rotulo="Notas lançadas" valor={producaoOk ? numero(producao.total) : 'Indisponível'}
          detalhe={producaoOk ? `${data(dia)} · ${numero(producao.time)} pelo time fiscal · ${numero(producao.supervisao)} supervisão · ${numero(producao.outros)} outros` : 'Não foi possível consultar a produção no Senior'}
          titulo={producao.fonte} cor="var(--serie-1)" />
        <Kpi rotulo="Pendências atuais" valor={pendenciasOk ? numero(pendencias.total) : 'Indisponível'}
          detalhe={pendenciasOk ? `VIA · consulta em ${dataConsulta(pendencias.consultado_em)}` : 'Não foi possível consultar a fila atual'}
          titulo={pendencias.fonte} cor="var(--status-atencao)" />
        <Kpi rotulo="Cumprimento do dia" valor={!producaoOk ? 'Indisponível' : cumprimento == null ? 'A definir' : `${numero(cumprimento)}%`}
          detalhe={k.compromisso != null ? `${numero(k.compromisso)} notas combinadas · por pessoa e tipo` : 'Sem compromisso registrado para o dia'}
          cor={cumprimento == null ? undefined : cumprimento >= 100 ? 'var(--status-bom)' : 'var(--status-atencao)'} />
        <Kpi rotulo="Documento mais antigo" valor={!antigosOk ? 'Indisponível' : maisAntiga ? `${numero(maisAntiga.dias)} dia(s)` : '—'}
          detalhe={maisAntiga ? `Recebido no VIA em ${data(maisAntiga.recebido_em)}` : antigosOk ? 'Sem pendência com data de recebimento válida' : 'Data de recebimento indisponível'}
          cor={maisAntiga?.dias > 5 ? 'var(--status-critico)' : undefined} />
      </div>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', alignItems: 'start' }}>
        <Cartao titulo="Composição da produção" sub={`notas lançadas por tipo em ${data(dia)} · total no Senior`}
          acoes={producaoOk && <BotaoExportar titulo={`Composição da produção ${dia}`} linhas={d.composicao ?? []} rotulo="Excel"
            colunas={[{ titulo: 'Tipo de nota', valor: (i) => i.rotulo }, { titulo: 'Notas lançadas', tipo: 'numero', valor: (i) => i.notas }, { titulo: 'Participação (%)', tipo: 'numero', valor: (i) => i.percentual }]} />}>
          <BarrasPorTipo itens={d.composicao ?? []} campo="notas" disponivel={producaoOk} vazio="Nenhuma nota lançada neste dia." percentual />
        </Cartao>
        <Cartao titulo="Pendências por tipo" sub="fila atual no VIA · entradas da Escrita Fiscal no grupo"
          acoes={pendenciasOk && <BotaoExportar titulo="Pendências atuais por tipo" linhas={pendencias.por_tipo ?? []} rotulo="Excel"
            colunas={[{ titulo: 'Tipo de nota', valor: (i) => i.rotulo }, { titulo: 'Pendências atuais', tipo: 'numero', valor: (i) => i.qtd }]} />}>
          <BarrasPorTipo itens={pendencias.por_tipo ?? []} campo="qtd" disponivel={pendenciasOk} vazio="Nenhuma pendência na consulta atual." />
          <p className="muted pequeno" style={{ marginBottom: 0 }}>Não inclui notas canceladas, já lançadas ou serviços recebidos apenas nas planilhas da contabilidade.</p>
        </Cartao>
      </div>
      <Cartao titulo="Produção por pessoa e tipo" sub={`${data(dia)} · documentos distintos pela data do lançamento no Senior`}
        semPadding acoes={<div className="linha" style={{ gap: 6, flexWrap: 'wrap' }}>
          {pessoas.length > 10 && <button className="btn pequeno ghost" onClick={() => setTodasPessoas((x) => !x)}>{todasPessoas ? 'Resumir' : `Ver todas (${numero(pessoas.length)})`}</button>}
          {producaoOk && <BotaoExportar titulo={`Produção por pessoa e tipo ${dia}`} linhas={pessoas} colunas={colunasPessoas} rotulo="Excel" />}
        </div>}>
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Pessoa</th><th>Bloco</th><th>Tipo de nota</th><th className="num">Lançadas</th><th className="num">Compromisso</th><th className="num">Diferença</th><th className="num">Cumprimento</th></tr></thead>
          <tbody>
            {producaoOk && (todasPessoas ? pessoas : pessoas.slice(0, 10)).map((i) => <tr key={`${i.usuario}|${i.categoria}`}>
              <td>{i.usuario}</td><td className="pequeno muted">{BLOCO[i.equipe] ?? i.equipe}</td><td>{i.categoria_rotulo}</td>
              <td className="num"><strong>{numero(i.realizado)}</strong></td><td className="num">{i.compromisso == null ? 'A definir' : numero(i.compromisso)}</td>
              <td className="num" style={{ color: i.diferenca == null ? undefined : i.diferenca >= 0 ? 'var(--status-bom)' : 'var(--status-critico)' }}>{i.diferenca == null ? '—' : `${i.diferenca > 0 ? '+' : ''}${numero(i.diferenca)}`}</td>
              <td className="num">{i.compromisso > 0 ? `${numero(i.realizado / i.compromisso * 100)}%` : '—'}</td>
            </tr>)}
            {(!producaoOk || !pessoas.length) && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>{producaoOk ? 'Nenhum lançamento ou compromisso neste dia.' : 'Produção indisponível no momento. Atualize para consultar novamente.'}</td></tr>}
          </tbody>
        </table></div>
        {producaoOk && pessoas.length > 10 && !todasPessoas && <div className="muted pequeno" style={{ padding: '8px 12px' }}>Mostrando as 10 maiores produções. A exportação inclui todas as pessoas e tipos.</div>}
      </Cartao>
      <Cartao titulo="Documentos mais antigos" sub="10 pendências com maior espera · data de recebimento no VIA"
        semPadding acoes={antigosOk && <BotaoExportar titulo="Documentos mais antigos" linhas={antigos.itens ?? []} colunas={colunasAntigos} rotulo="Excel" />}>
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Nota</th><th>Fornecedor</th><th>Empresa / filial</th><th>Tipo de nota</th><th>Recebimento no VIA</th><th className="num">Dias de espera</th></tr></thead>
          <tbody>
            {antigosOk && (antigos.itens ?? []).slice(0, 10).map((i, n) => <tr key={i.chave ?? `${i.numero}|${n}`}>
              <td>{i.numero ?? '—'}</td><td>{i.fornecedor ?? '—'}</td><td>{i.empresa ?? '—'}</td><td>{i.categoria_rotulo ?? '—'}</td><td>{data(i.recebido_em)}</td><td className="num">{numero(i.dias)}</td>
            </tr>)}
            {(!antigosOk || !antigos.itens?.length) && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>{antigosOk ? 'Nenhuma pendência com data de recebimento válida.' : 'Não foi possível consultar as datas de recebimento.'}</td></tr>}
          </tbody>
        </table></div>
        <div className="muted pequeno" style={{ padding: '8px 12px' }}>
          {antigosOk && <>{numero(antigos.total_com_data)} pendência(s) com data válida · {numero(antigos.sem_data)} sem data de recebimento válida. </>}
          A espera é contada desde o recebimento no VIA, sem substituir pela data de emissão.
        </div>
      </Cartao>
    </>
  );
}

function BarrasPorTipo({ itens, campo, disponivel, vazio, percentual = false }) {
  if (!disponivel) return <p className="muted" style={{ margin: 0 }}>Dados indisponíveis no momento.</p>;
  const linhas = itens.filter((i) => i[campo] > 0).slice().sort((a, b) => b[campo] - a[campo]);
  if (!linhas.length) return <p className="muted" style={{ margin: 0 }}>{vazio}</p>;
  const maior = Math.max(...linhas.map((i) => i[campo]));
  return <div>{linhas.map((i) => <div key={i.chave} style={{ marginBottom: 14 }}>
    <div className="linha entre pequeno" style={{ gap: 12, marginBottom: 5 }}>
      <span>{i.rotulo}</span><strong style={{ whiteSpace: 'nowrap' }}>{numero(i[campo])}{percentual && i.percentual != null ? ` · ${numero(i.percentual, 1)}%` : ''}</strong>
    </div>
    <div className="barra-progresso" style={{ height: 10 }}><div style={{ width: `${i[campo] / maior * 100}%`, background: COR_CATEGORIA[i.chave] ?? 'var(--serie-1)' }} /></div>
  </div>)}</div>;
}

function Placar({ k, falta, fora, disponivel }) {
  return <Cartao titulo="Compromissos do dia" sub="acompanhamento da Escrita Fiscal por pessoa e tipo">
    <div className="linha pequeno" style={{ gap: 22, flexWrap: 'wrap' }}>
      <span>Combinado: <strong>{k.compromisso == null ? 'A definir' : numero(k.compromisso)}</strong>{k.compromisso != null ? ` · ${numero(k.pessoas_com_compromisso)} pessoa(s)` : ''}</span>
      <span>Realizado pelo time: <strong>{disponivel ? numero(k.realizado_time) : 'Indisponível'}</strong></span>
      <span>Falta para o combinado: <strong>{disponivel ? numero(falta) : '—'}</strong></span>
      <span>Fora da fila combinada: <strong>{disponivel ? numero(fora) : '—'}</strong></span>
    </div>
  </Cartao>;
}

/** Uma coluna por fila: o tipo, o total e uma barra por pessoa. */
function ColunaFila({ fila }) {
  const pct = fila.combinado ? Math.round((fila.feito / fila.combinado) * 100) : null;
  const corDe = (p) => (p == null ? 'var(--texto-3)' : p >= 100 ? 'var(--status-bom)' : p >= 60 ? 'var(--status-atencao)' : 'var(--status-critico)');
  return (
    <Cartao>
      <div className="linha entre" style={{ alignItems: 'baseline' }}>
        <strong style={{ fontSize: 16 }}>{fila.rotulo}</strong>
        <span style={{ fontSize: 24, fontWeight: 700, color: corDe(pct) }}>
          {numero(fila.feito)}<span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>
            {fila.combinado ? ` / ${numero(fila.combinado)}` : ''}</span>
        </span>
      </div>
      {fila.em_aberto != null && <div className="muted pequeno">{numero(fila.em_aberto)} em aberto na fila</div>}
      <div style={{ marginTop: 10 }}>
        {fila.pessoas.map((p) => (
          <div key={p.usuario} style={{ marginBottom: 10 }}>
            <div className="linha entre pequeno">
              <span className="truncar">{p.usuario.split('.')[0]}</span>
              <strong style={{ color: corDe(p.pct) }}>
                {numero(p.realizado)}{p.compromisso != null ? ` / ${numero(p.compromisso)}` : ''}
              </strong>
            </div>
            <div className="barra-progresso" style={{ height: 10 }}>
              <div style={{ width: `${Math.min(100, p.pct ?? 0)}%`, background: corDe(p.pct) }} />
            </div>
            {p.compromisso != null && p.realizado < p.compromisso && (
              <div className="muted pequeno">faltam {numero(p.compromisso - p.realizado)}</div>
            )}
          </div>
        ))}
      </div>
    </Cartao>
  );
}

/** Alocação das pessoas por tipo de nota. Titular atende a fila; apoio reforça e trata exceções. */
function ConfiguracaoFilas({ filas, avisar }) {
  const [rascunho, setRascunho] = useState(null);
  useEffect(() => {
    if (filas.dados && !rascunho) {
      setRascunho(Object.fromEntries(filas.dados.categorias.map((c) => [c.chave, c.pessoas.map((p) => ({ usuario: p.usuario, papel: p.papel }))])));
    }
  }, [filas.dados]);
  if (!filas.dados || !rascunho) return <Cartao titulo="Configurar filas"><Carregando /></Cartao>;

  const time = filas.dados.time;
  const alternar = (categoria, usuario) => setRascunho((r) => {
    const atual = r[categoria] ?? [];
    const tem = atual.find((p) => p.usuario === usuario);
    return { ...r, [categoria]: tem ? atual.filter((p) => p.usuario !== usuario) : [...atual, { usuario, papel: 'titular' }] };
  });
  const trocarPapel = (categoria, usuario) => setRascunho((r) => ({
    ...r,
    [categoria]: (r[categoria] ?? []).map((p) => (p.usuario === usuario ? { ...p, papel: p.papel === 'apoio' ? 'titular' : 'apoio' } : p)),
  }));
  const gravar = async () => {
    try { await api.put('/filas', { filas: rascunho }); avisar('Filas gravadas', 'ok'); filas.recarregar(); }
    catch (e) { avisar(e.message, 'erro'); }
  };
  const alocadas = new Set(Object.values(rascunho).flat().map((p) => p.usuario));
  const semFila = time.filter((t) => !alocadas.has(t.usuario));

  return (
    <Cartao titulo="Filas por tipo de nota" sub="quem atende cada tipo · clique no nome para incluir, no selo para trocar titular/apoio"
      acoes={<button className="btn pequeno" onClick={gravar}>Gravar filas</button>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {filas.dados.categorias.map((c) => (
          <div key={c.chave} style={{ border: '1px solid var(--grade)', borderRadius: 10, padding: 10 }}>
            <div className="linha entre">
              <strong className="pequeno">{c.rotulo}</strong>
              <span className="muted pequeno">{(rascunho[c.chave] ?? []).length} pessoa(s)</span>
            </div>
            <div style={{ marginTop: 6 }}>
              {time.map((t) => {
                const p = (rascunho[c.chave] ?? []).find((x) => x.usuario === t.usuario);
                return (
                  <div key={t.usuario} className="linha" style={{ gap: 6, padding: '2px 0' }}>
                    <input type="checkbox" checked={Boolean(p)} onChange={() => alternar(c.chave, t.usuario)} />
                    <span className="pequeno" style={{ flex: 1, opacity: p ? 1 : 0.6 }}>{t.usuario}</span>
                    {p && (
                      <button className="btn pequeno ghost" style={{ padding: '0 6px', color: COR[p.papel] }}
                        title="Alternar entre titular e apoio" onClick={() => trocarPapel(c.chave, t.usuario)}>
                        {p.papel === 'apoio' ? 'apoio' : 'titular'}
                      </button>
                    )}
                    <span className="muted pequeno">meta {t.meta_dia ?? '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="muted pequeno" style={{ marginBottom: 0 }}>
        {semFila.length
          ? <>Sem fila: <strong>{semFila.map((t) => t.usuario).join(', ')}</strong>. O plano pede que nenhuma frente fique sem responsável.</>
          : 'Todas as pessoas do time estão em alguma fila.'}
        {' '}A supervisão ({filas.dados.supervisao.join(', ') || '—'}) fica fora da meta e da sugestão.
      </p>
    </Cartao>
  );
}
