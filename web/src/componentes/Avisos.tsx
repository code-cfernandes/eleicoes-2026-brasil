import { useEffect, useState } from 'react';
import { turnoDaTela } from '../api.ts';
import { api, ehIOS, inscricaoDoAparelho, instalado, suportaPush } from '../push.ts';

// Botão "Avisar sobre esta disputa": inscreve o aparelho em notificações push da disputa aberta.

type Estado =
  | 'carregando' | 'sem-suporte' | 'instalar-ios' | 'bloqueado'
  | 'desativado' | 'ativando' | 'ativado' | 'erro';

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
      // Já refaz a inscrição se ela foi criada com uma chave VAPID antiga
      const inscricao = await inscricaoDoAparelho(chave);
      if (!inscricao) return vivo && setEstado('desativado');
      const { disputas } = await api('POST', '/api/notificacoes/consultar', { endpoint: inscricao.endpoint }) as { disputas: string[] };
      if (vivo) setEstado(disputas.includes(`${uf}:${cargo}`) ? 'ativado' : 'desativado');
    })().catch(() => vivo && setEstado('desativado'));
    return () => { vivo = false; };
  }, [uf, cargo, chave]);

  async function alternar() {
    setErro('');
    try {
      if (estado === 'ativado') {
        const inscricao = await inscricaoDoAparelho(chave);
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
      const inscricao = (await inscricaoDoAparelho(chave, true))!;
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
  // Os marcos seguem o servidor (MARCOS_POR_TURNO em notificacoes.ts): mais finos no 2º turno
  const quando = proporcional
    ? 'no início, a cada 25% totalizado e quando os eleitos forem definidos'
    : (turnoDaTela() ?? 1) > 1
      ? 'no início, em 10, 25, 50, 75, 90 e 95% totalizado, em viradas e quando o resultado sair'
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
