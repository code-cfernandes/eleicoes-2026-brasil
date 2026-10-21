import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { rotasEventos } from './api/eventos.ts';
import { rotasNotificacoes } from './api/notificacoes.ts';
import { rotasNovidades } from './api/novidades.ts';
import { rotasPaineis } from './api/paineis.ts';
import { rotasResultados } from './api/resultados.ts';
import { rotasSistema } from './api/sistema.ts';
import { config } from './config/config.ts';
import { fechar } from './dados/banco.ts';
import { descobrirCodigos } from './servicos/codigos.ts';
import { iniciarTarefas, pararTarefas } from './servicos/coletor.ts';
import { encerrarTodas } from './servicos/tempo-real.ts';

// Inicialização do servidor. As camadas, de fora para dentro:
//   api/          rotas HTTP: validam a entrada e montam a resposta (ETag, 304, gzip)
//   servicos/     orquestram regras, dados e integrações (resultados, coletor, avisos, novidades…)
//   dominio/      regras e dados do domínio, sem I/O (cargos)
//   dados/        SQLite: conexão, tabelas e consultas
//   integracoes/  sistemas externos (TSE, fotos, IA)
//   config/       variáveis de ambiente e configuração dos turnos
// Cada camada só importa as de baixo (api → servicos → dominio/dados/integracoes → config).
// Exceção: config usa dominio/cargos.ts (dado estático) para validar o MONITORAR.

const app = express();
app.use(compression()); // JSON de deputados cai de ~250 kB para ~35 kB
app.use(rotasResultados, rotasPaineis, rotasNovidades, rotasEventos, rotasNotificacoes, rotasSistema);

// Arquivos do Vite têm hash no nome: cache de 1 ano. index.html sempre revalida.
app.use(express.static(fileURLToPath(new URL('../dist/web', import.meta.url)), {
  setHeaders: (res, caminho) => res.setHeader('Cache-Control',
    caminho.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));

// Na subida, antes de tudo: descobre os códigos que o ambiente não define (limite de 10s; se o TSE
// não responder, segue com o que tem e o coletor tenta de novo a cada rodada)
await descobrirCodigos();
console.log(`Códigos: ${config.turnos.map((t) => `${t.nome} federal ${t.eleicao.federal ?? '—'} / estadual ${t.eleicao.estadual ?? '—'}`).join(' · ')}`);
console.log(`Turno atual: ${config.turnoAtual}º · monitorando ${config.monitorar.map((p) => p.join(':')).join(', ')}`);
iniciarTarefas();

const servidor = app.listen(config.port, () => console.log(`http://localhost:${config.port}`));

// docker stop manda SIGTERM: fecha o SQLite limpo (checkpoint do WAL)
for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    pararTarefas();
    encerrarTodas(); // navegadores reconectam sozinhos na próxima instância
    servidor.close(() => { fechar(); process.exit(0); });
    servidor.closeAllConnections();
  });
}
