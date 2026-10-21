import { Router, type Request, type Response } from 'express';
import { CARGOS } from '../dominio/cargos.ts';
import { obter } from '../servicos/resultados.ts';
import { cargosDoTurno, disputaExiste } from '../servicos/turnos.ts';
import { comprimir, enviarPronto, resumoDaVersao, turnoDe, type CorpoPronto } from './respostas.ts';
import type { DisputaDoTurno, EstadoPanorama, Panorama, RespostaDisputas, ResumoCargo, VisaoEstado } from '../../shared/tipos.ts';

// Visões que juntam várias disputas: o mapa/lista "Por estado", a visão de um estado e o que se
// vota no turno. Todas leem pelo mesmo cache/dedupe de obter(), e o corpo só é refeito quando
// alguma das disputas muda de versão.
export const rotasPaineis = Router();

type Pronto = CorpoPronto & { chave: string; etag: string };

// Mapa/lista "Por estado": % totalizado e líder de cada UF para o cargo pedido
// (?cargo=1 Presidente, padrão, com exterior; 3 Governador; 5 Senador). `brasil` vem sempre de br:1.
// Mil pessoas na aba = 28 consultas ao TSE a cada 30s. Sem mudança, 304.
// ?turno=: no 2º turno, Governador só lista as UFs que tiveram 2º turno.
const CARGOS_PANORAMA = [1, 3, 5];
const panoramasProntos = new Map<string, Pronto>();

rotasPaineis.get('/api/panorama', async (req: Request, res: Response) => {
  const cargo = Number(req.query.cargo ?? 1);
  const turno = turnoDe(req.query.turno);
  const cargoTurno = turno === null ? undefined : cargosDoTurno(turno).find((c) => c.codigo === cargo);
  if (turno === null || !CARGOS_PANORAMA.includes(cargo) || !cargoTurno) {
    res.status(400).json({ erro: 'cargo inválido para o turno (use 1, 3 ou 5)' });
    return;
  }
  const ufs = cargoTurno.ufs.filter((u) => u !== 'br' && (cargo === 1 || u !== 'zz'));
  const brasil = disputaExiste(turno, 'br', 1) ? obter('br', 1, turno) : Promise.resolve(null);
  const [brPar, ...pares] = await Promise.allSettled([brasil, ...ufs.map((uf) => obter(uf, cargo, turno))]);
  const br = brPar?.status === 'fulfilled' ? brPar.value : null;
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = [br, ...resultados].map((r) => r?.instante ?? 'x').join(',');

  let pronto = panoramasProntos.get(`${turno}:${cargo}`);
  if (pronto?.chave !== chave) {
    const corpo: Panorama = {
      cargo,
      brasil: { pst: br?.secoesTotalizadas ?? null, instante: br?.instante ?? null, ...(br?.totais && { totais: br.totais }) },
      estados: ufs.map((uf, i): EstadoPanorama => {
        const r = resultados[i];
        const [primeiro, segundo, terceiro] = (r?.candidatos ?? []).filter((c) => c.votos > 0);
        const vagas = r?.vagas ?? 1;
        return {
          uf,
          pst: r ? r.secoesTotalizadas : null,
          instante: r?.instante ?? null,
          lider: primeiro ?? null,
          segundo: vagas > 1 ? segundo : undefined,
          // Vaga única: vantagem do 1º sobre o 2º. Senado (2 vagas): margem da última vaga (2º sobre o 3º).
          vantagem: vagas > 1
            ? (segundo && terceiro ? segundo.percentual - terceiro.percentual : null)
            : (primeiro && segundo ? primeiro.percentual - segundo.percentual : null),
          secoesTotalizadas: r?.totais?.secoesTotalizadas,
          secoes: r?.totais?.secoes,
        };
      }),
    };
    pronto = { chave, etag: `"pan-${turno}-${cargo}-${resumoDaVersao(chave)}"`, ...comprimir(corpo) };
    panoramasProntos.set(`${turno}:${cargo}`, pronto);
  }
  const p = pronto;
  enviarPronto(req, res, p.etag, () => p);
});

// Visão do estado: todos os cargos da UF com os mais votados (3 para Presidente, 5 nos demais).
// No 2º turno, um estado pode não ter disputa nenhuma (Governador decidido no 1º): cargos vazio.
const TOP_ESTADO: Record<number, number> = { 1: 3 };
const visoesProntas = new Map<string, Pronto>();

rotasPaineis.get('/api/estado', async (req: Request, res: Response) => {
  const uf = String(req.query.uf ?? '').toLowerCase();
  const turno = turnoDe(req.query.turno);
  if (turno === null || uf === 'br' || !CARGOS[1]!.ufs.includes(uf)) {
    res.status(400).json({ erro: 'uf ou turno inválido' });
    return;
  }
  const cargos = cargosDoTurno(turno).filter((c) => c.ufs.includes(uf));
  const pares = await Promise.allSettled(cargos.map((c) => obter(uf, c.codigo, turno)));
  const resultados = pares.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const chave = resultados.map((r) => r?.instante ?? 'x').join(',');

  let pronto = visoesProntas.get(`${turno}:${uf}`);
  if (pronto?.chave !== chave) {
    const corpo: VisaoEstado = {
      uf,
      cargos: cargos.map((c, i): ResumoCargo => {
        const r = resultados[i];
        return {
          cargo: c.codigo,
          nome: c.nome,
          proporcional: c.proporcional,
          vagas: r?.vagas ?? 1,
          pst: r ? r.secoesTotalizadas : null,
          instante: r?.instante ?? null,
          total: r?.candidatos.length ?? 0,
          candidatos: (r?.candidatos ?? []).filter((x) => x.votos > 0).slice(0, TOP_ESTADO[c.codigo] ?? 5),
        };
      }),
    };
    pronto = { chave, etag: `"est-${turno}-${uf}-${resumoDaVersao(chave)}"`, ...comprimir(corpo) };
    visoesProntas.set(`${turno}:${uf}`, pronto);
  }
  const p = pronto;
  enviarPronto(req, res, p.etag, () => p);
});

// O que se vota no turno, por disputa, com os candidatos (no 2º turno, os dois finalistas), mesmo
// antes de haver votos. Para a tela de espera do 2º turno. Só disputas majoritárias e só no nível
// que decide: Presidente no Brasil ('br'), Governador/Senador por UF.
// Também alimenta o placar dos governadores no Início durante a apuração: sem mudança, 304.
rotasPaineis.get('/api/disputas', async (req: Request, res: Response) => {
  const turno = turnoDe(req.query.turno);
  if (turno === null) {
    res.status(400).json({ erro: 'turno inválido' });
    return;
  }
  const pares = cargosDoTurno(turno).filter((c) => !c.proporcional)
    .flatMap((c) => (c.ufs.includes('br') ? ['br'] : c.ufs).map((uf) => ({ cargo: c, uf })));
  const resultados = await Promise.allSettled(pares.map((p) => obter(p.uf, p.cargo.codigo, turno)));
  const corpo: RespostaDisputas = {
    turno,
    disputas: pares.flatMap(({ cargo, uf }, i): DisputaDoTurno[] => {
      const r = resultados[i]!;
      if (r.status !== 'fulfilled') return [];
      // Vaga única no 2º turno: os dois primeiros bastam (no 1º turno viria a lista toda)
      const candidatos = turno > 1 ? r.value.candidatos.slice(0, 2) : r.value.candidatos;
      return [{ cargo: cargo.codigo, nome: cargo.nome, uf, pst: r.value.secoesTotalizadas, instante: r.value.instante, candidatos }];
    }),
  };
  const versao = corpo.disputas.map((d) => `${d.uf}${d.cargo}:${d.instante ?? 0}`).join(',');
  res.set({ ETag: `"disp-${turno}-${resumoDaVersao(versao)}"`, 'Cache-Control': 'no-cache' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.json(corpo);
});
