import { useState } from 'react';
import type { Candidato } from '../../../shared/tipos.ts';
import { pct, votos } from '../formato.ts';

// O número como aparece na tela da urna: um dígito por caixinha
function NumeroUrna({ numero }: { numero: string }) {
  return (
    <span className="urna" aria-label={`Número ${numero}`}>
      {[...numero].map((d, i) => <span key={i} aria-hidden="true">{d}</span>)}
    </span>
  );
}

export function Foto({ c }: { c: Candidato }) {
  const [falhou, setFalhou] = useState(false);
  if (!c.foto || falhou) {
    const iniciais = c.nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('');
    return <span className="foto foto-vazia" aria-hidden="true">{iniciais}</span>;
  }
  return <img className="foto" src={c.foto} alt="" loading="lazy" decoding="async" onError={() => setFalhou(true)} />;
}

// "Eleito", "2º turno", "Eleito por QP"… o texto vem do TSE; só escolhemos o tom
function Situacao({ c }: { c: Candidato }) {
  const texto = c.situacao || (c.eleito ? 'Eleito' : '');
  if (!texto) return null;
  const tom = c.eleito ? 'eleito' : /2º turno/i.test(texto) ? 'segundo-turno' : 'neutro';
  return <span className={`selo selo-${tom}`}>{texto}</span>;
}

interface Props {
  c: Candidato;
  cor: string;
  noGrafico: boolean;
  ativo: boolean;
  esmaecido: boolean;
  destaque?: boolean;
  apuracaoComecou?: boolean;
  dentroDasVagas?: boolean;
  /** Presidente/Governador: mostra a marca dos 50% dos votos válidos na barra */
  referencia50?: boolean;
  onDestacar: (numero: string | null) => void;
  onFixar: (numero: string) => void;
}

export function Cartao({ c, cor, noGrafico, ativo, esmaecido, destaque, apuracaoComecou = true, dentroDasVagas, referencia50, onDestacar, onFixar }: Props) {
  const semVotos = !apuracaoComecou && c.votos === 0;
  // Só elementos inline aqui dentro: o conteúdo pode ficar dentro de um <button>
  const conteudo = (
    <>
      <span className="cartao-topo">
        <Foto c={c} />
        <span className="cartao-nome">
          <strong>{c.nome}</strong>
          <span>{c.partido}</span>
        </span>
        <NumeroUrna numero={c.numero} />
      </span>
      <span className="cartao-placar">
        <span className="cartao-pct">{semVotos ? '—' : pct(c.percentual)}</span>
        {dentroDasVagas && !c.situacao && <span className="selo selo-vaga">Na faixa de vagas</span>}
        <Situacao c={c} />
      </span>
      <span className="cartao-rodape">
        <span>{semVotos ? 'Aguardando apuração' : votos(c.votos)}</span>
      </span>
      <span className="trilho" aria-hidden="true">
        <span style={{ width: `${semVotos ? 0 : c.percentual}%`, background: cor }} />
        {referencia50 && !semVotos && <span className="trilho-marca" style={{ left: '50%' }} />}
      </span>
    </>
  );

  const classe = `cartao${c.eleito ? ' cartao-eleito' : ''}${ativo ? ' cartao-ativo' : ''}${esmaecido ? ' cartao-esmaecido' : ''}${destaque ? ' cartao-destaque' : ''}${semVotos ? ' cartao-sem-votos' : ''}`;
  if (!noGrafico) return <li className={classe}>{conteudo}</li>;

  // Candidatos que estão no gráfico: passar o mouse/focar destaca a linha; clicar fixa
  return (
    <li className={classe}>
      <button
        type="button"
        className="cartao-botao"
        aria-pressed={ativo}
        aria-label={`${c.nome}, ${pct(c.percentual)}. Destacar no gráfico`}
        onMouseEnter={() => onDestacar(c.numero)}
        onMouseLeave={() => onDestacar(null)}
        onFocus={() => onDestacar(c.numero)}
        onBlur={() => onDestacar(null)}
        onClick={() => onFixar(c.numero)}
      >
        {conteudo}
      </button>
    </li>
  );
}
