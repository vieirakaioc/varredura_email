import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { BotaoExportar, Cartao, Carregando, data, Erro, Kpi, numero, useDados, useToast } from '../ui.jsx';

const hoje = () => new Date().toLocaleDateString('sv-SE');
const COR = { titular: 'var(--serie-1)', apoio: 'var(--status-atencao)' };

/**
 * Operação por fila de tipo de nota (piloto de 16 a 30/10/2026).
 * Duas coisas que não existem no Senior e moram aqui, agregadas: a alocação das pessoas por tipo
 * e o compromisso de produção do dia. Nada vira status ou apontamento por nota no ERP.
 */
export default function Filas() {
  const [params, setParams] = useSearchParams();
  const dia = params.get('dia') || hoje();
  const avisar = useToast();
  const [editando, setEditando] = useState(false);

  const filas = useDados(() => api.get('/filas'), [], { automatico: false });
  const painel = useDados(({ forcar } = {}) => api.get(`/filas/dia${qs({ dia, forcar: forcar ? '1' : '' })}`), [dia], { automatico: false });
  const [linhas, setLinhas] = useState(null);     // compromisso em edição
  const [sugestao, setSugestao] = useState(null);

  useEffect(() => { setLinhas(null); setSugestao(null); }, [dia]);

  const sugerir = async () => {
    try {
      const s = await api.get(`/filas/sugestao${qs({ dia })}`);
      setSugestao(s);
      setLinhas(s.itens.map((i) => ({ ...i, quantidade: i.sugerido })));
      avisar(`Sugestão para ${data(dia)}: ${numero(s.itens.reduce((t, i) => t + i.sugerido, 0))} notas`, 'ok');
    } catch (e) { avisar(e.message, 'erro'); }
  };
  const gravar = async () => {
    try {
      const r = await api.put('/filas/dia', { dia, itens: linhas ?? [] });
      avisar(`Compromisso de ${data(dia)} gravado (${numero(r.gravados)} linha(s))`, 'ok');
      setLinhas(null); setSugestao(null); painel.recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };

  const d = painel.dados;
  const k = d?.indicadores;
  const doTime = (d?.linhas ?? []).filter((l) => l.equipe === 'fiscal');
  const foraDaFila = doTime.filter((l) => l.compromisso == null && l.realizado > 0);

  return (
    <>
      <Cartao>
        <div className="linha" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="linha" style={{ gap: 6 }}>
            <strong className="muted pequeno">Dia</strong>
            <input type="date" value={dia} onChange={(e) => setParams({ dia: e.target.value || hoje() })} />
          </label>
          <button className="btn pequeno" onClick={sugerir}>Sugerir compromisso</button>
          {linhas && <button className="btn pequeno" onClick={gravar}>Gravar compromisso</button>}
          {linhas && <button className="btn pequeno ghost" onClick={() => { setLinhas(null); setSugestao(null); }}>Cancelar</button>}
          <button className="btn pequeno ghost" onClick={() => painel.recarregar()}>Atualizar</button>
          <span className="espaco" />
          <button className="btn pequeno ghost" onClick={() => setEditando((x) => !x)}>
            {editando ? 'Fechar a configuração' : 'Configurar filas'}
          </button>
        </div>
        {d && (
          <div className="muted pequeno" style={{ marginTop: 8 }}>
            Fonte: {d.fonte}. Atualizado em {data(d.atualizado_em, true)}.
            {!d.dia_util && ' Atenção: este dia não é dia útil.'}
          </div>
        )}
      </Cartao>

      <Erro erro={filas.erro ?? painel.erro} />
      {editando && <ConfiguracaoFilas filas={filas} avisar={avisar} />}

      {painel.carregando && !d ? <Carregando /> : d && (
        <>
          <div className="grade grade-kpi">
            <Kpi rotulo="Compromisso do dia" valor={k.compromisso != null ? numero(k.compromisso) : 'A definir'}
              detalhe={k.compromisso != null ? `${numero(k.pessoas_com_compromisso)} pessoa(s)` : 'nenhum combinado para este dia'}
              cor={k.compromisso != null ? 'var(--serie-1)' : undefined} />
            <Kpi rotulo="Realizado pelo time" valor={numero(k.realizado_time)}
              detalhe={`${numero(k.realizado_total)} no total, com integração e supervisão`} />
            <Kpi rotulo="Cumprimento" valor={k.cumprimento != null ? `${numero(k.cumprimento)}%` : 'Não se aplica'}
              detalhe={k.cumprimento != null ? 'realizado na fila ÷ combinado' : 'sem compromisso combinado'}
              cor={k.cumprimento == null ? undefined : k.cumprimento >= 100 ? 'var(--status-bom)' : k.cumprimento >= 80 ? 'var(--status-atencao)' : 'var(--status-critico)'} />
            <Kpi rotulo="Lançado fora da fila" valor={numero(foraDaFila.reduce((s, l) => s + l.realizado, 0))}
              detalhe={foraDaFila.length ? `${foraDaFila.length} combinação(ões) pessoa × tipo` : 'nada fora do combinado'}
              cor={foraDaFila.length ? 'var(--status-atencao)' : undefined} />
          </div>

          {sugestao && (
            <Cartao titulo="Sugestão do dia" sub="distribui as pendências em aberto pela capacidade de cada pessoa">
              <div className="aviso pequeno" style={{ marginBottom: 10 }}>
                {sugestao.premissas.aviso} Capacidade: {sugestao.premissas.calculo} = {numero(sugestao.premissas.meta_dia_padrao)} notas/dia.
                Pendências do time no momento da consulta: <strong>{numero(sugestao.pendentes_total)}</strong>.
              </div>
            </Cartao>
          )}

          <Cartao titulo={linhas ? `Compromisso de ${data(dia)} (ajuste antes de gravar)` : `Compromisso × realizado em ${data(dia)}`}
            semPadding
            acoes={!linhas && <BotaoExportar titulo={`Compromisso ${dia}`} linhas={d.linhas} rotulo="Excel"
              colunas={[
                { titulo: 'Pessoa', valor: (l) => l.usuario },
                { titulo: 'Bloco', valor: (l) => ({ fiscal: 'Escrita Fiscal', supervisao: 'Supervisão', outros: 'Outros' }[l.equipe] ?? l.equipe) },
                { titulo: 'Tipo de nota', valor: (l) => l.categoria_rotulo },
                { titulo: 'Compromisso', tipo: 'numero', valor: (l) => l.compromisso },
                { titulo: 'Realizado', tipo: 'numero', valor: (l) => l.realizado },
                { titulo: 'Diferença', tipo: 'numero', valor: (l) => l.diferenca },
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
                          <td className="num">{numero(l.realizado)}</td>
                          <td className="num" style={{ color: l.diferenca == null ? undefined : l.diferenca >= 0 ? 'var(--status-bom)' : 'var(--status-critico)' }}>
                            {l.diferenca == null ? <span className="muted">—</span> : `${l.diferenca > 0 ? '+' : ''}${numero(l.diferenca)}`}
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
          </Cartao>

          {Boolean(foraDaFila.length) && !linhas && (
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
