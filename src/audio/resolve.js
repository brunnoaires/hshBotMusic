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
async function rankearCandidatos(track, query, quantidade = 5) {
  const search = await runJson([
    `ytsearch${quantidade}:${query}`,
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

/**
 * Minusculas sem acento nem pontuacao, para comparar titulos com tolerancia.
 * O NFD separa a letra do acento; o replace seguinte descarta o acento junto com
 * qualquer pontuacao, porque nada disso e a-z0-9.
 */
function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * O video e realmente uma versao desta musica? Exige que todas as palavras
 * significativas do titulo da faixa aparecam no titulo do video. Assim "XTRANHO"
 * traz o clipe, o ao vivo e o acustico, mas corta compilacao e faixa sem relacao.
 */
function ehVersaoDaMusica(videoTitle, trackTitle) {
  const alvo = normalizar(trackTitle);
  if (!alvo) return true;

  const video = normalizar(videoTitle);
  const palavras = alvo.split(' ');
  const significativas = palavras.filter((w) => w.length >= 2);

  return (significativas.length ? significativas : palavras).every((w) => video.includes(w));
}

/**
 * Duracao compativel com uma versao da musica. Um ao vivo estica um pouco, um
 * acelerado encurta — mas album completo, compilacao e video de reacao sao
 * varias vezes mais longos, e e assim que eles passam pelo filtro de nome.
 */
function duracaoPlausivel(entry, trackMs) {
  const seg = entry.duration;
  if (!seg) return true; // sem info de duracao, nao descarta

  if (trackMs) {
    const trackSeg = trackMs / 1000;
    return seg <= trackSeg * 3 && seg >= trackSeg * 0.4;
  }
  return seg <= 900; // sem referencia: corta o que passa de 15 min
}

/**
 * Lista os candidatos para uma faixa, para o usuario escolher a mao (/rematch).
 *
 * Diferente do resolve automatico: busca mais larga (para as variacoes ao vivo,
 * acustico e afins aparecerem) e filtra pelo nome da musica (para o menu ficar
 * so com versoes daquela faixa, nao com compilacao ou resultado sem relacao). A
 * penalidade de variante do ranking so afeta a ordem aqui — nada e escondido.
 *
 * @returns {Promise<Array<{id, title, channel, durationMs, score}>>}
 */
export async function candidatosPara(track, { max = 12 } = {}) {
  await resolveCache.ready();
  const query = `${track.artists} - ${track.title}`;

  const ranked = await rankearCandidatos(track, query, 20);

  const porNome = ranked.filter(({ entry }) => ehVersaoDaMusica(entry.title ?? '', track.title));
  const porNomeEDuracao = porNome.filter(({ entry }) => duracaoPlausivel(entry, track.durationMs));

  // Afrouxa por etapas se ficar sem opcao: nome+duracao -> so nome -> tudo. O
  // /rematch nunca deve abrir um menu vazio.
  const base = porNomeEDuracao.length ? porNomeEDuracao : porNome.length ? porNome : ranked;

  return base.slice(0, max).map(({ entry, score }) => ({
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
 * Com o Spotify disponivel, ele identifica a musica primeiro — nome, artista e,
 * o que mais importa, a duracao exata para ranquear o YouTube. So entao o audio
 * e buscado no YouTube (o Spotify nao entrega audio). Sem Spotify, ou se ele nao
 * achar, cai direto para a busca no YouTube.
 *
 * @param {object} opcoes
 * @param {import('../spotify/api.js').SpotifyApi} [opcoes.spotifyApi]
 * @returns {Promise<object|null>} faixa no formato que o player espera.
 */
export async function buscarPedido(texto, { spotifyApi = null } = {}) {
  await resolveCache.ready();

  // Link do Spotify: pega os metadados canonicos pelo id e resolve o audio no
  // YouTube. Sem isso, o link cairia no yt-dlp e falharia com erro de DRM.
  const spotifyId = idDeLinkSpotify(texto);
  if (spotifyId) {
    if (!spotifyApi?.enabled) {
      log.warn('link do Spotify recebido, mas a Web API nao esta configurada');
      return null;
    }
    const sp = await spotifyApi.getTrack(spotifyId);
    if (!sp) {
      log.warn(`faixa ${spotifyId} nao encontrada no Spotify`);
      return null;
    }
    log.debug(`link do Spotify -> ${sp.artists} - ${sp.title}`);
    return faixaDoSpotify(sp);
  }

  const ehLink = /^https?:\/\//i.test(texto);

  if (!ehLink) {
    // Guarda a faixa inteira, nao so o id: guardando o id ainda seria preciso
    // outra chamada para os metadados, e a repeticao nao ganharia nada.
    const cacheada = resolveCache.get(buscaKey(texto));
    if (cacheada) {
      log.debug(`pedido "${texto}" veio do cache`);
      return { ...cacheada };
    }

    // Spotify identifica a musica; o audio ainda vem do YouTube via resolveAudio,
    // que recebe a faixa SEM youtubeId e faz a busca com duracao de referencia,
    // ranking e fallback entre candidatos.
    if (spotifyApi?.enabled) {
      const sp = await spotifyApi.searchTrack(texto);
      if (sp) {
        const faixa = faixaDoSpotify(sp);
        resolveCache.set(buscaKey(texto), faixa);
        log.debug(`"${texto}" -> Spotify: ${faixa.artists} - ${faixa.title}`);
        return faixa;
      }
      log.debug(`"${texto}" nao achado no Spotify; caindo para o YouTube`);
    }
  }

  return buscarNoYouTube(texto, ehLink);
}

/** Id da faixa em open.spotify.com/track/ID, /intl-xx/track/ID ou spotify:track:ID. */
function idDeLinkSpotify(texto) {
  const m = String(texto).match(
    /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([A-Za-z0-9]+)/i,
  );
  return m ? m[1] : null;
}

/**
 * Faixa do Spotify no formato do player, SEM youtubeId: assim o resolveAudio faz
 * a busca completa no YouTube (duracao de referencia, ranking, fallback).
 */
function faixaDoSpotify(sp) {
  return {
    id: sp.id,
    title: sp.title,
    artists: sp.artists,
    album: sp.album,
    url: sp.url,
    artwork: sp.artwork,
    durationMs: sp.durationMs,
    progressMs: 0,
    isPlaying: true,
    source: 'pedido',
  };
}

/** Busca (ou extrai um link) direto no YouTube e monta a faixa. */
async function buscarNoYouTube(texto, ehLink) {
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

  // Alguns videos existem e sao publicos mas recusam a extracao pela API
  // (upload de gravadora, bloqueio especifico). Em vez de desistir no melhor
  // candidato, percorre os demais ate um tocar — quase sempre ha outro upload
  // da mesma musica que funciona. Cacheia o que REALMENTE tocou, nao o 1o.
  const candidatos = await rankearCandidatos(track, query);
  if (!candidatos.length) return null;

  for (const { entry } of candidatos) {
    const source = await streamFor(entry.id).catch((err) => {
      log.debug(`extracao falhou para ${entry.id}: ${err.message}`);
      return null;
    });

    if (source) {
      if (track.id) resolveCache.set(matchKey(track.id), entry.id);
      return source;
    }
    log.debug(`"${entry.title}" nao extraiu; tentando o proximo candidato`);
  }

  log.warn(`nenhum candidato tocavel para "${query}"`);
  return null;
}
