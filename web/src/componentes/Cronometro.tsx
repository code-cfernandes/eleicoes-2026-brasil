import { useEffect, useState } from 'react';
import { agora } from '../api.ts';
import { Avisos } from './Avisos.tsx';

// Antes da totalização de um turno (ex.: 2º turno, até 25/10 às 17h), as telas de dados não têm
// o que mostrar: no lugar dos cards padrão entra este cronômetro até o TSE voltar a divulgar.

const SEGUNDO = 1000;
const DATA_EXTENSO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long',
});
const HORA = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

// true enquanto `inicio` não chegou (pelo relógio do servidor); vira false sozinho no horário.
// Confere a cada segundo, e não com um único setTimeout longo: o navegador atrasa timers de abas
// em segundo plano e para o relógio deles com o notebook suspenso, e a tela ficaria presa no
// cronômetro zerado. Voltar para a aba confere na hora. Setar o mesmo valor não re-renderiza.
export function useAntesDoInicio(inicio: number | null | undefined) {
  const [antes, setAntes] = useState(() => !!inicio && agora() < inicio);
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const conferir = () => {
      const esperando = !!inicio && agora() < inicio;
      setAntes(esperando);
      if (!esperando) clearInterval(t); // começou: não volta mais para a espera
    };
    conferir();
    if (!inicio || agora() >= inicio) return;
    t = setInterval(conferir, SEGUNDO);
    document.addEventListener('visibilitychange', conferir);
    addEventListener('focus', conferir);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', conferir);
      removeEventListener('focus', conferir);
    };
  }, [inicio]);
  return antes;
}

function useAgora() {
  const [instante, setInstante] = useState(agora);
  useEffect(() => {
    // Alinha o tique à virada do segundo do relógio, para os números não "pularem"
    let t: ReturnType<typeof setTimeout>;
    const tique = () => {
      setInstante(agora());
      t = setTimeout(tique, SEGUNDO - (agora() % SEGUNDO));
    };
    t = setTimeout(tique, SEGUNDO - (agora() % SEGUNDO));
    return () => clearTimeout(t);
  }, []);
  return instante;
}

const dois = (n: number) => String(n).padStart(2, '0');

export function Cronometro({ inicio, turno, chavePush }: { inicio: number; turno: string; chavePush?: string }) {
  const instante = useAgora();
  const total = Math.max(0, Math.floor((inicio - instante) / SEGUNDO));
  const partes = [
    { valor: Math.floor(total / 86400), rotulo: total >= 2 * 86400 ? 'dias' : 'dia' },
    { valor: Math.floor(total / 3600) % 24, rotulo: 'horas' },
    { valor: Math.floor(total / 60) % 60, rotulo: 'min' },
    { valor: total % 60, rotulo: 'seg' },
  ];
  const data = DATA_EXTENSO.format(inicio);
  // Leitores de tela: um resumo que muda a cada minuto, não a cada segundo
  const resumo = `Faltam ${partes[0]!.valor} dias, ${partes[1]!.valor} horas e ${partes[2]!.valor} minutos`;

  return (
    <section className="cronometro" aria-labelledby="cronometro-titulo">
      <p className="cronometro-sobretitulo">{turno} · {data}</p>
      <h2 id="cronometro-titulo" className="cronometro-titulo">
        A totalização começa às {HORA.format(inicio).replace(':00', 'h')}
      </h2>

      <div className="cronometro-relogio" role="timer" aria-label={resumo}>
        {partes.map((p, i) => (
          <div key={p.rotulo} className="cronometro-parte" aria-hidden="true">
            <span className="cronometro-valor">{i === 0 ? p.valor : dois(p.valor)}</span>
            <span className="cronometro-rotulo">{p.rotulo}</span>
          </div>
        ))}
      </div>

      <p className="cronometro-nota">
        Horário de Brasília. É quando o TSE volta a divulgar os resultados; a partir daí esta página
        passa sozinha para os números ao vivo.
      </p>

      {chavePush !== undefined && (
        <div className="cronometro-aviso">
          <Avisos uf="br" cargo={1} chave={chavePush} proporcional={false} />
        </div>
      )}
    </section>
  );
}
