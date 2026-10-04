import { useEffect, useRef, useState } from 'react';
import type { Cargo } from '../../../shared/tipos.ts';
import type { Tema } from '../paleta.ts';
import { StatusDados } from './StatusDados.tsx';
import {
  IconeCandidatos, IconeDeputado, IconeGovernador, IconeInicio, IconeLua, IconeMais, IconeMapa,
  IconeNovidades, IconePainel, IconePorEstado, IconePresidente, IconeSenador, IconeSobre, IconeSol,
} from './Icones.tsx';

// Navegação principal: sidebar recolhível no desktop (≥1024px), navegação inferior de
// 5 itens no mobile. Ambas controladas pelos mesmos sentinelas de "cargo" do App.tsx.

const CHAVE_SIDEBAR = 'eleicoes2026:sidebar-recolhida';

function lerSidebarRecolhida(): boolean {
  try { return localStorage.getItem(CHAVE_SIDEBAR) === '1'; } catch { return false; }
}
function salvarSidebarRecolhida(v: boolean) {
  try { localStorage.setItem(CHAVE_SIDEBAR, v ? '1' : '0'); } catch { /* modo privado: não lembra, sem problema */ }
}

function iconeCargo(codigo: number) {
  switch (codigo) {
    case 1: return IconePresidente;
    case 3: return IconeGovernador;
    case 5: return IconeSenador;
    default: return IconeDeputado;
  }
}

// Abreviação curta para o trilho recolhido (mais legível que ícones genéricos repetidos)
function abreviarCargo(nome: string) {
  if (nome.startsWith('Presidente')) return 'Pres';
  if (nome.startsWith('Governador')) return 'Gov';
  if (nome.startsWith('Senador')) return 'Sen';
  if (nome === 'Deputado federal') return 'DF';
  if (nome === 'Deputado estadual') return 'DE';
  if (nome === 'Deputado distrital') return 'Dist';
  return nome.slice(0, 4);
}

export interface PropsNavegacao {
  cargos: Cargo[];
  secao: Secao;
  cargoCandidatos: number;
  onIr: (s: Secao) => void;
  onAbrirCandidatos: (cargo: number) => void;
  tema: Tema;
  onAlternarTema: () => void;
}

export type Secao = 'inicio' | 'candidatos' | 'mapa' | 'novidades' | 'mais' | 'por-estado' | 'visao-estado' | 'sobre';

// --- Sidebar desktop ---

export function SidebarDesktop({ cargos, secao, cargoCandidatos, onIr, onAbrirCandidatos, tema, onAlternarTema }: PropsNavegacao) {
  const [recolhida, setRecolhida] = useState(lerSidebarRecolhida);
  const alternar = () => setRecolhida((r) => { salvarSidebarRecolhida(!r); return !r; });

  return (
    <aside className={`sidebar${recolhida ? ' sidebar-recolhida' : ''}`} aria-label="Navegação principal">
      <nav className="sidebar-nav">
        <button type="button" className="sidebar-item" aria-current={secao === 'inicio' ? 'page' : undefined}
          onClick={() => onIr('inicio')} title="Início">
          <IconeInicio /><span>Início</span>
        </button>

        {cargos.map((c) => {
          const Icone = iconeCargo(c.codigo);
          const ativo = secao === 'candidatos' && cargoCandidatos === c.codigo;
          return (
            <button key={c.codigo} type="button" className="sidebar-item" aria-current={ativo ? 'page' : undefined}
              onClick={() => onAbrirCandidatos(c.codigo)} title={c.nome}>
              <Icone /><span>{recolhida ? abreviarCargo(c.nome) : c.nome}</span>
            </button>
          );
        })}

        <button type="button" className="sidebar-item" aria-current={secao === 'por-estado' || secao === 'visao-estado' ? 'page' : undefined}
          onClick={() => onIr('por-estado')} title="Por estado">
          <IconePorEstado /><span>Por estado</span>
        </button>
        <button type="button" className="sidebar-item" aria-current={secao === 'mapa' ? 'page' : undefined}
          onClick={() => onIr('mapa')} title="Mapa">
          <IconeMapa /><span>Mapa</span>
        </button>
        <button type="button" className="sidebar-item" aria-current={secao === 'novidades' ? 'page' : undefined}
          onClick={() => onIr('novidades')} title="Novidades">
          <IconeNovidades /><span>Novidades</span>
        </button>
        <button type="button" className="sidebar-item" aria-current={secao === 'sobre' ? 'page' : undefined}
          onClick={() => onIr('sobre')} title="Sobre">
          <IconeSobre /><span>Sobre</span>
        </button>
      </nav>

      <div className="sidebar-rodape">
        <button type="button" className="sidebar-tema" onClick={onAlternarTema}
          aria-label={tema === 'escuro' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
          title={tema === 'escuro' ? 'Tema claro' : 'Tema escuro'}>
          {tema === 'escuro' ? <IconeSol /> : <IconeLua />}
          {!recolhida && <span>{tema === 'escuro' ? 'Tema claro' : 'Tema escuro'}</span>}
        </button>
        {!recolhida && <StatusDados compacto />}
        <button type="button" className="sidebar-recolher" onClick={alternar}
          aria-expanded={!recolhida} aria-controls="sidebar-nav-lista" title={recolhida ? 'Expandir menu' : 'Recolher menu'}>
          <IconePainel />
          {!recolhida && <span>Recolher menu</span>}
        </button>
      </div>
    </aside>
  );
}

// --- Navegação inferior mobile ---

export function NavInferiorMobile({ secao, onIr }: { secao: Secao; onIr: (s: Secao) => void }) {
  const itens: { s: Secao; rotulo: string; Icone: typeof IconeInicio }[] = [
    { s: 'inicio', rotulo: 'Início', Icone: IconeInicio },
    { s: 'candidatos', rotulo: 'Candidatos', Icone: IconeCandidatos },
    { s: 'mapa', rotulo: 'Mapa', Icone: IconeMapa },
    { s: 'novidades', rotulo: 'Novidades', Icone: IconeNovidades },
    { s: 'mais', rotulo: 'Mais', Icone: IconeMais },
  ];
  // "Candidatos" também fica ativo quando a pessoa está em Por estado/Visão do estado,
  // já que essas telas abrem a partir de dentro de "Candidatos" nesta fase
  const ativoCandidatos = secao === 'candidatos' || secao === 'por-estado' || secao === 'visao-estado';

  return (
    <nav className="nav-inferior" aria-label="Navegação principal">
      {itens.map(({ s, rotulo, Icone }) => {
        const ativo = s === 'candidatos' ? ativoCandidatos : secao === s;
        return (
          <button key={s} type="button" className="nav-inferior-item" aria-current={ativo ? 'page' : undefined} onClick={() => onIr(s)}>
            <Icone size={22} />
            <span>{rotulo}</span>
          </button>
        );
      })}
    </nav>
  );
}

// Rola a aba ativa do seletor de cargo (dentro de "Candidatos") para o centro visível
export function useRolarAbaAtiva(dependencia: unknown) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const botao = ref.current;
    const lista = botao?.parentElement;
    if (!botao || !lista) return;
    const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const alvo = botao.offsetLeft + botao.offsetWidth / 2 - lista.clientWidth / 2;
    lista.scrollTo({ left: Math.max(0, alvo), behavior: reduzido ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependencia]);
  return ref;
}
