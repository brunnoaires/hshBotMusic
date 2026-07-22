import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Gera o PDF com a documentacao funcional do bot.
//   npm run docs:pdf
//
// As fontes padrao do PDF usam WinAnsi, que cobre a acentuacao do portugues mas
// nao setas, emoji ou box-drawing. Por isso o conteudo usa "->" e nao seta. Um
// caractere fora do WinAnsi faz o pdf-lib lancar erro na geracao, entao a
// propria geracao ja serve de verificacao.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'botdc-funcionalidades.pdf');

const A4 = [595.28, 841.89];
const MARGIN = 56;
const CONTENT_WIDTH = A4[0] - MARGIN * 2;

const VERDE = rgb(0.114, 0.725, 0.329);
const TINTA = rgb(0.11, 0.11, 0.12);
const CINZA = rgb(0.42, 0.42, 0.45);
const LINHA = rgb(0.85, 0.85, 0.87);
const FUNDO = rgb(0.965, 0.965, 0.972);

const doc = await PDFDocument.create();
const regular = await doc.embedFont(StandardFonts.Helvetica);
const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
const mono = await doc.embedFont(StandardFonts.Courier);

let page;
let y;
const paginas = [];

function novaPagina() {
  page = doc.addPage(A4);
  paginas.push(page);
  y = A4[1] - MARGIN;
}

/** Garante espaco vertical; abre pagina nova se nao couber. */
function reservar(altura) {
  if (y - altura < MARGIN + 24) novaPagina();
}

/**
 * Quebra o texto em linhas que cabem na largura dada.
 *
 * A folga de 2pt cobre divergencia de arredondamento entre a medicao e o
 * rasterizador. Palavra que sozinha nao cabe e cortada no meio, senao ela
 * vazaria para fora da margem em vez de quebrar.
 */
function quebrar(texto, font, size, larguraBruta) {
  const largura = larguraBruta - 2;
  const cabe = (s) => font.widthOfTextAtSize(s, size) <= largura;

  const partir = (palavra) => {
    const partes = [];
    let resto = palavra;
    while (!cabe(resto)) {
      let corte = resto.length - 1;
      while (corte > 1 && !cabe(resto.slice(0, corte))) corte--;
      partes.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    partes.push(resto);
    return partes;
  };

  const linhas = [];
  let atual = '';

  for (const bruta of texto.split(/\s+/)) {
    for (const palavra of cabe(bruta) ? [bruta] : partir(bruta)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (cabe(tentativa)) {
        atual = tentativa;
      } else {
        if (atual) linhas.push(atual);
        atual = palavra;
      }
    }
  }
  if (atual) linhas.push(atual);

  return linhas;
}

function texto(str, { font = regular, size = 10, cor = TINTA, x = MARGIN, largura = CONTENT_WIDTH, leading = 14 } = {}) {
  for (const linha of quebrar(str, font, size, largura)) {
    reservar(leading);
    page.drawText(linha, { x, y: y - size, size, font, color: cor });
    y -= leading;
  }
}

function titulo1(str) {
  reservar(52);
  y -= 14;
  page.drawRectangle({ x: MARGIN, y: y - 20, width: 3, height: 22, color: VERDE });
  page.drawText(str, { x: MARGIN + 12, y: y - 15, size: 15, font: negrito, color: TINTA });
  y -= 34;
}

function titulo2(str) {
  reservar(30);
  y -= 8;
  page.drawText(str, { x: MARGIN, y: y - 11, size: 11, font: negrito, color: TINTA });
  y -= 22;
}

function paragrafo(str) {
  texto(str);
  y -= 6;
}

function bullets(itens) {
  for (const item of itens) {
    const linhas = quebrar(item, regular, 10, CONTENT_WIDTH - 16);
    // Reserva o item inteiro de uma vez: reservando linha a linha, a pagina
    // pode quebrar entre o marcador e o texto e deixar o marcador orfao.
    reservar(linhas.length * 14 + 2);

    page.drawText('.', { x: MARGIN + 4, y: y - 7, size: 14, font: negrito, color: VERDE });
    for (const linha of linhas) {
      page.drawText(linha, { x: MARGIN + 16, y: y - 10, size: 10, font: regular, color: TINTA });
      y -= 14;
    }
    y -= 2;
  }
  y -= 6;
}

/**
 * Tabela com larguras proporcionais. A primeira linha e cabecalho, e a primeira
 * coluna sai em monoespacada quando `codigo` esta ligado (comandos, variaveis).
 */
function tabela(linhas, { pesos, codigo = false } = {}) {
  const total = pesos.reduce((a, b) => a + b, 0);
  const larguras = pesos.map((p) => (p / total) * CONTENT_WIDTH);
  const PAD = 7;
  const SIZE = 9;
  const LEADING = 12;

  const fonteDe = (coluna, cabecalho) =>
    cabecalho ? negrito : codigo && coluna === 0 ? mono : regular;

  const medir = (linha, cabecalho) => {
    const celulas = linha.map((celula, coluna) =>
      quebrar(String(celula), fonteDe(coluna, cabecalho), SIZE, larguras[coluna] - PAD * 2),
    );
    return { celulas, altura: Math.max(...celulas.map((c) => c.length)) * LEADING + PAD * 2 - 4 };
  };

  const desenhar = ({ celulas, altura }, cabecalho) => {
    if (cabecalho) {
      page.drawRectangle({
        x: MARGIN, y: y - altura, width: CONTENT_WIDTH, height: altura, color: FUNDO,
      });
    }

    let x = MARGIN;
    celulas.forEach((conteudo, coluna) => {
      conteudo.forEach((linha, i) => {
        page.drawText(linha, {
          x: x + PAD,
          y: y - PAD - SIZE - i * LEADING + 1,
          size: SIZE,
          font: fonteDe(coluna, cabecalho),
          color: cabecalho || (codigo && coluna === 0) ? TINTA : CINZA,
        });
      });
      x += larguras[coluna];
    });

    y -= altura;
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_WIDTH, y },
      thickness: 0.5, color: LINHA,
    });
  };

  const [titulos, ...corpo] = linhas;
  const cabecalho = medir(titulos, true);

  reservar(cabecalho.altura + 2);
  desenhar(cabecalho, true);

  for (const linha of corpo) {
    const medida = medir(linha, false);
    // Tabela que atravessa a pagina precisa repetir o cabecalho, senao as
    // colunas da continuacao ficam sem rotulo.
    if (y - medida.altura < MARGIN + 24) {
      novaPagina();
      desenhar(cabecalho, true);
    }
    desenhar(medida, false);
  }

  y -= 12;
}

function nota(str) {
  const linhas = quebrar(str, regular, 9, CONTENT_WIDTH - 26);
  const altura = linhas.length * 12 + 16;
  reservar(altura + 8);

  page.drawRectangle({ x: MARGIN, y: y - altura, width: CONTENT_WIDTH, height: altura, color: FUNDO });
  page.drawRectangle({ x: MARGIN, y: y - altura, width: 3, height: altura, color: VERDE });

  linhas.forEach((linha, i) => {
    page.drawText(linha, { x: MARGIN + 16, y: y - 17 - i * 12, size: 9, font: regular, color: CINZA });
  });

  y -= altura + 12;
}

// ---------------------------------------------------------------------------
// Capa
// ---------------------------------------------------------------------------

novaPagina();

y -= 150;
page.drawRectangle({ x: MARGIN, y: y + 42, width: 46, height: 4, color: VERDE });
page.drawText('botdc', { x: MARGIN, y: y - 12, size: 40, font: negrito, color: TINTA });
y -= 46;
texto('Bot de Discord que segue em tempo real o que está tocando no seu Spotify', {
  size: 13, cor: CINZA, leading: 18,
});
y -= 8;
texto('Documentação funcional', { size: 13, cor: CINZA, leading: 18 });

y -= 60;
page.drawLine({
  start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_WIDTH, y }, thickness: 0.5, color: LINHA,
});
y -= 26;

texto(
  'Você troca a música no celular e o bot troca na call, começando no mesmo ponto em que o seu ' +
    'Spotify está. Este documento lista tudo o que ele faz: comandos, detecção de faixa, ' +
    'reprodução, desempenho, tolerância a falhas e configuração.',
  { size: 10.5, cor: CINZA, leading: 16 },
);

y -= 30;
texto(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`, { size: 9, cor: CINZA });

// ---------------------------------------------------------------------------

novaPagina();

titulo1('1. Comandos');
paragrafo(
  'Qualquer pessoa pode usar o bot, no servidor dela, sem login e sem token. Cada servidor tem ' +
    'uma sessão própria, seguindo o Spotify de quem rodou /vincular — o "driver". A mesma pessoa ' +
    'pode comandar vários servidores ao mesmo tempo.',
);

tabela(
  [
    ['Comando', 'O que faz'],
    ['/vincular [canal]', 'Entra no canal de voz e passa a seguir o SEU Spotify. Sem argumento, usa o canal em que você está. Se já houver música tocando, começa na hora.'],
    ['/desvincular', 'Para de seguir, sai do canal de voz e limpa a fila.'],
    ['/modo follow|queue', 'Define o que acontece quando você troca de música no Spotify. Em follow a troca é imediata; em queue a faixa nova espera a atual terminar.'],
    ['/agora', 'Mostra faixa, artista, álbum, capa, barra de progresso, qual vídeo foi escolhido no YouTube, o modo ativo e a fonte do dado (presence ou API).'],
    ['/pular', 'Pula a faixa atual. Em modo queue, avança para a próxima da fila.'],
    ['/fila', 'Lista as faixas enfileiradas (até 15, com contagem do restante).'],
    ['/rematch', 'Achou o vídeo errado? Descarta o match guardado em cache e procura de novo.'],
    ['/sr <música>', 'Pede uma música sem depender do Spotify: busca por nome ou aceita um link. Se o bot não estiver em canal nenhum, já entra no seu e começa a tocar.'],
    ['/ajuda', 'Lista todos os comandos com suas descrições e explica, dentro do Discord, como ligar o Spotify à conta. A lista é montada a partir das próprias definições dos comandos, então nunca fica defasada.'],
  ],
  { pesos: [1, 2.4], codigo: true },
);

titulo2('Quem pode usar o quê');
tabela(
  [
    ['Comando', 'Quem pode'],
    ['/sr, /vincular, /agora, /fila, /pular, /ajuda', 'Qualquer pessoa do servidor'],
    ['/desvincular, /modo, /rematch', 'O driver, ou quem tem Gerenciar Servidor'],
  ],
  { pesos: [1.5, 1.4] },
);

paragrafo(
  'Assumir o lugar de quem já está comandando exige Gerenciar Servidor: sem isso, qualquer um ' +
    'derrubaria a sessão alheia no meio da música. Quando o canal de voz esvazia, a sessão ' +
    'encerra sozinha.',
);

titulo2('Modo jukebox: sem Spotify');
bullets([
  'Não é preciso vincular nada. O /sr pede música por nome ou por link, e se o bot não estiver em canal nenhum, ele já entra no seu e começa a tocar.',
  'Sem ninguém sendo seguido, não há driver a proteger: a fila é coletiva e os controles ficam abertos a todo mundo.',
  'Um pedido nunca corta o que está tocando — quem pediu antes ouve inteiro. O /fila mostra quem pediu cada faixa.',
  'Link de playlist traz só o vídeo apontado, senão um único pedido viraria centenas de faixas.',
  'Dá para usar /sr numa sessão já vinculada ao Spotify, mas em modo follow a próxima troca interrompe o pedido. O bot avisa disso na resposta e sugere /modo queue, onde as duas fontes convivem na mesma fila.',
]);

titulo1('2. Detecção do que está tocando');

paragrafo(
  'Duas fontes independentes alimentam o bot, e elas se cobrem: se uma não estiver disponível, ' +
    'a outra sustenta o funcionamento sozinha.',
);

titulo2('Presence do Discord');
bullets([
  'Chega por push, em cerca de 1 segundo, sem nenhuma consulta de rede da nossa parte.',
  'Traz id da faixa, título, artista, álbum e os horários de início e fim.',
  'Depende de o Spotify estar conectado à sua conta do Discord e de "Exibir o Spotify como seu status" estar ligado.',
  'Não informa progresso exato nem distingue pausa de "parou de compartilhar".',
]);

titulo2('Web API do Spotify (opcional, uma conta só)');
bullets([
  'Consulta periódica (padrão a cada 3 segundos) ao endpoint de faixa atual.',
  'Sabe o progresso em milissegundos, se está pausado e em qual dispositivo.',
  'Também lê a fila, que é o que viabiliza o prefetch descrito na seção 4.',
  'Respeita limite de requisições: em resposta 429, recua pelo tempo que o Spotify pedir.',
  'Vale apenas para a conta de OWNER_USER_ID, porque o token do .env pertence a uma pessoa só. Todos os demais rodam pela presence.',
]);

titulo2('O que muda sem a Web API');
tabela(
  [
    ['Recurso', 'Só presence', 'Presence + API'],
    ['Trocar de faixa junto', 'Sim', 'Sim'],
    ['Sincronizar a posição', 'Sim', 'Sim'],
    ['Espelhar pausa e retomada', 'Não', 'Sim'],
    ['Prefetch (troca instantânea)', 'Não', 'Sim'],
  ],
  { pesos: [1.8, 1, 1] },
);

titulo2('Como as duas se combinam');
bullets([
  'A API é a fonte da verdade para estado e posição; a presence funciona como gatilho rápido.',
  'Quando a presence acusa uma faixa diferente, o bot já começa a resolver com esses dados em vez de esperar a ida e volta da API. São cerca de 300 ms a menos de silêncio.',
  'A consulta seguinte refina progresso e estado. A deduplicação por id da faixa garante que a música não toque duas vezes.',
  'Ao iniciar, o bot lê a presence que já estava no ar. Sem isso, subir com música tocando não detectaria nada até a próxima troca.',
  'Podcasts e episódios são ignorados: só faixas de música.',
]);

// ---------------------------------------------------------------------------

titulo1('3. Reprodução no Discord');

paragrafo(
  'A API do Spotify não entrega áudio em nenhum endpoint nem em nenhum plano. O bot usa apenas ' +
    'os metadados e reprocura a faixa no YouTube, de onde sai o áudio de fato.',
);

titulo2('Escolha do vídeo');
bullets([
  'Busca cinco candidatos e ranqueia por proximidade de duração com a faixa do Spotify, que é o sinal mais confiável de ser a mesma gravação.',
  'Dá preferência a canais "- Topic", que são uploads automáticos da gravadora.',
  'Penaliza títulos com marcadores de versão diferente (live, cover, karaokê, sped up, nightcore e afins), a menos que a própria faixa os tenha no nome.',
]);

titulo2('Áudio');
bullets([
  'O ffmpeg transcodifica para ogg/opus a 128 kbps, 48 kHz, estéreo, que é o formato que o Discord aceita direto.',
  'Com SYNC_POSITION ligado, a música começa no mesmo ponto em que o seu Spotify está, já somando o tempo gasto na busca. Você não ouve a faixa atrasada, apenas espera menos.',
  'O bot entra no canal em modo surdo, sem consumir áudio de ninguém.',
]);

titulo2('Cartão "Reproduzindo agora"');
bullets([
  'A cada troca de música, um cartão é publicado no canal de texto onde /vincular foi usado: capa do álbum, faixa com link para o Spotify, quem está sendo seguido, canal de voz, contadores e barra de progresso.',
  'A barra é uma imagem PNG gerada na hora, porque embed do Discord não renderiza gradiente nem alça circular. O preenchimento vai do preto ao branco e termina sempre claro na alça.',
  'Não usa biblioteca gráfica: os pixels são rasterizados à mão e o PNG é codificado com o zlib do próprio Node. Os dígitos saem de uma fonte 5x7 desenhada no próprio arquivo.',
  'O cartão sai depois que o áudio começa, então já mostra qual vídeo foi escolhido e em que ponto o bot entrou.',
  'O cartão anterior é apagado a cada troca, para o canal não virar um mural. Desliga com ANNOUNCE_TRACKS=false.',
]);

titulo2('Modos e espelhamento');
tabela(
  [
    ['Situação no Spotify', 'O que o bot faz'],
    ['Troca de faixa, modo follow', 'Interrompe o que estava tocando e toca a faixa nova, sincronizada na posição.'],
    ['Troca de faixa, modo queue', 'Enfileira. A faixa da fila começa do início quando chega a vez dela, e não no ponto em que entrou.'],
    ['Pausa', 'Pausa a reprodução no canal de voz.'],
    ['Retoma', 'Retoma de onde parou.'],
    ['Para de tocar', 'Encerra o áudio e limpa o status do bot.'],
    ['Qualquer faixa nova', 'O status do bot passa a exibir "Ouvindo <faixa> - <artista>".'],
  ],
  { pesos: [1, 1.6] },
);

// ---------------------------------------------------------------------------

titulo1('4. Desempenho');

paragrafo(
  'Resolver uma faixa custa duas chamadas ao yt-dlp: a busca e a extração da URL de áudio. ' +
    'Três mecanismos evitam pagar esse custo na frente do usuário.',
);

titulo2('Cache em duas camadas');
tabela(
  [
    ['Chave', 'Guarda', 'Vence'],
    ['match:<id spotify>', 'Id do vídeo no YouTube', 'Nunca; a escolha não muda'],
    ['stream:<id vídeo>', 'URL assinada e cabeçalhos', 'Junto com a assinatura, menos 15 min de margem'],
  ],
  { pesos: [1.1, 1.2, 1.4], codigo: true },
);

paragrafo(
  'A margem de 15 minutos existe para a URL não vencer no meio de uma faixa longa. O arquivo fica ' +
    'em cache/resolve.json, com escrita atômica, teto de 2000 entradas e descarte do menos usado.',
);

titulo2('Prefetch');
paragrafo(
  'O cache sozinho só ajuda na segunda vez. Para a primeira também ser instantânea, o bot consulta ' +
    'a fila do Spotify cinco segundos depois de cada troca e resolve as duas próximas faixas ' +
    'enquanto a atual toca. Ouvindo álbum ou playlist na ordem, a troca já está pronta. A espera de ' +
    'cinco segundos é proposital: logo após a troca, a faixa atual ainda está resolvendo, e não vale ' +
    'competir com ela por rede e processamento.',
);

titulo2('Binário onedir');
paragrafo(
  'No Windows o bot usa o build onedir do yt-dlp em vez do executável único. O onefile é um pacote ' +
    'que se reextrai a cada execução, custando cerca de 1,6 s de inicialização toda vez; já ' +
    'descompactado, o mesmo binário inicia em 0,4 s. Como são duas chamadas por faixa, isso sozinho ' +
    'cortou aproximadamente 2,4 s do atraso.',
);

titulo2('Resultado medido');
tabela(
  [
    ['Situação', 'Tempo até tocar'],
    ['Sequência normal de playlist ou álbum (pré-buscada)', 'aprox. 1 ms'],
    ['Faixa já tocada antes, URL vencida', 'aprox. 1,6 s'],
    ['Faixa nova e fora da fila (pulo aleatório)', 'aprox. 3,4 s'],
  ],
  { pesos: [2.2, 1] },
);

nota(
  'O piso é o próprio yt-dlp, que gasta cerca de 1,6 s por chamada e não tem modo servidor. Para ' +
    'ficar abaixo disso seria preciso trocar a fonte de áudio.',
);

// ---------------------------------------------------------------------------

titulo1('5. Tolerância a falhas');

bullets([
  'URL de áudio vencida ou recusada: o ffmpeg morre em segundos sem produzir som. O bot detecta, descarta a URL do cache e tenta uma vez com uma nova.',
  'Vídeo removido, privado ou bloqueado na região: o vínculo entre a faixa e aquele vídeo é desfeito e a busca, refeita.',
  'Troca rápida de música: resoluções que ficaram obsoletas no meio do caminho são descartadas, então a faixa antiga nunca começa a tocar por cima da nova.',
  'Queda na conexão de voz: se for apenas mudança de região, o bot reata sozinho; se for perda real, sai do canal de forma limpa.',
  'Limite de requisições do Spotify: recuo pelo tempo indicado, sem derrubar o bot.',
  'Falha de rede na consulta: recuo curto para não inundar o log, e a consulta seguinte segue normalmente.',
  'Cache corrompido ou ausente: começa vazio, sem impedir a inicialização.',
  'Fila indisponível: o prefetch é best-effort, e a faixa apenas resolve na hora de tocar.',
  'Encerramento: o cache é gravado antes de sair, para os matches da sessão não se perderem.',
]);

// ---------------------------------------------------------------------------

titulo1('6. Configuração');

paragrafo('Tudo vem do arquivo .env. Variáveis obrigatórias ausentes são apontadas pelo nome na inicialização.');

tabela(
  [
    ['Variável', 'Para que serve'],
    ['DISCORD_TOKEN', 'Token do bot. Obrigatório.'],
    ['DISCORD_CLIENT_ID', 'Application ID, usado no registro dos comandos. Obrigatório.'],
    ['DISCORD_GUILD_ID', 'Servidor onde registrar os comandos. Deixe VAZIO para registro global, que é o necessário para o bot funcionar em servidores de outras pessoas. Propaga em até 1 h.'],
    ['OWNER_USER_ID', 'Opcional. Identifica de quem é a conta do Spotify configurada abaixo; só essa pessoa ganha os extras da Web API.'],
    ['SPOTIFY_CLIENT_ID', 'Opcional. Credencial da Web API. Sem ela, todos rodam pela presence.'],
    ['SPOTIFY_CLIENT_SECRET', 'Credencial da Web API.'],
    ['SPOTIFY_REFRESH_TOKEN', 'Gerado por npm run login:spotify. Não expira.'],
    ['SPOTIFY_REDIRECT_URI', 'Padrão http://127.0.0.1:8888/callback. O Spotify exige loopback e não aceita mais localhost.'],
    ['POLL_INTERVAL_MS', 'Intervalo de consulta à Web API. Padrão 3000.'],
    ['DEFAULT_MODE', 'follow ou queue. Padrão follow.'],
    ['SYNC_POSITION', 'Começar no mesmo ponto do seu Spotify. Padrão ligado.'],
    ['ANNOUNCE_TRACKS', 'Publicar o cartão "Reproduzindo agora" a cada troca. Padrão ligado.'],
    ['LOG_LEVEL', 'debug, info, warn ou error. Em debug mostra ranking dos candidatos, acertos de cache e a saída do ffmpeg.'],
  ],
  { pesos: [1.15, 2], codigo: true },
);

titulo1('7. Comandos de terminal');

tabela(
  [
    ['Comando', 'O que faz'],
    ['npm start', 'Liga o bot.'],
    ['npm run setup:ytdlp', 'Baixa ou atualiza o yt-dlp. Primeira coisa a tentar quando o YouTube quebrar a extração.'],
    ['npm run login:spotify', 'Faz o login no Spotify e imprime o refresh token para colar no .env.'],
    ['npm run deploy:commands', 'Registra os comandos de barra. Com DISCORD_GUILD_ID vazio, registra globalmente e limpa registros de servidor sobrando, que é o que faz os comandos aparecerem duplicados.'],
    ['npm run check', 'Checagem offline: binários, carregamento dos módulos, montagem dos comandos, cache e lógica de detecção. Não precisa de credenciais.'],
    ['npm run test:audio', 'Diagnóstico da cadeia de áudio isolada do Discord. Aceita a busca e um ponto de início em segundos.'],
    ['npm run docs:pdf', 'Gera este documento.'],
  ],
  { pesos: [1.15, 2], codigo: true },
);

// ---------------------------------------------------------------------------

titulo1('8. Limitações conhecidas');

bullets([
  'A API do Spotify não entrega áudio. Reprocurar a faixa no YouTube é o que torna a reprodução possível, e também o que viola os termos de uso daquele serviço. Para uso pessoal em servidor próprio é o caminho padrão; para um bot público, não é.',
  'O match nem sempre é perfeito: a escolha do vídeo é heurística. Confira com /agora e corrija com /rematch.',
  'Um canal de voz por servidor, seguindo uma pessoa por vez. Vários servidores em paralelo, sim.',
  'Web API do Spotify: 25 usuários. Um app em modo de desenvolvimento exige cadastrar cada pessoa manualmente no painel, e a liberação de cota passa por revisão da Spotify, que costuma recusar exatamente este tipo de uso. Por isso a Web API vale para uma conta só e todo o resto roda pela presence.',
  'Discord: 100 servidores sem verificação. Verificar exige justificar o Presence Intent, que é privilegiado e difícil de aprovar para um bot que lê o que os outros ouvem.',
  'Cada servidor ativo custa uma conexão de voz e um ffmpeg na máquina que hospeda.',
  'Faixa nova fora da fila ainda custa cerca de 3,4 s, limitados pelo yt-dlp.',
  'Se o YouTube apertar o cerco na extração, atualizar o yt-dlp resolve na maioria das vezes. Essa é a manutenção recorrente deste tipo de bot.',
]);

// ---------------------------------------------------------------------------
// Rodape com numeracao, aplicado depois de saber o total de paginas.
// ---------------------------------------------------------------------------

paginas.forEach((p, indice) => {
  if (indice === 0) return;
  const rotulo = `${indice} / ${paginas.length - 1}`;
  const largura = regular.widthOfTextAtSize(rotulo, 8);

  p.drawText('botdc', { x: MARGIN, y: MARGIN - 18, size: 8, font: regular, color: LINHA });
  p.drawText(rotulo, {
    x: A4[0] - MARGIN - largura, y: MARGIN - 18, size: 8, font: regular, color: CINZA,
  });
});

doc.setTitle('botdc - Documentação funcional');
doc.setSubject('O que o bot faz: comandos, detecção, reprodução, desempenho e configuração');
doc.setCreator('botdc');

await writeFile(OUT, await doc.save());
console.log(`PDF gerado: ${OUT}`);
console.log(`${paginas.length} paginas.`);
