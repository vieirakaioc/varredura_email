import { useState } from 'react';
import { api } from '../api.js';
import { brl, Campo, data, Modal, Status, useToast } from '../ui.jsx';

// Situação de pagamento das duplicatas lidas dos boletos (o que a Senior chama de título).
const PAGAMENTO = {
  aberta: { rotulo: 'Em aberto', cls: 'sev-alerta' }, programada: { rotulo: 'Programada', cls: 'st-AGUARDANDO_XML' },
  paga: { rotulo: 'Paga', cls: 'sev-ok' }, cancelada: { rotulo: 'Cancelada', cls: 'sev-na' },
};

/** Registra pagamento/programação de uma duplicata. Aberto pela ficha da nota. */
export function ModalPagamento({ titulo, onFechar, onFeito }) {
  const avisar = useToast();
  const [f, setF] = useState({ status_pagamento: titulo.status_pagamento === 'aberta' ? 'programada' : titulo.status_pagamento, data_pagamento: new Date().toLocaleDateString('sv-SE'), observacao: titulo.observacao ?? '' });
  const naoAprovada = titulo.status_fiscal !== 'APROVADA';
  const salvar = async () => {
    try { await api.post(`/duplicatas/${titulo.id}/pagamento`, f); avisar('Situação do título atualizada.'); onFeito(); } catch (e) { avisar(e.message, 'erro'); }
  };
  return (
    <Modal titulo={`Duplicata ${titulo.numero ?? ''} · NF ${titulo.nf ?? titulo.numero_nf ?? ''}`} onFechar={onFechar} rodape={<><button className="btn" onClick={onFechar}>Cancelar</button><button className="btn primario" onClick={salvar}>Salvar</button></>}>
      <div className="definicoes">
        <div><span>Vencimento</span><strong>{data(titulo.vencimento)}</strong></div>
        <div><span>Valor</span><strong>{brl(titulo.valor)}</strong></div>
        <div><span>Situação fiscal da NF</span><Status s={titulo.status_fiscal} /></div>
      </div>
      {naoAprovada && ['paga', 'programada'].includes(f.status_pagamento) && (
        <div className="aviso atencao">A NF ainda <strong>não foi aprovada pela Escrita Fiscal</strong>. Programar ou pagar exige justificativa, que ficará registrada no histórico do documento.</div>
      )}
      <Campo rotulo="Situação do pagamento">
        <select value={f.status_pagamento} onChange={(e) => setF({ ...f, status_pagamento: e.target.value })}>
          {Object.entries(PAGAMENTO).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </select>
      </Campo>
      {f.status_pagamento === 'paga' && <Campo rotulo="Data do pagamento"><input type="date" value={f.data_pagamento} onChange={(e) => setF({ ...f, data_pagamento: e.target.value })} /></Campo>}
      <Campo rotulo={`Observação${naoAprovada && ['paga', 'programada'].includes(f.status_pagamento) ? ' (obrigatória)' : ''}`}><textarea value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></Campo>
    </Modal>
  );
}
