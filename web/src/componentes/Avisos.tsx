import { useEffect, useState } from 'react';

// Botão "Avisar sobre esta disputa": inscreve o aparelho em notificações push da disputa aberta.

type Estado =
  | 'carregando' | 'sem-suporte' | 'instalar-ios' | 'bloqueado'
  | 'desativado' | 'ativando' | 'ativado' | 'erro';

const ehIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS se diz Mac
const instalado = () => matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const suportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// Chave VAPID vem em base64url; o PushManager quer bytes
function bytesDaChave(base64url: string) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function api(metodo: 'POST' | 'DELETE', caminho: string, corpo: unknown) {
  const r = await fetch(caminho, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro ?? `HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

function Sino({ ativo }: { ativo: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill={ativo ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function Avisos({ uf, cargo, chave, proporcional }: { uf: string; cargo: number; chave: string; proporcional: boolean }) {
  const [estado, setEstado] = useState<Estado>('carregando');
  const [erro, setErro] = useState('');

  // Ao abrir/trocar de disputa: este aparelho já segue esta disputa?
  useEffect(() => {
    let vivo = true;
    (async () => {
      if (ehIOS() && !instalado()) return setEstado('instalar-ios');
      if (!suportaPush()) return setEstado('sem-suporte');
      if (Notification.permission === 'denied') return setEstado('bloqueado');
      const reg = await navigator.serviceWorker.ready;
      const inscricao = await reg.pushManager.getSubscription();
      if (!inscricao) return vivo && setEstado('desativado');
      const { disputas } = await api('POST', '/api/notificacoes/consultar', { endpoint: inscricao.endpoint }) as { disputas: string[] };
      if (vivo) setEstado(disputas.includes(`${uf}:${cargo}`) ? 'ativado' : 'desativado');
    })().catch(() => vivo && setEstado('desativado'));
    return () => { vivo = false; };
  }, [uf, cargo]);

  async function alternar() {
    setErro('');
    const reg = await navigator.serviceWorker.ready;
    try {
      if (estado === 'ativado') {
        const inscricao = await reg.pushManager.getSubscription();
        if (inscricao) await api('DELETE', '/api/notificacoes', { endpoint: inscricao.endpoint, uf, cargo });
        setEstado('desativado');
        return;
      }
      setEstado('ativando');
      // A permissão precisa ser pedida dentro do clique (exigência de Safari e Chrome)
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') {
        setEstado(permissao === 'denied' ? 'bloqueado' : 'desativado');
        return;
      }
      const inscricao = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDaChave(chave) });
      await api('POST', '/api/notificacoes', { inscricao: inscricao.toJSON(), uf, cargo });
      setEstado('ativado');
    } catch (e) {
      setErro((e as Error).message);
      setEstado('erro');
    }
  }

  if (estado === 'carregando' || estado === 'sem-suporte') return null;

  if (estado === 'instalar-ios') {
    return (
      <p className="avisos-dica">
        Para receber avisos desta disputa no iPhone, instale o app: toque em Compartilhar e depois em Adicionar à Tela de Início.
      </p>
    );
  }
  if (estado === 'bloqueado') {
    return <p className="avisos-dica">As notificações deste site estão bloqueadas. Libere nas configurações do navegador para receber avisos.</p>;
  }

  const ativo = estado === 'ativado';
  // Deputados não têm "virada": a eleição é por quociente partidário
  const quando = proporcional
    ? 'no início, a cada 25% totalizado e quando os eleitos forem definidos'
    : 'no início, a cada 25% totalizado, em viradas e quando o resultado sair';
  return (
    <div className="avisos">
      <button type="button" className="avisos-botao" aria-pressed={ativo} disabled={estado === 'ativando'} onClick={() => void alternar()}>
        <Sino ativo={ativo} />
        {ativo ? 'Avisos ativados' : estado === 'ativando' ? 'Ativando…' : 'Avisar sobre esta disputa'}
      </button>
      <p className="avisos-dica">
        {estado === 'erro'
          ? `Não foi possível ativar os avisos (${erro}). Tente de novo.`
          : ativo
            ? `Você será avisado ${quando}. Toque para desativar.`
            : `Receba um aviso ${quando}.`}
      </p>
    </div>
  );
}
