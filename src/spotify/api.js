import { createLogger } from '../logger.js';

const log = createLogger('spotify-api');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

/** Erro lancado quando o Spotify pede para desacelerar (HTTP 429). */
export class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`Rate limit do Spotify; aguardar ${retryAfterSeconds}s`);
    this.retryAfterMs = retryAfterSeconds * 1000;
  }
}

function normalizeItem(item) {
  return {
    id: item.id,
    uri: item.uri,
    url: item.external_urls?.spotify ?? null,
    title: item.name,
    artists: item.artists.map((a) => a.name).join(', '),
    album: item.album?.name ?? null,
    artwork: item.album?.images?.[0]?.url ?? null,
    durationMs: item.duration_ms,
    progressMs: 0,
    isPlaying: false,
    source: 'api',
  };
}

function normalize(payload) {
  return {
    ...normalizeItem(payload.item),
    progressMs: payload.progress_ms ?? 0,
    isPlaying: Boolean(payload.is_playing),
  };
}

export class SpotifyApi {
  #clientId;
  #clientSecret;
  #refreshToken;
  #accessToken = null;
  #expiresAt = 0;

  constructor({ clientId, clientSecret, refreshToken }) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#refreshToken = refreshToken;
  }

  /** A Web API so entra em jogo se as tres credenciais existirem. */
  get enabled() {
    return Boolean(this.#clientId && this.#clientSecret && this.#refreshToken);
  }

  async #token() {
    // Renova 30s antes de expirar para nao correr o risco de usar token morto.
    if (this.#accessToken && Date.now() < this.#expiresAt - 30_000) {
      return this.#accessToken;
    }

    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.#refreshToken,
      }),
    });

    if (!res.ok) {
      throw new Error(`Falha ao renovar o token do Spotify (${res.status}): ${await res.text()}`);
    }

    const json = await res.json();
    this.#accessToken = json.access_token;
    this.#expiresAt = Date.now() + json.expires_in * 1000;
    // O Spotify as vezes devolve um refresh token novo; se vier, adota.
    if (json.refresh_token) this.#refreshToken = json.refresh_token;
    log.debug(`token renovado, valido por ${json.expires_in}s`);

    return this.#accessToken;
  }

  /**
   * Faixa tocando agora, ou null se nada estiver tocando / for podcast.
   * @returns {Promise<object|null>}
   */
  async currentlyPlaying() {
    const res = await fetch(`${API_BASE}/me/player/currently-playing?additional_types=track`, {
      headers: { authorization: `Bearer ${await this.#token()}` },
    });

    if (res.status === 204) return null;
    if (res.status === 429) {
      throw new RateLimitError(Number(res.headers.get('retry-after') ?? 5));
    }
    if (!res.ok) {
      throw new Error(`currently-playing falhou (${res.status}): ${await res.text()}`);
    }

    const json = await res.json();
    if (!json?.item || json.currently_playing_type !== 'track') return null;

    return normalize(json);
  }

  /**
   * Proximas faixas da fila do Spotify — a materia-prima do prefetch.
   *
   * Endpoint historicamente instavel, e a fila e opcional para o bot funcionar:
   * qualquer falha vira lista vazia em vez de erro.
   */
  async queue(limit = 2) {
    try {
      const res = await fetch(`${API_BASE}/me/player/queue`, {
        headers: { authorization: `Bearer ${await this.#token()}` },
      });
      if (!res.ok) {
        log.debug(`fila indisponivel (${res.status})`);
        return [];
      }

      const json = await res.json();
      return (json?.queue ?? [])
        .filter((item) => item?.id && item.type === 'track')
        .slice(0, limit)
        .map(normalizeItem);
    } catch (err) {
      log.debug(`fila indisponivel: ${err.message}`);
      return [];
    }
  }

  /**
   * Procura uma faixa no catalogo do Spotify e devolve os metadados canonicos.
   *
   * Usado pelo /sr para identificar a musica antes de buscar o audio no YouTube:
   * nome e artista corretos e, sobretudo, a duracao exata para ranquear. Nao toca
   * nada — o Spotify nao entrega audio. Retorna null se nao achar ou falhar.
   *
   * Usa limit=8, nao 1: com limit=1 o Spotify aplica um ranking mais cru e
   * "die for you joji" volta "Slow Dancing in the Dark" (a mais popular do Joji).
   * Com o limite maior o ranking correto entra e o item[0] ja acerta — inclusive
   * com erro de digitacao ("gorilaz fill god" -> Gorillaz), que a busca fuzzy do
   * proprio Spotify resolve melhor do que qualquer casamento de palavra nosso.
   */
  async searchTrack(texto) {
    try {
      const params = new URLSearchParams({ q: texto, type: 'track', limit: '8' });
      const res = await fetch(`${API_BASE}/search?${params}`, {
        headers: { authorization: `Bearer ${await this.#token()}` },
      });
      if (!res.ok) {
        log.debug(`busca no Spotify falhou (${res.status})`);
        return null;
      }

      const item = (await res.json())?.tracks?.items?.find((i) => i?.id);
      return item ? normalizeItem(item) : null;
    } catch (err) {
      log.debug(`busca no Spotify indisponivel: ${err.message}`);
      return null;
    }
  }

  /**
   * Faixa por id — usado quando o /sr recebe um link do Spotify. Metadados
   * canonicos direto, sem busca; o audio ainda vem do YouTube.
   */
  async getTrack(id) {
    try {
      const res = await fetch(`${API_BASE}/tracks/${id}`, {
        headers: { authorization: `Bearer ${await this.#token()}` },
      });
      if (!res.ok) {
        log.debug(`faixa ${id} indisponivel no Spotify (${res.status})`);
        return null;
      }

      const item = await res.json();
      return item?.id ? normalizeItem(item) : null;
    } catch (err) {
      log.debug(`getTrack falhou: ${err.message}`);
      return null;
    }
  }
}
