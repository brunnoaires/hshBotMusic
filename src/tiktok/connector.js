import { EventEmitter } from 'node:events';
import { createLogger } from '../logger.js';

const log = createLogger('tiktok');

/**
 * Conexao com o chat de uma live da TikTok.
 *
 * A TikTok nao tem API publica; a tiktok-live-connector faz scraping da sala via
 * WebSocket interno. Depende de um sign server (EulerStream) e quebra quando a
 * TikTok muda o protocolo — mesma fragilidade do yt-dlp, e igualmente contra os
 * ToS. Para uso pessoal no proprio canal e o caminho padrao da comunidade.
 *
 * A biblioteca e carregada sob demanda: e pesada (protobufs) e opcional, entao
 * um problema nela nao pode impedir o bot de subir.
 *
 * Eventos: 'chat' ({ userId, label, comment }), 'gift' ({ userId, label,
 * giftName, count }), 'connected', 'ended', 'error'.
 */
export class TikTokConnector extends EventEmitter {
  #username;
  #signApiKey;
  #connection = null;
  #parado = false;
  #chatRecebidos = 0;
  #chatLidos = 0;
  #avisouFormato = false;

  constructor({ username, signApiKey = null }) {
    super();
    // Aceita "@nome", "nome" ou a URL da live; a lib normaliza, mas tiramos o @
    // e espacos para o log ficar limpo.
    this.#username = String(username).trim().replace(/^@/, '');
    this.#signApiKey = signApiKey;
  }

  get username() {
    return this.#username;
  }

  get conectado() {
    return Boolean(this.#connection);
  }

  async start() {
    let lib;
    try {
      lib = await import('tiktok-live-connector');
    } catch (err) {
      throw new Error(
        `Suporte a TikTok indisponivel (tiktok-live-connector nao instalado): ${err.message}`,
      );
    }

    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;

    const conn = new TikTokLiveConnection(this.#username, {
      ...(this.#signApiKey ? { signApiKey: this.#signApiKey } : {}),
      // Sem isto, o connect nao rejeita quando o streamer esta offline.
      fetchRoomInfoOnConnect: true,
      processInitialData: false,
    });

    conn.on(WebcastEvent.CHAT, (data) => this.#onChat(data));
    conn.on(WebcastEvent.GIFT, (data) => this.#onGift(data));
    conn.on(WebcastEvent.STREAM_END, () => {
      log.info(`@${this.#username} encerrou a live`);
      this.emit('ended');
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
      if (!this.#parado) log.warn(`desconectado de @${this.#username}`);
      this.emit('disconnected');
    });
    conn.on(ControlEvent.ERROR, (err) => {
      log.error(`erro na conexao com @${this.#username}:`, err?.message ?? err);
      // 'error' sem listener derruba o processo (ERR_UNHANDLED_ERROR). Durante o
      // connect ainda nao ha quem escute — repassa so quando alguem se importa.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    try {
      await conn.connect();
    } catch (err) {
      const nome = err?.constructor?.name ?? '';
      const msg = err?.message ?? '';
      // Todos apontam para "nao ha live acessivel agora": streamer offline,
      // usuario inexistente, ou sala nao encontrada.
      if (
        nome === 'UserOfflineError' ||
        /offline|room id|not.*live/i.test(msg) ||
        /room id/i.test(err?.info ?? '')
      ) {
        throw new Error(
          `@${this.#username} não está em live agora (ou o nome está errado). ` +
            'Confira que a live está no ar e que o @ está certo.',
        );
      }
      throw new Error(`não consegui conectar em @${this.#username}: ${msg}`);
    }

    this.#connection = conn;

    // DIAGNOSTICO: como a roomInfo identifica o dono da live? (para a verificacao
    // de propriedade). Loga os caminhos candidatos, sem despejar o objeto todo.
    const ri = conn.roomInfo ?? {};
    log.debug(`roomInfo chaves: ${Object.keys(ri).slice(0, 20).join(',')}`);
    for (const caminho of ['owner', 'room.owner', 'roomInfo.owner', 'anchor', 'operator']) {
      const obj = caminho.split('.').reduce((o, k) => o?.[k], ri);
      if (obj) {
        log.debug(`roomInfo.${caminho} chaves: ${Object.keys(obj).slice(0, 15).join(',')}`);
        log.debug(`  id=${obj.id ?? obj.id_str ?? obj.uid} handle=${obj.uniqueId ?? obj.display_id ?? obj.unique_id} nick=${obj.nickname}`);
      }
    }

    log.info(`conectado ao chat de @${this.#username}`);
    this.emit('connected');
  }

  stop() {
    this.#parado = true;
    try {
      this.#connection?.disconnect();
    } catch {
      // Ja pode estar caido; nada a fazer.
    }
    this.#connection = null;
  }

  #onChat(data) {
    this.#chatRecebidos++;

    const pedido = parseChat(data);
    if (pedido) {
      this.#chatLidos++;
      log.debug(`chat ${pedido.label}: ${pedido.comment}`);
      this.emit('chat', pedido);
    }

    // Verificacao: se chegam mensagens mas nenhuma e lida, a TikTok
    // provavelmente mudou o formato de novo — foi o que quebrou silenciosamente
    // desta vez. Avisa uma vez, alto, em vez de descartar tudo calado.
    if (!this.#avisouFormato && this.#chatRecebidos >= 8 && this.#chatLidos === 0) {
      this.#avisouFormato = true;
      log.warn(
        `recebi ${this.#chatRecebidos} mensagens de chat mas nao consegui ler nenhuma. ` +
          'A TikTok provavelmente mudou o formato — ajuste parseChat em src/tiktok/connector.js.',
      );
    }
  }

  #onGift(data) {
    const { userId, label } = usuarioDe(data?.user);
    if (!userId) return;

    // Presentes "streakable" (giftType 1) chegam a cada incremento e de novo no
    // fim. Contar so o fim, senao um unico presente vira varios eventos.
    const tipo = data?.giftDetails?.giftType ?? data?.giftType;
    if (tipo === 1 && !data.repeatEnd) return;

    this.emit('gift', {
      userId,
      label,
      giftName: data?.giftDetails?.giftName ?? data?.gift?.name ?? 'presente',
      count: Number(data?.repeatCount ?? 1),
    });
  }
}

/**
 * Extrai id estavel e rotulo de exibicao de um usuario do chat, tolerando as
 * variacoes de campo da TikTok. `id` (numerico) e o mais confiavel para o limite
 * por pessoa; o @ e so para mostrar.
 */
function usuarioDe(user) {
  if (!user) return { userId: null, label: '@?' };

  const handle = user.uniqueId || user.nickname || user.id;
  const id = user.id ?? user.userId ?? user.uniqueId ?? handle;

  return {
    userId: id != null ? String(id) : null,
    label: handle ? `@${handle}` : '@?',
  };
}

/**
 * Mensagem de chat crua da TikTok -> { userId, label, comment }, ou null se nao
 * der para ler. Funcao pura e exportada de proposito, para o selfcheck verificar
 * que os campos atuais (content/id/nickname) e os antigos (comment/uniqueId)
 * ainda sao lidos — a defesa offline contra a TikTok mudar o formato de novo.
 */
export function parseChat(data) {
  const texto = data?.content ?? data?.comment;
  const { userId, label } = usuarioDe(data?.user);
  if (!texto || !userId) return null;

  return { userId, label, comment: String(texto) };
}
