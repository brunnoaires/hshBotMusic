import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonCache } from '../audio/cache.js';
import { SpotifyApi } from './api.js';
import { createLogger } from '../logger.js';

const log = createLogger('spotify-users');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// Tokens de Spotify de cada streamer, por id de usuario do Discord. Sao
// CREDENCIAIS de terceiros: o arquivo fica no cache/ (gitignored) e nunca deve
// ser compartilhado. Sem LRU util aqui — 25 usuarios cabem folgado.
const store = new JsonCache({ file: path.join(ROOT, 'cache', 'spotify-users.json') });

/**
 * Troca o "authorization code" (do login OAuth) por um refresh token.
 * @returns {Promise<string|null>} o refresh token, ou null se falhar.
 */
export async function trocarCodigo({ clientId, clientSecret, redirectUri, code }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    log.debug(`troca de code falhou (${res.status}): ${(await res.text()).slice(0, 120)}`);
    return null;
  }
  return (await res.json()).refresh_token ?? null;
}

/**
 * Normaliza o valor guardado. Versoes antigas gravavam so o refresh token como
 * string; agora e um objeto { token, email, nome }. Le os dois formatos.
 */
function entradaDe(valor) {
  if (!valor) return null;
  return typeof valor === 'string' ? { token: valor } : valor;
}

/**
 * Grava/atualiza os dados de um streamer, mesclando com o que ja existe (para o
 * e-mail e o token poderem chegar em momentos diferentes).
 */
export async function salvarUsuario(discordUserId, dados) {
  await store.ready();
  const atual = entradaDe(store.get(discordUserId)) ?? {};
  store.set(discordUserId, { ...atual, ...dados });
  await store.flush();
}

/** Compat: grava so o token (usado pelo /conectar-spotify). */
export function salvarToken(discordUserId, token) {
  return salvarUsuario(discordUserId, { token });
}

/** Esquece o Spotify de um streamer. */
export async function esquecerToken(discordUserId) {
  await store.ready();
  store.delete(discordUserId);
  await store.flush();
}

/** Esse streamer ja tem token (conexao completa)? */
export async function temToken(discordUserId) {
  await store.ready();
  return Boolean(entradaDe(store.get(discordUserId))?.token);
}

/** Lista os streamers conectados, para o dono liberar no painel do Spotify. */
export async function listarUsuarios() {
  await store.ready();
  return store.entries().map(([id, valor]) => {
    const e = entradaDe(valor) ?? {};
    return { id, email: e.email ?? null, nome: e.nome ?? null, temToken: Boolean(e.token) };
  });
}

/**
 * SpotifyApi da conta conectada por um streamer, ou null se ele nao conectou.
 * Cada um usa o proprio token; o client id/secret sao os do app (compartilhado).
 */
export async function apiDoUsuario({ clientId, clientSecret }, discordUserId) {
  await store.ready();
  const refreshToken = entradaDe(store.get(discordUserId))?.token;
  if (!refreshToken) return null;

  return new SpotifyApi({ clientId, clientSecret, refreshToken });
}
