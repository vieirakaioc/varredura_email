import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { brl, BotaoExportar, Campo, Cartao, Carregando, cnpj as fmtCnpj, data, Erro, Kpi, Modal, numero, useDados, useToast } from '../ui.jsx';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** Últimos 24 meses para o filtro. */
const mesesDisponiveis = () => Array.from({ length: 24 }, (_, i) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - i);
  return { valor: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rotulo: `${MESES[d.getMonth()]}/${d.getFullYear()}` };
});
const situacaoSefaz = (l) => (l.origem === 'senior_saida' ? 'Cancelada (registro do Senior)' : l.tp_evento === '110112' ? 'Cancelada por substituição' : 'Cancelada na SEFAZ');
const situacaoSenior = (l) => (l.lancada ? l.situacao_senior : 'Não lançada');

const COLUNAS_EXPORT = [
  { titulo: 'Cancelada em', tipo: 'data', valor: (l) => l.data_evento },
  { titulo: 'Situação na SEFAZ', valor: situacaoSefaz },
  { titulo: 'Situação no Senior', valor: situacaoSenior },
  { titulo: 'Origem da informação', valor: (l) => (l.origem === 'senior_saida' ? 'Senior (nota de saída)' : 'SEFAZ') },
  { titulo: 'Chave de acesso', valor: (l) => l.chave },
  { titulo: 'NF', valor: (l) => l.numero },
  { titulo: 'Fornecedor', valor: (l) => l.fornecedor },
  { titulo: 'Valor', tipo: 'moeda', valor: (l) => l.valor },
  { titulo: 'Conferência', valor: (l) => ({ pendente: 'A ESTORNAR', ok_estornada: 'OK (já estornada)', ok_nao_lancada: 'OK (não lançada)' }[l.conferencia] ?? '') },
  { titulo: 'Lançada no Senior', valor: (l) => (l.lancada ? 'sim' : 'não') },
  { titulo: 'Títulos a pagar', tipo: 'numero', valor: (l) => l.titulos },
  { titulo: 'Saldo em aberto', tipo: 'moeda', valor: (l) => l.saldo_aberto },
  { titulo: 'Empresa/Filial', valor: (l) => (l.senior ? `${l.senior.codemp}/${l.senior.codfil}` : '') },
  { titulo: 'Entrada no Senior', tipo: 'data', valor: (l) => l.senior?.entrada },
  { titulo: 'Cancelada após a entrada', valor: (l) => (l.cancelada_apos_entrada ? 'sim' : '') },
  { titulo: 'Lançada após o cancelamento', valor: (l) => (l.lancada_apos_cancelamento ? 'SIM' : '') },
  { titulo: 'Justificativa do fornecedor', valor: (l) => l.justificativa },
  { titulo: 'O que aconteceu', valor: (l) => l.problema },
  { titulo: 'O que fazer', valor: (l) => l.acao },
  { titulo: 'Tratado em', tipo: 'data', valor: (l) => l.tratado_em },
  { titulo: 'Tratado por', valor: (l) => l.tratado_por },
  { titulo: 'Observação', valor: (l) => l.observacao },
];

function Canceladas() {
  const avisar = useToast();
  const { pode } = useAuth();
  const [params, setParams] = useSearchParams();
  // Padrão: só o que exige ação (lançada no Senior e ainda ativa). Cancelada e não lançada está certa.
  const filtros = { dias: params.get('dias') ?? '180', mes: params.get('mes') ?? '', ver: params.get('ver') ?? 'pendencias', pendentes: params.get('pendentes') ?? '' };
  const { dados, erro, carregando, recarregar } = useDados(
    () => api.get(`/sefaz/canceladas?dias=${filtros.dias}&mes=${filtros.mes}`),
    [filtros.dias, filtros.mes],
  );
  const [tratar, setTratar] = useState(null);
  const [obs, setObs] = useState('');
  const setFiltro = (k, v) => setParams(Object.fromEntries(Object.entries({ ...filtros, [k]: v }).filter(([, x]) => x)));
  const salvarTrato = async () => {
    try { await api.post(`/sefaz/eventos/${tratar.id}/tratar`, { observacao: obs }); avisar('Marcado como tratado.'); setTratar(null); setObs(''); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };
  const desfazer = async (l) => {
    try { await api.post(`/sefaz/eventos/${l.id}/tratar`, { desfazer: true }); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };
  const todos = dados?.itens ?? [];
  const aEstornar = todos.filter((l) => l.conferencia === 'pendente');
  const semPendencia = todos.filter((l) => l.conferencia !== 'pendente');
  const itens = (filtros.ver === 'pendencias' ? aEstornar : filtros.ver === 'ok' ? semPendencia : todos)
    .filter((l) => (filtros.pendentes !== '1' || !l.tratado_em));

  return (
    <>
      <div className="grade grade-kpi">
        <Kpi rotulo="A estornar no Senior" valor={numero(aEstornar.length)} detalhe={`${brl(aEstornar.reduce((s, l) => s + (l.valor ?? 0), 0))} · lançadas e ainda ativas`} cor="var(--status-critico)" onClick={() => setFiltro('ver', 'pendencias')} titulo="Cancelada na SEFAZ, mas a entrada continua ativa no Senior" />
        <Kpi rotulo="Aguardando tratamento" valor={numero(aEstornar.filter((l) => !l.tratado_em).length)} detalhe="ainda não marcadas como resolvidas" cor="var(--status-atencao)" onClick={() => setFiltro('pendentes', filtros.pendentes === '1' ? '' : '1')} />
        <Kpi rotulo="Sem pendência" valor={numero(semPendencia.length)} detalhe="não lançadas ou já estornadas" cor="var(--status-bom)" onClick={() => setFiltro('ver', filtros.ver === 'ok' ? 'pendencias' : 'ok')} />
        <Kpi rotulo="Cancelamentos recebidos" valor={numero(todos.length)} detalhe={filtros.mes ? 'no mês escolhido' : `últimos ${filtros.dias} dias`} cor="var(--serie-1)" onClick={() => setFiltro('ver', 'todas')} />
      </div>
      {dados?.senior !== 'ok' && <div className="aviso atencao">Situação no Senior indisponível ({dados?.senior}). A lista mostra os cancelamentos recebidos da SEFAZ mesmo assim.</div>}
      <Cartao semPadding>
        <div className="linha" style={{ padding: 12, borderBottom: '1px solid var(--borda)', gap: 12, flexWrap: 'wrap' }}>
          <select value={filtros.mes} onChange={(e) => setFiltro('mes', e.target.value)} aria-label="Mês">
            <option value="">Mês: todos (usar período)</option>
            {mesesDisponiveis().map((m) => <option key={m.valor} value={m.valor}>{m.rotulo}</option>)}
          </select>
          <select value={filtros.dias} onChange={(e) => setFiltro('dias', e.target.value)} aria-label="Período" disabled={Boolean(filtros.mes)}>
            {[30, 90, 180, 365].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
          </select>
          <select value={filtros.ver} onChange={(e) => setFiltro('ver', e.target.value)} aria-label="Mostrar">
            <option value="pendencias">A estornar no Senior ({aEstornar.length})</option>
            <option value="ok">Sem pendência ({semPendencia.length})</option>
            <option value="todas">Todos os cancelamentos ({todos.length})</option>
          </select>
          <label className="linha pequeno" style={{ gap: 6 }}><input type="checkbox" checked={filtros.pendentes === '1'} onChange={(e) => setFiltro('pendentes', e.target.checked ? '1' : '')} />Ocultar as já tratadas</label>
          <span className="espaco" />
          <span className="muted pequeno">{itens.length} nota(s)</span>
          <BotaoExportar titulo="Canceladas na SEFAZ" linhas={itens} colunas={COLUNAS_EXPORT} />
        </div>
        <Erro erro={erro} />
        {carregando && !dados ? <Carregando /> : !itens.length ? (
          <div className="vazio" style={{ padding: 40 }}><div style={{ fontSize: 26 }}>✓</div>
            {filtros.ver === 'pendencias'
              ? `Nada a estornar no período: os ${numero(semPendencia.length)} cancelamento(s) recebido(s) não estão lançados no Senior ou já foram estornados.`
              : 'Nenhum cancelamento recebido no período.'}
          </div>
        ) : (
          <div className="tabela-wrap">
            <table className="tabela">
              <thead><tr><th>Cancelada em</th><th>NF</th><th>Fornecedor</th><th className="num">Valor</th><th>Situação SEFAZ</th><th>Situação Senior</th><th style={{ minWidth: 340 }}>O que aconteceu e o que fazer</th><th>Tratamento</th><th /></tr></thead>
              <tbody>
                {itens.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{data(l.data_evento)}
                      <div className="muted pequeno" title={l.origem === 'senior_saida' ? 'Cancelamento registrado na nota de saída do próprio grupo (Senior)' : 'Evento recebido da SEFAZ'}>{l.origem === 'senior_saida' ? 'Senior (saída)' : 'SEFAZ'}</div>
                      <div className="muted pequeno mono">{l.chave?.slice(-12)}</div>
                    </td>
                    <td className="nowrap"><strong>{l.numero ?? '—'}</strong>{l.senior?.serie ? <span className="muted">-{l.senior.serie}</span> : null}</td>
                    <td style={{ maxWidth: 240 }}>{l.fornecedor ?? '—'}</td>
                    <td className="num">{brl(l.valor)}</td>
                    <td className="nowrap">
                      <span className="badge sev-erro">Cancelada</span>
                      <div className="muted pequeno">{l.origem === 'senior_saida' ? 'registro do Senior (saída)' : l.tp_evento === '110112' ? 'por substituição' : 'evento da SEFAZ'}</div>
                      {l.protocolo && <div className="muted pequeno mono" title="Protocolo do cancelamento">{l.protocolo}</div>}
                    </td>
                    <td className="nowrap">
                      {l.lancada
                        ? <>
                          <span className={`badge ${l.pendente_estorno ? 'sev-erro' : 'sev-ok'}`}>{l.pendente_estorno ? 'Ativa (estornar)' : 'Cancelada'}</span>
                          {l.lancada_apos_cancelamento && <span className="badge sev-erro" title="A entrada foi lançada depois de a nota já estar cancelada na SEFAZ">lançada após o cancelamento</span>}
                          <div className="muted pequeno">{l.situacao_senior} · Emp {l.senior.codemp}/{l.senior.codfil} · entrada {data(l.senior.entrada)}</div>
                          {l.saldo_aberto > 0 && <div className="pequeno" style={{ color: 'var(--erro)' }}>título em aberto: {brl(l.saldo_aberto)}</div>}
                        </>
                        : <span className="muted pequeno">não lançada</span>}
                    </td>
                    <td className="pequeno" style={{ maxWidth: 420 }}>
                      <div>{l.problema}</div>
                      {l.pendente_estorno && <div style={{ marginTop: 4, color: 'var(--erro)' }}><strong>O que fazer:</strong> {l.acao}</div>}
                    </td>
                    <td className="pequeno">{l.tratado_em ? <>✓ {data(l.tratado_em)}<div className="muted">{l.tratado_por}{l.observacao ? ` · ${l.observacao}` : ''}</div></> : <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {pode('decidir') && (l.tratado_em
                        ? <button className="btn pequeno ghost" onClick={() => desfazer(l)}>Reabrir</button>
                        : <button className="btn pequeno" onClick={() => { setTratar(l); setObs(l.lancada ? 'Escrituração estornada no Senior' : 'Conferido: nota não foi lançada'); }}>Marcar tratado</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
      {tratar && (
        <Modal titulo={`Tratar cancelamento da NF ${tratar.numero ?? ''}`} onFechar={() => setTratar(null)}
          rodape={<><button className="btn" onClick={() => setTratar(null)}>Cancelar</button><button className="btn primario" onClick={salvarTrato}>Salvar</button></>}>
          <div className="definicoes">
            <div><span>Fornecedor</span><strong>{tratar.fornecedor ?? '—'}</strong></div>
            <div><span>Valor</span><strong>{brl(tratar.valor)}</strong></div>
            <div><span>Cancelada em</span><strong>{data(tratar.data_evento)}</strong></div>
            {tratar.senior && <div><span>Entrada no Senior</span><strong>{data(tratar.senior.entrada)} · Emp {tratar.senior.codemp}/{tratar.senior.codfil}</strong></div>}
          </div>
          <div className="aviso atencao" style={{ display: 'block' }}>
            <div>{tratar.problema}</div>
            {tratar.pendente_estorno && <div style={{ marginTop: 6 }}><strong>O que fazer:</strong> {tratar.acao}</div>}
          </div>
          <Campo rotulo="O que foi feito"><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
          <p className="muted pequeno" style={{ marginBottom: 0 }}>O estorno no Senior é feito por lá; aqui fica o registro de quem tratou e quando.</p>
        </Modal>
      )}
    </>
  );
}

function Certificados() {
  const avisar = useToast();
  const { pode } = useAuth();
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/sefaz'), []);
  const refs = useDados(() => api.get('/referencias'), []);
  const [novo, setNovo] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [atualizando, setAtualizando] = useState(false);

  const enviar = async () => {
    if (!novo?.arquivo || !novo?.senha) { avisar('Escolha o arquivo .pfx e informe a senha.', 'erro'); return; }
    setEnviando(true);
    const form = new FormData();
    form.append('arquivo', novo.arquivo);
    form.append('senha', novo.senha);
    if (novo.cnpj) form.append('cnpj', novo.cnpj);
    try {
      const r = await api.upload('/certificados', form);
      avisar(`Certificado de ${r.titular} (${fmtCnpj(r.cnpj)}) cadastrado. Válido até ${data(r.valido_ate)}.`);
      setNovo(null); recarregar();
    } catch (e) { avisar(e.message, 'erro'); } finally { setEnviando(false); }
  };
  const atualizar = async () => {
    setAtualizando(true);
    try { const r = await api.post('/sefaz/atualizar'); avisar(r.ignorado ?? `${r.novos ?? 0} documento(s) novo(s) em ${r.cnpjs ?? 1} CNPJ(s).`); recarregar(); } catch (e) { avisar(e.message, 'erro'); } finally { setAtualizando(false); }
  };
  const remover = async (c) => {
    try { await api.del(`/certificados/${c.id}`); avisar('Certificado removido.'); recarregar(); } catch (e) { avisar(e.message, 'erro'); }
  };

  return (
    <>
      <Erro erro={erro} />
      <Cartao titulo="Certificados digitais A1" sub={dados ? `ambiente ${dados.ambiente} · ${dados.certificados.length} cadastrado(s)` : ''}
        acoes={pode('administrar') && (
          <div className="linha" style={{ gap: 8 }}>
            <button className="btn pequeno" disabled={atualizando} onClick={atualizar}>{atualizando ? 'Consultando…' : 'Consultar SEFAZ agora'}</button>
            <button className="btn pequeno primario" onClick={() => setNovo({})}>Adicionar certificado</button>
          </div>
        )}>
        <p className="muted pequeno" style={{ marginTop: 0 }}>
          O arquivo .pfx fica guardado no servidor e a senha é gravada cifrada — nunca aparece na tela nem na API.
          Com ele, o sistema pergunta à SEFAZ de hora em hora o que há de novo para cada CNPJ (Distribuição DF-e, somente leitura)
          e recebe os cancelamentos feitos pelos fornecedores.
        </p>
        {carregando && !dados ? <Carregando /> : (
          <div className="tabela-wrap">
            <table className="tabela">
              <thead><tr><th>CNPJ</th><th>Titular</th><th>Empresa</th><th>Validade</th><th>Última consulta</th><th>Documentos</th><th /></tr></thead>
              <tbody>
                {dados?.certificados.map((c) => (
                  <tr key={c.id}>
                    <td className="mono nowrap">{fmtCnpj(c.cnpj)}</td>
                    <td style={{ maxWidth: 260 }}>{c.titular}</td>
                    <td className="pequeno">{c.empresa ?? <span className="muted">não vinculada</span>}</td>
                    <td className="nowrap">
                      {data(c.valido_ate)}
                      {c.vencido ? <div><span className="badge sev-erro">vencido</span></div>
                        : c.vence_em_dias <= 30 ? <div><span className="badge sev-alerta">vence em {c.vence_em_dias} dia(s)</span></div> : null}
                    </td>
                    <td className="pequeno">{c.ultima_consulta ? data(c.ultima_consulta, true) : '—'}
                      <div className="muted">
                        {c.dfe_erro ? <span style={{ color: 'var(--erro)' }}>{c.dfe_erro}</span>
                          : c.faltam > 0 ? `baixando: faltam ${numero(c.faltam)} documento(s)`
                            : c.ultima_consulta ? 'em dia' : 'ainda não consultado'}
                      </div>
                      {c.ultimo_aviso && <div className="muted" title="A SEFAZ só aceita uma consulta por hora quando não há documentos novos">aguardando a janela de 1 h</div>}
                    </td>
                    <td className="num">{numero(c.documentos ?? 0)}</td>
                    <td className="nowrap">{pode('administrar') && <button className="btn pequeno ghost" onClick={() => remover(c)}>Remover</button>}</td>
                  </tr>
                ))}
                {!dados?.certificados.length && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>Nenhum certificado cadastrado. Sem certificado, o sistema não consegue consultar a SEFAZ.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {dados?.certificados.some((c) => c.ultimo_erro || c.dfe_erro) && (
          <div className="aviso atencao" style={{ marginTop: 10 }}>
            {dados.certificados.filter((c) => c.ultimo_erro || c.dfe_erro).map((c) => <div key={c.id}>{fmtCnpj(c.cnpj)}: {c.ultimo_erro ?? c.dfe_erro}</div>)}
          </div>
        )}
        <p className="muted pequeno" style={{ margin: '10px 0 0' }}>
          A SEFAZ entrega no máximo um lote por hora para cada CNPJ. Quando não há documentos novos, ela responde
          “656 – consumo indevido”, que significa apenas “volte daqui a 1 hora”: o sistema respeita essa janela sozinho.
        </p>
      </Cartao>
      {novo && (
        <Modal titulo="Adicionar certificado A1" onFechar={() => setNovo(null)}
          rodape={<><button className="btn" onClick={() => setNovo(null)}>Cancelar</button><button className="btn primario" disabled={enviando} onClick={enviar}>{enviando ? 'Enviando…' : 'Salvar'}</button></>}>
          <Campo rotulo="Arquivo do certificado (.pfx ou .p12)">
            <input type="file" accept=".pfx,.p12" onChange={(e) => setNovo((n) => ({ ...n, arquivo: e.target.files?.[0] }))} />
          </Campo>
          <Campo rotulo="Senha do certificado"><input type="password" value={novo.senha ?? ''} onChange={(e) => setNovo((n) => ({ ...n, senha: e.target.value }))} autoComplete="new-password" /></Campo>
          <Campo rotulo="CNPJ (só se o certificado não trouxer)"><input value={novo.cnpj ?? ''} onChange={(e) => setNovo((n) => ({ ...n, cnpj: e.target.value }))} placeholder="00.000.000/0000-00" /></Campo>
          <p className="muted pequeno" style={{ marginBottom: 0 }}>Um certificado por CNPJ. Enviar de novo para o mesmo CNPJ substitui o anterior (renovação).</p>
        </Modal>
      )}
    </>
  );
}

export default function Sefaz() {
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') ?? 'canceladas';
  return (
    <>
      <Topo titulo="SEFAZ · Canceladas" descricao="Cancelamentos de NF-e recebidos direto da SEFAZ, cruzados com o que já está escriturado no Senior." />
      <div className="pagina">
        <div className="abas" style={{ padding: 0 }}>
          <button className={aba === 'canceladas' ? 'ativa' : ''} onClick={() => setParams({})}>Notas canceladas</button>
          <button className={aba === 'certificados' ? 'ativa' : ''} onClick={() => setParams({ aba: 'certificados' })}>Certificados e consulta</button>
        </div>
        {aba === 'certificados' ? <Certificados /> : <Canceladas />}
      </div>
    </>
  );
}
