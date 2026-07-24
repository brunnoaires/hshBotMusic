import { runJson } from './ytdlp.js';
import { resolveCache } from './cache.js';
import { createLogger } from '../logger.js';

const log = createLogger('resolve');

// Marcadores que quase sempre indicam uma versao diferente da que voce esta
// ouvindo. So penalizam se a propria faixa do Spotify nao os tiver no nome.
const VARIANT = /\b(live|ao vivo|cover|reaction|karaoke|instrumental|sped ?up|slowed|nightcore|8d|lyrics? video)\b/i;

const matchKey = (spotifyId) => `match:${spotifyId}`;
const streamKey = (youtubeId) => `stream:${youtubeId}`;

// A URL do googlevideo precisa sobreviver a faixa inteira. Descontando essa
// margem do vencimento real, todo acerto de cache ja vem com folga de sobra.
const STREAM_MARGIN_MS = 15 * 60_000;

function scoreCandidate(entry, track, query) {
  let score = 0;

  // Duracao e o sinal mais confiavel de que e a mesma gravacao.
  if (track.durationMs && entry.duration) {
    const deltaSec = Math.abs(entry.duration * 1000 - track.durationMs) / 1000;
    if (deltaSec <= 3) score += 60;
    else if (deltaSec <= 7) score += 35;
    else if (deltaSec <= 15) score += 10;
    else score -= Math.min(deltaSec, 60);
  }

  const title = (entry.title ?? '').toLowerCase();
  const channel = (entry.channel ?? entry.uploader ?? '').toLowerCase();

  // Canais "- Topic" sao uploads automaticos da gravadora: o match mais limpo.
  if (channel.endsWith('- topic')) score += 30;
  if (title.includes(track.title.toLowerCase())) score += 15;
  if (VARIANT.test(title) && !VARIANT.test(query)) score -= 45;

  return score;
}

/** Busca rasa e barata: so ranqueia candidatos, sem extrair formato de nenhum. */
/** Todos os candidatos da busca, ja ranqueados (melhor primeiro). */
async function rankearCandidatos(track, query) {
  const search = await runJson([
    `ytsearch5:${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
  ]);

  const entries = (search?.entries ?? []).filter((e) => e?.id);
  if (!entries.length) {
    log.warn(`nenhum resultado no YouTube para "${query}"`);
    return [];
  }

  return entries
    .map((entry) => ({ entry, score: scoreCandidate(entry, track, query) }))
    .sort((a, b) => b.score - a.score);
}

async function searchYouTube(track, query) {
  const ranked = await rankearCandidatos(track, query);
  if (!ranked.length) return null;

  const melhor = ranked[0];
  log.debug(`escolhido "${melhor.entry.title}" (score ${melhor.score.toFixed(0)}) para "${query}"`);
  return melhor.entry;
}

/**
 * Lista os candidatos para uma faixa, para o usuario escolher a mao (/rematch).
 * @returns {Promise<Array<{id, title, channel, durationMs, score}>>}
 */
export async function candidatosPara(track) {
  await resolveCache.ready();
  const query = `${track.artists} - ${track.title}`;

  return (await rankearCandidatos(track, query)).map(({ entry, score }) => ({
    id: entry.id,
    title: entry.title ?? entry.id,
    channel: entry.channel ?? entry.uploader ?? '',
    durationMs: entry.duration ? Math.round(entry.duration * 1000) : null,
    score,
  }));
}

/** Fixa manualmente qual video corresponde a uma faixa do Spotify. */
export function fixarMatch(spotifyId, youtubeId) {
  if (spotifyId) resolveCache.set(matchKey(spotifyId), youtubeId);
}

/** Vencimento embutido na propria URL assinada do googlevideo. */
function streamExpiry(url) {
  try {
    const expire = Number(new URL(url).searchParams.get('expire'));
    if (Number.isFinite(expire) && expire > 0) return expire * 1000;
  } catch {
    // URL sem o parametro esperado; cai no padrao conservador abaixo.
  }
  return Date.now() + 60 * 60_000;
}

async function extractStream(youtubeId) {
  const info = await runJson([
    `https://www.youtube.com/watch?v=${youtubeId}`,
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '-f',
    'bestaudio[acodec=opus]/bestaudio/best',
  ]);

  const url = info?.url ?? info?.formats?.findLast((f) => f?.url)?.url;
  if (!url) return null;

  return {
    url,
    // As URLs do googlevideo costumam exigir os mesmos headers da extracao.
    headers: info.http_headers ?? {},
    title: info.title ?? youtubeId,
    id: youtubeId,
  };
}

async function streamFor(youtubeId) {
  const cached = resolveCache.get(streamKey(youtubeId));
  if (cached) return { ...cached, fromCache: true };

  const source = await extractStream(youtubeId);
  if (!source) return null;

  resolveCache.set(streamKey(youtubeId), source, {
    expiresAt: streamExpiry(source.url) - STREAM_MARGIN_MS,
  });

  return source;
}

const buscaKey = (texto) => `busca:${texto.toLowerCase().replace(/\s+/g, ' ').trim()}`;

function melhorMiniatura(entrada) {
  const lista = entrada?.thumbnails ?? [];
  // Ordena por area e pega a maior com URL utilizavel.
  const maior = [...lista]
    .filter((t) => t?.url)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
  return maior?.url ?? entrada?.thumbnail ?? null;
}

/**
 * Pedido manual do /sr: texto de busca ou link direto vira uma faixa tocavel.
 *
 * Diferente do fluxo do Spotify, aqui nao ha duracao de referencia para
 * ranquear — a pessoa digitou o que queria, entao a relevancia do proprio
 * YouTube e o melhor criterio. Uma chamada so, sem a passada de ranking.
 *
 * @returns {Promise<object|null>} faixa no formato que o player espera.
 */
export async function buscarPedido(texto) {
  await resolveCache.ready();

  const ehLink = /^https?:\/\//i.test(texto);

  // Guarda a faixa inteira, nao so o id: guardando o id ainda seria preciso
  // outra chamada ao yt-dlp para os metadados, e a repeticao nao ganharia nada.
  if (!ehLink) {
    const cacheada = resolveCache.get(buscaKey(texto));
    if (cacheada) {
      log.debug(`pedido "${texto}" veio do cache`);
      return { ...cacheada };
    }
  }

  let info;
  try {
    info = await runJson([
      ehLink ? texto : `ytsearch1:${texto}`,
      '--dump-single-json',
      '--flat-playlist',
      // Link de playlist traz so o video apontado, senao um pedido viraria
      // centenas de faixas na fila.
      '--no-playlist',
      '--no-warnings',
    ]);
  } catch (err) {
    log.warn(`pedido "${texto}" falhou: ${err.message}`);
    return null;
  }

  // Busca devolve playlist com entries; link devolve o video direto.
  const entrada = info?.entries?.[0] ?? info;
  if (!entrada?.id) {
    log.warn(`nenhum resultado para o pedido "${texto}"`);
    return null;
  }

  const faixa = {
    id: `yt:${entrada.id}`,
    youtubeId: entrada.id,
    title: entrada.title ?? texto,
    artists: entrada.uploader ?? entrada.channel ?? 'YouTube',
    album: null,
    url: entrada.webpage_url ?? `https://www.youtube.com/watch?v=${entrada.id}`,
    artwork: melhorMiniatura(entrada),
    durationMs: entrada.duration ? Math.round(entrada.duration * 1000) : null,
    progressMs: 0,
    isPlaying: true,
    source: 'pedido',
  };

  if (!ehLink) resolveCache.set(buscaKey(texto), faixa);
  return faixa;
}

/** Descarta a URL assinada de um video (usado quando o ffmpeg leva 403). */
export function invalidateStream(youtubeId) {
  resolveCache.delete(streamKey(youtubeId));
}

/** Esquece o video escolhido para uma faixa, forcando nova busca. */
export function invalidateMatch(spotifyId) {
  resolveCache.delete(matchKey(spotifyId));
}

/**
 * Metadados do Spotify -> URL de audio direta tocavel pelo ffmpeg.
 *
 * O Spotify nao expoe audio em nenhum endpoint, entao a faixa e reprocurada no
 * YouTube. Duas camadas de cache cortam esse trabalho:
 *
 *   match:<spotify id>  -> id do video. Permanente: a escolha nao muda.
 *   stream:<video id>   -> URL assinada. Expira junto com a assinatura.
 *
 * Faixa repetida na mesma sessao acerta as duas e resolve em milissegundos;
 * repetida dias depois acerta so o match e pula a busca, que e a parte cara.
 *
 * @returns {Promise<{url: string, headers: object, title: string, id: string}|null>}
 */
export async function resolveAudio(track) {
  await resolveCache.ready();

  // Pedido manual (/sr) ja chega com o video escolhido: nao ha o que procurar,
  // so extrair o audio. Pula a busca inteira, que e a metade cara.
  if (track.youtubeId) {
    return streamFor(track.youtubeId).catch((err) => {
      log.warn(`extracao falhou para ${track.youtubeId}: ${err.message}`);
      return null;
    });
  }

  const query = `${track.artists} - ${track.title}`;
  const cachedId = track.id ? resolveCache.get(matchKey(track.id)) : null;

  if (cachedId) {
    const source = await streamFor(cachedId).catch((err) => {
      log.warn(`extracao falhou para ${cachedId}: ${err.message}`);
      return null;
    });

    if (source) {
      log.debug(`cache ${source.fromCache ? 'completo' : 'de match'} para "${query}"`);
      return source;
    }

    // Video removido, privado ou bloqueado na regiao: desfaz o vinculo.
    log.warn(`video em cache nao serve mais para "${query}"; procurando de novo`);
    invalidateMatch(track.id);
  }

  const best = await searchYouTube(track, query);
  if (!best) return null;

  const source = await streamFor(best.id);
  if (!source) {
    log.warn(`sem URL de audio utilizavel para "${best.title}"`);
    return null;
  }

  if (track.id) resolveCache.set(matchKey(track.id), best.id);
  return source;
}
