import { useEffect, useMemo, useState } from 'react';
import { api, baixar, qs } from '../api.js';
import { useAuth } from '../contexto.jsx';
import { BotaoExportar, brl, Campo, Cartao, Carregando, cnpj, data, Erro, Kpi, Modal, numero, useDados, useToast } from '../ui.jsx';

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const PRIORIDADES = { 1: 'Urgente', 2: 'Alta', 3: 'Normal' };
const STATUS = { pendente: 'A fazer', andamento: 'Em andamento', bloqueada: 'Bloqueada', lancada: 'Lançada' };
const COMPARAR_TEXTO = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const ORDENACOES = {
  prioridade: { rotulo: 'Prioridade', valor: (n) => n.prioridade },
  prazo: { rotulo: 'Prazo', valor: (n) => n.data_prevista },
  emissao: { rotulo: 'Emissão', valor: (n) => n.emissao || '' },
  numero: { rotulo: 'Número da nota', valor: (n) => n.numero },
  fornecedor: { rotulo: 'Fornecedor', valor: (n) => n.fornecedor },
  filial: { rotulo: 'Filial', valor: (n) => n.empfil },
  tomador: { rotulo: 'Tomador', valor: (n) => n.tomador_nome || n.empresa },
  pdf_nota: { rotulo: 'PDF da nota', valor: (n) => n.pdfs_nota?.length ?? 0 },
  boleto: { rotulo: 'Boleto', valor: (n) => n.pdfs_boleto?.length ?? 0 },
  responsavel: { rotulo: 'Responsável', valor: (n) => n.responsavel },
  status: { rotulo: 'Status', valor: (n) => STATUS[n.status] ?? n.status },
  valor: { rotulo: 'Valor', valor: (n) => n.valor },
};
const ACOES = { importar_nova: 'Incluída pela planilha', importar_atualizacao: 'Programação atualizada pela planilha',
  alterar_programacao: 'Programação alterada', confirmar_senior: 'Lançamento confirmado no Senior', reabrir_senior: 'Retornou à carteira após conferência no Senior',
  excluir_importacao: 'Retirada da carteira pela exclusão da importação', complementar_tomador: 'Tomador completado pelo cadastro de filiais do Senior' };
const COLUNAS = [
  { titulo: 'Recebida em', tipo: 'data', valor: (n) => n.recebida_em },
  { titulo: 'Emissão', tipo: 'data', valor: (n) => n.emissao },
  { titulo: 'Documento', valor: (n) => n.documento }, { titulo: 'Número', valor: (n) => n.numero },
  { titulo: 'Série', valor: (n) => n.serie }, { titulo: 'Chave de acesso', valor: (n) => n.chave },
  { titulo: 'Fornecedor', valor: (n) => n.fornecedor }, { titulo: 'CNPJ fornecedor', valor: (n) => n.cnpj_fornecedor },
  { titulo: 'Empresa destinatária', valor: (n) => n.empresa }, { titulo: 'Emp/Fil', valor: (n) => n.empfil },
  { titulo: 'Tomador', valor: (n) => n.tomador_nome }, { titulo: 'CNPJ tomador', valor: (n) => n.tomador_cnpj },
  { titulo: 'Valor', tipo: 'moeda', valor: (n) => n.valor }, { titulo: 'Tipo de nota', valor: (n) => n.tipo_nota },
  { titulo: 'Prioridade', valor: (n) => PRIORIDADES[n.prioridade] },
  { titulo: 'Data prevista', tipo: 'data', valor: (n) => n.data_prevista },
  { titulo: 'Responsável da programação', valor: (n) => n.responsavel_email },
  { titulo: 'Observação da programação', valor: (n) => n.observacao },
  { titulo: 'Prazo original', tipo: 'data', valor: (n) => n.data_original },
  { titulo: 'Motivo de não ter sido lançada', valor: (n) => n.motivo_rotulo || '' },
  { titulo: 'Detalhe do motivo', valor: (n) => n.motivo_bloqueio || '' },
  { titulo: 'Status da carteira', valor: (n) => STATUS[n.status] },
  { titulo: 'Motivo do bloqueio', valor: (n) => n.motivo_bloqueio },
  { titulo: 'Lançada em', tipo: 'data', valor: (n) => n.lancada_em },
];

export default function Carteira() {
  const { usuario, pode } = useAuth();
  const editar = pode('carteira_gerir');
  const operar = pode('carteira_operar');
  const somenteAndamento = usuario.perfil === 'membro';
  const avisar = useToast();
  const [f, setF] = useState({ dia: hoje(), visao: 'hoje', minha: '', empresa: '', empfil: '', tomador: '', emissao_de: '', emissao_ate: '', motivo: '', tipo_nota: '', responsavel: '', prioridade: '', status: '', busca: '' });
  const [configurando, setConfigurando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [verImportacoes, setVerImportacoes] = useState(false);
  const [nota, setNota] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [ordem, setOrdem] = useState(null);
  useEffect(() => {
    if (!editar) { setConfigurando(false); setImportando(false); setVerImportacoes(false); }
  }, [editar]);
  const cfg = useDados(() => api.get('/carteira/configuracao'));
  const painel = useDados(() => api.get(`/carteira${qs(f)}`), [JSON.stringify(f)]);
  useEffect(() => { setPagina(1); }, [JSON.stringify(f)]);
  // O dia acompanha a virada da data enquanto a gestão à vista fica aberta.
  useEffect(() => {
    let anterior = hoje();
    const h = setInterval(() => { const atual = hoje(); if (atual !== anterior) { setF((v) => ({ ...v, dia: v.dia === anterior ? atual : v.dia })); anterior = atual; } }, 30000);
    return () => clearInterval(h);
  }, []);
  const set = (campo, valor) => setF((v) => ({ ...v, [campo]: valor }));
  const setEmpresa = (empresa) => setF((v) => ({
    ...v, empresa,
    empfil: empresa && String(v.empfil).split('/')[0] !== empresa ? '' : v.empfil,
  }));
  const conferir = async () => {
    setOcupado(true);
    try {
      const r = await api.post('/carteira/conferir');
      avisar(`${numero(r.conferidas)} conferidas · ${numero(r.concluidas)} confirmadas · ${numero(r.reabertas)} reabertas${r.ambiguas ? ` · ${r.ambiguas} exigem conferência por terem mais de uma entrada` : ''}`, 'ok');
      painel.recarregar();
    } catch (e) { avisar(e.message, 'erro'); } finally { setOcupado(false); }
  };
  const verHistorico = async (n) => {
    try { const r = await api.get(`/carteira/${n.id}/historico`); setHistorico({ nota: n, itens: r.itens }); }
    catch (e) { avisar(e.message, 'erro'); }
  };
  const d = painel.dados;
  const k = d?.indicadores;
  const itens = useMemo(() => {
    const notas = d?.itens ?? [];
    if (!ordem) return notas;
    const { valor } = ORDENACOES[ordem.campo];
    return [...notas].sort((a, b) => {
      const va = valor(a), vb = valor(b);
      const vazioA = va == null || va === '', vazioB = vb == null || vb === '';
      if (vazioA || vazioB) return Number(vazioA) - Number(vazioB);
      const comparacao = typeof va === 'number' && typeof vb === 'number' ? va - vb : COMPARAR_TEXTO.compare(String(va), String(vb));
      return ordem.dir === 'asc' ? comparacao : -comparacao;
    });
  }, [d?.itens, ordem]);
  const ordenar = (campo) => {
    setOrdem((anterior) => ({ campo, dir: anterior?.campo === campo && anterior.dir === 'asc' ? 'desc' : 'asc' }));
    setPagina(1);
  };
  const ariaOrdem = (campos) => campos.includes(ordem?.campo) ? (ordem.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const cabecalho = (campo, titulo = ORDENACOES[campo].rotulo) => <BotaoOrdenar campo={campo} titulo={titulo} ordem={ordem} onOrdenar={ordenar} />;
  const opcoes = d?.filtros ?? {};
  const filiais = (opcoes.filiais ?? (d?.filiais ?? []).map((p) => ({
    chave: p.empfil, rotulo: `${p.empfil} ${p.empresa ?? ''}`, empresa: String(p.empfil).split('/')[0],
  }))).filter((p) => !f.empresa || String(p.empresa) === f.empresa);
  const paginas = Math.max(1, Math.ceil(itens.length / 100));
  const paginaAtual = Math.min(pagina, paginas);
  return <>
    <Cartao titulo="Programação de lançamentos" sub="Carteira permanente · prioridades, prazos e responsáveis por filial">
      <div className="linha" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <Campo rotulo="Dia"><input type="date" value={f.dia} onChange={(e) => set('dia', e.target.value || hoje())} /></Campo>
        <Campo rotulo="Visão"><select value={f.visao} onChange={(e) => set('visao', e.target.value)}>
          <option value="hoje">Dia e atrasadas</option><option value="carteira">Carteira em aberto</option>
          <option value="historico">Lançadas</option><option value="todas">Todas da carteira</option>
        </select></Campo>
        <button className={`btn pequeno ${f.minha ? '' : 'ghost'}`} onClick={() => setF((v) => ({ ...v, minha: v.minha ? '' : '1', responsavel: '' }))}>Minha fila</button>
        <button className="btn pequeno ghost" onClick={() => painel.recarregar()}>Atualizar</button>
        <span className="espaco" />
        {editar && <>
          <button className="btn pequeno" onClick={() => setImportando(true)}>Importar programação</button>
          <button className="btn pequeno ghost" onClick={() => setVerImportacoes((v) => !v)}>Importações</button>
          <button className="btn pequeno ghost" onClick={() => setConfigurando((v) => !v)}>Responsáveis por filial</button>
          <button className="btn pequeno ghost" disabled={ocupado || !d?.senior_configurado} onClick={conferir}>{ocupado ? 'Conferindo…' : 'Conferir no Senior'}</button>
        </>}
      </div>
      <p className="muted pequeno" style={{ marginBottom: 0 }}>
        {d?.senior_configurado ? 'Use o botão Conferir no Senior para atualizar a confirmação das entradas fechadas.' : 'A carteira funciona sem conexão. A confirmação dos lançamentos depende da integração com o Senior.'}
        {' '}Última conferência: {d?.ultima_conferencia ? new Date(d.ultima_conferencia).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'ainda não realizada'}.
      </p>
    </Cartao>
    {editar && configurando && cfg.dados && <Responsaveis cfg={cfg} avisar={avisar} />}
    {editar && verImportacoes && <Importacoes avisar={avisar} onExcluir={() => painel.recarregar()} />}
    <Erro erro={painel.erro ?? cfg.erro} />
    {painel.carregando && !d && <Carregando />}
    {k && <>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))' }}>
        <Kpi rotulo="Programadas no dia" valor={numero(k.programadas)} detalhe={data(f.dia)} />
        <Kpi rotulo="Concluídas do plano" valor={numero(k.concluidas_plano)} cor="var(--status-bom)" detalhe="Confirmadas no Senior" />
        <Kpi rotulo="Restantes do plano" valor={numero(k.restantes)} cor="var(--status-atencao)" />
        <Kpi rotulo="Atrasadas" valor={numero(k.atrasadas)} cor="var(--status-critico)" detalhe="Prazo já vencido (anterior a hoje)" />
        <Kpi rotulo="Bloqueadas" valor={numero(k.bloqueadas)} detalhe="Já vencidas ou previstas até o dia" />
        <Kpi rotulo="Sem responsável" valor={numero(k.sem_responsavel)} onClick={() => setF((v) => ({ ...v, minha: '', responsavel: 'sem', visao: 'carteira' }))} />
      </div>
      <p className="muted pequeno">Lançadas no dia entre as notas da carteira: <strong>{numero(k.lancadas_dia)}</strong>.{!somenteAndamento && ' A produção total, incluindo notas fora do plano, continua em “Lançamentos” e “Dashboard”.'}</p>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <Resumo titulo="Por pessoa" linhas={d.por_pessoa} onEscolher={(p) => setF((v) => ({ ...v, minha: '', responsavel: String(p.chave) }))} />
        <Resumo titulo="Por filial" linhas={d.por_filial} onEscolher={(p) => set('empfil', p.chave)} />
      </div>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <PorMotivo motivos={d.por_motivo} ativo={f.motivo} aoEscolher={(c) => set('motivo', f.motivo === c ? '' : c)} />
        <AgingPorMotivo motivos={d.por_motivo} faixas={d.faixas_idade} />
      </div>
    </>}
    <Cartao titulo="Notas da carteira" sub={`${numero(itens.length)} nota(s) · ${ordem ? `ordem por ${ORDENACOES[ordem.campo].rotulo.toLocaleLowerCase('pt-BR')} · ${ordem.dir === 'asc' ? 'crescente' : 'decrescente'}` : 'atrasadas primeiro, depois prioridade e prazo'}`}
      acoes={<div className="linha" style={{ gap: 8, flexWrap: 'wrap' }}>
        {ordem && <button className="btn pequeno ghost" onClick={() => { setOrdem(null); setPagina(1); }}>Ordem padrão</button>}
        <BotaoExportar titulo="Programação de lançamentos" colunas={COLUNAS} linhas={itens} rotulo="Exportar programação" />
      </div>}>
      <div className="filtros" style={{ marginBottom: 12 }}>
        <Campo rotulo="Empresa"><select aria-label="Filtrar empresa da carteira" value={f.empresa} onChange={(e) => setEmpresa(e.target.value)}>
          <option value="">Todas as empresas</option>{(opcoes.empresas ?? []).map((p) => <option key={p.chave} value={p.chave}>{p.rotulo}</option>)}
        </select></Campo>
        <Campo rotulo="Filial"><select aria-label="Filtrar filial da carteira" value={f.empfil} onChange={(e) => set('empfil', e.target.value)}>
          <option value="">Todas as filiais</option>{filiais.map((p) => <option key={p.chave} value={p.chave}>{p.rotulo}</option>)}
        </select></Campo>
        <Campo rotulo="Tomador"><select aria-label="Filtrar tomador da nota" value={f.tomador} onChange={(e) => set('tomador', e.target.value)}>
          <option value="">Todos os tomadores</option>{(opcoes.tomadores ?? []).map((p) => <option key={p.chave} value={p.chave}>{p.rotulo}{p.cnpj ? ` · ${cnpj(p.cnpj)}` : ''}</option>)}
        </select></Campo>
        <Campo rotulo="Tipo de nota"><select aria-label="Filtrar tipo de nota da carteira" value={f.tipo_nota} onChange={(e) => set('tipo_nota', e.target.value)}>
          <option value="">Todos os tipos</option>{(opcoes.tipos_nota ?? []).map((p) => <option key={p.chave} value={p.chave}>{p.rotulo}</option>)}
        </select></Campo>
        <Campo rotulo="Responsável"><select aria-label="Filtrar responsável" value={f.minha ? 'minha' : f.responsavel} onChange={(e) => setF((v) => ({ ...v, minha: e.target.value === 'minha' ? '1' : '', responsavel: e.target.value === 'minha' ? '' : e.target.value }))}>
          <option value="">Todos</option><option value="minha">Minha fila</option><option value="sem">Sem responsável</option>
          {(cfg.dados?.pessoas ?? []).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select></Campo>
        <Campo rotulo="Prioridade"><select aria-label="Filtrar prioridade da nota" value={f.prioridade} onChange={(e) => set('prioridade', e.target.value)}>
          <option value="">Todas as prioridades</option>{Object.entries(PRIORIDADES).map(([v, rotulo]) => <option key={v} value={v}>{rotulo}</option>)}
        </select></Campo>
        <Campo rotulo="Status"><select aria-label="Filtrar status" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Todos</option>{Object.entries(STATUS).map(([v, rotulo]) => <option key={v} value={v}>{rotulo}</option>)}
        </select></Campo>
        <Campo rotulo="Emissão de"><input type="date" aria-label="Emissão a partir de" value={f.emissao_de} onChange={(e) => set('emissao_de', e.target.value)} /></Campo>
        <Campo rotulo="Emissão até"><input type="date" aria-label="Emissão até" value={f.emissao_ate} onChange={(e) => set('emissao_ate', e.target.value)} /></Campo>
        <Campo rotulo="Buscar"><input aria-label="Buscar nota, fornecedor ou chave" placeholder="Nota, fornecedor ou chave…" value={f.busca} onChange={(e) => set('busca', e.target.value)} /></Campo>
        <button className="btn pequeno ghost" onClick={() => setF({ dia: hoje(), visao: 'hoje', minha: '', empresa: '', empfil: '', tomador: '', emissao_de: '', emissao_ate: '', motivo: '', tipo_nota: '', responsavel: '', prioridade: '', status: '', busca: '', emissao_de: '', emissao_ate: '', motivo: '' })}>Limpar filtros</button>
      </div>
      <div className="tabela-wrap"><table className="tabela">
        <thead><tr>
          <th aria-sort={ariaOrdem(['prioridade'])}>{cabecalho('prioridade')}</th>
          <th aria-sort={ariaOrdem(['prazo'])}>{cabecalho('prazo')}</th>
          <th aria-sort={ariaOrdem(['emissao'])}>{cabecalho('emissao')}</th>
          <th aria-sort={ariaOrdem(['numero', 'fornecedor'])}>{cabecalho('numero', 'Nota')} / {cabecalho('fornecedor')}</th>
          <th aria-sort={ariaOrdem(['filial'])}>{cabecalho('filial')}</th>
          <th aria-sort={ariaOrdem(['tomador'])}>{cabecalho('tomador')}</th>
          <th aria-sort={ariaOrdem(['pdf_nota'])}>{cabecalho('pdf_nota')}</th>
          <th aria-sort={ariaOrdem(['boleto'])}>{cabecalho('boleto')}</th>
          <th aria-sort={ariaOrdem(['responsavel'])}>{cabecalho('responsavel')}</th>
          <th aria-sort={ariaOrdem(['status'])}>{cabecalho('status')}</th>
          <th className="num" aria-sort={ariaOrdem(['valor'])}>{cabecalho('valor')}</th>
          <th>Ações</th>
        </tr></thead>
        <tbody>{itens.slice((paginaAtual - 1) * 100, paginaAtual * 100).map((n) => <tr key={n.id}>
          <td><span className={`badge ${n.prioridade === 1 ? 'sev-erro' : n.prioridade === 2 ? 'sev-alerta' : 'sev-na'}`}>{PRIORIDADES[n.prioridade]}</span></td>
          <td className="nowrap"><strong style={{ color: n.status !== 'lancada' && n.data_prevista < f.dia ? 'var(--status-critico)' : undefined }}>{data(n.data_prevista)}</strong>
            {n.status !== 'lancada' && n.data_prevista < f.dia && <div className="pequeno">Atrasada</div>}
            {n.data_original !== n.data_prevista && <div className="muted pequeno">Original: {data(n.data_original)}</div>}</td>
          <td className="nowrap">{n.emissao ? data(n.emissao) : <span className="muted">—</span>}</td>
          <td><strong>{n.documento} {n.numero}</strong><div>{n.fornecedor || 'Fornecedor não informado'}</div>
            {n.observacao && <div className="muted pequeno">{n.observacao}</div>}</td>
          <td><code>{n.empfil}</code><div className="muted pequeno">{n.empresa}</div></td>
          <td><div>{n.tomador_nome || n.empresa || 'Não informado'}</div><div className="muted pequeno nowrap">{n.tomador_cnpj ? cnpj(n.tomador_cnpj) : 'CNPJ não informado'}</div></td>
          <td><ArquivosNota nota={n} arquivos={n.pdfs_nota} rotulo="PDF" avisar={avisar} /></td>
          <td><ArquivosNota nota={n} arquivos={n.pdfs_boleto} rotulo="Boleto" avisar={avisar} /></td>
          <td>{n.responsavel || <span className="badge sev-alerta">Sem responsável</span>}</td>
          <td><span className={`badge ${n.status === 'lancada' ? 'sev-ok' : n.status === 'bloqueada' ? 'sev-erro' : 'sev-conferencia'}`}>{STATUS[n.status]}</span>
            {n.motivo && <div className="pequeno">{(cfg.dados?.motivos ?? {})[n.motivo] ?? n.motivo}</div>}
            {n.motivo_bloqueio && <div className="muted pequeno truncar" style={{ maxWidth: 220 }}>{n.motivo_bloqueio}</div>}
            {n.lancada_em && <div className="muted pequeno">{data(n.lancada_em)}</div>}</td>
          <td className="num">{brl(n.valor)}</td>
          <td><div className="linha" style={{ gap: 4 }}>
            {(editar || operar) && n.status !== 'lancada' && <button className="btn pequeno" onClick={() => setNota(n)}>{somenteAndamento ? 'Atualizar andamento' : 'Atualizar nota'}</button>}
            <button className="btn pequeno ghost" onClick={() => verHistorico(n)}>Histórico</button>
          </div></td>
        </tr>)}
          {!itens.length && <tr><td colSpan={11} className="muted" style={{ padding: 24 }}>Nenhuma nota nesta visão. Importe a programação ou ajuste os filtros.</td></tr>}
        </tbody>
      </table></div>
      {paginas > 1 && <div className="linha" style={{ gap: 10, marginTop: 12 }}>
        <button className="btn pequeno ghost" disabled={paginaAtual <= 1} onClick={() => setPagina(paginaAtual - 1)}>Anterior</button>
        <span>{paginaAtual} de {paginas}</span>
        <button className="btn pequeno ghost" disabled={paginaAtual >= paginas} onClick={() => setPagina(paginaAtual + 1)}>Próxima</button>
      </div>}
    </Cartao>
    {editar && importando && <Importacao dia={f.dia} onFechar={() => setImportando(false)} onConcluir={() => { setImportando(false); setVerImportacoes(true); painel.recarregar(); }} avisar={avisar} />}
    {nota && (editar || operar) && <EditarNota key={`${nota.id}-${somenteAndamento}`} somenteAndamento={somenteAndamento} nota={nota} pessoas={cfg.dados?.pessoas ?? []} motivos={cfg.dados?.motivos ?? {}} onFechar={() => setNota(null)} onConcluir={() => { setNota(null); painel.recarregar(); }} avisar={avisar} />}
    {historico && <Modal titulo={`Histórico · ${historico.nota.documento} ${historico.nota.numero}`} onFechar={() => setHistorico(null)} largo>
      <p>Prazo original: <strong>{data(historico.nota.data_original)}</strong></p>
      {historico.itens.map((h) => <div key={h.id} style={{ borderBottom: '1px solid var(--grade)', padding: '12px 0' }}>
        <strong>{ACOES[h.acao] || h.acao}</strong>
        <div className="muted pequeno">{new Date(h.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {h.usuario || 'Conferência automática'}</div>
        <div>Prazo: {h.antes ? `${data(h.antes.data_prevista)} → ` : ''}{data(h.depois.data_prevista)} · Prioridade: {PRIORIDADES[h.depois.prioridade]} · {STATUS[h.depois.status]}</div>
        <div className="pequeno">Responsável: {h.depois.responsavel_id ? (cfg.dados?.pessoas.find((p) => p.id === h.depois.responsavel_id)?.nome ?? `Usuário ${h.depois.responsavel_id}`) : 'Sem responsável'}</div>
        {h.depois.observacao && <p className="pequeno">{h.depois.observacao}</p>}
        {h.depois.motivo_bloqueio && <p className="pequeno">Bloqueio: {h.depois.motivo_bloqueio}</p>}
      </div>)}
    </Modal>}
  </>;
}

function BotaoOrdenar({ campo, titulo, ordem, onOrdenar }) {
  const ativa = ordem?.campo === campo;
  const proxima = ativa && ordem.dir === 'asc' ? 'decrescente' : 'crescente';
  const dica = ['pdf_nota', 'boleto'].includes(campo) ? ' pela quantidade de arquivos localizados' : '';
  const descricao = `Ordenar por ${ORDENACOES[campo].rotulo.toLocaleLowerCase('pt-BR')}${dica}, em ordem ${proxima}`;
  return <button type="button" className="ordenar-coluna" data-ativo={ativa} onClick={() => onOrdenar(campo)} title={descricao} aria-label={descricao}>
    {titulo}<span aria-hidden="true">{ativa ? (ordem.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
  </button>;
}

function ArquivosNota({ nota, arquivos = [], rotulo, avisar }) {
  const abrir = async (a) => {
    try { await baixar(`/anexos/${a.id}/arquivo`, a.nome, true); }
    catch (e) { avisar(e.message, 'erro'); }
  };
  if (!arquivos.length) return <span className="muted pequeno" title={nota.vinculo_documento === 'ambiguo'
    ? 'Mais de uma nota corresponde aos dados da planilha; confira em Todas as notas.'
    : nota.vinculo_documento === 'sem_tomador' ? 'Inclua o CNPJ tomador na planilha para localizar esta nota sem chave de acesso.'
      : nota.documento_id ? 'A nota foi localizada em Todas as notas, mas este PDF ainda não está vinculado a ela.' : 'Nota ainda não localizada em Todas as notas.'}>Não localizado</span>;
  return <div className="linha" style={{ gap: 4, flexWrap: 'wrap' }}>{arquivos.map((a, i) =>
    <button key={a.id} className="btn pequeno" title={`Abrir ${a.nome}`} onClick={() => abrir(a)}>{rotulo}{arquivos.length > 1 ? ` ${i + 1}` : ''}</button>)}</div>;
}

function Importacoes({ avisar, onExcluir }) {
  const dados = useDados(() => api.get('/carteira/importacoes'));
  const [exclusao, setExclusao] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [falha, setFalha] = useState(null);
  const revisar = async (id) => {
    setOcupado(true); setFalha(null);
    try { setExclusao(await api.get(`/carteira/importacoes/${id}/exclusao`)); }
    catch (e) { setFalha(e); } finally { setOcupado(false); }
  };
  const excluir = async () => {
    setOcupado(true); setFalha(null);
    try {
      const r = await api.del(`/carteira/importacoes/${exclusao.id}${qs({ versao: exclusao.versao })}`);
      avisar(`Importação excluída: ${r.removidas} nota(s) retiradas da carteira; ${r.preservadas} preservadas em outras importações`, 'ok');
      setExclusao(null); dados.recarregar(); onExcluir();
    } catch (e) { setFalha(e); } finally { setOcupado(false); }
  };
  return <Cartao titulo="Importações da carteira" sub="Exclua os arquivos de teste por aqui; as notas compartilhadas com outras importações continuam na carteira">
    <Erro erro={dados.erro ?? falha} />
    {dados.carregando && !dados.dados && <Carregando />}
    <div className="tabela-wrap"><table className="tabela"><thead><tr><th>Arquivo</th><th>Importado em</th><th>Por</th><th>Notas</th><th>Ações</th></tr></thead><tbody>
      {(dados.dados?.itens ?? []).map((i) => <tr key={i.id}>
        <td>{i.arquivo}</td><td>{new Date(i.confirmada_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td><td>{i.usuario}</td>
        <td>{numero(i.resumo.novas + i.resumo.atualizadas + i.resumo.sem_alteracao + i.resumo.concluidas)}</td>
        <td><button className="btn pequeno ghost" disabled={ocupado} onClick={() => revisar(i.id)}>Excluir importação</button></td>
      </tr>)}
      {dados.dados && !dados.dados.itens.length && <tr><td colSpan={5} className="muted">Nenhuma importação ativa.</td></tr>}
    </tbody></table></div>
    {exclusao && <Modal titulo="Excluir importação" onFechar={ocupado ? undefined : () => setExclusao(null)}>
      <p>Arquivo: <strong>{exclusao.arquivo}</strong></p>
      <p><strong>{exclusao.removidas}</strong> nota(s) exclusivas deste arquivo sairão da carteira.</p>
      <p><strong>{exclusao.preservadas}</strong> nota(s) presentes em outras importações continuarão na carteira com a programação atual.</p>
      <p className="muted pequeno">Os documentos e PDFs de Todas as notas, os lançamentos no Senior e os responsáveis por filial são preservados. Você pode importar a planilha novamente para repetir o teste.</p>
      <Erro erro={falha} />
      <div className="linha" style={{ gap: 8 }}><button className="btn" disabled={ocupado} onClick={excluir}>{ocupado ? 'Excluindo…' : 'Confirmar exclusão'}</button>
        <button className="btn ghost" disabled={ocupado} onClick={() => setExclusao(null)}>Cancelar</button></div>
    </Modal>}
  </Cartao>;
}

// Cores das faixas de espera, do mais novo para o mais velho
const COR_FAIXA = ['var(--status-bom)', 'var(--serie-1)', 'var(--status-atencao)', 'var(--status-critico)'];

/** Por que as notas em aberto estão paradas. Clicar filtra a lista. */
function PorMotivo({ motivos, ativo, aoEscolher }) {
  const total = motivos.reduce((s, m) => s + m.qtd, 0);
  const maior = Math.max(...motivos.map((m) => m.qtd), 1);
  const semMotivo = motivos.find((m) => m.chave === 'sem_motivo');
  return (
    <Cartao titulo="Por que estão paradas" sub={total ? `${numero(total)} nota(s) em aberto · clique para filtrar` : 'Nenhuma nota em aberto'}>
      {semMotivo && semMotivo.qtd === total && (
        <div className="aviso pequeno" style={{ marginBottom: 10 }}>
          Nenhuma nota tem motivo registrado ainda. O motivo é escolhido em <strong>Atualizar andamento</strong>,
          na própria nota. Enquanto estiver vazio, não dá para atacar a causa.
        </div>
      )}
      {motivos.map((m) => (
        <button key={m.chave} className="btn ghost" onClick={() => aoEscolher(m.chave)}
          style={{ width: '100%', textAlign: 'left', display: 'block', marginBottom: 2, padding: '6px 8px', opacity: !ativo || ativo === m.chave ? 1 : 0.45 }}>
          <div className="linha entre" style={{ gap: 8 }}>
            <span className="truncar" style={{ fontWeight: m.chave === 'sem_motivo' ? 400 : 600 }}>{m.rotulo}</span>
            <span className="nowrap"><strong>{numero(m.qtd)}</strong> <span className="muted pequeno">{brl(m.valor)}</span></span>
          </div>
          <div className="barra-progresso" style={{ marginTop: 4 }}>
            <div style={{ width: `${(m.qtd / maior) * 100}%`, background: m.chave === 'sem_motivo' ? 'var(--texto-3)' : 'var(--serie-1)' }} />
          </div>
        </button>
      ))}
      {!motivos.length && <span className="muted pequeno">Nada em aberto.</span>}
    </Cartao>
  );
}

/** Há quanto tempo cada motivo está segurando a nota, contado do recebimento. */
function AgingPorMotivo({ motivos, faixas }) {
  const linhas = motivos.filter((m) => m.qtd > 0);
  return (
    <Cartao titulo="Há quanto tempo estão paradas" sub="por motivo · tempo desde o recebimento da nota">
      <div className="linha pequeno" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {faixas.map((f, i) => (
          <span key={f.id} className="linha" style={{ gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: COR_FAIXA[i] }} />{f.rotulo}
          </span>
        ))}
      </div>
      {linhas.map((m) => (
        <div key={m.chave} style={{ marginBottom: 10 }}>
          <div className="linha entre pequeno">
            <span className="truncar">{m.rotulo}</span>
            <span className="nowrap muted">média {numero(m.idade_media ?? 0, 1)}d · mais antiga <strong>{numero(m.mais_antiga ?? 0)}d</strong></span>
          </div>
          <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', marginTop: 3, background: 'var(--superficie-3)' }}>
            {faixas.map((f, i) => {
              const q = m.faixas?.[f.id] ?? 0;
              if (!q) return null;
              return <div key={f.id} title={`${f.rotulo}: ${numero(q)} nota(s)`}
                style={{ width: `${(q / m.qtd) * 100}%`, background: COR_FAIXA[i] }} />;
            })}
          </div>
        </div>
      ))}
      {!linhas.length && <span className="muted pequeno">Nada em aberto.</span>}
    </Cartao>
  );
}

/**
 * Resumo por filial ou por pessoa.
 *
 * A barra representa o TAMANHO da carga (proporcional à maior do quadro), com a parte lançada
 * preenchida por dentro. Antes ela mostrava só o percentual concluído: no começo do dia ficava
 * tudo vazio e não dava para ver quem tinha 2 notas e quem tinha 27.
 */
function Resumo({ titulo, linhas, onEscolher }) {
  const maior = Math.max(...linhas.map((p) => p.total ?? 0), 1);
  // Quem tem atraso ou bloqueio primeiro; depois a carga maior
  const ordenadas = [...linhas].sort((a, b) => (b.atrasadas + b.bloqueadas) - (a.atrasadas + a.bloqueadas)
    || (b.total - b.lancadas) - (a.total - a.lancadas) || b.total - a.total);
  const totais = linhas.reduce((t, p) => ({
    total: t.total + p.total, lancadas: t.lancadas + p.lancadas,
    atrasadas: t.atrasadas + p.atrasadas, bloqueadas: t.bloqueadas + p.bloqueadas,
  }), { total: 0, lancadas: 0, atrasadas: 0, bloqueadas: 0 });

  return <Cartao titulo={titulo}
    sub={linhas.length ? `${numero(totais.lancadas)} de ${numero(totais.total)} lançadas · plano do dia e pendências anteriores` : 'Plano do dia e pendências anteriores'}>
    <div style={{ maxHeight: 260, overflow: 'auto' }}>
      {!linhas.length && <span className="muted pequeno">Nenhuma nota para o dia.</span>}
      {ordenadas.map((p) => {
        const falta = p.total - p.lancadas;
        const pct = p.total ? Math.round((p.lancadas / p.total) * 100) : 0;
        const alerta = p.atrasadas || p.bloqueadas;
        return (
          <button key={p.chave} className="btn ghost" onClick={() => onEscolher(p)}
            style={{ width: '100%', textAlign: 'left', display: 'block', marginBottom: 2, padding: '6px 8px' }}>
            <div className="linha entre" style={{ gap: 8 }}>
              <strong className="truncar">{p.rotulo}</strong>
              <span className="nowrap">
                <strong style={{ color: pct === 100 ? 'var(--status-bom)' : undefined }}>{numero(p.lancadas)}</strong>
                <span className="muted">/{numero(p.total)}</span>
                {falta > 0 && <span className="muted pequeno"> · faltam {numero(falta)}</span>}
              </span>
            </div>
            {/* a largura externa mostra o peso da filial; o preenchimento, o que já saiu */}
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: `${Math.max(4, (p.total / maior) * 100)}%`, height: 12, borderRadius: 3, background: 'var(--superficie-3)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--status-bom)' : 'var(--serie-1)' }} />
              </div>
              {pct > 0 && <span className="muted pequeno">{pct}%</span>}
            </div>
            {Boolean(alerta) && (
              <div className="linha pequeno" style={{ gap: 6, marginTop: 3 }}>
                {p.atrasadas > 0 && <span className="badge sev-erro">{numero(p.atrasadas)} atrasada(s)</span>}
                {p.bloqueadas > 0 && <span className="badge sev-alerta">{numero(p.bloqueadas)} bloqueada(s)</span>}
              </div>
            )}
          </button>
        );
      })}
    </div>
  </Cartao>;
}

function Responsaveis({ cfg, avisar }) {
  const [filial, setFilial] = useState('');
  const [pessoa, setPessoa] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const salvar = async (empfil, usuario_id) => {
    setOcupado(true);
    try { await api.put('/carteira/filial', { empfil, usuario_id }); cfg.recarregar(); setFilial(''); setPessoa(''); avisar('Responsável por filial atualizado', 'ok'); }
    catch (e) { avisar(e.message, 'erro'); } finally { setOcupado(false); }
  };
  return <Cartao titulo="Responsáveis por empresa/filial" sub="Aplicados na importação às notas novas ou sem responsável; notas já atribuídas preservam a pessoa definida">
    <div className="linha" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      <input aria-label="Empresa e filial" placeholder="Emp/Fil, ex.: 1/2" value={filial} onChange={(e) => setFilial(e.target.value)} />
      <select aria-label="Responsável da filial" value={pessoa} onChange={(e) => setPessoa(e.target.value)}><option value="">Escolha o responsável</option>
        {cfg.dados.pessoas.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.email})</option>)}</select>
      <button className="btn pequeno" disabled={!filial || !pessoa || ocupado} onClick={() => salvar(filial, Number(pessoa))}>Gravar responsável</button>
    </div>
    <div className="tabela-wrap"><table className="tabela"><thead><tr><th>Emp/Fil</th><th>Responsável</th><th /></tr></thead><tbody>
      {cfg.dados.filiais.map((f) => <tr key={f.empfil}><td>{f.empfil}</td><td>{f.nome} <span className="muted pequeno">{f.email}</span></td>
        <td><button className="btn pequeno ghost" disabled={ocupado} onClick={() => salvar(f.empfil, null)}>Remover vínculo</button></td></tr>)}
      {!cfg.dados.filiais.length && <tr><td colSpan={3} className="muted">Cadastre quem atende cada filial antes de importar.</td></tr>}
    </tbody></table></div>
  </Cartao>;
}

function Importacao({ dia, onFechar, onConcluir, avisar }) {
  const [arquivo, setArquivo] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [falha, setFalha] = useState(null);
  const enviar = async () => {
    setOcupado(true); setFalha(null);
    try {
      const form = new FormData(); form.append('arquivo', arquivo); form.append('dia', dia);
      setPrevia(await api.upload('/carteira/importar/previa', form));
    } catch (e) { setFalha(e); } finally { setOcupado(false); }
  };
  const confirmar = async () => {
    setOcupado(true); setFalha(null);
    try {
      const r = await api.post(`/carteira/importar/${previa.id}/confirmar`);
      avisar(`Programação importada: ${r.resumo.novas} novas e ${r.resumo.atualizadas} atualizadas`, 'ok'); onConcluir();
    } catch (e) { setFalha(e); } finally { setOcupado(false); }
  };
  return <Modal titulo="Importar programação do Excel" onFechar={ocupado ? undefined : onFechar} largo>
    <p>Use o arquivo <strong>.xlsx exportado de Pendentes de lançamentos</strong>. Preencha Prioridade (Urgente, Alta ou Normal), Data prevista e Observação da programação. Responsável da programação é opcional: use o e-mail do usuário para substituir o responsável da filial.</p>
    <p className="muted pequeno">Para novas notas sem data, será usado {data(dia)}. Campos de programação em branco preservam o que já está salvo. Notas concluídas ficam preservadas e notas ausentes do arquivo continuam na carteira.</p>
    <input type="file" accept=".xlsx" aria-label="Planilha da programação" disabled={ocupado} onChange={(e) => { setArquivo(e.target.files?.[0] ?? null); setPrevia(null); setFalha(null); }} />
    <button className="btn pequeno" style={{ marginLeft: 8 }} disabled={!arquivo || ocupado} onClick={enviar}>{ocupado ? 'Processando…' : 'Conferir planilha'}</button>
    <Erro erro={falha} />
    {previa && <>
      <p><strong>{previa.resumo.novas}</strong> novas · <strong>{previa.resumo.atualizadas}</strong> atualizadas · {previa.resumo.sem_alteracao} sem alteração · {previa.resumo.concluidas} já concluídas.</p>
      {previa.resumo.sem_responsavel > 0 && <div className="aviso">{previa.resumo.sem_responsavel} nota(s) ficarão sem responsável. Você pode atribuir depois ou cadastrar o vínculo da filial e conferir o arquivo novamente.</div>}
      {previa.erros.length > 0 && <div className="aviso erro"><strong>Corrija os {previa.erros.length} erro(s) antes de importar.</strong>
        <div style={{ maxHeight: 180, overflow: 'auto' }}>{previa.erros.map((e) => <div key={e.linha}>Linha {e.linha}: {e.erro}</div>)}</div>
      </div>}
      <p className="muted pequeno">Prévia das primeiras {previa.amostra.length} notas válidas, de {previa.total} linhas.</p>
      <div className="tabela-wrap" style={{ maxHeight: 280 }}><table className="tabela"><thead><tr><th>Linha</th><th>Nota</th><th>Filial</th><th>Prioridade / Prazo</th><th>Responsável</th><th>Ação</th></tr></thead>
        <tbody>{previa.amostra.map((i) => <tr key={i.linha}><td>{i.linha}</td><td>{i.nota.documento} {i.nota.numero}</td><td>{i.nota.empfil}</td>
          <td>{PRIORIDADES[i.nota.prioridade]} · {data(i.nota.data_prevista)}</td><td>{i.responsavel || 'Sem responsável'}</td>
          <td>{{ nova: 'Incluir', atualizada: 'Atualizar', concluida: 'Preservar concluída', sem_alteracao: 'Sem alteração' }[i.acao]}</td></tr>)}</tbody>
      </table></div>
      <div className="linha" style={{ gap: 8, marginTop: 16 }}>
        <button className="btn" disabled={ocupado || previa.resumo.erros > 0} onClick={confirmar}>Confirmar importação</button>
        <button className="btn ghost" disabled={ocupado} onClick={onFechar}>Cancelar</button>
      </div>
    </>}
  </Modal>;
}

function EditarNota({ nota, pessoas, motivos = {}, onFechar, onConcluir, avisar, somenteAndamento = false }) {
  const [f, setF] = useState({ ...(somenteAndamento ? {} : { prioridade: nota.prioridade, data_prevista: nota.data_prevista, responsavel_id: nota.responsavel_id || '', observacao: nota.observacao }),
    status: nota.status, motivo: nota.motivo || '', motivo_bloqueio: nota.motivo_bloqueio, versao: nota.atualizado_em });
  const [ocupado, setOcupado] = useState(false);
  const [falha, setFalha] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const salvar = async (e) => {
    e.preventDefault(); setOcupado(true); setFalha(null);
    try { await api.put(`/carteira/${nota.id}`, f); avisar('Nota atualizada', 'ok'); onConcluir(); }
    catch (e) { setFalha(e); } finally { setOcupado(false); }
  };
  return <Modal titulo={`${nota.documento} ${nota.numero} · ${nota.fornecedor || ''}`} onFechar={ocupado ? undefined : onFechar}>
    <form onSubmit={salvar}>
      <p className="muted pequeno">Filial {nota.empfil} · Prazo original: {data(nota.data_original)}. Cada alteração fica registrada no histórico.</p>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {!somenteAndamento && <><Campo rotulo="Prioridade"><select value={f.prioridade} onChange={(e) => set('prioridade', Number(e.target.value))}>{Object.entries(PRIORIDADES).map(([v, nome]) => <option key={v} value={v}>{nome}</option>)}</select></Campo>
        <Campo rotulo="Data prevista"><input type="date" required value={f.data_prevista} onChange={(e) => set('data_prevista', e.target.value)} /></Campo>
        <Campo rotulo="Responsável"><select value={f.responsavel_id} onChange={(e) => set('responsavel_id', e.target.value)}><option value="">Sem responsável</option>
          {pessoas.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select></Campo></>}
        <Campo rotulo="Status"><select value={f.status} onChange={(e) => set('status', e.target.value)}>{Object.entries(STATUS).filter(([v]) => v !== 'lancada').map(([v, nome]) => <option key={v} value={v}>{nome}</option>)}</select></Campo>
      </div>
      {f.status !== 'lancada' && <>
        <Campo rotulo={f.status === 'bloqueada' ? 'Por que está bloqueada' : 'Por que ainda não foi lançada'}>
          <select required={f.status === 'bloqueada'} value={f.motivo} onChange={(e) => set('motivo', e.target.value)}>
            <option value="">{f.status === 'bloqueada' ? 'Escolha o motivo…' : 'Sem motivo registrado'}</option>
            {Object.entries(motivos).map(([v, rotulo]) => <option key={v} value={v}>{rotulo}</option>)}
          </select>
        </Campo>
        {(f.status === 'bloqueada' || f.motivo) && <Campo rotulo="Detalhe (opcional)">
          <textarea maxLength={2000} placeholder="O que falta, com quem está, o que já foi tentado…"
            value={f.motivo_bloqueio} onChange={(e) => set('motivo_bloqueio', e.target.value)} />
        </Campo>}
      </>}
      {!somenteAndamento && <Campo rotulo="Observação da programação"><textarea maxLength={4000} value={f.observacao} onChange={(e) => set('observacao', e.target.value)} /></Campo>}
      <Erro erro={falha} />
      <div className="linha" style={{ gap: 8, marginTop: 16 }}><button className="btn" disabled={ocupado} type="submit">{ocupado ? 'Gravando…' : 'Salvar alteração'}</button>
        <button type="button" className="btn ghost" disabled={ocupado} onClick={onFechar}>Cancelar</button></div>
    </form>
  </Modal>;
}
