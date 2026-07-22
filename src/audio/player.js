import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { invalidateStream, resolveAudio } from './resolve.js';
import { spawnFfmpeg } from './ffmpeg.js';
import { createLogger } from '../logger.js';

const log = createLogger('player');

// Processos que nos mesmos matamos. Sem isso o encerramento normal de uma troca
// de faixa seria confundido com o stream morrendo sozinho.
const killedByUs = new WeakSet();

/**
 * Toca no Discord o que esta tocando no Spotify.
 *
 * Dois modos:
 *   follow — troca no Spotify interrompe e toca a nova na hora (padrao)
 *   queue  — troca no Spotify enfileira; a atual termina antes
 *
 * O audio sai do ffmpeg ja como ogg/opus, que e o formato que o Discord aceita
 * cru. Isso evita depender de um encoder opus nativo (@discordjs/opus), que e
 * justamente a dependencia que mais quebra em instalacao no Windows.
 */
export class SyncPlayer {
  #connection = null;
  #audioPlayer;
  #ffmpeg = null;
  /** Invalida trabalhos de resolucao que ficaram obsoletos no meio do caminho. */
  #generation = 0;
  /** Geracao do que esta no ar, para distinguir fim natural de interrupcao. */
  #playingGeneration = 0;

  queue = [];
  current = null;
  /**
   * Uma faixa esta sendo resolvida agora. `current` so aparece depois da
   * resolucao, entao quem checa "esta tocando?" antes disso ve um player livre
   * que ja tem trabalho a caminho.
   */
  carregando = false;
  mode;
  syncPosition;
  /** Chamado quando o audio realmente comeca, com a faixa ja resolvida. */
  onTrackStart = null;

  constructor({ mode, syncPosition }) {
    this.mode = mode;
    this.syncPosition = syncPosition;

    this.#audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => this.#onPlaybackEnded());

    this.#audioPlayer.on('error', (err) => {
      log.error('erro no audio player:', err.message);
      this.#onPlaybackEnded();
    });
  }

  /**
   * Fim de uma reproducao. Precisa distinguir dois casos que chegam pelo mesmo
   * evento: a faixa acabou sozinha (avanca a fila) ou nos a cortamos para tocar
   * outra coisa (nao avanca — senao a fila dispara junto com a faixa nova e as
   * duas brigam pelo player).
   */
  #onPlaybackEnded() {
    if (this.#playingGeneration !== this.#generation) return;

    this.current = null;
    const next = this.queue.shift();
    // Faixa que esperou na fila comeca do zero: o progresso capturado no
    // momento em que ela entrou nao vale mais nada.
    if (next) void this.play(next, { fromStart: true });
  }

  get connected() {
    return this.#connection?.state.status === VoiceConnectionStatus.Ready;
  }

  get channelId() {
    return this.#connection?.joinConfig.channelId ?? null;
  }

  async join(channel) {
    if (this.channelId === channel.id && this.connected) return;
    this.leave();

    this.#connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    const connection = this.#connection;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Pode ser so uma troca de regiao de voz; tenta reatar antes de desistir.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log.warn('conexao de voz perdida');
        if (this.#connection === connection) this.leave();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      // Sem isso a conexao morta fica pendurada e bloqueia a proxima tentativa.
      this.leave();
      throw err;
    }

    connection.subscribe(this.#audioPlayer);
    log.info(`conectado em #${channel.name}`);
  }

  leave() {
    this.#killFfmpeg();
    // Invalida resolucao em andamento: sem isso, sair durante a busca deixaria
    // ela terminar depois e subir um ffmpeg orfao numa conexao ja destruida.
    this.#generation++;
    this.carregando = false;
    this.queue = [];
    this.current = null;
    this.#audioPlayer.stop(true);

    if (this.#connection && this.#connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.#connection.destroy();
    }
    this.#connection = null;
  }

  /** Reage a uma troca de faixa no Spotify, conforme o modo ativo. */
  async onSpotifyTrack(track) {
    if (!this.connected) return;

    if (this.mode === 'queue' && this.current) {
      this.queue.push(track);
      log.info(`enfileirado: ${track.artists} - ${track.title} (${this.queue.length} na fila)`);
      return;
    }

    await this.play(track);
  }

  /**
   * Resolve e toca uma faixa imediatamente, cortando o que estiver tocando.
   * Se SYNC_POSITION estiver ligado, comeca no mesmo ponto do seu Spotify,
   * compensando o tempo gasto resolvendo o audio.
   */
  async play(track, { fromStart = false, allowRetry = true } = {}) {
    const generation = ++this.#generation;
    const startedAt = Date.now();
    this.carregando = true;

    let source;
    try {
      source = await resolveAudio(track);
    } catch (err) {
      log.error(`falha ao resolver "${track.title}":`, err.message);
      if (generation === this.#generation) this.carregando = false;
      return;
    }

    // Voce ja trocou de musica de novo enquanto isso resolvia — descarta.
    // A flag fica com a resolucao mais nova, que ainda esta em andamento.
    if (generation !== this.#generation) {
      log.debug(`descartando "${track.title}": faixa obsoleta`);
      return;
    }

    this.carregando = false;
    if (!source) return;

    // Soma o tempo gasto resolvendo, senao a faixa entra atrasada por esse tanto.
    const seekMs =
      this.syncPosition && !fromStart ? (track.progressMs ?? 0) + (Date.now() - startedAt) : 0;

    this.#killFfmpeg();

    const proc = spawnFfmpeg(source, seekMs);
    const spawnedAt = Date.now();
    this.#ffmpeg = proc;

    proc.on('close', (code, signal) => {
      // URL assinada vencida ou revogada faz o ffmpeg morrer em segundos sem
      // produzir nada. Como ela pode ter vindo do cache, vale invalidar e tentar
      // de novo com uma URL fresca — uma vez so, para nao entrar em loop.
      const morreuNaLargada = !signal && code !== 0 && Date.now() - spawnedAt < 5_000;
      if (killedByUs.has(proc) || !morreuNaLargada) return;
      if (generation !== this.#generation || !allowRetry) return;

      log.warn(`stream de "${source.title}" caiu na largada (codigo ${code}); renovando URL`);
      invalidateStream(source.id);
      void this.play(track, { fromStart, allowRetry: false });
    });

    const resource = createAudioResource(proc.stdout, {
      inputType: StreamType.OggOpus,
    });

    this.#playingGeneration = generation;
    this.#audioPlayer.play(resource);
    this.current = { ...track, youtubeTitle: source.title, seekMs };

    log.info(
      `tocando "${source.title}"` + (seekMs > 1000 ? ` a partir de ${Math.round(seekMs / 1000)}s` : ''),
    );

    // Anunciar so aqui garante que o cartao ja sai com o video escolhido e a
    // posicao real de entrada, em vez dos dados crus do Spotify.
    this.onTrackStart?.(this.current);
  }

  skip() {
    const skipped = this.current;
    this.#killFfmpeg();
    this.#audioPlayer.stop(true);
    return skipped;
  }

  pause() {
    this.#audioPlayer.pause();
  }

  resume() {
    this.#audioPlayer.unpause();
  }

  #killFfmpeg() {
    const proc = this.#ffmpeg;
    if (!proc) return;

    this.#ffmpeg = null;
    killedByUs.add(proc);
    proc.kill('SIGKILL');
    proc.stdout.destroy();
  }
}
