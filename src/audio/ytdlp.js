import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { criarSemaforo } from './semaforo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const isWindows = process.platform === 'win32';

/**
 * Asset do release do yt-dlp para uma plataforma e arquitetura.
 *
 * No Windows usamos o build "onedir" (zip) em vez do .exe unico: o onefile e um
 * bundle PyInstaller que se reextrai a cada execucao, custando ~1.6s de startup
 * toda vez. Ja descompactado, o mesmo binario inicia em ~0.4s — e o resolve faz
 * duas chamadas, entao a diferenca aparece dobrada.
 *
 * A arquitetura importa em Linux: as maquinas gratuitas mais generosas (Oracle
 * Ampere, por exemplo) sao ARM, e o binario x86 simplesmente nao executa la.
 *
 * O projeto so publica binarios standalone para x86_64 e aarch64. Em ARM de 32
 * bits (Raspberry Pi com sistema de 32 bits) cai no zipapp Python, que exige
 * Python 3 na maquina — presente por padrao no Raspberry Pi OS.
 */
export function assetPara(plataforma = process.platform, arquitetura = process.arch) {
  if (plataforma === 'win32') return 'yt-dlp_win.zip';
  if (plataforma === 'darwin') return 'yt-dlp_macos';
  if (plataforma !== 'linux') return 'yt-dlp';

  return (
    { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64', arm: 'yt-dlp' }[arquitetura] ??
    'yt-dlp_linux'
  );
}

export const ASSET = assetPara();

export const BIN_DIR = path.join(ROOT, 'bin');

export const BIN_PATH = isWindows
  ? path.join(BIN_DIR, 'yt-dlp', 'yt-dlp.exe')
  : path.join(BIN_DIR, ASSET);

export function isInstalled() {
  return existsSync(BIN_PATH);
}

// Trocar um pouco de latencia em pico por nao levar o IP para a lista negra do
// YouTube. Fora de pico, a fila esta vazia e ninguem espera.
const semaforo = criarSemaforo(Number(process.env.YTDLP_CONCURRENCY ?? 3));

/** Quantas chamadas rodam e quantas esperam; util com LOG_LEVEL=debug. */
export const statusFila = () => semaforo.status();

/**
 * Roda o yt-dlp e devolve o JSON do stdout.
 *
 * O yt-dlp fala bastante no stderr mesmo quando da certo, entao o unico
 * criterio de sucesso e o exit code.
 */
export async function runJson(args) {
  if (!isInstalled()) {
    throw new Error(`yt-dlp nao encontrado em ${BIN_PATH}. Rode: npm run setup:ytdlp`);
  }

  return semaforo.executar(() => executar(args));
}

function executar(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp saiu com codigo ${code}: ${stderr.trim().slice(0, 400)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`saida do yt-dlp nao e JSON valido: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
