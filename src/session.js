import { ActivityType } from 'discord.js';
import { SpotifyWatcher } from './spotify/watcher.js';
import { SyncPlayer } from './audio/player.js';
import { prefetch } from './audio/prefetch.js';
import { createLogger } from './logger.js';

const log = createLogger('sessions');

/**
 * Fonte inerte para quem nao tem a Web API ligada. O watcher ja sabe operar so
 * pela presence quando a API esta desabilitada — nao precisa de caminho especial.
 */
const SEM_API = {
  enabled: false,
  currentlyPlaying: async () => null,
  queue: async () => [],
};

/**
 * Um servidor sendo comandado por uma pessoa: um player de voz e um watcher.
 *
 * O "driver" e quem rodou /vincular. E a presence dele que alimenta a sessao, e
 * so ele (ou quem gerencia o servidor) pode mexer nos controles.
 */
class GuildSession {
  constructor({ guildId, driverId, api, config, criarPlayer, announceChannelId }) {
    this.guildId = guildId;
    this.driverId = driverId;
    this.usaApi = api.enabled;

    /** Canal onde /vincular foi usado; e la que os cartoes sao publicados. */
    this.announceChannelId = announceChannelId ?? null;
    this.announceMessage = null;

    this.player = criarPlayer({ mode: config.defaultMode, syncPosition: config.syncPosition });
    this.watcher = new SpotifyWatcher({ api, intervalMs: config.pollIntervalMs });

    this.watcher.on('track', (track) => void this.player.onSpotifyTrack(track));
    this.watcher.on('upcoming', (tracks) => void prefetch(tracks));
    this.watcher.on('paused', () => this.player.pause());
    this.watcher.on('resumed', () => this.player.resume());
    this.watcher.on('stopped', () => this.player.skip());
  }

  get current() {
    return this.watcher.current ?? this.player.current ?? null;
  }

  stop() {
    this.watcher.stop();
    this.player.leave();

    // Cartao de "reproduzindo agora" so faz sentido enquanto a sessao existe.
    void this.announceMessage?.delete?.().catch(() => {});
    this.announceMessage = null;
  }
}

/**
 * Todas as sessoes ativas, uma por servidor.
 *
 * A mesma pessoa pode comandar varios servidores ao mesmo tempo: cada um recebe
 * o proprio player e a propria fila, alimentados pela mesma presence.
 */
export class SessionManager {
  #sessions = new Map();
  #config;
  #ownerApi;
  #criarPlayer;
  #onTrackStart;

  // criarPlayer e injetavel para o selfcheck exercitar o roteamento entre
  // servidores sem precisar de conexao de voz real.
  constructor({
    config,
    ownerApi,
    criarPlayer = (opcoes) => new SyncPlayer(opcoes),
    onTrackStart = null,
  }) {
    this.#config = config;
    this.#ownerApi = ownerApi;
    this.#criarPlayer = criarPlayer;
    this.#onTrackStart = onTrackStart;
  }

  get size() {
    return this.#sessions.size;
  }

  get(guildId) {
    return this.#sessions.get(guildId) ?? null;
  }

  list() {
    return [...this.#sessions.values()];
  }

  /**
   * A Web API do .env pertence a uma conta so. Quem for essa pessoa ganha
   * progresso exato, deteccao de pausa e prefetch; os demais rodam pela
   * presence, que nao custa credencial nenhuma.
   */
  #apiPara(userId) {
    const dono = this.#config.discord.ownerId;
    return dono && userId === dono && this.#ownerApi.enabled ? this.#ownerApi : SEM_API;
  }

  async start({ channel, driverId, announceChannelId = null }) {
    const guildId = channel.guild.id;
    this.stop(guildId);

    const session = new GuildSession({
      guildId,
      driverId,
      api: this.#apiPara(driverId),
      config: this.#config,
      criarPlayer: this.#criarPlayer,
      announceChannelId: this.#config.announceTracks ? announceChannelId : null,
    });

    if (this.#onTrackStart) {
      session.player.onTrackStart = () => this.#onTrackStart(session);
    }

    this.#sessions.set(guildId, session);

    try {
      await session.player.join(channel);
    } catch (err) {
      this.#sessions.delete(guildId);
      session.stop();
      throw err;
    }

    session.watcher.start();
    log.info(
      `sessao em ${guildId} para ${driverId} ` +
        `(${session.usaApi ? 'presence + Web API' : 'so presence'})`,
    );

    return session;
  }

  stop(guildId) {
    const session = this.#sessions.get(guildId);
    if (!session) return false;

    session.stop();
    this.#sessions.delete(guildId);
    log.info(`sessao encerrada em ${guildId}`);
    return true;
  }

  stopAll() {
    for (const guildId of [...this.#sessions.keys()]) this.stop(guildId);
  }

  /** Alguem esta comandando alguma sessao com esse id? Filtro barato de eventos. */
  temDriver(userId) {
    for (const session of this.#sessions.values()) {
      if (session.driverId === userId) return true;
    }
    return false;
  }

  /** Distribui a presence de uma pessoa para todos os servidores que ela comanda. */
  onPresence(userId, track) {
    for (const session of this.#sessions.values()) {
      if (session.driverId === userId) session.watcher.onPresence(track);
    }
  }
}

/**
 * Status do bot. Com varias sessoes ao mesmo tempo nao da para exibir uma faixa
 * so, entao mostra a contagem; com uma sessao, mostra a musica.
 */
export function atualizarStatus(client, sessions) {
  const ativas = sessions.list();

  if (ativas.length === 0) {
    client.user?.setActivity(null);
    return;
  }

  if (ativas.length === 1) {
    const track = ativas[0].current;
    client.user?.setActivity(
      track
        ? { name: `${track.title} — ${track.artists}`, type: ActivityType.Listening }
        : null,
    );
    return;
  }

  client.user?.setActivity({
    name: `${ativas.length} servidores`,
    type: ActivityType.Listening,
  });
}
