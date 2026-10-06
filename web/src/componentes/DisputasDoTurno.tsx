import { useEffect, useState } from 'react';
import type { Candidato, DisputaDoTurno } from '../../../shared/tipos.ts';
import { NOMES_UF } from '../../../shared/ufs.ts';
import { buscarDisputas } from '../api.ts';
import { Bandeira } from './Bandeira.tsx';
import { Foto } from './Cartao.tsx';

// Tela de espera do 2º turno, abaixo do cronômetro: o que se vota e onde. Presidente em todo o
// país; Governador só nos estados que tiveram 2º turno; os demais estados votam só para Presidente.
// O estado escolhido em "Seu estado" (Início) aparece em destaque.

const CHAVE_ESTADO_PREFERIDO = 'eleicoes2026:estado'; // a mesma do Início
const UFS = Object.keys(NOMES_UF).filter((u) => u !== 'br' && u !== 'zz');
const nome = (uf: string) => NOMES_UF[uf] ?? uf.toUpperCase();
const porNome = (a: string, b: string) => nome(a).localeCompare(nome(b), 'pt-BR');

function lerEstadoSalvo(): string | null {
  try {
    return localStorage.getItem(CHAVE_ESTADO_PREFERIDO);
  } catch {
    return null;
  }
}

function Confronto({ candidatos, grande = false }: { candidatos: Candidato[]; grande?: boolean }) {
  const [a, b] = candidatos;
  if (!a || !b) return <p className="disputas-vazio">Candidatos ainda não disponíveis.</p>;
  const lado = (c: Candidato) => (
    <span className="disputas-candidato">
      <Foto c={c} />
      <span className="disputas-candidato-texto">
        <strong>{c.nome}</strong>
        <span>{c.partido} · {c.numero}</span>
      </span>
    </span>
  );
  return (
    <div className={`disputas-confronto${grande ? ' disputas-confronto-grande' : ''}`}>
      {lado(a)}
      <span className="disputas-x" aria-label="contra">×</span>
      {lado(b)}
    </div>
  );
}

export function DisputasDoTurno({ turno }: { turno: string }) {
  const [disputas, setDisputas] = useState<DisputaDoTurno[]>();
  const [erro, setErro] = useState(false);
  const [seuEstado] = useState(lerEstadoSalvo);

  // Antes da apuração os finalistas não mudam: uma busca basta (e outra se falhar)
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const carregar = () => buscarDisputas(ctrl.signal)
      .then((r) => { setDisputas(r.disputas); setErro(false); })
      .catch(() => { if (!ctrl.signal.aborted) { setErro(true); timer = setTimeout(carregar, 30_000); } });
    void carregar();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, []);

  if (!disputas) {
    return erro ? <p className="resumo-estados">Não foi possível carregar as disputas do {turno}. Nova tentativa em 30s.</p> : null;
  }

  const presidente = disputas.find((d) => d.cargo === 1 && d.uf === 'br');
  const estaduais = disputas.filter((d) => d.uf !== 'br').sort((a, b) => porNome(a.uf, b.uf));
  const ufsComEstadual = new Set(estaduais.map((d) => d.uf));
  const soPresidente = UFS.filter((u) => !ufsComEstadual.has(u)).sort(porNome);
  // O que o seu estado vota neste turno
  const noSeuEstado = seuEstado && UFS.includes(seuEstado)
    ? [presidente && 'Presidente', ...estaduais.filter((d) => d.uf === seuEstado).map((d) => d.nome)].filter(Boolean)
    : null;

  return (
    <section className="disputas" aria-labelledby="disputas-titulo">
      <h2 id="disputas-titulo">O que se vota no {turno}</h2>

      {noSeuEstado && (
        <p className="disputas-seu-estado">
          <Bandeira uf={seuEstado!} />
          <span>Em <strong>{nome(seuEstado!)}</strong>, você vota para <strong>{noSeuEstado.join(' e ')}</strong>.</span>
        </p>
      )}

      {presidente && (
        <div className="disputas-bloco">
          <h3>Presidente <span className="disputas-onde">em todo o país e no exterior</span></h3>
          <Confronto candidatos={presidente.candidatos} grande />
        </div>
      )}

      {estaduais.length > 0 && (
        <div className="disputas-bloco">
          <h3>
            {[...new Set(estaduais.map((d) => d.nome))].join(' e ')}{' '}
            <span className="disputas-onde">em {estaduais.length} {estaduais.length === 1 ? 'estado' : 'estados'}</span>
          </h3>
          <ul className="disputas-estados">
            {estaduais.map((d) => (
              <li key={`${d.cargo}-${d.uf}`} className={`disputas-estado${d.uf === seuEstado ? ' disputas-estado-seu' : ''}`}>
                <span className="disputas-estado-nome">
                  <Bandeira uf={d.uf} />
                  {nome(d.uf)}
                  {estaduais.some((x) => x.uf === d.uf && x.cargo !== d.cargo) && <span className="disputas-onde">{d.nome}</span>}
                </span>
                <Confronto candidatos={d.candidatos} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {presidente && soPresidente.length > 0 && (
        <div className="disputas-bloco">
          <h3>Só Presidente <span className="disputas-onde">nos outros {soPresidente.length} estados</span></h3>
          <ul className="disputas-so-presidente">
            {soPresidente.map((u) => (
              <li key={u} className={u === seuEstado ? 'disputas-estado-seu' : undefined}>{nome(u)}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
