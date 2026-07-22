import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ASSET, BIN_DIR, BIN_PATH } from '../src/audio/ytdlp.js';

// Release oficial do projeto yt-dlp. Os binarios sao standalone (PyInstaller),
// por isso nao precisam de Python instalado na maquina.
const URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;
const isZip = ASSET.endsWith('.zip');

function extractZip(zipPath, destDir) {
  // O tar do Windows (bsdtar, System32) le zip. Chamado pelo caminho completo
  // para nao cair no tar do Git Bash, que interpreta "C:" como host remoto.
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

  return new Promise((resolve, reject) => {
    const proc = spawn(tar, ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar saiu com codigo ${code}`)),
    );
  });
}

console.log(`Baixando ${ASSET}`);
console.log(`  de:   ${URL}`);
console.log(`  para: ${BIN_PATH}\n`);

const res = await fetch(URL, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download falhou: HTTP ${res.status}`);
  process.exit(1);
}

const bytes = Buffer.from(await res.arrayBuffer());
await mkdir(BIN_DIR, { recursive: true });

if (isZip) {
  const zipPath = path.join(BIN_DIR, ASSET);
  const destDir = path.dirname(BIN_PATH);

  await writeFile(zipPath, bytes);
  // Sem limpar, uma atualizacao deixaria arquivos da versao antiga em _internal.
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await extractZip(zipPath, destDir);
  await rm(zipPath, { force: true });

  // Resquicio de instalacoes anteriores, quando usavamos o onefile.
  await rm(path.join(BIN_DIR, 'yt-dlp.exe'), { force: true });
} else {
  await writeFile(BIN_PATH, bytes);
  await chmod(BIN_PATH, 0o755);
}

console.log(`Pronto — ${(bytes.length / 1024 / 1024).toFixed(1)} MB baixados.`);
console.log('Para atualizar depois, rode este mesmo comando de novo.');
