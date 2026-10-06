// Inscrição do aparelho em notificações push, compartilhada por Avisos (disputa) e
// AvisosNovidades (canal global). O servidor guarda as disputas por endpoint da inscrição.

export const ehIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS se diz Mac
export const instalado = () => matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const suportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// Chave VAPID vem em base64url; o PushManager quer bytes
function bytesDaChave(base64url: string) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function api(metodo: 'POST' | 'DELETE', caminho: string, corpo: unknown) {
  const r = await fetch(caminho, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro ?? `HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// A inscrição foi feita com a chave VAPID atual do servidor? Se as chaves mudaram (volume recriado,
// variável trocada), o push service recusa todo envio para a inscrição antiga, em silêncio.
// Navegador que não informa a chave: não dá para comparar, assume que está certa.
function mesmaChave(s: PushSubscription, chave: string) {
  const atual = s.options?.applicationServerKey;
  if (!atual) return true;
  const a = new Uint8Array(atual), b = bytesDaChave(chave);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const assinar = (reg: ServiceWorkerRegistration, chave: string) =>
  reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDaChave(chave) });

// Inscrição deste aparelho, já com a chave certa. Com chave antiga, refaz a inscrição e pede ao
// servidor para transferir disputas e novidades para a nova. criar=true (só dentro de um clique,
// com permissão concedida) inscreve quem ainda não tem inscrição.
export async function inscricaoDoAparelho(chave: string, criar = false): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  let s = await reg.pushManager.getSubscription();
  if (s && chave && !mesmaChave(s, chave) && Notification.permission === 'granted') {
    const antigo = s.endpoint;
    await s.unsubscribe();
    s = await assinar(reg, chave);
    await api('POST', '/api/notificacoes/renovar', { antigo, inscricao: s.toJSON() });
  }
  if (!s && criar) s = await assinar(reg, chave);
  return s;
}
