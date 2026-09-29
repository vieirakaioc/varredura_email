import { useState } from 'react';
import { api } from '../api.js';
import { Topo, useAuth } from '../contexto.jsx';
import { Campo, Cartao, Carregando, cnpj, Erro, Modal, Tabela, useDados, useToast } from '../ui.jsx';

const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ');
const REGIMES = { simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real' };
const PERFIS = { comercio: 'Comércio', industria: 'Indústria', servicos: 'Serviços', misto: 'Misto' };

function Formulario({ empresa, onFechar, onSalvo }) {
  const avisar = useToast();
  const [f, setF] = useState({
    razao_social: '', nome_fantasia: '', cnpj: '', ie: '', uf: 'GO', municipio: '', regime_tributario: 'real', perfil_fiscal: 'comercio', ...empresa,
    regras_especificas: empresa?.regras_especificas ? JSON.stringify(empresa.regras_especificas, null, 2) : '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const salvar = async () => {
    try {
      const r = empresa?.id ? await api.put(`/empresas/${empresa.id}`, f) : await api.post('/empresas', f);
      avisar(r.documentos_vinculados ? `Empresa salva. ${r.documentos_vinculados} documento(s) já recebido(s) foram vinculados.` : 'Empresa salva.');
      onSalvo();
    } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={empresa?.id ? 'Editar empresa' : 'Nova empresa do grupo'} onFechar={onFechar} largo rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      <div className="form-grade">
        <Campo rotulo="Razão social"><input value={f.razao_social} onChange={set('razao_social')} /></Campo>
        <Campo rotulo="Nome fantasia"><input value={f.nome_fantasia ?? ''} onChange={set('nome_fantasia')} /></Campo>
        <Campo rotulo="CNPJ (numérico ou alfanumérico)"><input value={f.cnpj} onChange={set('cnpj')} /></Campo>
        <Campo rotulo="Inscrição estadual"><input value={f.ie ?? ''} onChange={set('ie')} /></Campo>
        <Campo rotulo="UF"><select value={f.uf} onChange={set('uf')}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Campo>
        <Campo rotulo="Município"><input value={f.municipio ?? ''} onChange={set('municipio')} /></Campo>
        <Campo rotulo="Regime tributário"><select value={f.regime_tributario ?? ''} onChange={set('regime_tributario')}>{Object.entries(REGIMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        <Campo rotulo="Perfil fiscal"><select value={f.perfil_fiscal ?? ''} onChange={set('perfil_fiscal')}>{Object.entries(PERFIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
      </div>
      <Campo rotulo="Regras específicas (JSON, opcional)"><textarea className="mono" rows={5} value={f.regras_especificas} onChange={set('regras_especificas')} placeholder='{"observacao": "Regime especial TARE nº ..."}' /></Campo>
      <p className="muted pequeno" style={{ margin: 0 }}>As NFs são direcionadas automaticamente para a empresa cujo CNPJ é o do destinatário (ou tomador, no CT-e/NFS-e). Regras fiscais específicas podem ser vinculadas a uma empresa na tela de Regras.</p>
    </Modal>
  );
}

export default function Empresas() {
  const { pode } = useAuth();
  const { dados, erro, carregando, recarregar } = useDados(() => api.get('/empresas'), []);
  const [editar, setEditar] = useState(null);
  return (
    <>
      <Topo titulo="Empresas do grupo" descricao="Estabelecimentos destinatários das notas fiscais.">
        {pode('administrar') && <button className="btn primario" onClick={() => setEditar({})}>Nova empresa</button>}
      </Topo>
      <div className="pagina">
        <Erro erro={erro} />
        <Cartao semPadding>
          {carregando ? <Carregando /> : (
            <Tabela linhas={dados} onClique={pode('administrar') ? (l) => setEditar(l) : undefined} colunas={[
              { campo: 'razao_social', titulo: 'Empresa', render: (l) => <div><strong>{l.nome_fantasia || l.razao_social}</strong><div className="muted pequeno">{l.razao_social}</div></div> },
              { campo: 'cnpj', titulo: 'CNPJ', render: (l) => <span className="mono">{cnpj(l.cnpj)}</span> },
              { campo: 'ie', titulo: 'IE', render: (l) => <span className="mono">{l.ie ?? '—'}</span> },
              { campo: 'uf', titulo: 'UF / Município', render: (l) => `${l.uf} · ${l.municipio ?? ''}` },
              { campo: 'regime', titulo: 'Regime', render: (l) => REGIMES[l.regime_tributario] ?? '—' },
              { campo: 'perfil', titulo: 'Perfil fiscal', render: (l) => PERFIS[l.perfil_fiscal] ?? '—' },
              { campo: 'qtd_documentos', titulo: 'NFs', classe: 'num' },
              { campo: 'ativo', titulo: 'Situação', render: (l) => (l.ativo ? <span className="badge sev-ok">Ativa</span> : <span className="badge sev-na">Inativa</span>) },
            ]} vazio="Nenhuma empresa cadastrada. Cadastre as empresas do grupo para que as NFs sejam direcionadas automaticamente." />
          )}
        </Cartao>
      </div>
      {editar && <Formulario empresa={editar.id ? editar : null} onFechar={() => setEditar(null)} onSalvo={() => { setEditar(null); recarregar(); }} />}
    </>
  );
}
