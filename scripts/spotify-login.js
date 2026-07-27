import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Grava (ou substitui) SPOTIFY_REFRESH_TOKEN no .env, para o usuario nao ter que
 * copiar e colar. So mexe nessa linha; o resto do arquivo fica intacto.
 */
function gravarNoEnv(refreshToken) {
  const caminho = new URL('../.env', import.meta.url);
  let texto = '';
  try {
    texto = readFileSync(caminho, 'utf8');
  } catch {
    // Sem .env ainda: cria com so essa linha.
  }

  const linha = `SPOTIFY_REFRESH_TOKEN=${refreshToken}`;
  texto = /^SPOTIFY_REFRESH_TOKEN=.*$/m.test(texto)
    ? texto.replace(/^SPOTIFY_REFRESH_TOKEN=.*$/m, linha)
    : `${texto.replace(/\s*$/, '')}\n${linha}\n`;

  writeFileSync(caminho, texto);
}

// Le o .env direto em vez de src/config.js: da para pegar o refresh token do
// Spotify antes mesmo de ter criado o bot no Discord.
const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const redirectUri = process.env.SPOTIFY_REDIRECT_URI?.trim() || 'http://127.0.0.1:8888/callback';

if (!clientId || !clientSecret) {
  console.error('Preencha SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET no .env primeiro.');
  process.exit(1);
}

// modify-playback-state permite enfileirar faixas na sua conta (modo Spotify do
// /sr e do TikTok). Se voce nao usa esse modo, ele fica so nao usado.
const SCOPES =
  'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const state = randomBytes(16).toString('hex');
const redirect = new URL(redirectUri);

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;background:#121212;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="color:#1db954">${title}</h1><p>${body}</p></div>`;
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirect.origin);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Autorizacao negada', error));
    server.close();
    process.exit(1);
  }

  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('State invalido', 'Tente de novo.'));
    return;
  }

  try {
    const tokens = await exchangeCode(url.searchParams.get('code'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Pronto!', 'Pode fechar esta aba e voltar para o terminal.'));

    gravarNoEnv(tokens.refresh_token);
    console.log('\n  Token salvo direto no .env. Reinicie o bot para valer.\n');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Falhou', String(err.message)));
    console.error('\nFalha ao trocar o code por token:', err.message);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 100);
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  }).toString();

  console.log('\n  Abra este link no navegador e autorize:\n');
  console.log(`  ${authUrl}\n`);
  console.log(`  Aguardando o callback em ${redirectUri} ...`);
});
