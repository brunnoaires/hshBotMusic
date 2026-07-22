import { crc32, deflateSync } from 'node:zlib';

// Embed do Discord nao renderiza gradiente nem alca arredondada: barra de
// progresso bonita so sai como imagem. Este modulo rasteriza uma na mao e
// codifica o PNG com o zlib do proprio Node — sem dependencia grafica nenhuma.

const LARGURA = 600;
const ALTURA = 92;
const MARGEM = 12;

const TRILHA_Y = 24;
const TRILHA_H = 12;
const ALCA_R = 10;

const COR_TRILHA = [74, 74, 82];
const COR_INICIO = [32, 32, 36]; // preto...
const COR_FIM = [255, 255, 255]; // ...ao branco
const COR_ALCA = [255, 255, 255];
const COR_ALCA_BORDA = [18, 18, 20];
const COR_TEXTO = [205, 207, 212];

// Fonte 5x7 desenhada a mao: so precisamos de digitos e dois-pontos, e assim o
// modulo nao depende de nenhuma biblioteca de fonte.
const FONTE = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
};

const GLIFO_W = 5;
const GLIFO_H = 7;

class Canvas {
  constructor(largura, altura) {
    this.largura = largura;
    this.altura = altura;
    this.pixels = Buffer.alloc(largura * altura * 4);
  }

  /** Composicao "source-over" simples; alpha 0..1. */
  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.largura || y >= this.altura) return;

    const i = (y * this.largura + x) * 4;
    const a = Math.min(1, alpha);
    const destA = this.pixels[i + 3] / 255;
    const outA = a + destA * (1 - a);
    if (outA <= 0) return;

    for (let c = 0; c < 3; c++) {
      const src = [r, g, b][c];
      this.pixels[i + c] = Math.round((src * a + this.pixels[i + c] * destA * (1 - a)) / outA);
    }
    this.pixels[i + 3] = Math.round(outA * 255);
  }

  toPNG() {
    // Cada scanline vai prefixada pelo byte de filtro (0 = nenhum).
    const bruto = Buffer.alloc(this.altura * (this.largura * 4 + 1));
    for (let y = 0; y < this.altura; y++) {
      const destino = y * (this.largura * 4 + 1);
      bruto[destino] = 0;
      this.pixels.copy(bruto, destino + 1, y * this.largura * 4, (y + 1) * this.largura * 4);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.largura, 0);
    ihdr.writeUInt32BE(this.altura, 4);
    ihdr[8] = 8; // bits por canal
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0; // compressao
    ihdr[11] = 0; // filtro
    ihdr[12] = 0; // sem entrelacamento

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      bloco('IHDR', ihdr),
      bloco('IDAT', deflateSync(bruto, { level: 9 })),
      bloco('IEND', Buffer.alloc(0)),
    ]);
  }
}

function bloco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);

  const cabecalho = Buffer.from(tipo, 'ascii');
  const verificacao = Buffer.alloc(4);
  verificacao.writeUInt32BE(crc32(Buffer.concat([cabecalho, dados])) >>> 0);

  return Buffer.concat([tamanho, cabecalho, dados, verificacao]);
}

/**
 * Distancia com sinal ate um retangulo arredondado. Negativo dentro, positivo
 * fora — e o que da o antisserrilhado de graca na hora de virar alpha.
 */
function distRetangulo(px, py, cx, cy, meiaL, meiaA, raio) {
  const dx = Math.abs(px - cx) - (meiaL - raio);
  const dy = Math.abs(py - cy) - (meiaA - raio);
  const fora = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return fora + Math.min(Math.max(dx, dy), 0) - raio;
}

const cobertura = (distancia) => Math.max(0, Math.min(1, 0.5 - distancia));

const mistura = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function desenharTexto(canvas, texto, x, y, escala, cor) {
  let cursor = x;

  for (const char of texto) {
    const glifo = FONTE[char];
    if (!glifo) {
      cursor += (GLIFO_W + 1) * escala;
      continue;
    }

    for (let gy = 0; gy < GLIFO_H; gy++) {
      for (let gx = 0; gx < GLIFO_W; gx++) {
        if (glifo[gy][gx] !== '1') continue;
        for (let sy = 0; sy < escala; sy++) {
          for (let sx = 0; sx < escala; sx++) {
            canvas.blend(cursor + gx * escala + sx, y + gy * escala + sy, cor, 1);
          }
        }
      }
    }
    cursor += (GLIFO_W + 1) * escala;
  }

  return cursor - escala;
}

const larguraTexto = (texto, escala) => texto.length * (GLIFO_W + 1) * escala - escala;

export function formatarTempo(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Barra de progresso em PNG, no estilo dos bots de musica: trilha arredondada,
 * preenchimento em gradiente do preto ao branco, alca circular na posicao e os
 * tempos embaixo, nas pontas.
 *
 * @returns {Buffer} PNG RGBA pronto para anexar ao embed.
 */
export function renderizarBarra({ progressMs = 0, durationMs = 0 }) {
  const canvas = new Canvas(LARGURA, ALTURA);

  const barraX = MARGEM;
  const barraL = LARGURA - MARGEM * 2;
  const centroY = TRILHA_Y + TRILHA_H / 2;
  const meiaA = TRILHA_H / 2;

  const fracao = durationMs > 0 ? Math.max(0, Math.min(1, progressMs / durationMs)) : 0;
  const preenchidoAte = barraX + barraL * fracao;

  // Trilha inteira primeiro; o preenchimento entra por cima.
  for (let y = TRILHA_Y - 2; y < TRILHA_Y + TRILHA_H + 2; y++) {
    for (let x = barraX - 2; x < barraX + barraL + 2; x++) {
      const d = distRetangulo(x + 0.5, y + 0.5, barraX + barraL / 2, centroY, barraL / 2, meiaA, meiaA);
      canvas.blend(x, y, COR_TRILHA, cobertura(d));
    }
  }

  if (fracao > 0) {
    const larguraPreenchida = preenchidoAte - barraX;
    for (let y = TRILHA_Y - 2; y < TRILHA_Y + TRILHA_H + 2; y++) {
      for (let x = barraX - 2; x <= preenchidoAte + 1; x++) {
        // Recorta pela trilha inteira para as pontas seguirem arredondadas...
        const dTrilha = distRetangulo(
          x + 0.5, y + 0.5, barraX + barraL / 2, centroY, barraL / 2, meiaA, meiaA,
        );
        // ...e corta na posicao atual, sem arredondar essa borda.
        const dCorte = x + 0.5 - preenchidoAte;
        const alpha = Math.min(cobertura(dTrilha), cobertura(dCorte));
        if (alpha <= 0) continue;

        // Gradiente ancorado no preenchimento: sempre termina branco na alca,
        // em vez de sumir no escuro quando a musica esta no comeco.
        const t = larguraPreenchida > 0 ? (x + 0.5 - barraX) / larguraPreenchida : 1;
        canvas.blend(x, y, mistura(COR_INICIO, COR_FIM, Math.max(0, Math.min(1, t))), alpha);
      }
    }
  }

  // Alca presa dentro da barra, para nao vazar nas pontas.
  const alcaX = Math.max(barraX + ALCA_R, Math.min(barraX + barraL - ALCA_R, preenchidoAte));
  for (let y = centroY - ALCA_R - 2; y <= centroY + ALCA_R + 2; y++) {
    for (let x = alcaX - ALCA_R - 2; x <= alcaX + ALCA_R + 2; x++) {
      const d = Math.hypot(x + 0.5 - alcaX, y + 0.5 - centroY) - ALCA_R;
      // A borda escura mantem a alca visivel tambem no tema claro do Discord.
      canvas.blend(Math.round(x), Math.round(y), COR_ALCA_BORDA, cobertura(d));
      canvas.blend(Math.round(x), Math.round(y), COR_ALCA, cobertura(d + 2));
    }
  }

  // O Discord reduz a imagem no embed; a escala 4 mantem os tempos legiveis
  // depois desse encolhimento.
  const escala = 4;
  const topoTexto = 54;
  const atual = formatarTempo(progressMs);
  const total = formatarTempo(durationMs);

  desenharTexto(canvas, atual, barraX, topoTexto, escala, COR_TEXTO);
  desenharTexto(
    canvas,
    total,
    barraX + barraL - larguraTexto(total, escala),
    topoTexto,
    escala,
    COR_TEXTO,
  );

  return canvas.toPNG();
}
