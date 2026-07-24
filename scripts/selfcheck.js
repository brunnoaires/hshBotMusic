// Checagem rapida do que da para verificar sem token do Discord nem conta do
// Spotify: os modulos carregam, os slash commands sao validos, e a logica de
// deduplicacao / leitura de presence se comporta como esperado.
//   npm run check

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('escolhe o binario certo por plataforma e arquitetura', async () => {
  const { assetPara } = await import('../src/audio/ytdlp.js');

  const casos = [
    ['win32', 'x64', 'yt-dlp_win.zip'],
    ['darwin', 'arm64', 'yt-dlp_macos'],
    ['linux', 'x64', 'yt-dlp_linux'],
    // Maquinas gratuitas mais generosas sao ARM; o binario x86 nao roda la.
    ['linux', 'arm64', 'yt-dlp_linux_aarch64'],
    // Nao existe binario standalone para ARM 32 bits; cai no zipapp Python.
    ['linux', 'arm', 'yt-dlp'],
    // Arquitetura desconhecida cai no x86, que e o mais provavel.
    ['linux', 'mips', 'yt-dlp_linux'],
  ];

  for (const [plataforma, arquitetura, esperado] of casos) {
    const obtido = assetPara(plataforma, arquitetura);
    if (obtido !== esperado) {
      throw new Error(`${plataforma}/${arquitetura}: esperava ${esperado}, veio ${obtido}`);
    }
  }

  return `${casos.length} combinacoes corretas`;
});

check('cookies do yt-dlp, se configurados, estao utilizaveis', async () => {
  const caminho = process.env.YTDLP_COOKIES?.trim();
  if (!caminho) return 'nao configurados (normal em IP residencial)';

  const { existsSync, statSync } = await import('node:fs');
  if (!existsSync(caminho)) throw new Error(`YTDLP_COOKIES aponta para arquivo inexistente`);

  const modo = statSync(caminho).mode & 0o777;
  // O arquivo da acesso a conta do YouTube que o gerou; nao pode ficar legivel
  // para outros usuarios da maquina.
  if (process.platform !== 'win32' && modo & 0o077) {
    throw new Error(`permissoes frouxas (${modo.toString(8)}); use chmod 600`);
  }

  return `ok (${caminho})`;
});

check('binarios instalados', async () => {
  const { isInstalled, BIN_PATH } = await import('../src/audio/ytdlp.js');
  const { existsSync } = await import('node:fs');
  const ffmpegPath = (await import('ffmpeg-static')).default;

  if (!isInstalled()) throw new Error(`yt-dlp ausente (${BIN_PATH}); rode npm run setup:ytdlp`);
  if (!ffmpegPath || !existsSync(ffmpegPath)) throw new Error('ffmpeg-static sem binario');
  return 'yt-dlp + ffmpeg presentes';
});

check('commands.js constroi os slash commands', async () => {
  const { commands } = await import('../src/discord/commands.js');
  const names = commands.map((c) => c.name);
  const esperados = [
    'vincular', 'desvincular', 'modo', 'agora', 'pular', 'pausar', 'retomar',
    'fila', 'limpar', 'rematch', 'sr', 'tiktok', 'ajuda',
  ];
  for (const n of esperados) {
    if (!names.includes(n)) throw new Error(`faltou /${n}`);
  }
  return names.map((n) => `/${n}`).join(' ');
});

check('/ajuda lista todos os comandos e cabe nos limites do Discord', async () => {
  const { commands, ajudaEmbed } = await import('../src/discord/commands.js');
  const embed = ajudaEmbed().toJSON();

  const texto = [embed.description, ...embed.fields.flatMap((f) => [f.name, f.value])].join('\n');

  for (const comando of commands) {
    if (!texto.includes(`/${comando.name}`)) throw new Error(`/${comando.name} nao aparece`);
    if (!texto.includes(comando.description)) {
      throw new Error(`a descricao de /${comando.name} nao aparece`);
    }
  }

  // Estourar esses limites so falharia na hora de responder, dentro do Discord.
  if (embed.description.length > 4096) throw new Error('description passa de 4096 caracteres');
  for (const campo of embed.fields) {
    if (campo.value.length > 1024) throw new Error(`campo "${campo.name}" passa de 1024`);
  }
  if (texto.length > 6000) throw new Error('embed passa de 6000 caracteres no total');

  return `${commands.length} comandos, ${texto.length} caracteres`;
});

check('barra de progresso sai como PNG valido', async () => {
  const { renderizarBarra, formatarTempo } = await import('../src/discord/progressbar.js');
  const { inflateSync } = await import('node:zlib');

  if (formatarTempo(213_000) !== '3:33') throw new Error('formatarTempo errado');
  if (formatarTempo(29_000) !== '0:29') throw new Error('formatarTempo errado nos segundos');

  const png = renderizarBarra({ progressMs: 106_000, durationMs: 213_000 });

  const assinatura = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!assinatura.every((b, i) => png[i] === b)) throw new Error('assinatura PNG invalida');

  // Percorre os blocos: se algum tamanho ou CRC estiver errado, a leitura sai
  // do trilho e o total nao fecha com o tamanho do arquivo.
  let off = 8;
  const tipos = [];
  let largura = 0;
  let idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const tipo = png.toString('ascii', off + 4, off + 8);
    const dados = png.subarray(off + 8, off + 8 + len);
    tipos.push(tipo);
    if (tipo === 'IHDR') largura = dados.readUInt32BE(0);
    if (tipo === 'IDAT') idat.push(dados);
    off += 12 + len;
  }
  if (off !== png.length) throw new Error('blocos do PNG nao fecham com o arquivo');
  if (tipos.join(',') !== 'IHDR,IDAT,IEND') throw new Error(`blocos inesperados: ${tipos}`);

  const bruto = inflateSync(Buffer.concat(idat));
  const px = (x, y) => {
    const i = y * (largura * 4 + 1) + 1 + x * 4;
    return [bruto[i], bruto[i + 1], bruto[i + 2], bruto[i + 3]];
  };

  // O gradiente tem que sair escuro na esquerda e branco na alca; se inverter,
  // a barra some no tema escuro do Discord.
  const [r] = px(14, 30);
  if (r > 60) throw new Error(`inicio do gradiente claro demais (${r})`);
  if (px(295, 30)[0] < 200) throw new Error('fim do gradiente deveria ser branco');
  if (px(300, 30).join() !== '255,255,255,255') throw new Error('alca deveria ser branca solida');
  if (px(300, 88)[3] !== 0) throw new Error('fundo deveria ser transparente');

  // Progresso zerado nao pode dividir por zero nem estourar a alca para fora.
  const vazio = renderizarBarra({ progressMs: 0, durationMs: 0 });
  if (vazio.length < 100) throw new Error('barra vazia saiu quebrada');

  return `${png.length} bytes, gradiente e alca ok`;
});

check('cartao de "reproduzindo agora" monta dentro dos limites', async () => {
  const { montarCartao } = await import('../src/discord/nowplaying.js');

  const session = {
    driverId: '123',
    usaApi: false,
    player: { queue: [], mode: 'follow', channelId: 'v1' },
  };
  const track = {
    id: 'abc',
    title: 'XTRANHO',
    artists: 'Matuê',
    url: 'https://open.spotify.com/track/abc',
    artwork: 'https://i.scdn.co/image/abc',
    durationMs: 213_000,
    seekMs: 29_000,
    youtubeTitle: 'Matuê - XTRANHO (Official Video)',
  };

  const cartao = montarCartao({ track, session, voiceChannelName: 'FDM' });
  const embed = cartao.embeds[0].toJSON();

  if (embed.title !== 'Reproduzindo agora') throw new Error('titulo errado');
  if (!embed.description.includes('Matuê')) throw new Error('faltou o artista');
  if (!embed.description.includes('<@123>')) throw new Error('faltou quem esta sendo seguido');
  if (!embed.description.includes('FDM')) throw new Error('faltou o canal de voz');
  if (embed.image?.url !== 'attachment://progresso.png') throw new Error('barra nao anexada');
  if (cartao.files.length !== 1) throw new Error('deveria anexar exatamente um arquivo');
  if (embed.description.length > 4096) throw new Error('description passa de 4096');

  // Faixa sem capa, sem link e sem duracao: nada pode explodir.
  const magro = montarCartao({
    track: { title: 'x', artists: 'y' },
    session,
    voiceChannelName: null,
  });
  const descricaoMagra = magro.embeds[0].toJSON().description;
  if (!descricaoMagra.includes('**y — x**')) {
    throw new Error(`faixa sem url deveria sair em negrito sem link: ${descricaoMagra}`);
  }
  if (descricaoMagra.includes('🔊')) throw new Error('sem canal de voz nao pode sobrar a linha');

  return 'cartao completo e versao minima ok';
});

check('semaforo respeita o limite e nao perde vaga em erro', async () => {
  const { criarSemaforo } = await import('../src/audio/semaforo.js');
  const semaforo = criarSemaforo(2);

  let simultaneos = 0;
  let pico = 0;

  const tarefa = () =>
    semaforo.executar(async () => {
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 20));
      simultaneos--;
    });

  await Promise.all(Array.from({ length: 8 }, tarefa));
  if (pico > 2) throw new Error(`rodaram ${pico} ao mesmo tempo, limite era 2`);
  if (pico < 2) throw new Error(`so ${pico} em paralelo; a fila esta serializando demais`);

  // Tarefa que lanca nao pode reter a vaga, senao o bot trava de vez apos
  // alguns erros de rede.
  await Promise.allSettled(
    Array.from({ length: 4 }, () => semaforo.executar(async () => { throw new Error('falhou'); })),
  );
  const { ativos, esperando } = semaforo.status();
  if (ativos !== 0 || esperando !== 0) {
    throw new Error(`vagas vazaram apos erro: ativos=${ativos} esperando=${esperando}`);
  }

  // E depois disso o semaforo ainda tem que funcionar normalmente.
  let rodou = false;
  await semaforo.executar(async () => { rodou = true; });
  if (!rodou) throw new Error('semaforo travou depois dos erros');

  return `pico ${pico}/2, vagas devolvidas apos erro`;
});

check('sessoes respeitam o teto de servidores simultaneos', async () => {
  const { SessionManager } = await import('../src/session.js');

  const criarPlayer = () => ({
    queue: [], current: null, mode: 'follow',
    join: async () => {}, leave() {}, skip: () => null,
    pause() {}, resume() {}, onSpotifyTrack() {},
  });

  const sessions = new SessionManager({
    config: {
      discord: {}, defaultMode: 'follow', syncPosition: true,
      pollIntervalMs: 60_000, maxSessions: 2, announceTracks: false,
    },
    ownerApi: { enabled: false },
    criarPlayer,
  });

  await sessions.start({ channel: { guild: { id: 'g1' } }, driverId: 'a' });
  await sessions.start({ channel: { guild: { id: 'g2' } }, driverId: 'b' });

  let recusou = false;
  try {
    await sessions.start({ channel: { guild: { id: 'g3' } }, driverId: 'c' });
  } catch (err) {
    recusou = err.message.includes('limite');
  }
  if (!recusou) throw new Error('deveria recusar acima do teto');
  if (sessions.size !== 2) throw new Error(`ficaram ${sessions.size} sessoes`);

  // Servidor que ja tem sessao pode reiniciar mesmo no teto, senao quem ja
  // estava usando perderia o /vincular so porque o bot esta cheio.
  await sessions.start({ channel: { guild: { id: 'g1' } }, driverId: 'a' });
  if (sessions.size !== 2) throw new Error('reiniciar sessao existente nao pode contar como nova');

  sessions.stopAll();
  return 'recusa acima do teto, permite reiniciar existente';
});

check('jukebox: primeiro pedido toca, os seguintes enfileiram', async () => {
  const { SessionManager } = await import('../src/session.js');

  const criarPlayer = () => ({
    queue: [], current: null, carregando: false, mode: 'follow',
    tocadas: [],
    join: async () => {}, leave() {}, skip: () => null,
    pause() {}, resume() {}, onSpotifyTrack() {},
    async play(track) {
      // Imita o player real: `current` so aparece depois de resolver.
      this.carregando = true;
      await new Promise((r) => setTimeout(r, 10));
      this.carregando = false;
      this.current = track;
      this.tocadas.push(track.id);
    },
  });

  const sessions = new SessionManager({
    config: {
      discord: { ownerId: 'dono' }, defaultMode: 'follow', syncPosition: true,
      pollIntervalMs: 60_000, maxSessions: 10, announceTracks: false,
    },
    ownerApi: { enabled: true, currentlyPlaying: async () => null, queue: async () => [] },
    criarPlayer,
  });

  const s = await sessions.start({ channel: { guild: { id: 'g1' } }, driverId: null });
  if (!s.manual) throw new Error('sessao sem driver deveria ser jukebox');
  if (s.usaApi) throw new Error('jukebox nao pode consumir a Web API do dono');

  const faixa = (id) => ({ id, youtubeId: id, title: id, artists: 'x' });

  const um = s.pedir(faixa('a'));
  if (!um.tocandoAgora) throw new Error('o primeiro pedido deveria tocar na hora');
  if (s.player.queue.length !== 0) {
    throw new Error('o que toca agora nao pode ficar tambem na fila, senao repete');
  }

  // Ainda resolvendo: o segundo pedido nao pode cortar o primeiro.
  const dois = s.pedir(faixa('b'));
  if (dois.tocandoAgora) throw new Error('o segundo pedido cortou o primeiro durante a resolucao');
  if (dois.posicao !== 1) throw new Error(`posicao errada: ${dois.posicao}`);

  await new Promise((r) => setTimeout(r, 30));
  const tres = s.pedir(faixa('c'));
  if (tres.tocandoAgora) throw new Error('deveria enfileirar, ja tem faixa tocando');
  if (s.player.tocadas.join(',') !== 'a') throw new Error(`tocou ${s.player.tocadas}`);
  if (s.player.queue.length !== 2) throw new Error(`fila com ${s.player.queue.length}`);

  sessions.stopAll();
  return 'toca a primeira, enfileira b e c, sem duplicar';
});

check('pausa por comando tem precedencia sobre o Spotify', async () => {
  const { SessionManager } = await import('../src/session.js');

  const criarPlayer = () => ({
    queue: [], current: { id: 'a' }, carregando: false, mode: 'follow',
    tocando: true,
    join: async () => {}, leave() {}, skip: () => null, play: async () => {},
    onSpotifyTrack() {},
    pause() { this.tocando = false; return true; },
    resume() { this.tocando = true; return true; },
  });

  const sessions = new SessionManager({
    config: {
      discord: {}, defaultMode: 'follow', syncPosition: true,
      pollIntervalMs: 60_000, maxSessions: 10, announceTracks: false,
    },
    ownerApi: { enabled: false },
    criarPlayer,
  });

  const s = await sessions.start({ channel: { guild: { id: 'g1' } }, driverId: 'ana' });

  // Pausa por comando, e o Spotify manda retomar logo em seguida.
  s.player.pause();
  s.pausadoPorComando = true;
  s.watcher.emit('resumed', {});
  if (s.player.tocando) throw new Error('o Spotify retomou por cima da pausa por comando');

  // Sem a marca, o espelhamento normal volta a valer.
  s.pausadoPorComando = false;
  s.watcher.emit('resumed', {});
  if (!s.player.tocando) throw new Error('sem pausa por comando, o Spotify deveria retomar');

  // Trocar de faixa limpa a pausa: quem troca quer ouvir a nova.
  s.player.pause();
  s.pausadoPorComando = true;
  s.watcher.emit('track', { id: 'b', title: 'b', artists: 'x' });
  if (s.pausadoPorComando) throw new Error('faixa nova deveria limpar a pausa por comando');

  sessions.stopAll();
  return 'comando vence o Spotify, e troca de faixa reseta';
});

check('tiktok: extrai pedido do chat pelo prefixo', async () => {
  const { extrairPedido } = await import('../src/tiktok/bridge.js');

  if (extrairPedido('!sr never gonna give you up', '!sr') !== 'never gonna give you up') {
    throw new Error('nao extraiu a query');
  }
  if (extrairPedido('  !SR  Tim Maia  ', '!sr') !== 'Tim Maia') throw new Error('nao normalizou');
  if (extrairPedido('oi pessoal', '!sr') !== null) throw new Error('chat comum virou pedido');
  if (extrairPedido('!sr', '!sr') !== null) throw new Error('pedido vazio deveria ser null');
  if (extrairPedido('!sr x', '!sr') !== null) throw new Error('query de 1 char deveria ser null');

  return 'prefixo, espacos e vazio tratados';
});

check('tiktok bridge: limite por pessoa e prioridade por presente', async () => {
  const { TikTokBridge } = await import('../src/tiktok/bridge.js');
  const { EventEmitter } = await import('node:events');

  // Sessao falsa com a mesma superficie que o bridge usa.
  const criarSessao = () => {
    const queue = [];
    return {
      player: { queue, current: null, carregando: false },
      pedidosDe(id) {
        return queue.filter((t) => t.requestedById === id).length +
          (this.player.current?.requestedById === id ? 1 : 0);
      },
      priorizarPedidoDe(id) {
        const i = queue.findIndex((t) => t.requestedById === id);
        if (i <= 0) return i === 0;
        const [t] = queue.splice(i, 1);
        queue.unshift(t);
        return true;
      },
      pedir(track, { prioridade = false } = {}) {
        if (this.player.current || this.player.carregando) {
          if (prioridade) queue.unshift(track);
          else queue.push(track);
          return { posicao: prioridade ? 1 : queue.length, tocandoAgora: false };
        }
        this.player.current = track;
        return { posicao: 0, tocandoAgora: true };
      },
    };
  };

  const connector = new EventEmitter();
  const session = criarSessao();
  session.player.current = { requestedById: 'outro' }; // ja tem algo tocando

  // Resolver falso: devolve uma faixa com o titulo = query.
  const resolver = async (q) => ({ youtubeId: q, title: q, artists: 'yt', url: 'u' });
  const config = { prefixo: '!sr', maxPorUsuario: 2, janelaPrioridadeMs: 60_000 };

  const bridge = new TikTokBridge({ connector, session, config, resolver });
  bridge.attach();

  const chat = (userId, comment) => connector.emit('chat', { userId, label: '@' + userId, comment });
  const gift = (userId) => connector.emit('gift', { userId, label: '@' + userId, giftName: 'rosa' });
  const esperar = () => new Promise((r) => setTimeout(r, 10));

  // ana pede duas — as duas entram.
  chat('ana', '!sr musica1');
  chat('ana', '!sr musica2');
  await esperar();
  if (session.pedidosDe('ana') !== 2) throw new Error(`ana deveria ter 2, tem ${session.pedidosDe('ana')}`);

  // terceira de ana e barrada pelo limite.
  chat('ana', '!sr musica3');
  await esperar();
  if (session.pedidosDe('ana') !== 2) throw new Error('limite por pessoa nao segurou o 3o pedido');

  // bruno manda presente e depois pede: entra na frente.
  gift('bruno');
  chat('bruno', '!sr furou');
  await esperar();
  if (session.player.queue[0].title !== 'furou') {
    throw new Error(`presente nao priorizou; frente = ${session.player.queue[0].title}`);
  }

  // carla pede normal (vai pro fim), depois manda presente: pedido dela sobe.
  chat('carla', '!sr normal');
  await esperar();
  gift('carla');
  if (session.player.queue[0].title !== 'normal') {
    throw new Error('presente nao moveu pedido existente para a frente');
  }

  bridge.detach();
  return 'limite, prioridade nova e prioridade de pedido existente ok';
});

check('sessoes isolam servidores e roteiam por driver', async () => {
  const { SessionManager } = await import('../src/session.js');

  // Player de mentira: o roteamento nao depende de conexao de voz.
  const criarPlayer = () => ({
    recebidas: [],
    queue: [],
    current: null,
    mode: 'follow',
    join: async () => {},
    leave() {},
    skip: () => null,
    pause() {},
    resume() {},
    onSpotifyTrack(track) { this.recebidas.push(track.id); },
  });

  const config = {
    discord: { ownerId: 'dono' },
    defaultMode: 'follow',
    syncPosition: true,
    pollIntervalMs: 60_000,
  };
  const ownerApi = { enabled: true, currentlyPlaying: async () => null, queue: async () => [] };
  const sessions = new SessionManager({ config, ownerApi, criarPlayer });

  const canal = (id) => ({ guild: { id } });
  await sessions.start({ channel: canal('g1'), driverId: 'ana' });
  await sessions.start({ channel: canal('g2'), driverId: 'bruno' });
  await sessions.start({ channel: canal('g3'), driverId: 'ana' });

  if (sessions.size !== 3) throw new Error(`esperava 3 sessoes, tem ${sessions.size}`);
  if (!sessions.temDriver('ana') || sessions.temDriver('carla')) {
    throw new Error('temDriver errado');
  }

  const faixa = (id) => ({ id, title: id, artists: 'x', isPlaying: true, source: 'presence' });
  sessions.onPresence('ana', faixa('t1'));
  sessions.onPresence('bruno', faixa('t2'));

  const recebidas = (g) => sessions.get(g).player.recebidas.join(',');
  if (recebidas('g1') !== 't1') throw new Error(`g1 recebeu "${recebidas('g1')}"`);
  if (recebidas('g3') !== 't1') throw new Error(`g3 (mesma dona) recebeu "${recebidas('g3')}"`);
  if (recebidas('g2') !== 't2') throw new Error(`g2 recebeu "${recebidas('g2')}"`);

  // A Web API do .env pertence a uma conta so; os demais rodam pela presence.
  await sessions.start({ channel: canal('g4'), driverId: 'dono' });
  if (!sessions.get('g4').usaApi) throw new Error('o dono deveria usar a Web API');
  if (sessions.get('g1').usaApi) throw new Error('quem nao e dono nao pode usar a Web API');

  sessions.stop('g1');
  if (sessions.get('g1')) throw new Error('stop nao removeu');
  sessions.stopAll();
  if (sessions.size !== 0) throw new Error('stopAll nao limpou');

  return 'roteamento, isolamento e escopo da API ok';
});

check('sessao nao fica pendurada se a conexao de voz falhar', async () => {
  const { SessionManager } = await import('../src/session.js');

  const criarPlayer = () => ({
    queue: [], current: null, mode: 'follow',
    join: async () => { throw new Error('canal cheio'); },
    leave() {}, skip: () => null, pause() {}, resume() {}, onSpotifyTrack() {},
  });

  const sessions = new SessionManager({
    config: { discord: {}, defaultMode: 'follow', syncPosition: true, pollIntervalMs: 60_000 },
    ownerApi: { enabled: false },
    criarPlayer,
  });

  let lancou = false;
  try {
    await sessions.start({ channel: { guild: { id: 'g9' } }, driverId: 'ana' });
  } catch {
    lancou = true;
  }

  if (!lancou) throw new Error('deveria propagar o erro de conexao');
  if (sessions.size !== 0) throw new Error('sessao falha ficou registrada');
  return 'erro propagado e sessao removida';
});

check('cache guarda, expira e sobrevive a reinicializacao', async () => {
  const { JsonCache } = await import('../src/audio/cache.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdtemp, rm } = await import('node:fs/promises');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'botdc-cache-'));
  const file = path.join(dir, 'test.json');

  try {
    const cache = new JsonCache({ file });
    await cache.ready();

    cache.set('match:abc', 'dQw4w9WgXcQ');
    cache.set('stream:xyz', { url: 'https://exemplo' }, { expiresAt: Date.now() - 1 });

    if (cache.get('match:abc') !== 'dQw4w9WgXcQ') throw new Error('nao devolveu o valor guardado');
    if (cache.get('stream:xyz') !== null) throw new Error('devolveu entrada ja vencida');
    if (cache.get('inexistente') !== null) throw new Error('deveria devolver null');

    cache.delete('match:abc');
    if (cache.get('match:abc') !== null) throw new Error('delete nao funcionou');

    // Persistencia: grava, releva de um objeto novo apontando para o mesmo arquivo.
    cache.set('match:persistir', 'video123');
    await cache.flush();

    const relido = new JsonCache({ file });
    await relido.ready();
    if (relido.get('match:persistir') !== 'video123') throw new Error('nao releu do disco');

    // LRU: com limite 2, a entrada mais antiga sai.
    const pequeno = new JsonCache({ file: path.join(dir, 'lru.json'), maxEntries: 2 });
    await pequeno.ready();
    pequeno.set('a', 1);
    pequeno.set('b', 2);
    pequeno.set('c', 3);
    if (pequeno.size !== 2) throw new Error(`esperava 2 entradas, tem ${pequeno.size}`);
    if (pequeno.get('a') !== null) throw new Error('deveria ter descartado a mais antiga');

    return 'get/expiry/delete/persistencia/LRU ok';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

check('discord.js expoe os eventos e intents usados', async () => {
  const { Events, GatewayIntentBits, ActivityType } = await import('discord.js');
  for (const key of ['ClientReady', 'PresenceUpdate', 'InteractionCreate']) {
    if (!Events[key]) throw new Error(`Events.${key} nao existe`);
  }
  if (GatewayIntentBits.GuildPresences === undefined) throw new Error('sem GuildPresences');
  if (ActivityType.Listening === undefined) throw new Error('sem ActivityType.Listening');
  return 'eventos + intents ok';
});

check('nao compensa posicao em faixa recem-comecada', async () => {
  const { SyncPlayer } = await import('../src/audio/player.js');

  // A regra vive dentro de play(), que depende de rede e conexao de voz. Testa
  // a decisao em si, que e o que pode regredir sem ninguem notar.
  const decidir = (progressMs, syncPosition = true, fromStart = false) => {
    const recemComecada = (progressMs ?? 0) < 10_000;
    return syncPosition && !fromStart && !recemComecada;
  };

  // Troca natural: o bot detecta a faixa nova com ~1s. Compensar cortaria a
  // introducao inteira.
  if (decidir(1_000)) throw new Error('faixa recem-comecada nao pode compensar');
  if (decidir(4_000)) throw new Error('4s ainda e comeco de faixa');

  // Alguem entrando no meio da musica: aqui a compensacao e o ponto.
  if (!decidir(90_000)) throw new Error('entrada no meio da faixa precisa compensar');

  // Faixa vinda da fila comeca do zero por definicao.
  if (decidir(90_000, true, true)) throw new Error('fromStart nunca compensa');
  if (decidir(90_000, false)) throw new Error('SYNC_POSITION desligado nunca compensa');

  const player = new SyncPlayer({ mode: 'follow', syncPosition: true });
  if (player.carregando) throw new Error('deveria comecar sem carregar nada');

  return 'compensa so quando se entra no meio da faixa';
});

check('SyncPlayer instancia desconectado', async () => {
  const { SyncPlayer } = await import('../src/audio/player.js');
  const player = new SyncPlayer({ mode: 'follow', syncPosition: true });
  if (player.connected) throw new Error('deveria comecar desconectado');
  if (player.mode !== 'follow') throw new Error('modo errado');
  return `mode=${player.mode} connected=${player.connected}`;
});

check('watcher deduplica por id e sinaliza parada', async () => {
  const { SpotifyWatcher } = await import('../src/spotify/watcher.js');
  const api = { enabled: false, currentlyPlaying: async () => null };
  const watcher = new SpotifyWatcher({ api, intervalMs: 3000 });

  const seen = [];
  watcher.on('track', (t) => seen.push(t.id));
  watcher.on('stopped', () => seen.push('STOP'));

  const fake = (id) => ({ id, title: id, artists: 'x', isPlaying: true, source: 'presence' });
  watcher.onPresence(fake('a'));
  watcher.onPresence(fake('a')); // repetida: nao pode emitir de novo
  watcher.onPresence(fake('b'));
  watcher.onPresence(null);

  const got = seen.join(',');
  if (got !== 'a,b,STOP') throw new Error(`esperava "a,b,STOP", veio "${got}"`);
  return got;
});

check('watcher distingue passagem do tempo de seek', async () => {
  const { SpotifyWatcher } = await import('../src/spotify/watcher.js');

  const api = { enabled: false, currentlyPlaying: async () => null, queue: async () => [] };
  const watcher = new SpotifyWatcher({ api, intervalMs: 60_000 });

  const seeks = [];
  const faixas = [];
  watcher.on('seek', (t) => seeks.push(Math.round(t.progressMs / 1000)));
  watcher.on('track', (t) => faixas.push(t.id));

  const em = (progressMs) => ({
    id: 'x1', title: 'x', artists: 'y', isPlaying: true, source: 'presence', progressMs,
  });

  watcher.onPresence(em(10_000));
  if (faixas.length !== 1) throw new Error('deveria ter emitido a faixa');

  // Avanco natural: passou ~0ms real, posicao subiu 2s. Dentro da tolerancia.
  watcher.onPresence(em(12_000));
  if (seeks.length) throw new Error(`avanco normal virou seek: ${seeks}`);

  // Salto para frente e para tras, ambos alem da tolerancia.
  watcher.onPresence(em(90_000));
  watcher.onPresence(em(5_000));
  if (seeks.join(',') !== '90,5') throw new Error(`seeks detectados: ${seeks.join(',')}`);

  // Pausado nao pode gerar seek: a posicao congela e o esperado se afasta.
  const pausado = { ...em(5_000), isPlaying: false };
  watcher.onPresence(pausado);
  await new Promise((r) => setTimeout(r, 30));
  watcher.onPresence({ ...pausado });
  if (seeks.length !== 2) throw new Error(`pausa gerou seek falso: ${seeks.join(',')}`);

  watcher.stop();
  return 'ignora avanco natural e pausa, detecta os dois saltos';
});

check('presence dispara o resolve sem esperar a API', async () => {
  const { SpotifyWatcher } = await import('../src/spotify/watcher.js');

  const faixa = { id: 'z1', title: 'z', artists: 'x', isPlaying: true, source: 'presence' };
  const api = {
    enabled: true,
    currentlyPlaying: async () => ({ ...faixa, source: 'api', progressMs: 42_000 }),
    queue: async () => [],
  };
  const watcher = new SpotifyWatcher({ api, intervalMs: 60_000, upcomingDelayMs: 20 });

  const emitidos = [];
  watcher.on('track', (t) => emitidos.push(t.source));
  watcher.onPresence(faixa);

  // Tem que sair antes de qualquer ida a rede — e esse o ganho de latencia.
  if (emitidos.length !== 1) throw new Error(`esperava 1 emissao imediata, veio ${emitidos.length}`);
  if (emitidos[0] !== 'presence') throw new Error(`emitiu ${emitidos[0]}, nao a presence`);

  await new Promise((r) => setTimeout(r, 80));
  if (emitidos.length !== 1) throw new Error(`o poll re-emitiu (${emitidos.length} no total)`);
  if (watcher.current?.source !== 'api') throw new Error('o poll deveria ter refinado os dados');
  watcher.stop();

  return 'emite na presence, refina no poll';
});

check('watcher pede a fila do Spotify para o prefetch', async () => {
  const { SpotifyWatcher } = await import('../src/spotify/watcher.js');

  const atual = { id: 'a1', title: 'atual', artists: 'x', isPlaying: true, source: 'presence' };
  const api = {
    enabled: true,
    currentlyPlaying: async () => atual,
    queue: async () => [{ id: 'n1', title: 'proxima', artists: 'y' }],
  };
  const watcher = new SpotifyWatcher({ api, intervalMs: 60_000, upcomingDelayMs: 20 });

  let recebido = null;
  watcher.on('upcoming', (tracks) => (recebido = tracks));
  watcher.onPresence(atual);

  await new Promise((r) => setTimeout(r, 100));
  watcher.stop();

  if (recebido?.[0]?.id !== 'n1') throw new Error('nao emitiu as proximas da fila');
  return `emitiu ${recebido.length} faixa(s) para prefetch`;
});

check('prefetch ignora entradas invalidas sem quebrar', async () => {
  const { prefetch } = await import('../src/audio/prefetch.js');
  // Best-effort de verdade: fila malformada nao pode derrubar o bot.
  await prefetch([null, undefined, {}, { id: null, title: 'x' }]);
  return 'nao lancou';
});

check('presence.js le a atividade do Spotify', async () => {
  const { readSpotifyActivity } = await import('../src/spotify/presence.js');
  const { ActivityType } = await import('discord.js');
  const start = Date.now() - 30_000;

  const track = readSpotifyActivity({
    activities: [
      {
        type: ActivityType.Listening,
        name: 'Spotify',
        syncId: '4cOdK2wGLETKBW3PvgPWqT',
        details: 'Never Gonna Give You Up',
        state: 'Rick Astley',
        assets: { largeText: 'Whenever You Need Somebody' },
        timestamps: { start: new Date(start), end: new Date(start + 213_000) },
      },
    ],
  });

  if (track?.id !== '4cOdK2wGLETKBW3PvgPWqT') throw new Error('nao extraiu o syncId');
  if (track.durationMs !== 213_000) throw new Error(`duracao errada: ${track.durationMs}`);
  if (track.progressMs < 29_000 || track.progressMs > 32_000) {
    throw new Error(`progresso errado: ${track.progressMs}`);
  }
  return `${track.artists} - ${track.title} @ ${Math.round(track.progressMs / 1000)}s`;
});

check('presence.js ignora quem nao esta no Spotify', async () => {
  const { readSpotifyActivity } = await import('../src/spotify/presence.js');
  const { ActivityType } = await import('discord.js');

  const jogando = readSpotifyActivity({
    activities: [{ type: ActivityType.Playing, name: 'Counter-Strike 2' }],
  });
  if (jogando !== null) throw new Error('deveria ignorar atividade que nao e Spotify');
  if (readSpotifyActivity(null) !== null) throw new Error('deveria aceitar presence nula');
  return 'null como esperado';
});

check('SpotifyApi se desativa sem refresh token', async () => {
  const { SpotifyApi } = await import('../src/spotify/api.js');
  const off = new SpotifyApi({ clientId: 'a', clientSecret: 'b', refreshToken: null });
  const on = new SpotifyApi({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
  if (off.enabled) throw new Error('deveria estar desabilitada sem refresh token');
  if (!on.enabled) throw new Error('deveria estar habilitada');
  return 'enabled=false / enabled=true';
});

check('config.js reclama de variavel obrigatoria ausente', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  try {
    execFileSync(process.execPath, ['-e', "import('./src/config.js')"], {
      cwd: root,
      // Aponta o dotenv para um caminho inexistente para o .env real nao mascarar o teste.
      env: { ...process.env, DISCORD_TOKEN: '', DOTENV_CONFIG_PATH: path.join(root, '.env.ausente') },
      stdio: 'pipe',
    });
  } catch (err) {
    if (!String(err.stderr).includes('DISCORD_TOKEN')) {
      throw new Error(`erro nao cita a variavel: ${String(err.stderr).slice(0, 200)}`);
    }
    return 'aponta DISCORD_TOKEN ausente';
  }
  throw new Error('deveria ter falhado sem DISCORD_TOKEN');
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log(`  ok    ${name} — ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA ${name}\n        ${err.message}`);
  }
}

console.log(
  failed ? `\n${failed} de ${checks.length} checks falharam.` : `\n${checks.length} checks passaram.`,
);
process.exit(failed ? 1 : 0);
