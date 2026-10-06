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

// Finalistas do 2º turno: cada um na cor oficial do seu partido. Hue do registro de cores de
// partidos da Wikipédia (Module:Political party, o mesmo dos mapas eleitorais); luminosidade
// ajustada por tema em OKLCH e validada par a par (faixa, croma, daltonismo, visão normal e
// contraste) com o validador do guia de dataviz. Valores em estilos.css (--partido-*).
// Onde os dois lados do confronto têm o mesmo azul, um usa a cor secundária oficial do partido:
// Acre (PP × Republicanos) -> Republicanos em verde; Tocantins (União × PSDB) -> PSDB em amarelo.
// A chave é cargo:uf:número; Presidente vale para qualquer UF ('*').
const FINALISTAS_2T: Record<string, string> = {
  '1:*:13': 'pt', '1:*:22': 'pl',                         // Lula × Flávio Bolsonaro
  '3:ac:11': 'pp', '3:ac:10': 'republicanos-verde',       // Mailza Assis × Alan Rick
  '3:am:55': 'psd', '3:am:22': 'pl',                      // Omar Aziz × Professora Maria do Carmo
  '3:df:11': 'pp', '3:df:13': 'pt',                       // Celina Leão × Leandro Grass
  '3:es:10': 'republicanos', '3:es:15': 'mdb',            // Lorenzo Pazolini × Ricardo Ferraço
  '3:rj:22': 'pl', '3:rj:55': 'psd',                      // Douglas Ruas × Eduardo Paes
  '3:rn:44': 'uniao', '3:rn:13': 'pt',                    // Allyson × Cadu de Lula
  '3:to:44': 'uniao', '3:to:45': 'psdb-amarelo',          // Professora Dorinha × Vicentinho Júnior
};

/** Cor de um finalista do 2º turno (variável CSS); undefined fora do 2º turno ou fora da lista */
export function corDoFinalista(turno: number | undefined, cargo: number, uf: string | undefined, numero: string): string | undefined {
  if ((turno ?? 1) < 2) return undefined;
  const partido = (uf && FINALISTAS_2T[`${cargo}:${uf}:${numero}`]) || FINALISTAS_2T[`${cargo}:*:${numero}`];
  return partido ? `var(--partido-${partido})` : undefined;
}
