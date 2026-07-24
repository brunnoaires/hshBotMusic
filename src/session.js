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
    /** Quem esta sendo seguido no Spotify. Null = modo jukebox, so /sr. */
    this.driverId = driverId ?? null;
    this.usaApi = api.enabled;

    /** Canal onde /vincular foi usado; e la que os cartoes sao publicados. */
    this.announceChannelId = announceChannelId ?? null;
    this.announceMessage = null;

    /** Pausado por /pausar. Impede o Spotify de retomar por conta propria. */
    this.pausadoPorComando = false;

    /** Ponte com o chat da TikTok, quando /tiktok esta ativo. */
    this.tiktok = null;

    this.player = criarPlayer({ mode: config.defaultMode, syncPosition: config.syncPosition });
    this.watcher = new SpotifyWatcher({ api, intervalMs: config.pollIntervalMs });

    this.watcher.on('track', (track) => {
      // Trocou de musica: se estava pausado por comando, a intencao evidente e
      // ouvir a nova.
      this.pausadoPorComando = false;
      void this.player.onSpotifyTrack(track);
    });
    this.watcher.on('upcoming', (tracks) => void prefetch(tracks));
    this.watcher.on('paused', () => this.player.pause());
    this.watcher.on('stopped', () => this.player.skip());

    // Pausa pedida por comando tem precedencia sobre o estado do Spotify.
    // Sem isso, quem pausasse pelo bot veria a musica voltar sozinha no
    // proximo evento, sem entender o motivo.
    this.watcher.on('resumed', () => {
      if (!this.pausadoPorComando) this.player.resume();
    });

    // Arrastou a barra no Spotify: retoca a posicao daqui. A URL do audio ja
    // esta em cache, entao isso e so respawnar o ffmpeg noutro ponto — barato o
    // suficiente para acompanhar de perto.
    this.watcher.on('seek', (track) => {
      if (this.player.current) void this.player.play(track);
    });
  }

  /** Sem driver, a fila do /sr e a unica fonte. */
  get manual() {
    return this.driverId === null;
  }

  get current() {
    return this.watcher.current ?? this.player.current ?? null;
  }

  /**
   * Enfileira um pedido manual e comeca a tocar se estiver parado.
   *
   * Nao passa pelo player.onSpotifyTrack de proposito: aquele caminho respeita
   * o modo follow, que interromperia a faixa atual. Pedido nunca corta o que ja
   * esta tocando — quem pediu antes ouve inteiro.
   */
  pedir(track, { prioridade = false } = {}) {
    // Checar tambem `carregando`: dois /sr seguidos veriam `current` ainda nulo
    // durante a resolucao do primeiro, e o segundo cortaria o primeiro.
    if (this.player.current || this.player.carregando) {
      // Prioridade (presente da TikTok) entra na frente, mas nunca corta o que
      // ja esta tocando — quem esta ouvindo agora nao perde a faixa.
      if (prioridade) this.player.queue.unshift(track);
      else this.player.queue.push(track);

      const posicao = prioridade ? 1 : this.player.queue.length;
      return { posicao, tocandoAgora: false };
    }

    void this.player.play(track, { fromStart: true });
    return { posicao: 0, tocandoAgora: true };
  }

  /** Quantos pedidos de um usuario (TikTok) estao na fila ou tocando agora. */
  pedidosDe(userId) {
    const naFila = this.player.queue.filter((t) => t.requestedById === userId).length;
    const tocando = this.player.current?.requestedById === userId ? 1 : 0;
    return naFila + tocando;
  }

  /**
   * Move o pedido mais antigo de um usuario para a frente da fila.
   * @returns {boolean} se havia um pedido dele para priorizar.
   */
  priorizarPedidoDe(userId) {
    const idx = this.player.queue.findIndex((t) => t.requestedById === userId);
    if (idx <= 0) return idx === 0; // ja esta na frente, ou nao existe
    const [track] = this.player.queue.splice(idx, 1);
    this.player.queue.unshift(track);
    return true;
  }

  stop() {
    this.watcher.stop();
    this.player.leave();
    this.pararTikTok();

    // Cartao de "reproduzindo agora" so faz sentido enquanto a sessao existe.
    void this.announceMessage?.delete?.().catch(() => {});
    this.announceMessage = null;
  }

  pararTikTok() {
    if (!this.tiktok) return;
    this.tiktok.bridge.detach();
    this.tiktok.connector.stop();
    this.tiktok = null;
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

    // Cada sessao e ~128 kbps de upload continuo mais um ffmpeg. Sem teto, o
    // gargalo aparece como audio picotando para todos ao mesmo tempo, sem
    // nenhuma pista do motivo. Melhor recusar a nova e dizer o porque.
    if (!this.#sessions.has(guildId) && this.#sessions.size >= this.#config.maxSessions) {
      throw new Error(
        `limite de ${this.#config.maxSessions} servidores tocando ao mesmo tempo atingido`,
      );
    }

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
