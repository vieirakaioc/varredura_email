import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { brl, BotaoExportar, Cartao, Carregando, data, Erro, Kpi, numero, useDados, useToast } from '../ui.jsx';

const hoje = () => new Date().toLocaleDateString('sv-SE');
/** Próximo dia útil: o prazo padrão de retorno de quem precisa resolver. */
const proximoDiaUtil = (de = hoje()) => {
  const d = new Date(`${de}T12:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
};

/**
 * Exceções: pendências que saíram da mão do time e dependem de alguém de fora.
 * O relógio aqui é o do retorno de quem precisa resolver, não o do lançamento.
 */
export default function Excecoes() {
  const [params, setParams] = useSearchParams();
  const f = {
    motivo: params.get('motivo') ?? '', responsavel: params.get('responsavel') ?? '',
    so_atrasadas: params.get('so_atrasadas') ?? '',
  };
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ aba: 'excecoes', ...f, [k]: v }).filter(([, x]) => x)));
  const avisar = useToast();
  const [editando, setEditando] = useState(null);

  const { dados, erro, carregando, recarregar } = useDados(
    ({ forcar } = {}) => api.get(`/pendentes-lancamento/excecoes${qs({ forcar: forcar ? '1' : '' })}`), [], { automatico: false },
  );

  const salvar = async (chave, corpo) => {
    try {
      await api.put('/pendentes-lancamento/motivo', { chave, ...corpo });
      avisar('Exceção atualizada', 'ok');
      setEditando(null); recarregar();
    } catch (e) { avisar(e.message, 'erro'); }
  };

  const k = dados?.indicadores;
  let itens = dados?.itens ?? [];
  if (f.motivo) itens = itens.filter((i) => i.motivo === f.motivo);
  if (f.responsavel) itens = itens.filter((i) => (i.responsavel_externo ?? '—') === f.responsavel);
  if (f.so_atrasadas === '1') itens = itens.filter((i) => i.atrasada);

  return (
    <>
      <Cartao>
        <div className="linha" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="linha" style={{ gap: 6 }}>
            <input type="checkbox" checked={f.so_atrasadas === '1'} onChange={() => setFiltro('so_atrasadas', f.so_atrasadas === '1' ? '' : '1')} />
            <strong>Só as vencidas</strong>
          </label>
          <select value={f.motivo} onChange={(e) => setFiltro('motivo', e.target.value)} aria-label="Motivo">
            <option value="">Todos os motivos</option>
            {(dados?.por_motivo ?? []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo} ({numero(m.qtd)})</option>)}
          </select>
          <select value={f.responsavel} onChange={(e) => setFiltro('responsavel', e.target.value)} aria-label="Responsável">
            <option value="">Todos os responsáveis</option>
            {(dados?.por_responsavel ?? []).map((r) => <option key={r.chave} value={r.chave}>{r.rotulo} ({numero(r.qtd)})</option>)}
          </select>
          <button className="btn pequeno" onClick={recarregar}>Atualizar</button>
          <span className="espaco" />
          {dados && <span className="muted pequeno">{dados.fonte}. Atualizado em {data(dados.atualizado_em, true)}.</span>}
        </div>
      </Cartao>

      <Erro erro={erro} />
      {carregando && !dados ? <Carregando /> : dados && (
        <>
          <div className="grade grade-kpi monetario">
            <Kpi rotulo="Exceções vencidas" valor={numero(k.atrasadas)} detalhe="sem retorno dentro do prazo"
              cor={k.atrasadas ? 'var(--status-critico)' : 'var(--status-bom)'}
              onClick={() => setFiltro('so_atrasadas', f.so_atrasadas === '1' ? '' : '1')} />
            <Kpi rotulo="Exceções abertas" valor={numero(k.com_motivo)} detalhe={brl(k.valor)} />
            <Kpi rotulo="Sem responsável" valor={numero(k.sem_responsavel)} detalhe="ninguém para cobrar"
              cor={k.sem_responsavel ? 'var(--status-atencao)' : undefined} />
            <Kpi rotulo="Sem prazo" valor={numero(k.sem_prazo)} detalhe="não dá para vencer"
              cor={k.sem_prazo ? 'var(--status-atencao)' : undefined} />
            <Kpi rotulo="Pendências com motivo" valor={k.pct_com_motivo != null ? `${numero(k.pct_com_motivo)}%` : '—'}
              detalhe={`${numero(k.sem_motivo)} ainda sem motivo`}
              cor={k.pct_com_motivo >= 90 ? 'var(--status-bom)' : 'var(--status-critico)'} />
          </div>

          {k.sem_motivo > 0 && (
            <div className="aviso">
              <strong>{numero(k.sem_motivo)}</strong> pendência(s) ainda não têm motivo registrado.
              Enquanto estiverem assim, não viram exceção e ninguém é cobrado por elas — o motivo é marcado na aba
              <strong> Pendentes de lançamento</strong>, na própria linha da nota.
            </div>
          )}

          <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
            <Barras titulo="Por motivo" sub="a causa a atacar" itens={dados.por_motivo}
              ativo={f.motivo} aoClicar={(c) => setFiltro('motivo', f.motivo === c ? '' : c)} />
            <Barras titulo="Quem precisa resolver" sub="fora do time" itens={dados.por_responsavel}
              ativo={f.responsavel} aoClicar={(c) => setFiltro('responsavel', f.responsavel === c ? '' : c)} />
          </div>

          <Cartao titulo={`Exceções (${numero(itens.length)})`} sub="vencidas primeiro, depois as mais antigas" semPadding
            acoes={<BotaoExportar titulo="Exceções" linhas={itens} rotulo="Excel"
              colunas={[
                { titulo: 'Situação', valor: (i) => (i.atrasada ? 'VENCIDA' : i.retorno_em ? 'Respondida' : 'No prazo') },
                { titulo: 'Empresa', valor: (i) => i.empresa },
                { titulo: 'Fornecedor', valor: (i) => i.fornecedor },
                { titulo: 'Documento', valor: (i) => `${i.especie_rotulo} ${i.numero}` },
                { titulo: 'Valor', tipo: 'moeda', valor: (i) => i.valor },
                { titulo: 'Motivo', valor: (i) => i.motivo_rotulo },
                { titulo: 'Quem resolve', valor: (i) => i.responsavel_externo },
                { titulo: 'Prazo de retorno', tipo: 'data', valor: (i) => i.prazo },
                { titulo: 'Respondida em', valor: (i) => i.retorno_em },
                { titulo: 'Tempo desde a entrada (dias)', tipo: 'numero', valor: (i) => i.dias_parada },
                { titulo: 'Observação', valor: (i) => i.motivo_obs },
              ]} />}>
            <div className="tabela-wrap">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Documento</th><th>Motivo</th><th>Quem resolve</th><th className="num">Prazo</th>
                    <th className="num">Desde a entrada</th><th className="num">Valor</th><th />
                  </tr>
                </thead>
                <tbody>
                  {itens.map((i) => (
                    <Linha key={i.chave} i={i} motivos={dados.motivos_disponiveis}
                      editando={editando === i.chave} abrir={() => setEditando(editando === i.chave ? null : i.chave)}
                      salvar={(corpo) => salvar(i.chave, corpo)} />
                  ))}
                  {!itens.length && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>Nenhuma exceção com esses filtros.</td></tr>}
                </tbody>
              </table>
            </div>
          </Cartao>
        </>
      )}
    </>
  );
}

function Barras({ titulo, sub, itens, ativo, aoClicar }) {
  const max = Math.max(...(itens ?? []).map((i) => i.qtd), 1);
  return (
    <Cartao titulo={titulo} sub={sub} semPadding>
      <div style={{ padding: 12 }}>
        {(itens ?? []).map((i) => (
          <button key={i.chave} className="linha entre" onClick={() => aoClicar(i.chave)}
            style={{ width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', opacity: !ativo || ativo === i.chave ? 1 : 0.45 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="linha entre pequeno">
                <span className="truncar">{i.rotulo}</span>
                <strong>{numero(i.qtd)}{i.atrasadas ? <span style={{ color: 'var(--status-critico)' }}> · {numero(i.atrasadas)} vencida(s)</span> : null}</strong>
              </div>
              <div className="barra-progresso"><div style={{ width: `${(i.qtd / max) * 100}%`, background: i.atrasadas ? 'var(--status-critico)' : 'var(--serie-1)' }} /></div>
            </div>
          </button>
        ))}
        {!itens?.length && <span className="muted pequeno">Nada registrado ainda.</span>}
      </div>
    </Cartao>
  );
}

function Linha({ i, motivos, editando, abrir, salvar }) {
  const [form, setForm] = useState({
    motivo: i.motivo, responsavel: i.responsavel_externo ?? '', prazo: i.prazo ?? proximoDiaUtil(), observacao: i.motivo_obs ?? '',
  });
  const cor = i.atrasada ? 'var(--status-critico)' : i.retorno_em ? 'var(--status-bom)' : undefined;
  return (
    <>
      <tr style={{ background: i.atrasada ? 'color-mix(in srgb, var(--status-critico) 10%, transparent)' : undefined }}>
        <td>
          <span className="tag azul">{i.especie_rotulo}</span> <strong>{i.numero}</strong>
          <div className="muted pequeno truncar" style={{ maxWidth: 260 }}>{i.fornecedor} · {i.empresa}</div>
        </td>
        <td className="pequeno">{i.motivo_rotulo}{i.motivo_obs && <div className="muted truncar" style={{ maxWidth: 200 }}>{i.motivo_obs}</div>}</td>
        <td className="pequeno">{i.responsavel_externo ?? <span className="muted">a definir</span>}</td>
        <td className="num pequeno" style={{ color: cor, fontWeight: i.atrasada ? 600 : undefined }}>
          {i.prazo ? data(i.prazo) : <span className="muted">sem prazo</span>}
          {i.atrasada && <div>vencida</div>}
          {i.retorno_em && <div className="muted">respondida</div>}
        </td>
        <td className="num">{numero(i.dias_parada ?? 0)} d</td>
        <td className="num">{brl(i.valor)}</td>
        <td className="num"><button className="btn pequeno ghost" onClick={abrir}>{editando ? 'Fechar' : 'Tratar'}</button></td>
      </tr>
      {editando && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--superficie-2)' }}>
            <div className="linha" style={{ gap: 10, flexWrap: 'wrap', padding: '4px 0' }}>
              <select value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} aria-label="Motivo">
                {Object.entries(motivos).map(([c, r]) => <option key={c} value={c}>{r}</option>)}
              </select>
              <input placeholder="quem resolve (área, filial, fornecedor)" value={form.responsavel} style={{ width: 250 }}
                onChange={(e) => setForm({ ...form, responsavel: e.target.value })} />
              <label className="linha pequeno" style={{ gap: 5 }}>prazo de retorno
                <input type="date" value={form.prazo} onChange={(e) => setForm({ ...form, prazo: e.target.value })} />
              </label>
              <input placeholder="observação" value={form.observacao} style={{ flex: 1, minWidth: 180 }}
                onChange={(e) => setForm({ ...form, observacao: e.target.value })} />
              <button className="btn pequeno" onClick={() => salvar(form)}>Gravar</button>
              {!i.retorno_em && <button className="btn pequeno ghost" onClick={() => salvar({ ...form, responder: true })}
                title="A área respondeu: para o relógio da cobrança, sem fechar a pendência">Marcar retorno</button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
