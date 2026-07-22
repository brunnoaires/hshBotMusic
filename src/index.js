import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { SpotifyApi } from './spotify/api.js';
import { readSpotifyActivity } from './spotify/presence.js';
import { SessionManager, atualizarStatus } from './session.js';
import { anunciar } from './discord/nowplaying.js';
import { resolveCache } from './audio/cache.js';
import { handleCommand } from './discord/commands.js';

const log = createLogger('bot');

const ownerApi = new SpotifyApi(config.spotify);
const sessions = new SessionManager({
  config,
  ownerApi,
  onTrackStart: (session) => void anunciar(session, client),
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    // Privilegiado: precisa ser ligado no Developer Portal > Bot > Presence Intent.
    // E dele que vem o Spotify de todo mundo, sem nenhum login.
    GatewayIntentBits.GuildPresences,
  ],
});

const onChange = () => atualizarStatus(client, sessions);

// ---------------------------------------------------------------------------

client.once(Events.ClientReady, (ready) => {
  log.info(`conectado como ${ready.user.tag} em ${ready.guilds.cache.size} servidor(es)`);

  if (ownerApi.enabled && config.discord.ownerId) {
    log.info(`Web API ativa para ${config.discord.ownerId}; demais usuarios rodam pela presence`);
  } else {
    log.info('sem Web API: todos rodam pela presence (sem espelhar pausa e sem prefetch)');
  }

  atualizarStatus(client, sessions);
});

client.on(Events.PresenceUpdate, (_old, presence) => {
  // Filtro barato primeiro: a esmagadora maioria dos eventos e de gente que nao
  // esta comandando sessao nenhuma.
  if (!presence?.userId || !sessions.temDriver(presence.userId)) return;

  sessions.onPresence(presence.userId, readSpotifyActivity(presence));
  atualizarStatus(client, sessions);
});

// Ninguem sobrou no canal: nao ha motivo para continuar tocando. Isso tambem
// cobre o caso de quem estava comandando sair do servidor — detectar isso pelo
// evento de saida exigiria o intent privilegiado GuildMembers so para isso.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const session = sessions.get(oldState.guild.id);
  const channelId = session?.player.channelId;
  if (!channelId || oldState.channelId !== channelId) return;

  const canal = oldState.guild.channels.cache.get(channelId);
  const humanos = canal?.members.filter((m) => !m.user.bot).size ?? 0;
  if (humanos > 0) return;

  log.info(`canal vazio em ${oldState.guild.id}; encerrando sessao`);
  sessions.stop(oldState.guild.id);
  atualizarStatus(client, sessions);
});

client.on(Events.GuildDelete, (guild) => {
  if (sessions.stop(guild.id)) atualizarStatus(client, sessions);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction, { sessions, config, onChange });
  } catch (err) {
    log.error(`comando /${interaction.commandName} falhou:`, err);
    const message = { content: 'Deu ruim ao executar esse comando.' };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------

async function shutdown(signal) {
  log.info(`recebi ${signal}, encerrando`);
  sessions.stopAll();
  // A gravacao do cache e debounced; sem isso os matches da sessao se perdem.
  await resolveCache.flush();
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('promise rejeitada:', err));

await client.login(config.discord.token);
