import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { formatarTempo, renderizarBarra } from './progressbar.js';
import { createLogger } from '../logger.js';

const log = createLogger('anuncio');

// Faixa branca na lateral do embed, combinando com a ponta clara do gradiente.
// O Discord so aceita uma cor solida aqui — gradiente, so na imagem.
const COR = 0xffffff;

const ARQUIVO = 'progresso.png';

/**
 * Cartao de "reproduzindo agora": embed com capa, quem esta sendo seguido, o
 * canal de voz, os contadores e a barra de progresso desenhada como imagem.
 */
export function montarCartao({ track, session, voiceChannelName }) {
  const png = renderizarBarra({
    progressMs: track.seekMs ?? track.progressMs ?? 0,
    durationMs: track.durationMs ?? 0,
  });

  const titulo = `${track.artists} — ${track.title}`;

  // Pedido pelo /sr ou pela TikTok mostra quem pediu; faixa do Spotify mostra
  // quem esta sendo seguido. Em jukebox sem pedido nao ha ninguem a citar.
  const quemPediu = track.requestedByLabel ?? (track.requestedBy ? `<@${track.requestedBy}>` : null);
  const origem = quemPediu
    ? `- Pedido por ${quemPediu}`
    : session.driverId
      ? `- Seguindo <@${session.driverId}>`
      : null;

  const rodape = session.manual
    ? `Fila: \`${session.player.queue.length}\` · Modo: \`jukebox\``
    : `Fila: \`${session.player.queue.length}\` · Modo: \`${session.player.mode}\` · ` +
      `Fonte: \`${session.usaApi ? 'presence + API' : 'presence'}\``;

  const linhas = [
    track.url ? `**[${titulo}](${track.url})**` : `**${titulo}**`,
    origem,
    voiceChannelName ? `- 🔊 ${voiceChannelName}` : null,
    '',
    rodape,
  ].filter((linha) => linha !== null);

  const embed = new EmbedBuilder()
    .setColor(COR)
    .setTitle('Reproduzindo agora')
    .setDescription(linhas.join('\n'))
    .setImage(`attachment://${ARQUIVO}`);

  if (track.artwork) embed.setThumbnail(track.artwork);

  if (track.youtubeTitle) {
    embed.setFooter({
      text:
        `via ${track.youtubeTitle}` +
        (track.seekMs > 1000 ? ` · entrou em ${formatarTempo(track.seekMs)}` : ''),
    });
  }

  return { embeds: [embed], files: [new AttachmentBuilder(png, { name: ARQUIVO })] };
}

/**
 * Publica o cartao no canal onde /vincular foi usado, apagando o anterior para
 * o canal nao virar um mural de cartoes a cada troca de musica.
 */
export async function anunciar(session, client) {
  const { announceChannelId } = session;
  if (!announceChannelId || !session.player.current) return;

  let canal;
  try {
    canal = await client.channels.fetch(announceChannelId);
  } catch {
    // Canal apagado ou sem acesso: desliga o anuncio em vez de tentar sempre.
    log.warn(`canal ${announceChannelId} inacessivel; anuncios desligados nesta sessao`);
    session.announceChannelId = null;
    return;
  }

  if (!canal?.isTextBased()) return;

  const anterior = session.announceMessage;
  session.announceMessage = null;

  try {
    const nomeVoz = canal.guild?.channels?.cache?.get(session.player.channelId)?.name ?? null;

    session.announceMessage = await canal.send(
      montarCartao({ track: session.player.current, session, voiceChannelName: nomeVoz }),
    );
  } catch (err) {
    log.warn(`nao consegui anunciar em ${announceChannelId}: ${err.message}`);
  }

  // Só depois de publicar o novo, para o canal nunca ficar sem cartao nenhum.
  if (anterior) await anterior.delete().catch(() => {});
}
