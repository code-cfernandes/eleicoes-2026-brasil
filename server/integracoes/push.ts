import webpush, { type PushSubscription } from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config/config.ts';
import { env } from '../config/ambiente.ts';

// Web Push: chaves VAPID, validação das inscrições e a fila de envio para os push services
// (Google, Apple, Mozilla, Microsoft). Não sabe nada de disputas nem de banco: quem chama decide
// para quem vai cada aviso e o que fazer com inscrições que expiraram.

const CONCORRENCIA = 25; // envios simultâneos (cada um é uma requisição ao push service)

// --- Chaves VAPID: identificam este servidor nos push services. Precisam ser estáveis:
// se mudarem, todas as inscrições existentes deixam de funcionar. Ficam no volume.
function carregarVapid() {
  const publicKey = env('VAPID_PUBLICA'), privateKey = env('VAPID_PRIVADA');
  if (publicKey && privateKey) {
    return { publicKey, privateKey };
  }
  const arquivo = join(dirname(config.historicoDb), 'vapid.json');
  if (existsSync(arquivo)) return JSON.parse(readFileSync(arquivo, 'utf8')) as { publicKey: string; privateKey: string };
  const chaves = webpush.generateVAPIDKeys();
  writeFileSync(arquivo, JSON.stringify(chaves), { mode: 0o600 });
  console.log(`Chaves VAPID geradas em ${arquivo}`);
  return chaves;
}
const vapid = carregarVapid();
// Contato exigido pelos push services: "mailto:..." ou "https://...". Um e-mail puro (o jeito
// natural de preencher) vira mailto: sozinho. Valor inválido não pode derrubar o site: o
// web-push lança exceção na subida, e o container entrava em loop de reinício.
const CONTATO_PADRAO = 'mailto:apuracao@example.com';
function contatoVapid(): string {
  const bruto = env('VAPID_CONTATO');
  if (!bruto) {
    console.warn('VAPID_CONTATO não definido: a Apple pode recusar pushes sem um contato real (mailto: ou https:)');
    return CONTATO_PADRAO;
  }
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(bruto)) return `mailto:${bruto}`;
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(bruto) || /^https:\/\/\S+$/.test(bruto)) return bruto;
  console.error(`VAPID_CONTATO inválido ("${bruto}"): use um e-mail ou https://... Usando o contato padrão.`);
  return CONTATO_PADRAO;
}
try {
  webpush.setVapidDetails(contatoVapid(), vapid.publicKey, vapid.privateKey);
} catch (e) {
  // Ex.: VAPID_PUBLICA/VAPID_PRIVADA mal copiadas. O site segue no ar; só o push fica fora.
  console.error(`[push] desativado: configuração VAPID inválida (${(e as Error).message})`);
}
export const chavePublica = vapid.publicKey;

// --- Só enviamos para push services conhecidos: sem isso, qualquer um poderia cadastrar
// uma URL arbitrária e usar o servidor para disparar requisições a terceiros.
const HOSTS_PUSH = [
  /(^|\.)fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,   // Chrome, Edge, Android
  /(^|\.)push\.services\.mozilla\.com$/,                            // Firefox
  /(^|\.)push\.apple\.com$/,                                        // Safari / iOS
  /(^|\.)notify\.windows\.com$/,                                    // Edge legado / Windows
];
const HOSTS_EXTRA = (env('PUSH_HOSTS_EXTRA') ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export function inscricaoValida(x: unknown): x is PushSubscription {
  const s = x as PushSubscription | undefined;
  if (typeof s?.endpoint !== 'string' || s.endpoint.length > 1000) return false;
  if (!/^[\w-]{80,100}$/.test(s.keys?.p256dh ?? '') || !/^[\w-]{16,30}$/.test(s.keys?.auth ?? '')) return false;
  try {
    const url = new URL(s.endpoint);
    return url.protocol === 'https:' && (HOSTS_PUSH.some((re) => re.test(url.hostname)) || HOSTS_EXTRA.includes(url.host));
  } catch {
    return false;
  }
}

// --- Envio: fila com concorrência limitada
export interface Destino { endpoint: string; p256dh: string; auth: string }
export interface OpcoesEnvio { topico: string; urgente: boolean; ttl: number }
type Envio = OpcoesEnvio & { inscricao: PushSubscription; payload: string };
const fila: Envio[] = [];
let ativos = 0;
const contadores = { enviados: 0, falhas: 0, expirados: 0 };

// Inscrição morta (404/410 do push service): quem usa a fila decide o que fazer (ex.: apagar)
let aoExpirar: (endpoint: string) => void = () => {};
export const quandoExpirar = (fn: (endpoint: string) => void) => { aoExpirar = fn; };

// Diagnóstico por serviço de push (GET /api/saude): onde os envios falham e com qual erro.
// O corpo do erro do push service traz só o motivo (ex.: {"reason":"BadJwtToken"} da Apple).
type Servico = 'apple' | 'google' | 'mozilla' | 'microsoft' | 'outro';
interface ContagemServico { enviados: number; falhas: number; expirados: number; ultimoErro?: { status: number | null; motivo: string; em: number } }
type ErroPush = { statusCode?: number; body?: string; message?: string };
const porServico = new Map<Servico, ContagemServico>();
function servico(endpoint: string): Servico {
  const host = (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
  if (host.endsWith('push.apple.com')) return 'apple';
  if (host.endsWith('googleapis.com')) return 'google';
  if (host.endsWith('mozilla.com')) return 'mozilla';
  if (host.endsWith('notify.windows.com')) return 'microsoft';
  return 'outro';
}
function contar(endpoint: string, tipo: 'enviados' | 'falhas' | 'expirados', erro?: ErroPush) {
  const s = servico(endpoint);
  const c = porServico.get(s) ?? { enviados: 0, falhas: 0, expirados: 0 };
  c[tipo]++;
  contadores[tipo]++;
  if (erro) c.ultimoErro = { status: erro.statusCode ?? null, motivo: String(erro.body || erro.message || '').trim().slice(0, 160), em: Date.now() };
  porServico.set(s, c);
}

function bombear() {
  while (ativos < CONCORRENCIA && fila.length) {
    const e = fila.shift()!;
    ativos++;
    webpush.sendNotification(e.inscricao, e.payload, {
      TTL: e.ttl,
      urgency: e.urgente ? 'high' : 'normal',
      topic: e.topico, // aviso do mesmo tópico ainda não entregue é substituído pelo novo
      timeout: 10_000,
    })
      .then(() => { contar(e.inscricao.endpoint, 'enviados'); })
      .catch((err: ErroPush) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          contar(e.inscricao.endpoint, 'expirados');
          aoExpirar(e.inscricao.endpoint);
        } else {
          contar(e.inscricao.endpoint, 'falhas', err);
          console.error(`[push ${servico(e.inscricao.endpoint)}] ${err.statusCode ?? ''} ${err.body ?? err.message ?? err}`.trim());
        }
      })
      .finally(() => { ativos--; bombear(); });
  }
}

/** Põe o mesmo payload na fila para cada destino; devolve quantos */
export function enfileirar(destinos: Destino[], payload: string, opcoes: OpcoesEnvio): number {
  for (const d of destinos) {
    fila.push({ ...opcoes, inscricao: { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload });
  }
  bombear();
  return destinos.length;
}

export const estatisticasEnvio = () => ({
  naFila: fila.length + ativos,
  ...contadores,
  porServico: Object.fromEntries(porServico),
});
