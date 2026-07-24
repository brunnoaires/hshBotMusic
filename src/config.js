import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente: ${name}. Copie o .env.example para .env e preencha.`,
    );
  }
  return value;
}

function optional(name, fallback = null) {
  return process.env[name]?.trim() || fallback;
}

function bool(name, fallback) {
  const value = optional(name);
  if (value === null) return fallback;
  return ['1', 'true', 'sim', 'yes'].includes(value.toLowerCase());
}

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: optional('DISCORD_GUILD_ID'),
    // Opcional: identifica de quem e a conta do Spotify configurada abaixo.
    // Todo mundo pode usar o bot pela presence; so essa pessoa ganha os extras
    // da Web API, porque o token do .env pertence a uma conta so.
    ownerId: optional('OWNER_USER_ID'),
  },
  spotify: {
    clientId: optional('SPOTIFY_CLIENT_ID'),
    clientSecret: optional('SPOTIFY_CLIENT_SECRET'),
    refreshToken: optional('SPOTIFY_REFRESH_TOKEN'),
    redirectUri: optional('SPOTIFY_REDIRECT_URI', 'http://127.0.0.1:8888/callback'),
  },
  pollIntervalMs: Math.max(1500, Number(optional('POLL_INTERVAL_MS', '3000'))),
  announceTracks: bool('ANNOUNCE_TRACKS', true),
  maxSessions: Math.max(1, Number(optional('MAX_SESSIONS', '10'))),
  tiktok: {
    signApiKey: optional('TIKTOK_SIGN_API_KEY'),
    prefixo: optional('TIKTOK_PREFIX', '!sr'),
    maxPorUsuario: Math.max(1, Number(optional('TIKTOK_MAX_PER_USER', '2'))),
    janelaPrioridadeMs: Math.max(0, Number(optional('TIKTOK_PRIORITY_WINDOW_S', '120'))) * 1000,
  },
  defaultMode: optional('DEFAULT_MODE', 'follow') === 'queue' ? 'queue' : 'follow',
  syncPosition: bool('SYNC_POSITION', true),
};
