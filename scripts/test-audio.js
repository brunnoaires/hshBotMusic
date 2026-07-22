import { createHash } from 'node:crypto';
import { resolveAudio } from '../src/audio/resolve.js';
import { spawnFfmpeg } from '../src/audio/ffmpeg.js';
import { resolveCache } from '../src/audio/cache.js';

// Diagnostico da cadeia de audio sem envolver o Discord: yt-dlp acha a faixa,
// o ffmpeg transcodifica, e conferimos que sai ogg/opus valido.
//   node scripts/test-audio.js "Daft Punk - Get Lucky" [segundos-de-seek]
//
// Rode duas vezes com a mesma query para ver o efeito do cache: o id sintetico
// abaixo e estavel, entao a segunda rodada bate no cache como bateria uma faixa
// repetida no Spotify.

const query = process.argv[2] ?? 'Daft Punk - Get Lucky';
const seekSec = Number(process.argv[3] ?? 0);
const [artists, ...rest] = query.split(' - ');

console.log(`Procurando: ${query}`);
const started = Date.now();

const source = await resolveAudio({
  id: createHash('sha1').update(query).digest('hex').slice(0, 22),
  artists,
  title: rest.join(' - ') || query,
  durationMs: null,
});

if (!source) {
  console.error('Nao achei nada. Cadeia do yt-dlp quebrada ou busca sem resultado.');
  process.exit(1);
}

console.log(`Achou em ${Date.now() - started}ms: ${source.title}`);
console.log(`URL: ${source.url.slice(0, 80)}...\n`);

// O cache grava com debounce; sem isso o processo termina antes de persistir.
await resolveCache.flush();

const proc = spawnFfmpeg(source, seekSec * 1000);
proc.stderr.on('data', (chunk) => process.stderr.write(chunk));

let bytes = 0;
let first = null;

proc.stdout.on('data', (chunk) => {
  first ??= chunk;
  bytes += chunk.length;
  // 256 KB ja provam que o stream esta fluindo; nao precisa baixar a faixa toda.
  if (bytes > 256 * 1024) proc.kill('SIGKILL');
});

proc.on('close', () => {
  const magic = first?.subarray(0, 4).toString('ascii');
  if (magic === 'OggS') {
    console.log(`OK — ${(bytes / 1024).toFixed(0)} KB de ogg/opus. Cadeia de audio funcionando.`);
  } else {
    console.error(`FALHOU — esperava magic "OggS", veio "${magic ?? 'nada'}" (${bytes} bytes).`);
    process.exit(1);
  }
});
