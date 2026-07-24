import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { buscarPedido, invalidateMatch } from '../audio/resolve.js';
import { readSpotifyActivity } from '../spotify/presence.js';
import { TikTokConnector } from '../tiktok/connector.js';
import { TikTokBridge } from '../tiktok/bridge.js';
import { createLogger } from '../logger.js';

const log = createLogger('commands');

// Nomes de comando so aceitam minusculas sem acento, mas as descricoes aceitam
// texto normal — e sao elas que a pessoa le na interface do Discord.
export const commands = [
  new SlashCommandBuilder()
    .setName('vincular')
    .setDescription('Entra no canal de voz e passa a seguir o SEU Spotify')
    .addChannelOption((option) =>
      option
        .setName('canal')
        .setDescription('Canal de voz (padrão: o canal em que você está)')
        .addChannelTypes(ChannelType.GuildVoice),
    ),
  new SlashCommandBuilder()
    .setName('desvincular')
    .setDescription('Para de seguir o Spotify e sai do canal de voz'),
  new SlashCommandBuilder()
    .setName('modo')
    .setDescription('Define o que fazer quando você troca de música no Spotify')
    .addStringOption((option) =>
      option
        .setName('opcao')
        .setDescription('follow interrompe na hora; queue espera a atual acabar')
        .setRequired(true)
        .addChoices(
          { name: 'follow — troca na hora', value: 'follow' },
          { name: 'queue — enfileira', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('agora')
    .setDescription('Mostra o que está tocando, com progresso e o vídeo escolhido'),
  new SlashCommandBuilder().setName('pular').setDescription('Pula a faixa atual'),
  new SlashCommandBuilder().setName('pausar').setDescription('Pausa o que está tocando'),
  new SlashCommandBuilder().setName('retomar').setDescription('Retoma o que estava pausado'),
  new SlashCommandBuilder().setName('fila').setDescription('Lista as faixas enfileiradas'),
  new SlashCommandBuilder().setName('limpar').setDescription('Esvazia a fila sem parar a faixa atual'),
  new SlashCommandBuilder()
    .setName('rematch')
    .setDescription('Achou o vídeo errado? Esquece o match em cache e procura de novo'),
  new SlashCommandBuilder()
    .setName('sr')
    .setDescription('Pede uma música sem Spotify: busca por nome ou cola um link')
    .addStringOption((option) =>
      option
        .setName('musica')
        .setDescription('Nome da música, ou um link do YouTube')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(200),
    ),
  new SlashCommandBuilder()
    .setName('tiktok')
    .setDescription('Liga o chat de uma live da TikTok à fila de pedidos')
    .addStringOption((option) =>
      option
        .setName('usuario')
        .setDescription('@usuario da live, ou "parar" para desligar')
        .setRequired(true)
        .setMaxLength(100),
    ),
  new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('Lista os comandos e explica como ligar o seu Spotify'),
].map((command) => command.toJSON());

/** Comandos que mexem na sessao alheia; ver podeControlar(). */
const RESTRITOS = new Set(['desvincular', 'modo', 'rematch', 'limpar', 'tiktok']);

const efemero = (content) => ({ content, flags: MessageFlags.Ephemeral });

const COMO_LIGAR =
  'No Discord: **Configurações do Usuário -> Conexões -> Spotify**, conecte a conta e deixe ' +
  '**"Exibir o Spotify como seu status"** ligado. Depois entre num canal de voz e use `/vincular`. ' +
  'Você também não pode estar como **Invisível**, senão ninguém (nem o bot) enxerga o seu status.';

function progressBar(progressMs, durationMs, width = 18) {
  if (!durationMs) return '';
  const filled = Math.min(width, Math.round((progressMs / durationMs) * width));
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, width - filled));
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Presence do membro, tolerando cache frio. */
function presenceDe(guild, userId) {
  return guild.members.cache.get(userId)?.presence ?? guild.presences.cache.get(userId) ?? null;
}

/**
 * Quem gerencia o servidor pode mexer na sessao de outra pessoa.
 *
 * Sessao em modo jukebox (sem driver) nao tem dono: a fila e coletiva, entao
 * os controles ficam abertos a todo mundo.
 */
function podeControlar(interaction, session) {
  if (!session || session.manual) return true;
  if (interaction.user.id === session.driverId) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

/** Canal de voz para entrar: o informado, ou o de quem chamou. */
function canalDeVoz(interaction) {
  return interaction.options.getChannel('canal') ?? interaction.member?.voice?.channel ?? null;
}

function faltaPermissaoDeVoz(channel, interaction) {
  const permissoes = channel.permissionsFor(interaction.guild.members.me);
  return !permissoes?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
}

function podeAnunciarEm(interaction) {
  return (
    interaction.channel
      ?.permissionsFor(interaction.guild.members.me)
      ?.has([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ]) ?? false
  );
}

function duracaoLegivel(ms) {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Lista de comandos montada a partir das proprias definicoes acima. Escrever a
 * lista a mao daria divergencia na primeira vez que um comando mudasse.
 */
export function ajudaEmbed() {
  const lista = commands
    .map((c) => `\`/${c.name}\`${RESTRITOS.has(c.name) ? ' 🔒' : ''} — ${c.description}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('Comandos do botdc')
    .setDescription(
      'Você troca a música no Spotify e o bot troca na call, começando no mesmo ponto.\n\n' +
        lista,
    )
    .addFields(
      {
        name: '🔒 Quem pode usar',
        value:
          'Os marcados com cadeado são de quem rodou `/vincular` ou de quem tem ' +
          '**Gerenciar Servidor**. O resto é livre para todo mundo. Em modo jukebox ' +
          '(sem ninguém vinculado), tudo fica aberto — a fila é coletiva.',
      },
      {
        name: 'Primeira vez aqui?',
        value: COMO_LIGAR,
      },
      {
        name: 'Preciso fazer login no Spotify?',
        value:
          'Não. O bot lê o que o próprio Discord já publica no seu status. ' +
          'Nenhuma senha, nenhum token, nenhuma autorização. Ele também não controla ' +
          'o seu Spotify — só observa e reproduz o mesmo na call.',
      },
    );
}

function nowPlayingEmbed(session) {
  const spotify = session.watcher.current;
  const playing = session.player.current;

  if (!spotify && !playing) {
    return new EmbedBuilder().setColor(0x2b2d31).setDescription('Nada tocando no momento.');
  }

  const track = spotify ?? playing;
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setAuthor({ name: 'Tocando agora no Spotify' })
    .setTitle(track.title)
    .setDescription(track.artists);

  if (track.url) embed.setURL(track.url);
  if (track.artwork) embed.setThumbnail(track.artwork);
  if (track.album) embed.addFields({ name: 'Album', value: track.album, inline: true });

  if (track.durationMs) {
    embed.addFields({
      name: 'Progresso',
      value:
        `${progressBar(track.progressMs ?? 0, track.durationMs)}\n` +
        `\`${formatTime(track.progressMs ?? 0)} / ${formatTime(track.durationMs)}\``,
    });
  }

  embed.addFields({
    name: 'No Discord',
    value: playing
      ? `\`${playing.youtubeTitle}\`` +
        (playing.seekMs > 1000 ? `\niniciou em ${formatTime(playing.seekMs)}` : '')
      : 'sem audio tocando',
  });

  embed.setFooter({
    text: session.manual
      ? `jukebox · ${session.player.queue.length} na fila`
      : `de <@${session.driverId}> · modo: ${session.player.mode} · ` +
        `fonte: ${session.usaApi ? 'presence + API' : 'presence'}`,
  });

  return embed;
}

export async function handleCommand(interaction, { sessions, config, onChange }) {
  if (!interaction.inGuild()) {
    await interaction.reply(efemero('Esses comandos só funcionam dentro de um servidor.'));
    return;
  }

  const session = sessions.get(interaction.guildId);

  switch (interaction.commandName) {
    case 'tiktok': {
      if (!session) {
        await interaction.reply(
          efemero('Entre num canal e use `/sr` ou `/vincular` primeiro — o TikTok alimenta essa fila.'),
        );
        return;
      }
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(`Só <@${session.driverId}> ou quem gerencia o servidor pode ligar o TikTok.`),
        );
        return;
      }

      const arg = interaction.options.getString('usuario').trim();

      if (/^(parar|stop|off|desligar)$/i.test(arg)) {
        if (!session.tiktok) {
          await interaction.reply(efemero('O TikTok já está desligado.'));
          return;
        }
        const quem = session.tiktok.connector.username;
        session.pararTikTok();
        await interaction.reply(`Desliguei o chat de **@${quem}**.`);
        return;
      }

      await interaction.deferReply();

      // Troca a conexao anterior, se houver: uma sessao segue uma live por vez.
      session.pararTikTok();

      const connector = new TikTokConnector({
        username: arg,
        signApiKey: config.tiktok.signApiKey,
      });

      try {
        await connector.start();
      } catch (err) {
        await interaction.editReply(`Não consegui conectar: ${err.message}`);
        return;
      }

      const bridge = new TikTokBridge({ connector, session, config: config.tiktok });
      bridge.attach();
      session.tiktok = { connector, bridge };

      // Live que cai ou termina nao pode deixar a ponte pendurada.
      connector.once('ended', () => session.pararTikTok());
      connector.once('disconnected', () => session.pararTikTok());

      await interaction.editReply(
        `Seguindo o chat de **@${connector.username}**. Peça com \`${config.tiktok.prefixo} <música>\` ` +
          `(até ${config.tiktok.maxPorUsuario} por pessoa). Presentes furam a fila.`,
      );
      return;
    }

    case 'ajuda': {
      await interaction.reply({ embeds: [ajudaEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }

    case 'sr': {
      const pedido = interaction.options.getString('musica').trim();

      // Sem sessao, o /sr cria uma em modo jukebox: sem Spotify, sem driver,
      // a fila e a unica fonte. Assim ninguem precisa vincular nada primeiro.
      let alvo = session;
      if (!alvo) {
        const channel = canalDeVoz(interaction);
        if (!channel) {
          await interaction.reply(efemero('Entre num canal de voz antes de pedir música.'));
          return;
        }
        if (faltaPermissaoDeVoz(channel, interaction)) {
          await interaction.reply(
            efemero(`Não tenho permissão de conectar e falar em **${channel.name}**.`),
          );
          return;
        }

        await interaction.deferReply();
        try {
          alvo = await sessions.start({
            channel,
            driverId: null,
            announceChannelId: podeAnunciarEm(interaction) ? interaction.channelId : null,
          });
        } catch (err) {
          await interaction.editReply(`Não consegui entrar em **${channel.name}**: ${err.message}`);
          return;
        }
        onChange?.();
      } else {
        await interaction.deferReply();
      }

      const track = await buscarPedido(pedido);
      if (!track) {
        await interaction.editReply(`Não achei nada para **${pedido}**.`);
        return;
      }

      track.requestedBy = interaction.user.id;
      const { posicao, tocandoAgora } = alvo.pedir(track);

      const duracao = duracaoLegivel(track.durationMs);
      const rotulo = `**[${track.title}](${track.url})**${duracao ? ` \`${duracao}\`` : ''}`;

      // Em modo follow, a proxima troca no Spotify cortaria o pedido. Avisar
      // aqui evita a pessoa achar que o bot ignorou o comando.
      const aviso =
        !alvo.manual && alvo.player.mode === 'follow'
          ? '\n-# A próxima troca no Spotify vai interromper. Use `/modo queue` para evitar.'
          : '';

      await interaction.editReply(
        tocandoAgora ? `Tocando agora: ${rotulo}${aviso}` : `Na fila (#${posicao}): ${rotulo}${aviso}`,
      );
      return;
    }

    case 'vincular': {
      // Tomar o lugar de quem ja esta comandando exige gerenciar o servidor,
      // senao qualquer um derrubaria a sessao alheia no meio da musica.
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(
            `<@${session.driverId}> já está com o bot aqui. Peça para essa pessoa usar ` +
              '`/desvincular`, ou peça a alguém que gerencia o servidor.',
          ),
        );
        return;
      }

      const channel = canalDeVoz(interaction);
      if (!channel) {
        await interaction.reply(efemero('Entre em um canal de voz ou informe um em `canal`.'));
        return;
      }

      if (faltaPermissaoDeVoz(channel, interaction)) {
        await interaction.reply(
          efemero(`Não tenho permissão de conectar e falar em **${channel.name}**.`),
        );
        return;
      }

      // Sem isso o cartao de "reproduzindo agora" falharia calado, e a pessoa
      // acharia que o bot simplesmente nao anuncia.
      const podeAnunciar = podeAnunciarEm(interaction);

      await interaction.deferReply();

      let novaSessao;
      try {
        novaSessao = await sessions.start({
          channel,
          driverId: interaction.user.id,
          // Os cartoes de "reproduzindo agora" saem aqui, no canal de texto em
          // que o comando foi usado.
          announceChannelId: podeAnunciar ? interaction.channelId : null,
        });
      } catch (err) {
        log.error('falha ao entrar no canal:', err.message);
        await interaction.editReply(`Não consegui entrar em **${channel.name}**: ${err.message}`);
        return;
      }

      // Diagnostico na hora: dizer so "vinculado" e deixar a pessoa no silencio
      // e o pior resultado possivel aqui.
      const presence = presenceDe(interaction.guild, interaction.user.id);
      const track = readSpotifyActivity(presence);

      const aviso = podeAnunciar
        ? ''
        : '\n\n⚠️ Não posso publicar o cartão de "reproduzindo agora" neste canal — ' +
          'me faltam Enviar Mensagens, Inserir Links ou Anexar Arquivos. A música toca normalmente.';

      if (track) {
        novaSessao.watcher.onPresence(track);
        await interaction.editReply(
          `Seguindo o Spotify de <@${interaction.user.id}> em **${channel.name}**.\n` +
            `Tocando agora: **${track.title}** — ${track.artists}` +
            aviso,
        );
      } else if (!presence) {
        await interaction.editReply(
          `Entrei em **${channel.name}**, mas não consigo ver o seu status. ` +
            'Você está como Invisível? Fique online e toque algo no Spotify.' +
            aviso,
        );
      } else {
        await interaction.editReply(
          `Entrei em **${channel.name}** e vou seguir o seu Spotify assim que ele aparecer.\n` +
            'Não vejo Spotify no seu status agora. Se já estiver tocando, use `/ajuda`.' +
            aviso,
        );
      }

      onChange?.();
      return;
    }

    case 'desvincular': {
      if (!session) {
        await interaction.reply(efemero('Não estou vinculado a nada neste servidor.'));
        return;
      }
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(`Só <@${session.driverId}> ou quem gerencia o servidor pode desvincular.`),
        );
        return;
      }

      sessions.stop(interaction.guildId);
      onChange?.();
      await interaction.reply('Desvinculado e fora do canal de voz.');
      return;
    }

    case 'modo': {
      if (!session) {
        await interaction.reply(efemero('Use `/vincular` primeiro.'));
        return;
      }
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(`Só <@${session.driverId}> ou quem gerencia o servidor pode trocar o modo.`),
        );
        return;
      }

      session.player.mode = interaction.options.getString('opcao');
      await interaction.reply(
        session.player.mode === 'follow'
          ? 'Modo **follow**: troquei no Spotify, troco aqui na hora.'
          : 'Modo **queue**: as trocas entram na fila e tocam em sequência.',
      );
      return;
    }

    case 'agora': {
      if (!session) {
        await interaction.reply(efemero('Não estou vinculado a nada neste servidor.'));
        return;
      }
      await interaction.reply({ embeds: [nowPlayingEmbed(session)] });
      return;
    }

    case 'pular': {
      if (!session) {
        await interaction.reply(efemero('Não estou vinculado a nada neste servidor.'));
        return;
      }

      session.pausadoPorComando = false;
      const skipped = session.player.skip();
      await interaction.reply(
        skipped ? `Pulei **${skipped.title}**.` : 'Não tem nada tocando para pular.',
      );
      return;
    }

    case 'pausar': {
      if (!session) {
        await interaction.reply(efemero('Não estou tocando nada neste servidor.'));
        return;
      }
      if (!session.player.pause()) {
        await interaction.reply(efemero('Não tem nada tocando para pausar.'));
        return;
      }

      session.pausadoPorComando = true;
      await interaction.reply(
        'Pausado.' +
          (session.manual
            ? ''
            : ' Enquanto estiver assim, não retomo sozinho mesmo que o Spotify volte a tocar.'),
      );
      return;
    }

    case 'retomar': {
      if (!session) {
        await interaction.reply(efemero('Não estou tocando nada neste servidor.'));
        return;
      }

      session.pausadoPorComando = false;
      await interaction.reply(
        session.player.resume() ? 'Retomado.' : 'Não tem nada pausado para retomar.',
      );
      return;
    }

    case 'limpar': {
      if (!session) {
        await interaction.reply(efemero('Não estou vinculado a nada neste servidor.'));
        return;
      }
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(`Só <@${session.driverId}> ou quem gerencia o servidor pode limpar a fila.`),
        );
        return;
      }

      const quantas = session.player.queue.length;
      session.player.queue = [];
      await interaction.reply(
        quantas
          ? `Fila esvaziada (${quantas} ${quantas === 1 ? 'faixa' : 'faixas'}). A atual continua tocando.`
          : 'A fila já estava vazia.',
      );
      return;
    }

    case 'fila': {
      if (!session?.player.queue.length) {
        await interaction.reply(efemero('A fila está vazia.'));
        return;
      }

      const lines = session.player.queue.slice(0, 15).map((track, index) => {
        const quem = track.requestedByLabel ?? (track.requestedBy ? `<@${track.requestedBy}>` : null);
        return `\`${index + 1}.\` **${track.title}** — ${track.artists}` + (quem ? ` · ${quem}` : '');
      });
      const rest = session.player.queue.length - lines.length;

      await interaction.reply(lines.join('\n') + (rest > 0 ? `\n…e mais ${rest}.` : ''));
      return;
    }

    case 'rematch': {
      if (!session) {
        await interaction.reply(efemero('Use `/vincular` primeiro.'));
        return;
      }
      if (!podeControlar(interaction, session)) {
        await interaction.reply(
          efemero(`Só <@${session.driverId}> ou quem gerencia o servidor pode refazer a busca.`),
        );
        return;
      }

      const track = session.current;
      if (!track?.id) {
        await interaction.reply(efemero('Não tem faixa atual para procurar de novo.'));
        return;
      }

      // Sem isso o match ruim ficaria colado na faixa para sempre — e o preco
      // de cachear a escolha do video.
      invalidateMatch(track.id);
      await interaction.deferReply();
      await session.player.play(track);

      await interaction.editReply(
        session.player.current
          ? `Agora tocando \`${session.player.current.youtubeTitle}\`.`
          : `Procurei de novo por **${track.title}**, mas não achei nada melhor.`,
      );
      return;
    }

    default:
      await interaction.reply(efemero('Comando desconhecido.'));
  }
}
