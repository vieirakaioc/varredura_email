// Botão de sumário executivo para mandar no WhatsApp ou por e-mail: uma imagem com os números que importam
// e um texto de visão geral. Desenhado no canvas, sem biblioteca: o que vai para o grupo precisa
// ser previsível, e a tela inteira "fotografada" fica ilegível no celular.
//
// Cada aba monta o seu `resumo`:
//   { titulo, periodo, visao: [frases], kpis: [{ rotulo, valor, detalhe, tom }], destaques: [{ rotulo, valor, detalhe }], rodape }
// tom: 'bom' | 'alerta' | 'critico' | 'neutro'
import { useState } from 'react';
import { useToast } from './ui.jsx';
import { desenharResumo, textoResumo } from './resumo-desenho.js';

const nomeArquivo = (resumo) => `${String(resumo.titulo ?? 'resumo').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-${new Date().toLocaleDateString('sv-SE')}.png`;

/**
 * Botão de sumário executivo: baixa a imagem, copia o texto ou copia a imagem
 * (colar direto na conversa do WhatsApp Web).
 */
export function BotaoResumo({ resumo, rotulo = 'Sumário executivo' }) {
  const avisar = useToast();
  const [aberto, setAberto] = useState(false);

  const comCanvas = (fn) => {
    try { fn(desenharResumo(typeof resumo === 'function' ? resumo() : resumo)); } catch (e) { avisar(`Não consegui gerar o resumo: ${e.message}`, 'erro'); }
    setAberto(false);
  };
  const baixar = () => comCanvas((canvas) => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = nomeArquivo(typeof resumo === 'function' ? resumo() : resumo);
    a.click();
    avisar('Imagem baixada', 'ok');
  });
  const copiarImagem = () => comCanvas((canvas) => {
    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        avisar('Imagem copiada: é só colar na conversa', 'ok');
      } catch { avisar('O navegador não deixou copiar a imagem; use "Baixar imagem"', 'erro'); }
    }, 'image/png');
  });
  const copiarTexto = async () => {
    try {
      await navigator.clipboard.writeText(textoResumo(typeof resumo === 'function' ? resumo() : resumo));
      avisar('Texto copiado', 'ok');
    } catch (e) { avisar(`Não consegui copiar: ${e.message}`, 'erro'); }
    setAberto(false);
  };

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn pequeno" onClick={() => setAberto((x) => !x)} title="Resumo para mandar no WhatsApp ou por e-mail">
        {rotulo} ▾
      </button>
      {aberto && (
        <>
          <span style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setAberto(false)} />
          <div className="cartao" style={{
            position: 'absolute', right: 0, top: '110%', zIndex: 11, minWidth: 232, padding: 6,
            boxShadow: '0 10px 30px rgba(0,0,0,.18)',
          }}>
            {[['Baixar imagem (PNG)', baixar], ['Copiar imagem', copiarImagem], ['Copiar texto', copiarTexto]].map(([t, fn]) => (
              <button key={t} className="btn pequeno ghost" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={fn}>{t}</button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
