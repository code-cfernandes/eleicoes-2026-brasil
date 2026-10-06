import { config, env, envNumero } from './config.ts';

// Cliente do DeepSeek: redige frases curtas e neutras para a linha do tempo de Presidente/Brasil.
// A IA só reescreve os fatos já detectados pelo código (que continuam sendo a fonte da verdade);
// ela não inventa números nem nomes. Sem DEEPSEEK_API_KEY, fica desligado e a linha do tempo
// segue com as frases-modelo.

const chave = config.simulacao ? undefined : env('DEEPSEEK_API_KEY'); // simulação não gasta API
const modelo = env('DEEPSEEK_MODEL') ?? 'deepseek-chat';
const base = (env('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const TEMPO_MAX_MS = 15_000;

export const iaDisponivel = () => !!chave;
export const intervaloIaMs = () => envNumero('IA_INTERVALO_MIN', 15) * 60_000;

const SISTEMA = [
  'Você redige uma única frase curta de notícia, em português do Brasil, sobre a totalização das eleições.',
  'Regras obrigatórias:',
  '- Apenas reescreva os fatos fornecidos, de forma natural e neutra. NÃO acrescente números, nomes, datas ou juízos que não estejam no texto original.',
  '- Nenhuma opinião, adjetivo político, previsão ou interpretação.',
  '- Sem markdown, sem emoji, sem aspas decorativas.',
  '- Máximo de ~40 palavras.',
].join('\n');

export async function redigir(fatos: string): Promise<string | null> {
  if (!chave) return null;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
      signal: AbortSignal.timeout(TEMPO_MAX_MS),
      body: JSON.stringify({
        model: modelo,
        messages: [
          { role: 'system', content: SISTEMA },
          { role: 'user', content: fatos },
        ],
        temperature: 0.3,
        max_tokens: 120,
        stream: false,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const texto = json.choices?.[0]?.message?.content?.trim();
    return texto || null;
  } catch {
    return null; // timeout, rede ou resposta malformada: a frase-modelo continua valendo
  }
}
