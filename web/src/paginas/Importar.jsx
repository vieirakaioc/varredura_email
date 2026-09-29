import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Topo } from '../contexto.jsx';
import { Cartao, Tabela, useToast } from '../ui.jsx';

const ACAO = { criado: 'Documento criado', duplicado: 'Já existia (duplicado)', pdf_vinculado: 'PDF vinculado ao XML', xml_complementou_pdf: 'XML completou documento lido do PDF', evento: 'Evento aplicado', ignorado: 'Ignorado', erro: 'Erro' };

export default function Importar() {
  const avisar = useToast();
  const entrada = useRef(null);
  const [arquivos, setArquivos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const enviar = async () => {
    const fd = new FormData();
    for (const a of arquivos) fd.append('arquivos', a);
    setEnviando(true);
    try { const r = await api.upload('/importar', fd); setResultado(r.resultados); setArquivos([]); avisar(`${r.resultados.length} arquivo(s) processado(s).`); } catch (e) { avisar(e.message, 'erro'); } finally { setEnviando(false); }
  };
  return (
    <>
      <Topo titulo="Importar arquivos" descricao="Envio manual de XML, PDF (DANFE/DACTE/NFS-e) ou ZIP — mesmo pipeline dos e-mails." />
      <div className="pagina">
        <Cartao>
          <div onDragOver={(e) => { e.preventDefault(); setArrastando(true); }} onDragLeave={() => setArrastando(false)}
            onDrop={(e) => { e.preventDefault(); setArrastando(false); setArquivos([...arquivos, ...e.dataTransfer.files]); }}
            onClick={() => entrada.current.click()}
            style={{ border: `2px dashed ${arrastando ? 'var(--marca-2)' : 'var(--borda-forte)'}`, borderRadius: 10, padding: 36, textAlign: 'center', cursor: 'pointer', background: arrastando ? 'var(--marca-suave)' : 'var(--superficie-2)' }}>
            <strong>Arraste arquivos aqui ou clique para selecionar</strong>
            <div className="muted pequeno">.xml, .pdf ou .zip · até 25 MB por arquivo</div>
            <input ref={entrada} type="file" multiple accept=".xml,.pdf,.zip" hidden onChange={(e) => setArquivos([...arquivos, ...e.target.files])} />
          </div>
          {arquivos.length > 0 && (
            <div className="linha" style={{ marginTop: 12 }}>
              <span style={{ flex: 1 }}>{arquivos.length} arquivo(s): {arquivos.map((a) => a.name).join(', ')}</span>
              <button className="btn" onClick={() => setArquivos([])}>Limpar</button>
              <button className="btn primario" disabled={enviando} onClick={enviar}>{enviando ? 'Processando…' : 'Processar'}</button>
            </div>
          )}
        </Cartao>
        {resultado && (
          <Cartao titulo="Resultado" semPadding>
            <Tabela chave="anexoId" linhas={resultado} colunas={[
              { campo: 'arquivo', titulo: 'Arquivo', render: (l) => <span className="mono pequeno">{l.arquivo}</span> },
              { campo: 'tipo', titulo: 'Identificado como', render: (l) => <span className="tag">{l.tipo}</span> },
              { campo: 'acao', titulo: 'Resultado', render: (l) => <span className={`badge ${l.acao === 'erro' ? 'sev-erro' : l.acao === 'ignorado' ? 'sev-na' : 'sev-ok'}`}>{ACAO[l.acao] ?? l.acao}</span> },
              { campo: 'mensagem', titulo: 'Mensagem', render: (l) => <span className="pequeno">{l.mensagem ?? ''}</span> },
              { campo: 'documentoId', titulo: '', render: (l) => (l.documentoId ? <Link to={`/documentos/${l.documentoId}`}>Abrir validação →</Link> : null) },
            ]} />
          </Cartao>
        )}
      </div>
    </>
  );
}
