import { EventEmitter } from 'node:events';
import { RateLimitError } from './api.js';
import { createLogger } from '../logger.js';

const log = createLogger('watcher');

// Quanto a posicao pode divergir do esperado antes de ser considerada um seek.
// Precisa acomodar o intervalo de polling, a latencia da rede e a oscilacao da
// posicao derivada da presence — abaixo disso a faixa reiniciaria sozinha.
const TOLERANCIA_SEEK_MS = 5_000;

/**
 * Junta as duas fontes de "o que esta tocando":
 *
 *   - presence do Discord  -> push, chega em ~1s, mas nao informa progresso
 *                             exato nem distingue pausa de "parou de compartilhar"
 *   - Web API do Spotify   -> polling, sabe progresso em ms, pausa e device
 *
 * Estrategia: quando as duas existem, a API e a fonte da verdade e a presence
 * serve so de gatilho — ao ver um ID diferente ela antecipa o poll, cortando a
 * latencia sem precisar reduzir o intervalo de polling. Se so uma das duas
 * estiver disponivel, ela sozinha comanda.
 *
 * Eventos: 'track' (faixa nova), 'upcoming' (proximas da fila), 'paused',
 * 'resumed', 'stopped'.
 */
export class SpotifyWatcher extends EventEmitter {
  #api;
  #intervalMs;
  #timer = null;
  #polling = false;
  #backoffUntil = 0;
  #upcomingTimer = null;
  #upcomingDelayMs;
  /** Ultima posicao conhecida e quando foi lida, para detectar seek. */
  #posicao = null;

  current = null;

  constructor({ api, intervalMs, upcomingDelayMs = 5_000 }) {
    super();
    this.#api = api;
    this.#intervalMs = intervalMs;
    this.#upcomingDelayMs = upcomingDelayMs;
  }

  start() {
    if (!this.#api.enabled) {
      log.info('Web API desativada (sem credenciais); seguindo apenas pela presence');
      return;
    }
    log.info(`polling da Web API a cada ${this.#intervalMs}ms`);
    this.#timer = setInterval(() => this.poll(), this.#intervalMs);
    this.poll();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#upcomingTimer) clearTimeout(this.#upcomingTimer);
    this.#timer = null;
    this.#upcomingTimer = null;
  }

  /** Chamado pelo listener de presenceUpdate. */
  onPresence(track) {
    if (!this.#api.enabled) {
      // Sem API, a presence e tudo o que temos — inclusive para detectar parada.
      this.#ingest(track);
      return;
    }
    // Com API disponivel, ignora o "sumiu" da presence (pode ser so o usuario
    // desligando o compartilhamento) e deixa o poll confirmar.
    if (!track || track.id === this.current?.id) return;

    log.debug(`presence adiantou troca para "${track.title}"`);
    // Emite ja com o que a presence trouxe em vez de esperar o round-trip da
    // API: sao ~300ms a menos de silencio, e o dedupe por id garante que o poll
    // logo abaixo so vai refinar progresso e estado, sem tocar de novo.
    this.#ingest(track);
    this.poll();
  }

  async poll() {
    if (this.#polling || Date.now() < this.#backoffUntil) return;
    this.#polling = true;

    try {
      this.#ingest(await this.#api.currentlyPlaying());
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.#backoffUntil = Date.now() + err.retryAfterMs;
        log.warn(`rate limit; pausando polling por ${err.retryAfterMs}ms`);
      } else {
        // Backoff curto para nao inundar o log em queda de rede.
        this.#backoffUntil = Date.now() + 10_000;
        log.error('falha no poll:', err.message);
      }
    } finally {
      this.#polling = false;
    }
  }

  #ingest(track) {
    const previous = this.current;
    this.current = track;

    if (!track) {
      this.#posicao = null;
      if (previous) {
        log.info('nada tocando no Spotify');
        this.emit('stopped');
      }
      return;
    }

    if (!previous || previous.id !== track.id) {
      log.info(`faixa: ${track.artists} - ${track.title} (${track.source})`);
      this.#marcarPosicao(track);
      this.emit('track', track);
      this.#scheduleUpcoming();
      return;
    }

    if (previous.isPlaying !== track.isPlaying) {
      log.info(track.isPlaying ? 'retomado' : 'pausado');
      this.emit(track.isPlaying ? 'resumed' : 'paused', track);
      this.#marcarPosicao(track);
      return;
    }

    this.#detectarSeek(previous, track);
  }

  /**
   * Mesma faixa com a posicao fora do lugar significa que voce arrastou a barra.
   *
   * Compara a posicao recebida com a que era esperada pelo tempo decorrido desde
   * a ultima leitura. Sem essa comparacao nao daria para distinguir seek de
   * simples passagem do tempo, porque as duas mudam progressMs.
   */
  #detectarSeek(previous, track) {
    if (!track.isPlaying || !this.#posicao) {
      this.#marcarPosicao(track);
      return;
    }

    const esperado = this.#posicao.progressMs + (Date.now() - this.#posicao.em);
    const desvio = Math.abs((track.progressMs ?? 0) - esperado);

    this.#marcarPosicao(track);

    // A posicao vinda da presence e derivada de timestamps e oscila um pouco; o
    // limiar precisa ser maior que esse ruido para nao reiniciar a faixa a toa.
    if (desvio < TOLERANCIA_SEEK_MS) return;

    log.info(`seek para ${Math.round((track.progressMs ?? 0) / 1000)}s`);
    this.emit('seek', track);
  }

  #marcarPosicao(track) {
    this.#posicao = { progressMs: track.progressMs ?? 0, em: Date.now() };
  }

  /**
   * Consulta a fila do Spotify para antecipar o proximo resolve.
   *
   * Espera alguns segundos de proposito: logo depois de uma troca a faixa atual
   * ainda esta resolvendo, e nao vale competir com ela por rede e CPU. A faixa
   * tem minutos pela frente — a pressa e zero.
   */
  #scheduleUpcoming() {
    if (!this.#api.enabled) return;
    if (this.#upcomingTimer) clearTimeout(this.#upcomingTimer);

    this.#upcomingTimer = setTimeout(async () => {
      const upcoming = await this.#api.queue(2);
      if (upcoming.length) this.emit('upcoming', upcoming);
    }, this.#upcomingDelayMs);

    this.#upcomingTimer.unref();
  }
}
