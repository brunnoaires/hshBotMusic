import { buscarPedido } from '../audio/resolve.js';
import { createLogger } from '../logger.js';

const log = createLogger('tiktok-bridge');

/**
 * Extrai o pedido de uma mensagem do chat.
 * "!sr never gonna give you up" -> "never gonna give you up"; null se nao for
 * um pedido ou vier vazio.
 */
export function extrairPedido(comment, prefixo) {
  const texto = comment.trim();
  const p = prefixo.toLowerCase();
  if (!texto.toLowerCase().startsWith(p)) return null;

  const query = texto.slice(prefixo.length).trim();
  return query.length >= 2 ? query : null;
}

/**
 * Liga um chat da TikTok a uma sessao do Discord: pedidos do chat entram na fila
 * que ja existe, e presentes dao prioridade.
 *
 * O resolver e injetavel para os testes exercitarem limite e prioridade sem
 * tocar na rede.
 */
export class TikTokBridge {
  #connector;
  #session;
  #resolver;
  #config;
  #handlers = null;

  /** Creditos de prioridade concedidos por presente, por usuario -> expira em. */
  #prioridades = new Map();

  constructor({ connector, session, config, resolver = buscarPedido }) {
    this.#connector = connector;
    this.#session = session;
    this.#config = config;
    this.#resolver = resolver;
  }

  attach() {
    this.#handlers = {
      chat: (evento) => void this.#onChat(evento),
      gift: (evento) => void this.#onGift(evento),
    };
    this.#connector.on('chat', this.#handlers.chat);
    this.#connector.on('gift', this.#handlers.gift);
  }

  detach() {
    if (!this.#handlers) return;
    this.#connector.off('chat', this.#handlers.chat);
    this.#connector.off('gift', this.#handlers.gift);
    this.#handlers = null;
  }

  async #onChat({ userId, label, comment }) {
    const query = extrairPedido(comment, this.#config.prefixo);
    if (!query) return;

    // Limite por pessoa: sem isso, um espectador soltando "!sr" em sequencia
    // domina a fila inteira.
    if (this.#session.pedidosDe(userId) >= this.#config.maxPorUsuario) {
      log.debug(`${label} atingiu o limite de ${this.#config.maxPorUsuario} pedidos`);
      return;
    }

    let track;
    try {
      track = await this.#resolver(query);
    } catch (err) {
      log.warn(`falha ao resolver "${query}" de ${label}: ${err.message}`);
      return;
    }
    if (!track) {
      log.debug(`nada encontrado para "${query}" (${label})`);
      return;
    }

    track.requestedById = userId;
    track.requestedByLabel = label;
    track.requestedBy = null;

    // Presente recente concede prioridade ao proximo pedido.
    const prioridade = this.#consumirPrioridade(userId);

    const r = await this.#session.pedir(track, { prioridade });

    if (r?.erro) {
      log.debug(`pedido de ${label} nao entrou (${r.erro}): ${track.title}`);
      return;
    }
    const onde = r?.spotify
      ? 'fila do Spotify'
      : r?.tocandoAgora
        ? 'tocando agora'
        : `#${r?.posicao}${prioridade ? ', prioritario' : ''}`;
    log.info(`${label} pediu "${track.title}" (${onde})`);
  }

  #onGift({ userId, label, giftName }) {
    // Se a pessoa ja tem pedido na fila, o presente o joga para a frente.
    if (this.#session.priorizarPedidoDe(userId)) {
      log.info(`${label} mandou ${giftName}: pedido movido para a frente`);
      return;
    }

    // Senao, guarda um credito para o proximo "!sr" dela dentro da janela.
    this.#prioridades.set(userId, Date.now() + this.#config.janelaPrioridadeMs);
    log.info(`${label} mandou ${giftName}: proximo pedido entra na frente`);
  }

  #consumirPrioridade(userId) {
    const expira = this.#prioridades.get(userId);
    if (!expira) return false;

    this.#prioridades.delete(userId);
    return Date.now() < expira;
  }
}
