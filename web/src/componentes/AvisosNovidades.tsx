import { useEffect, useState } from 'react';

// Botão "Receber novidades por notificação": inscreve o aparelho no canal global de novidades
// (as mesmas para todos os usuários), diferente dos avisos por disputa (Avisos.tsx).

type Estado =
  | 'carregando' | 'sem-suporte' | 'instalar-ios' | 'bloqueado'
  | 'desativado' | 'ativando' | 'ativado' | 'erro';

const ehIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const suportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

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

export function AvisosNovidades({ chave }: { chave: string }) {
  const [estado, setEstado] = useState<Estado>('carregando');
  const [erro, setErro] = useState('');

  useEffect(() => {
    let vivo = true;
    (async () => {
      if (ehIOS() && !instalado()) return setEstado('instalar-ios');
      if (!suportaPush()) return setEstado('sem-suporte');
      if (Notification.permission === 'denied') return setEstado('bloqueado');
      const reg = await navigator.serviceWorker.ready;
      const inscricao = await reg.pushManager.getSubscription();
      if (!inscricao) return vivo && setEstado('desativado');
      const { novidades } = await api('POST', '/api/notificacoes/consultar', { endpoint: inscricao.endpoint }) as { novidades?: boolean };
      if (vivo) setEstado(novidades ? 'ativado' : 'desativado');
    })().catch(() => vivo && setEstado('desativado'));
    return () => { vivo = false; };
  }, []);

  async function alternar() {
    setErro('');
    const reg = await navigator.serviceWorker.ready;
    try {
      if (estado === 'ativado') {
        const inscricao = await reg.pushManager.getSubscription();
        if (inscricao) await api('DELETE', '/api/notificacoes/novidades', { endpoint: inscricao.endpoint });
        setEstado('desativado');
        return;
      }
      setEstado('ativando');
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') {
        setEstado(permissao === 'denied' ? 'bloqueado' : 'desativado');
        return;
      }
      const inscricao = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDaChave(chave) });
      await api('POST', '/api/notificacoes/novidades', { inscricao: inscricao.toJSON() });
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
        Para receber novidades no iPhone, instale o app: toque em Compartilhar e depois em Adicionar à Tela de Início.
      </p>
    );
  }
  if (estado === 'bloqueado') {
    return <p className="avisos-dica">As notificações deste site estão bloqueadas. Libere nas configurações do navegador para receber novidades.</p>;
  }

  const ativo = estado === 'ativado';
  return (
    <div className="avisos">
      <button type="button" className="avisos-botao" aria-pressed={ativo} disabled={estado === 'ativando'} onClick={() => void alternar()}>
        <Sino ativo={ativo} />
        {ativo ? 'Notificações de novidades ativadas' : estado === 'ativando' ? 'Ativando…' : 'Receber novidades por notificação'}
      </button>
      <p className="avisos-dica">
        {estado === 'erro'
          ? `Não foi possível ativar (${erro}). Tente de novo.`
          : ativo
            ? 'Você será avisado a cada novidade da totalização. Toque para desativar.'
            : 'Receba as novidades em tempo real no celular, mesmo com a tela fechada.'}
      </p>
    </div>
  );
}
