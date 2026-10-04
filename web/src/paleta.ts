import { useEffect, useState } from 'react';

// Paleta categórica validada (separação para daltonismo) em cada modo.
// A ordem é fixa; a cor segue o candidato, nunca a posição no placar.
const SERIES = {
  claro: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  escuro: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const NEUTROS = {
  claro: { contexto: '#b9c3cb', grade: '#dde3e8', eixo: '#5a6876' },
  escuro: { contexto: '#3d4a57', grade: '#26323e', eixo: '#94a3b1' },
};
export const MAX_SERIES = SERIES.claro.length;

export type Tema = 'claro' | 'escuro';

export function useTema(): Tema {
  const consulta = matchMedia('(prefers-color-scheme: dark)');
  const [tema, setTema] = useState<Tema>(consulta.matches ? 'escuro' : 'claro');
  useEffect(() => {
    const mudou = (e: MediaQueryListEvent) => setTema(e.matches ? 'escuro' : 'claro');
    consulta.addEventListener('change', mudou);
    return () => consulta.removeEventListener('change', mudou);
  }, [consulta]);
  return tema;
}

export const corSerie = (tema: Tema, slot: number | undefined) =>
  slot === undefined ? NEUTROS[tema].contexto : SERIES[tema][slot]!;
export const neutros = (tema: Tema) => NEUTROS[tema];
