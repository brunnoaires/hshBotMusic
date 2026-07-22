import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from '../logger.js';

const log = createLogger('ffmpeg');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/**
 * Transcodifica a URL de audio para ogg/opus no stdout.
 *
 * O Discord aceita opus cru, entao deixar o ffmpeg cuidar do encode dispensa
 * o @discordjs/opus — que e uma dependencia nativa e a que mais quebra em
 * instalacao no Windows.
 *
 * @param {{url: string, headers?: object}} source
 * @param {number} seekMs ponto de inicio, para casar com o seu Spotify
 */
export function spawnFfmpeg(source, seekMs = 0) {
  const headers = source.headers ?? {};
  const userAgent = headers['User-Agent'] ?? headers['user-agent'] ?? DEFAULT_UA;
  const extraHeaders = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== 'user-agent')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    // Ja sabemos que e um stream de audio unico; sondar mais que isso so atrasa
    // o primeiro byte.
    '-probesize', '32k',
    '-analyzeduration', '0',
    // A URL do googlevideo pode cair no meio de faixas longas.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', userAgent,
  ];

  if (extraHeaders) args.push('-headers', `${extraHeaders}\r\n`);
  // -ss antes de -i faz seek por HTTP range: pula direto, sem decodificar.
  if (seekMs > 1000) args.push('-ss', (seekMs / 1000).toFixed(3));

  args.push(
    '-i', source.url,
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'opus',
    'pipe:1',
  );

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (chunk) => log.debug(chunk.toString().trim()));
  proc.on('error', (err) => log.error('falhou ao iniciar:', err.message));

  return proc;
}
