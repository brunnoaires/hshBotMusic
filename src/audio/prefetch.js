import { resolveAudio } from './resolve.js';
import { createLogger } from '../logger.js';

const log = createLogger('prefetch');

const inFlight = new Set();

/**
 * Resolve antecipadamente as proximas faixas da fila do Spotify.
 *
 * O resultado e descartado de proposito: o que interessa e o efeito colateral
 * de popular o cache. Quando voce chegar nessa faixa, o resolve vira consulta
 * em memoria e a musica entra na hora, em vez dos ~3.4s da busca.
 *
 * Roda em serie, uma faixa por vez: sao processos do yt-dlp, e nao ha pressa —
 * a faixa atual ainda tem minutos pela frente.
 */
export async function prefetch(tracks) {
  for (const track of tracks) {
    if (!track?.id || inFlight.has(track.id)) continue;

    inFlight.add(track.id);
    const started = Date.now();
    try {
      const source = await resolveAudio(track);
      if (source) {
        log.debug(`pronta em ${Date.now() - started}ms: ${track.artists} - ${track.title}`);
      }
    } catch (err) {
      // Prefetch e best-effort: se falhar, a faixa so resolve na hora de tocar.
      log.debug(`falhou para "${track.title}": ${err.message}`);
    } finally {
      inFlight.delete(track.id);
    }
  }
}
