import { useState } from 'react';
import type { Tema } from '../paleta.ts';
import { StatusDados } from './StatusDados.tsx';
import { IconeCompartilhar, IconeFonte, IconeLink, IconeLua, IconeMetodologia, IconeSobre, IconeSol } from './Icones.tsx';

function IconeGitHub() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.67 0 8.21c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.2-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.03.08-2.15 0 0 .67-.22 2.2.84a7.4 7.4 0 0 1 4 0c1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.15.51.57.82 1.29.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.75.54 1.5 0 1.09-.01 1.97-.01 2.24 0 .21.15.47.55.39A8.23 8.23 0 0 0 16 8.21C16 3.67 12.42 0 8 0Z" />
    </svg>
  );
}

const URL_REPOSITORIO = 'https://github.com/code-cfernandes/eleicoes-2026-brasil';
const URL_TSE = 'https://resultados.tse.jus.br';

function ItemLista({ icone, titulo, descricao, onClick, href, externo }: {
  icone: React.ReactNode; titulo: string; descricao: string;
  onClick?: () => void; href?: string; externo?: boolean;
}) {
  const conteudo = (
    <>
      <span className="mais-item-icone">{icone}</span>
      <span className="mais-item-texto">
        <strong>{titulo}</strong>
        <span>{descricao}</span>
      </span>
      {externo && <IconeLink size={16} />}
    </>
  );
  if (href) {
    return (
      <a className="mais-item" href={href} target={externo ? '_blank' : undefined} rel={externo ? 'noopener noreferrer' : undefined}>
        {conteudo}
      </a>
    );
  }
  return <button type="button" className="mais-item" onClick={onClick}>{conteudo}</button>;
}

function Metodologia({ onFechar }: { onFechar: () => void }) {
  return (
    <section className="mais-detalhe" aria-labelledby="metodologia-titulo">
      <button type="button" className="visao-estado-voltar" onClick={onFechar}>Mais</button>
      <h2 id="metodologia-titulo">Metodologia</h2>
      <div className="mais-texto">
        <p>Os números vêm diretamente dos arquivos públicos de totalização do TSE, os mesmos que alimentam o Boletim de Urna e o painel oficial.</p>
        <p><strong>Totalização</strong> é a soma de todos os boletins de urna já processados — é diferente de <strong>apuração</strong>, que acontece em cada seção eleitoral. O percentual mostrado aqui é sempre a fração de seções já totalizadas.</p>
        <p>Os candidatos são ordenados pelo número de votos. Para Deputado Federal, Estadual e Distrital, a eleição é proporcional: estar bem colocado na lista de mais votados não garante uma vaga, que depende do quociente partidário calculado pelo TSE.</p>
        <p>O site consulta os arquivos do TSE em intervalos regulares (o status dos dados mostra a frequência atual) e atualiza a tela automaticamente, sem precisar recarregar a página.</p>
      </div>
    </section>
  );
}

function SobreOProjeto({ onFechar }: { onFechar: () => void }) {
  return (
    <section className="mais-detalhe" aria-labelledby="sobre-titulo">
      <button type="button" className="visao-estado-voltar" onClick={onFechar}>Mais</button>
      <h2 id="sobre-titulo">Sobre o projeto</h2>
      <div className="mais-texto">
        <p>Projeto de código aberto, sem vínculo com o TSE, criado para acompanhar a totalização das eleições de 2026 de forma simples e direta.</p>
        <p>O código é público no GitHub — qualquer pessoa pode conferir como os dados são tratados, relatar problemas ou contribuir.</p>
        <a className="mais-link-externo" href={URL_REPOSITORIO} target="_blank" rel="noopener noreferrer">
          <IconeGitHub /> Ver no GitHub
        </a>
      </div>
    </section>
  );
}

export function Mais({ tema, onAlternarTema }: { tema: Tema; onAlternarTema: () => void }) {
  const [tela, setTela] = useState<'lista' | 'sobre' | 'metodologia'>('lista');
  const [compartilhado, setCompartilhado] = useState(false);

  async function compartilhar() {
    const dados = { title: 'Eleições 2026 — Totalização ao vivo', url: location.origin };
    if (navigator.share) {
      try { await navigator.share(dados); return; } catch { /* usuário cancelou ou falhou: cai no fallback */ }
    }
    try {
      await navigator.clipboard.writeText(dados.url);
      setCompartilhado(true);
      setTimeout(() => setCompartilhado(false), 2000);
    } catch { /* sem clipboard disponível: nada a fazer */ }
  }

  if (tela === 'sobre') return <SobreOProjeto onFechar={() => setTela('lista')} />;
  if (tela === 'metodologia') return <Metodologia onFechar={() => setTela('lista')} />;

  return (
    <section className="mais-pagina" aria-labelledby="mais-titulo">
      <h2 id="mais-titulo">Mais</h2>
      <p className="resumo-estados">Informações e configurações.</p>

      <div className="mais-lista">
        <ItemLista icone={<IconeSobre />} titulo="Sobre o projeto" descricao="Acompanhe os dados oficiais do TSE" onClick={() => setTela('sobre')} />
        <ItemLista icone={<IconeFonte />} titulo="Fonte dos dados" descricao="Tribunal Superior Eleitoral (TSE)" href={URL_TSE} externo />
        <ItemLista icone={<IconeLink />} titulo="Ver no TSE" descricao="Acesse o portal oficial" href={URL_TSE} externo />
        <ItemLista icone={<IconeMetodologia />} titulo="Metodologia" descricao="Como os dados são processados" onClick={() => setTela('metodologia')} />
        <ItemLista icone={<IconeCompartilhar />} titulo="Compartilhar" descricao={compartilhado ? 'Link copiado!' : 'Envie para seus amigos'} onClick={() => void compartilhar()} />
        <ItemLista icone={<IconeGitHub />} titulo="Código aberto" descricao="Veja no GitHub e deixe sua estrela" href={URL_REPOSITORIO} externo />
      </div>

      <div className="mais-lista">
        <ItemLista
          icone={tema === 'escuro' ? <IconeSol /> : <IconeLua />}
          titulo={tema === 'escuro' ? 'Tema claro' : 'Tema escuro'}
          descricao={tema === 'escuro' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
          onClick={onAlternarTema} />
      </div>

      <StatusDados />
    </section>
  );
}
