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

// Botão "Testar notificação": duas notificações, para separar onde está o problema.
// 1) "Teste local": exibida pelo próprio navegador, sem servidor nem push service. Se ela não
//    aparece, o bloqueio é do sistema/navegador (Não perturbar, notificações do navegador desligadas).
// 2) "Teste de notificação": push de verdade, vindo do servidor (POST /api/notificacoes/teste).
export async function testarNotificacao(): Promise<string> {
  const reg = await navigator.serviceWorker.ready;
  if (Notification.permission !== 'granted') return 'As notificações deste site não estão permitidas no navegador.';
  await reg.showNotification('Teste local', {
    body: 'Se você está vendo isto, o navegador consegue exibir notificações.',
    tag: 'teste-local', icon: '/icones/icone-192.png', lang: 'pt-BR',
  });
  const s = await reg.pushManager.getSubscription();
  if (!s) return 'Este aparelho não está inscrito. Ative os avisos de novo.';
  const r = await fetch('/api/notificacoes/teste', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: s.endpoint }),
  });
  const corpo = await r.json().catch(() => null) as { ok?: boolean; status?: number | null; motivo?: string; erro?: string } | null;
  if (r.status === 404) return 'Este aparelho não está inscrito no servidor. Desative e ative os avisos de novo.';
  if (!r.ok) return corpo?.erro ?? `Não foi possível testar (HTTP ${r.status}).`;
  if (corpo?.ok) {
    return 'Enviadas duas notificações: "Teste local" (do navegador) e "Teste de notificação" (do servidor). '
      + 'Nenhuma apareceu: as notificações do navegador estão desligadas no sistema (no Windows: Configurações > '
      + 'Sistema > Notificações, e o modo Não perturbar). Só a local apareceu: o navegador não está recebendo '
      + 'o push; desative e ative os avisos de novo.';
  }
  return `O serviço de push recusou o envio (${[corpo?.status, corpo?.motivo].filter(Boolean).join(': ') || 'sem detalhe'}). `
    + 'Desative e ative os avisos de novo; se continuar, avise o responsável pelo site.';
}
