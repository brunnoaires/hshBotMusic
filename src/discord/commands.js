import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { buscarPedido, candidatosPara, fixarMatch, invalidateMatch } from '../audio/resolve.js';
import { readSpotifyActivity } from '../spotify/presence.js';
import { apiDoUsuario, esquecerToken, salvarToken, trocarCodigo } from '../spotify/users.js';
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
    .setName('entrar')
    .setDescription('Entra no canal de voz pronto para pedidos, sem precisar do /sr')
    .addChannelOption((option) =>
      option
        .setName('canal')
        .setDescription('Canal de voz (padrão: o que você está)')
        .addChannelTypes(ChannelType.GuildVoice),
    ),
  new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Modo Spotify: pedidos entram na fila do SEU Spotify (sem voz)'),
  new SlashCommandBuilder()
    .setName('conectar-spotify')
    .setDescription('Conecta o SEU Spotify ao bot (para o modo Spotify)')
    .addStringOption((option) =>
      option
        .setName('codigo')
        .setDescription('Cole aqui o código que a página mostrou (deixe vazio para pegar o link)')
        .setMaxLength(400),
    ),
  new SlashCommandBuilder()
    .setName('desconectar-spotify')
    .setDescription('Remove o seu Spotify conectado ao bot'),
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

/**
 * Corta uma string ao limite do Discord, que conta em code units UTF-16
 * (.length), nao em code points. Se o corte cair no meio de um par surrogate,
 * remove o pedaco solto — senao o Discord rejeita a resposta inteira.
 */
function cortar(texto, max) {
  const s = String(texto);
  if (s.length <= max) return s;

  let corte = s.slice(0, max);
  const ultimo = corte.charCodeAt(corte.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) corte = corte.slice(0, -1);
  return corte;
}

/** URL de autorizacao do Spotify para o streamer conectar a propria conta. */
function urlAutorizacaoSpotify(config) {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    client_id: config.spotify.clientId,
    response_type: 'code',
    redirect_uri: config.spotify.userRedirectUri,
    scope: 'user-modify-playback-state user-read-playback-state',
  }).toString();
  return url.toString();
}

/**
 * Conta do Spotify que deve receber os pedidos de quem rodou o comando: a que
 * ela conectou pelo /conectar-spotify; se for o dono e ele nao conectou, cai
 * para a conta do .env.
 */
async function contaSpotifyDe(interaction, config, ownerApi) {
  const doUsuario = await apiDoUsuario(config.spotify, interaction.user.id);
  if (doUsuario) return doUsuario;
  if (interaction.user.id === config.discord.ownerId && ownerApi?.enabled) return ownerApi;
  return null;
}

/** Resposta do /sr no modo Spotify, traduzindo os erros da fila. */
function explicarSpotify(resultado, rotulo) {
  if (resultado?.spotify) return `Adicionado à sua fila do Spotify: ${rotulo}`;

  switch (resultado?.erro) {
    case 'sem-spotify':
      return 'Esse pedido não existe no Spotify (link do YouTube não entra no modo Spotify).';
    case 'sem-conta':
      return 'Nenhum Spotify conectado nesta sessão. Rode `/conectar-spotify`.';
    case 'nao-registrado':
      return (
        'Sua conta do Spotify ainda não foi **liberada** pelo dono do bot. Conectar não ' +
        'basta: o dono precisa te adicionar em *User Management* no painel do Spotify, com o ' +
        'e-mail da sua conta. Passe o e-mail do seu Spotify para ele.'
      );
    case 'sem-device':
      return (
        'O Spotify não está tocando em nenhum aparelho. Abra o Spotify e **dê play em ' +
        'qualquer música** (uma vez), aí o `/sr` passa a adicionar na fila. Precisa ficar tocando.'
      );
    case 'sem-premium':
      return 'Essa conta do Spotify **não é Premium** — a fila pela API só funciona com Premium.';
    default:
      return `Não consegui adicionar à fila do Spotify (${resultado?.erro ?? 'erro'}).`;
  }
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
      'O bot toca música numa call do Discord. Três jeitos de usar:\n' +
        '• **Pedir música** — `/sr <nome>` (ou cole um link do YouTube/Spotify)\n' +
        '• **Seguir o seu Spotify** — `/vincular`, e o que você ouve ele toca junto\n' +
        '• **Chat da live da TikTok** — `/tiktok`, e a plateia pede com `!sr <nome>`\n\n' +
        lista,
    )
    .addFields(
      {
        name: '🔒 Quem pode usar',
        value:
          'Os com cadeado são de quem trouxe o bot (ou de quem tem **Gerenciar ' +
          'Servidor**). O resto é livre. Sem ninguém vinculado, tudo fica aberto — a ' +
          'fila é coletiva.',
      },
      {
        name: 'Seguir o seu Spotify (/vincular)',
        value:
          COMO_LIGAR +
          '\nNão precisa de login nem senha: o bot só lê o que o Discord já publica no ' +
          'seu status, e não controla o seu Spotify.',
      },
      {
        name: 'Tocar na sua fila do Spotify (/spotify)',
        value:
          'Em vez de tocar na call, o bot põe os pedidos na fila do **seu** Spotify ' +
          '(precisa de Premium). Aí sim há um login, uma vez: `/conectar-spotify`.',
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

/**
 * Selecao do dropdown do /rematch. O usuario escolheu qual video corresponde a
 * faixa; fixamos esse match e, se a faixa ainda estiver tocando, retocamos.
 */
export async function handleRematchSelect(interaction, { sessions }) {
  const spotifyId = interaction.customId.slice('rematch:'.length);
  const youtubeId = interaction.values[0];
  const session = sessions.get(interaction.guildId);

  if (!session) {
    await interaction.update({ content: 'A sessão já foi encerrada.', components: [] });
    return;
  }
  if (!podeControlar(interaction, session)) {
    await interaction.reply(
      efemero('Só quem comanda a sessão pode escolher o vídeo.'),
    );
    return;
  }

  // Persiste a escolha: da proxima vez que a faixa tocar, ja vem certa.
  fixarMatch(spotifyId, youtubeId);

  const atual = session.current;
  // Se a faixa passou, nao interrompe a que esta tocando agora — o match ja
  // ficou corrigido para o futuro.
  if (atual?.id !== spotifyId) {
    await interaction.update({
      content: 'Match corrigido para a próxima vez que essa música tocar.',
      components: [],
    });
    return;
  }

  await interaction.update({ content: 'Trocando…', components: [] });
  await session.player.play({ ...atual, youtubeId });

  await interaction.editReply(
    session.player.current
      ? `Agora tocando \`${session.player.current.youtubeTitle}\`.`
      : 'Escolhi, mas não consegui tocar esse vídeo.',
  );
}

export async function handleCommand(interaction, { sessions, config, onChange, ownerApi }) {
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

      const bridge = new TikTokBridge({
        connector,
        session,
        config: config.tiktok,
        // Pedidos do chat tambem identificam pelo Spotify quando disponivel.
        resolver: (texto) => buscarPedido(texto, { spotifyApi: ownerApi }),
      });
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

    case 'entrar': {
      if (session) {
        await interaction.reply(
          efemero(
            session.saida === 'spotify'
              ? 'Já estou no modo Spotify aqui. Use `/desvincular` para trocar.'
              : `Já estou em um canal aqui. Peça com \`/sr\` ou ligue o \`/tiktok\`.`,
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

      await interaction.deferReply();
      try {
        await sessions.start({
          channel,
          driverId: null,
          announceChannelId: podeAnunciarEm(interaction) ? interaction.channelId : null,
        });
      } catch (err) {
        await interaction.editReply(`Não consegui entrar em **${channel.name}**: ${err.message}`);
        return;
      }
      onChange?.();

      await interaction.editReply(
        `Entrei em **${channel.name}**. Peça com \`/sr <música>\` ou ligue o chat da live com \`/tiktok\`.`,
      );
      return;
    }

    case 'conectar-spotify': {
      if (!config.spotify.clientId || !config.spotify.userRedirectUri) {
        await interaction.reply(
          efemero('O dono do bot ainda não configurou o login por usuário do Spotify.'),
        );
        return;
      }

      const codigo = interaction.options.getString('codigo')?.trim();

      // Sem codigo: manda o link para a pessoa autorizar.
      if (!codigo) {
        await interaction.reply(
          efemero(
            '**1.** Abra este link e autorize:\n' +
              urlAutorizacaoSpotify(config) +
              '\n\n**2.** Copie o código que a página mostrar.\n' +
              '**3.** Rode `/conectar-spotify codigo:<o código>`.',
          ),
        );
        return;
      }

      // Com codigo: troca por token e guarda para essa pessoa.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const refreshToken = await trocarCodigo({
        clientId: config.spotify.clientId,
        clientSecret: config.spotify.clientSecret,
        redirectUri: config.spotify.userRedirectUri,
        code: codigo,
      });
      if (!refreshToken) {
        await interaction.editReply(
          'Código inválido ou expirado. Rode `/conectar-spotify` de novo para um link novo.',
        );
        return;
      }

      await salvarToken(interaction.user.id, refreshToken);
      await interaction.editReply(
        'Spotify conectado! Agora `/spotify` manda os pedidos para a **sua** conta. ' +
          'Precisa de Premium e do Spotify aberto e tocando.',
      );
      return;
    }

    case 'desconectar-spotify': {
      await esquecerToken(interaction.user.id);
      await interaction.reply(efemero('Seu Spotify foi desconectado do bot.'));
      return;
    }

    case 'spotify': {
      const conta = await contaSpotifyDe(interaction, config, ownerApi);
      if (!conta) {
        await interaction.reply(
          efemero('Conecte o seu Spotify primeiro: rode `/conectar-spotify`.'),
        );
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Precisa de um canal-alvo para a chave da sessao (uma por servidor),
      // mesmo sem entrar nele.
      const guildFicticio = { id: interaction.guildId, guild: interaction.guild };
      try {
        await sessions.start({
          channel: guildFicticio,
          driverId: interaction.user.id,
          announceChannelId: podeAnunciarEm(interaction) ? interaction.channelId : null,
          saida: 'spotify',
          spotifyApi: conta,
        });
      } catch (err) {
        await interaction.editReply(`Não consegui ligar o modo Spotify: ${err.message}`);
        return;
      }
      onChange?.();

      await interaction.editReply(
        'Modo **Spotify** ligado. Pedidos (por `/sr` ou pelo `/tiktok`) entram na fila do seu ' +
          'Spotify. Deixe o Spotify **aberto e tocando** (precisa de Premium) e capture o áudio ' +
          'dele no OBS. Link do YouTube não funciona neste modo.',
      );
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

      // Identifica pelo Spotify quando disponivel; o audio vem do YouTube.
      const track = await buscarPedido(pedido, { spotifyApi: ownerApi });
      if (!track) {
        await interaction.editReply(`Não achei nada para **${pedido}**.`);
        return;
      }

      track.requestedBy = interaction.user.id;
      const resultado = await alvo.pedir(track);

      const duracao = duracaoLegivel(track.durationMs);
      const rotulo = `**[${track.title}](${track.url})**${duracao ? ` \`${duracao}\`` : ''}`;

      // Modo Spotify: enfileirou na conta do dono (ou explicou o porque de falhar).
      if (alvo.saida === 'spotify') {
        await interaction.editReply(explicarSpotify(resultado, rotulo));
        return;
      }

      // Em modo follow, a proxima troca no Spotify cortaria o pedido. Avisar
      // aqui evita a pessoa achar que o bot ignorou o comando.
      const aviso =
        !alvo.manual && alvo.player.mode === 'follow'
          ? '\n-# A próxima troca no Spotify vai interromper. Use `/modo queue` para evitar.'
          : '';

      await interaction.editReply(
        resultado.tocandoAgora
          ? `Tocando agora: ${rotulo}${aviso}`
          : `Na fila (#${resultado.posicao}): ${rotulo}${aviso}`,
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

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const candidatos = await candidatosPara(track).catch(() => []);
      if (!candidatos.length) {
        await interaction.editReply(`Não achei alternativas no YouTube para **${track.title}**.`);
        return;
      }

      // O video escolhido vai no value; o id da faixa do Spotify no customId,
      // para o handler saber o que remapear quando alguem selecionar.
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`rematch:${track.id}`)
        .setPlaceholder('Escolha o vídeo certo')
        .addOptions(
          candidatos.slice(0, 25).map((c, i) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(cortar(c.title, 100))
              .setDescription(
                cortar(
                  [c.channel, c.durationMs ? formatTime(c.durationMs) : null]
                    .filter(Boolean)
                    .join(' · '),
                  100,
                ) || 'sem detalhes',
              )
              .setValue(c.id)
              .setDefault(i === 0),
          ),
        );

      await interaction.editReply({
        content: `Alternativas para **${track.artists} — ${track.title}**:`,
        components: [new ActionRowBuilder().addComponents(menu)],
      });
      return;
    }

    default:
      await interaction.reply(efemero('Comando desconhecido.'));
  }
}
