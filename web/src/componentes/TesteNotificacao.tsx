import { useState } from 'react';
import { testarNotificacao } from '../push.ts';

// "Testar notificação": o servidor manda um push na hora só para este aparelho e diz o que o
// serviço de push respondeu. Separa "o servidor não conseguiu enviar" de "o aparelho não mostrou".
export function TesteNotificacao() {
  const [enviando, setEnviando] = useState(false);
  const [mensagem, setMensagem] = useState('');

  async function testar() {
    setEnviando(true);
    setMensagem('');
    try {
      setMensagem(await testarNotificacao());
    } catch (e) {
      setMensagem(`Não foi possível testar (${(e as Error).message}).`);
    }
    setEnviando(false);
  }

  return (
    <div className="avisos-teste">
      <button type="button" className="avisos-teste-botao" disabled={enviando} onClick={() => void testar()}>
        {enviando ? 'Enviando teste…' : 'Testar notificação neste aparelho'}
      </button>
      {mensagem && <p className="avisos-dica" role="status">{mensagem}</p>}
    </div>
  );
}
