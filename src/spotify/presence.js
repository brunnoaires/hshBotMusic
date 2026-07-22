import { ActivityType } from 'discord.js';

/**
 * Extrai a faixa do Spotify da presence de um usuario no Discord.
 *
 * Depende de o usuario ter o Spotify conectado a conta do Discord e a opcao
 * "Exibir o Spotify como seu status" ligada. Nao ha OAuth aqui: o Discord ja
 * publica esses dados na presence, e o evento chega por push (instantaneo).
 *
 * @returns {object|null} faixa normalizada, ou null se nao estiver ouvindo.
 */
export function readSpotifyActivity(presence) {
  const activity = presence?.activities?.find(
    (a) => a.type === ActivityType.Listening && a.name === 'Spotify' && a.syncId,
  );
  if (!activity) return null;

  const start = activity.timestamps?.start?.getTime() ?? null;
  const end = activity.timestamps?.end?.getTime() ?? null;

  let artwork = null;
  try {
    artwork = activity.assets?.largeImageURL() ?? null;
  } catch {
    // assets do Spotify as vezes vem em formato inesperado; capa e opcional.
  }

  return {
    id: activity.syncId,
    uri: `spotify:track:${activity.syncId}`,
    url: `https://open.spotify.com/track/${activity.syncId}`,
    title: activity.details ?? 'Desconhecido',
    artists: activity.state ?? 'Desconhecido',
    album: activity.assets?.largeText ?? null,
    artwork,
    durationMs: start && end ? end - start : null,
    // A presence nao informa progresso; deriva do timestamp de inicio.
    progressMs: start ? Math.max(0, Date.now() - start) : 0,
    isPlaying: true,
    source: 'presence',
  };
}
