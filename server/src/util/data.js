// Datas no fuso local do servidor, no mesmo formato de datetime('now','localtime') do SQLite.
const pad = (n) => String(n).padStart(2, '0');

export function dataHoraLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const hojeLocal = () => dataHoraLocal().slice(0, 10);
export const diasAPartirDeHoje = (n) => dataHoraLocal(new Date(Date.now() + n * 86400000)).slice(0, 10);
/** Converte 'AAAA-MM-DD HH:MM:SS' (local) em Date. */
export const lerDataLocal = (s) => new Date(String(s).replace(' ', 'T'));
