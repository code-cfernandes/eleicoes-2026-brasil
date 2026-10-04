import { useEffect, useState } from 'react';

// Paleta categórica validada (separação para daltonismo) em cada modo.
// A ordem é fixa; a cor segue o candidato, nunca a posição no placar.
// O escuro é o tema de referência do projeto (mesma lógica de estilos.css: dark é o :root
// padrão, claro só entra via @media (prefers-color-scheme: light)).
const SERIES = {
  escuro: ['#5b9bf7', '#ef8a4e', '#30d19b', '#e0a93a', '#ec84ac', '#4ad66d', '#a996f5', '#ef6b6b'],
  claro: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};
const NEUTROS = {
  escuro: { contexto: '#3c4766', grade: '#26304a', eixo: '#93a0c0' },
  claro: { contexto: '#b9c3cb', grade: '#dde3e8', eixo: '#5a6876' },
};
export const MAX_SERIES = SERIES.claro.length;

export type Tema = 'claro' | 'escuro';

const CHAVE_TEMA = 'eleicoes2026:tema';

function temaDoSistema(): Tema {
  return matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'escuro';
}

function lerTemaSalvo(): Tema | null {
  try {
    const v = localStorage.getItem(CHAVE_TEMA);
    return v === 'claro' || v === 'escuro' ? v : null;
  } catch {
    return null;
  }
}

// Tema da interface. Sem preferência salva, segue o sistema (o escuro é a referência).
// Devolve também a função de alternar, que persiste a escolha no aparelho.
export function useTema(): [Tema, () => void] {
  const [tema, setTema] = useState<Tema>(() => lerTemaSalvo() ?? temaDoSistema());

  useEffect(() => {
    document.documentElement.dataset.tema = tema;
  }, [tema]);

  // Só segue o sistema enquanto a pessoa não escolheu um tema manualmente
  useEffect(() => {
    const consulta = matchMedia('(prefers-color-scheme: light)');
    const mudou = (e: MediaQueryListEvent) => {
      if (!lerTemaSalvo()) setTema(e.matches ? 'claro' : 'escuro');
    };
    consulta.addEventListener('change', mudou);
    return () => consulta.removeEventListener('change', mudou);
  }, []);

  const alternar = () => {
    setTema((atual) => {
      const novo: Tema = atual === 'escuro' ? 'claro' : 'escuro';
      try { localStorage.setItem(CHAVE_TEMA, novo); } catch { /* modo privado: não lembra */ }
      return novo;
    });
  };

  return [tema, alternar];
}

export const corSerie = (tema: Tema, slot: number | undefined) =>
  slot === undefined ? NEUTROS[tema].contexto : SERIES[tema][slot]!;
export const neutros = (tema: Tema) => NEUTROS[tema];
