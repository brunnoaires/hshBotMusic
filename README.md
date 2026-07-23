# botdc

Bot de Discord que segue em tempo real o que está tocando no seu Spotify. Você
troca a música no celular, o bot troca na call — começando no mesmo ponto em que
você está.

**Sem login, sem token, sem autorização.** O Discord já publica o Spotify de quem
conectou a conta, e é de lá que o bot lê. Qualquer pessoa do servidor entra numa
call, usa `/vincular`, e pronto.

Também funciona **sem Spotify nenhum**: `/sr <música>` pede faixa por nome ou
link, e a fila vira coletiva. Veja [modo jukebox](#sem-spotify-modo-jukebox).

```
Spotify ──presence do Discord──┐                  ┌── cache ──┐
                               ├─► watcher ──► resolve ──► ffmpeg ──► canal de voz
        ──Web API (opcional)───┘   (dedupe)     (yt-dlp)   (ogg/opus)
```

---

## Aviso

Projeto para uso pessoal, auto-hospedado. Três coisas antes de rodar ou publicar
um fork:

- **A API do Spotify não entrega áudio** — nenhum endpoint, em nenhum plano. O bot
  usa só os metadados e reprocura a faixa no YouTube. Essa etapa **viola os termos
  de uso** do YouTube: é o mesmo mecanismo que derrubou o Groovy e o Rythm. Rodar
  para você e alguns amigos é uma coisa; operar um bot público é outra.
- **O `.env` guarda credenciais** — o token do bot e, se você ligar a Web API, um
  refresh token do Spotify que dá acesso de leitura ao seu histórico de escuta.
  Está no `.gitignore`; confira antes de commitar.
- **O `cache/` guarda o seu IP.** As URLs assinadas do YouTube carregam o IP que as
  requisitou. Também está no `.gitignore` — não publique.

Sem garantia de espécie alguma. Veja a [LICENSE](LICENSE).

---

## Instalação

### 1. Dependências

```bash
npm install
```

```bash
npm run setup:ytdlp
```

O `npm install` traz o ffmpeg (via `ffmpeg-static`); o `setup:ytdlp` baixa o
binário oficial do yt-dlp para `bin/`. Nenhum dos dois precisa de Python nem de
instalação global.

No Windows ele baixa o build **onedir** (`yt-dlp_win.zip`) em vez do `.exe` único.
O onefile é um pacote PyInstaller que se reextrai a cada execução, custando ~1,6s
de inicialização toda vez; já descompactado, o mesmo binário inicia em ~0,4s. Como
são duas chamadas por faixa, isso sozinho cortou ~2,4s do atraso.

Rode o `setup:ytdlp` de novo quando o YouTube quebrar a extração — é sempre a
primeira coisa a tentar.

### 2. Aplicação no Discord

Em [discord.com/developers/applications](https://discord.com/developers/applications),
crie uma aplicação e configure:

| Onde | O quê |
| --- | --- |
| **Bot → Token** | copie para `DISCORD_TOKEN` |
| **Bot → Presence Intent** | **ligue.** É privilegiado e obrigatório: é dele que vem o Spotify de todo mundo |
| **Bot → Public Bot** | ligue, se outras pessoas forem adicionar o bot aos servidores delas |
| **Bot → Requires OAuth2 Code Grant** | **desligue** (veja [o bot não entra](#o-bot-não-entra-no-servidor)) |
| **General Information → Application ID** | copie para `DISCORD_CLIENT_ID` |

Copie `.env.example` para `.env` e preencha os dois valores.

Para pegar IDs de usuário ou servidor: ligue o Modo Desenvolvedor no Discord
(Configurações → Avançado) e clique com o botão direito no nome → Copiar ID.

### 3. Spotify — opcional

**Pode pular.** O bot funciona para qualquer pessoa sem nada disso.

Preencher esta seção liga a Web API para **uma** conta, a de `OWNER_USER_ID`, que
ganha espelhamento de pausa e prefetch. Veja [o que muda sem a Web
API](#o-que-muda-sem-a-web-api) e [os tetos reais](#os-tetos-reais).

Em [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) crie
um app e cadastre exatamente esta Redirect URI:

```
http://127.0.0.1:8888/callback
```

O Spotify não aceita mais `localhost` — tem que ser o IP de loopback. Preencha
`SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` no `.env` e rode:

```bash
npm run login:spotify
```

Abra o link do terminal, autorize, e cole no `.env` a linha
`SPOTIFY_REFRESH_TOKEN=` que o script imprime. Esse token não expira.

### 4. Comandos e start

```bash
npm run deploy:commands
```

```bash
npm start
```

Deixe `DISCORD_GUILD_ID` **vazio** para registro global — é o que faz os comandos
funcionarem em qualquer servidor. Com um ID preenchido eles só existem naquele
servidor, o que é útil para testar (aparece na hora) mas é o motivo mais comum de
"adicionei o bot e não aparece comando nenhum".

---

## Usando

### Para quem vai usar o bot

1. No Discord: **Configurações do Usuário → Conexões → Spotify**, conectar a conta
   e deixar **"Exibir o Spotify como seu status"** ligado
2. Não ficar como **Invisível** — ninguém enxerga o status de quem está invisível
3. Entrar num canal de voz e usar `/vincular`

O comando `/ajuda` explica isso dentro do próprio Discord.

### Comandos

| Comando | O que faz | Quem pode |
| --- | --- | --- |
| `/sr <música>` | Pede uma música sem Spotify: busca por nome ou cola um link | qualquer um |
| `/vincular [canal]` | Entra no canal de voz (padrão: o seu) e passa a seguir o **seu** Spotify | qualquer um |
| `/agora` | Mostra o que está tocando, com progresso e o vídeo escolhido | qualquer um |
| `/fila` | Lista o que está enfileirado | qualquer um |
| `/pular` | Pula a faixa atual | qualquer um |
| `/ajuda` | Lista os comandos e explica como ligar o Spotify | qualquer um |
| `/desvincular` | Sai do canal e para de seguir | driver 🔒 |
| `/modo follow\|queue` | `follow` troca na hora; `queue` enfileira e toca em sequência | driver 🔒 |
| `/rematch` | Achou o vídeo errado? Esquece o match em cache e procura de novo | driver 🔒 |

🔒 = o **driver** (quem rodou `/vincular`) ou quem tem Gerenciar Servidor.

### Sem Spotify: modo jukebox

Não precisa vincular nada para usar o bot. O `/sr` pede música direto:

```
/sr racionais mcs negro drama
/sr https://www.youtube.com/watch?v=...
```

Se o bot não estiver em nenhum canal, o `/sr` já o traz para o seu e começa a
tocar. A partir daí a fila é coletiva: **qualquer pessoa pede, e os controles
ficam abertos a todos** — não há driver a proteger, porque não há Spotify de
ninguém sendo seguido.

O pedido **nunca corta** o que está tocando. Quem pediu antes ouve inteiro; o
resto entra na fila, e `/fila` mostra quem pediu cada faixa.

Link de playlist traz só o vídeo apontado, não a playlist inteira — senão um
pedido viraria centenas de faixas de uma vez.

**Misturando com o Spotify:** dá para usar `/sr` numa sessão vinculada, mas em
modo `follow` a próxima troca no Spotify interrompe o pedido. O bot avisa disso
na resposta e sugere `/modo queue`, onde as duas fontes convivem na mesma fila.

### Uma sessão por servidor

Cada servidor tem player e fila próprios, seguindo o Spotify do driver. A mesma
pessoa pode comandar vários servidores ao mesmo tempo.

Assumir o lugar de quem já está comandando exige Gerenciar Servidor — sem isso,
qualquer um derrubaria a sessão alheia no meio da música. Quando o canal de voz
esvazia, a sessão encerra sozinha.

### Cartão "Reproduzindo agora"

A cada troca de música o bot publica um cartão no canal de texto onde `/vincular`
foi usado: capa do álbum, faixa com link para o Spotify, quem está sendo seguido,
o canal de voz, contadores e barra de progresso. O cartão anterior é apagado a
cada troca, para o canal não virar um mural. Desliga com `ANNOUNCE_TRACKS=false`.

---

## Adicionando em outros servidores

Gere o link de convite com:

```bash
npm run convite
```

Ele calcula as permissões a partir do que o código realmente usa e já inclui o
escopo `bot`. Não monte a URL à mão: além de `Connect` e `Speak` para o áudio, o
cartão precisa de `Enviar Mensagens`, `Inserir Links` e `Anexar Arquivos`, e sem
elas ele falha em silêncio.

O bot precisa continuar rodando na sua máquina: cada servidor conectado abre uma
conexão de voz e processos próprios de yt-dlp e ffmpeg.

### O bot não entra no servidor

Autorizou, a tela fechou, e o bot não apareceu na lista de membros. Em ordem de
frequência:

| Causa | Onde arrumar |
| --- | --- |
| **Requires OAuth2 Code Grant ligado** | Developer Portal → Bot → desligue. Ligado, o Discord espera uma troca de código que não existe aqui, e a autorização termina sem o bot entrar. |
| **URL sem o escopo `bot`** | Só com `applications.commands` o convite instala os comandos e o bot não entra. Use `npm run convite`. |
| **Public Bot desligado** | Developer Portal → Bot → ligue. Desligado, só você consegue adicionar. |
| **Quem clicou não tem Gerenciar Servidor** | O servidor nem aparece na lista de destinos. |

Se os comandos aparecem mas o bot não está no servidor, é o escopo `bot` faltando.

### Comandos duplicados

É registro de servidor sobrando junto com o global — o Discord exibe os dois
conjuntos. Com `DISCORD_GUILD_ID` vazio, o `deploy:commands` varre os servidores
do bot, apaga os registros de servidor e refaz o global. Resolve numa rodada e
diz quantos limpou.

### Deixando aberto para qualquer pessoa

Se você vai distribuir o link livremente, entenda que **você continua sendo o
operador de todo mundo**: o bot roda na sua máquina, e é o seu terminal que
mostra quem vinculou e cada faixa que tocam. Isso é inerente — um bot que
reproduz o que você ouve precisa saber o que você ouve.

Dois limites protegem a instância de uso aberto:

- **`MAX_SESSIONS`** (padrão 10) — cada sessão é ~128 kbps de upload contínuo mais
  um ffmpeg. 10 simultâneas são ~1,3 Mbps de subida sustentada. Passando do teto,
  o `/vincular` recusa explicando, em vez de todos ouvirem áudio picotado sem
  entender o motivo. Banda de upload costuma ser o gargalo antes da CPU.
- **`YTDLP_CONCURRENCY`** (padrão 3) — todas as buscas saem do mesmo IP. Sem fila,
  dez pessoas trocando de música ao mesmo tempo disparariam vinte processos numa
  rajada, e o 429 do YouTube degradaria o bot para todos. Medido com seis resolves
  simultâneos: o pico fica em 3 e os seis completam em ~6s.

O bot também registra no log quando é adicionado ou removido de um servidor —
sem isso você só descobriria que alguém adicionou quando um comando fosse usado.

Se preferir **não** ser o operador de estranhos, o caminho é o inverso: cada
pessoa clona o repositório e roda a própria instância. Aí cada uma vê só os
próprios usuários, e você não vê nada.

### Os tetos reais

- **Spotify: 25 usuários.** Um app em modo de desenvolvimento exige cadastrar cada
  pessoa manualmente (nome e e-mail) no painel. Extended Quota passa por revisão da
  Spotify, e ler o que toca para reproduzir de outra fonte é justamente o tipo de
  uso que eles recusam. Por isso a Web API é opcional e vale para uma conta só.
- **Discord: 100 servidores** sem verificação. Verificar exige justificar o Presence
  Intent, que é privilegiado — difícil de aprovar para um bot que lê o que os
  outros ouvem.
- **Sua máquina.** Cada servidor ativo é uma conexão de voz mais um ffmpeg.

Entre amigos funciona bem. Bot público não é.

---

## Como funciona

### Detecção: duas fontes

| | Presence do Discord | Web API do Spotify |
| --- | --- | --- |
| Como chega | push, ~1s | consulta a cada 3s |
| Precisa de credencial | não | sim (uma conta só) |
| Progresso exato | derivado dos timestamps | em milissegundos |
| Detecta pausa | não | sim |
| Lê a fila | não | sim |

Quando as duas estão disponíveis, a API é a fonte da verdade e a presence serve
de gatilho rápido: ao ver um ID diferente, o bot **já começa a resolver** com os
dados da presence em vez de esperar a ida e volta da API — são ~300ms a menos de
silêncio. A consulta seguinte refina progresso e estado, e a deduplicação por ID
garante que a música não toque duas vezes.

Podcasts e episódios são ignorados: só faixas de música.

#### O que muda sem a Web API

| Recurso | Só presence (todos) | Presence + API (`OWNER_USER_ID`) |
| --- | --- | --- |
| Trocar de faixa junto | sim | sim |
| Sincronizar a posição | sim | sim |
| Espelhar pausa e retomada | não | sim |
| Prefetch (troca instantânea) | não | sim |

### De onde vem o áudio

Como o Spotify não entrega áudio, cada faixa é reprocurada **no YouTube**, via
yt-dlp. A query é `"artista - título"`, montada com os metadados do Spotify.

A busca traz cinco candidatos (passada barata, sem extrair formato de nenhum) e o
ranking escolhe um:

- **Duração** é o sinal mais forte — dentro de ±3s do que o Spotify informou vale
  +60; a pontuação cai conforme se afasta
- **Canal `- Topic`** vale +30 — são os uploads automáticos da gravadora
- **−45** para títulos com marcador de versão diferente (live, cover, karaokê,
  nightcore, sped up, 8d), mas só se a faixa original não tiver esses termos no
  nome — quem ouve uma gravação ao vivo de verdade não é penalizado

Só o vencedor tem a URL de áudio extraída. O ffmpeg transcodifica para ogg/opus a
128 kbps, 48 kHz, estéreo — que é o que o Discord aceita direto, dispensando um
encoder opus nativo.

Confira a escolha com `/agora`; corrija com `/rematch`.

### Sincronização de posição

Com `SYNC_POSITION` ligado (padrão), o ffmpeg entra no mesmo ponto em que o seu
Spotify está, **já somando o tempo gasto na busca**. Você não ouve a faixa
atrasada — só espera menos.

### Cache

Resolver uma faixa custa duas chamadas ao yt-dlp: a busca e a extração da URL.
Duas camadas em `cache/resolve.json` cortam isso:

| Chave | Guarda | Vence |
| --- | --- | --- |
| `match:<id do spotify>` | id do vídeo no YouTube | nunca — a escolha não muda |
| `stream:<id do vídeo>` | URL assinada e cabeçalhos | junto com a assinatura, menos 15min de margem |

A margem de 15 minutos existe para a URL não vencer no meio de uma faixa longa. O
arquivo tem escrita atômica, teto de 2000 entradas e descarte do menos usado.

O efeito colateral é que **um match ruim fica colado na faixa** — é para isso que
serve o `/rematch`. Para zerar tudo, apague `cache/resolve.json`.

### Prefetch

O cache só ajuda na segunda vez. Para a **primeira** também ser instantânea, o bot
consulta a fila do Spotify cinco segundos depois de cada troca e resolve as duas
próximas faixas enquanto a atual toca. Ouvindo álbum ou playlist na ordem, a troca
já está pronta.

Os cinco segundos são de propósito: logo após a troca, a faixa atual ainda está
resolvendo, e não vale competir com ela por rede e CPU. É best-effort — se a fila
não vier, a faixa resolve na hora de tocar, como antes.

#### Resultado medido

| Situação | Tempo até tocar |
| --- | --- |
| Sequência normal de playlist ou álbum (pré-buscada) | ~1 ms |
| Faixa já tocada antes, URL vencida | ~1,6 s |
| Faixa nova e fora da fila (pulo aleatório) | ~3,4 s |

### Barra de progresso

Embed do Discord não renderiza gradiente nem alça circular, então a barra é uma
**imagem PNG gerada na hora**. O preenchimento vai do preto ao branco, ancorado na
largura preenchida para terminar sempre claro na alça, em vez de sumir no escuro
quando a música está no começo. A alça branca tem contorno escuro para continuar
visível também no tema claro.

Nada disso usa biblioteca gráfica: os pixels são rasterizados à mão e o PNG é
codificado com o `zlib` do próprio Node, em
[progressbar.js](src/discord/progressbar.js). Os dígitos dos tempos saem de uma
fonte 5x7 desenhada no próprio arquivo.

### Tolerância a falhas

- **URL vencida ou recusada** — o ffmpeg morre em segundos sem produzir som. O bot
  detecta, descarta a URL do cache e tenta uma vez com uma nova.
- **Vídeo removido, privado ou bloqueado** — o vínculo com aquele vídeo é desfeito
  e a busca, refeita.
- **Troca rápida de música** — resoluções obsoletas são descartadas, então a faixa
  antiga nunca começa a tocar por cima da nova.
- **Queda na conexão de voz** — se for troca de região, reata sozinho; se for perda
  real, sai do canal de forma limpa.
- **Rate limit do Spotify** — recua pelo tempo indicado, sem derrubar o bot.
- **Cache corrompido** — começa vazio, sem impedir a inicialização.
- **Encerramento** — o cache é gravado antes de sair.

---

## Rodando 24/7

O bot precisa de um processo sempre no ar. A escolha de onde hospedar tem uma
particularidade que inverte o conselho usual.

### O IP importa mais que a máquina

O YouTube trata IP de datacenter de forma bem mais agressiva que IP residencial.
Em VPS e plataformas de nuvem, o yt-dlp passa a receber "Sign in to confirm you're
not a bot" com frequência — e quando isso acontece, **nenhuma música toca para
ninguém**. Contornar exige cookies de uma conta logada ou proxy residencial, os
dois frágeis e de manutenção constante.

Por isso, para este bot, **hospedar em casa costuma funcionar melhor que na
nuvem** — o oposto do normal.

| Opção | IP | Consumo mensal aproximado |
| --- | --- | --- |
| **Raspberry Pi em casa** | residencial | ~5 W, algo como R$ 3/mês de energia |
| **Notebook velho em casa** | residencial | ~20 W, ~R$ 12/mês |
| Mini PC / NAS que você já tem ligado | residencial | custo marginal ~zero |
| VPS (Hetzner, Contabo, Oracle free) | datacenter | R$ 0–25/mês, mas com o risco acima |
| PC desktop ligado direto | residencial | ~80 W, ~R$ 50/mês |

Um Raspberry Pi 4 dá conta com folga: transcodificar opus a 128 kbps é barato, e o
gargalo continua sendo a sua banda de upload, não a CPU.

Se for de VPS mesmo assim, escolha um provedor cujos termos não proíbam o uso e
esteja pronto para lidar com bloqueio do YouTube.

### Hospedagem gratuita

Quase toda lista de "hospedagem grátis" ignora o número que decide isto aqui:
**franquia de tráfego de saída**. Cada sessão transmite ~128 kbps contínuos, o que
dá **~60 MB por hora de música**. Uma pessoa ouvindo 3h por dia consome ~5 GB/mês.

Isso elimina a maioria das opções antes de qualquer outra consideração:

| Opção | Saída grátis | Serve? |
| --- | --- | --- |
| **Oracle Cloud Always Free** | **10 TB/mês** | **Sim.** Sobra folga absurda |
| Google Cloud `e2-micro` | 1 GB/mês | Não — ~15h de música e começa a cobrar |
| AWS / Azure free tier | 100 GB/mês, só 12 meses | Temporário |
| Render free | — | Não — só web service, e dorme sem tráfego |
| Replit free | — | Não — dorme; "Always On" é pago |
| Railway / Fly.io | — | Crédito de teste, depois pago |

Sobra uma resposta: **Oracle Cloud Always Free**. É VM de verdade, com root e UDP
liberado (o Discord precisa de UDP para voz), gratuita por tempo indeterminado, e
os 10 TB tornam o tráfego irrelevante. A unidade systemd do repositório funciona
lá direto.

O que esperar na prática:

- **É ARM** (Ampere A1: 4 vCPU e 24 GB no free tier). O `setup:ytdlp` detecta a
  arquitetura e baixa o `aarch64` — nada a configurar.
- **Capacidade ARM vive esgotada** nas regiões populares. Tente outra região, ou
  caia para as 2 VMs AMD `micro` (1 GB RAM cada), que também são Always Free e dão
  conta de algumas sessões.
- **Pede cartão de crédito** para verificação de identidade. Não cobra no Always
  Free, mas o cadastro exige.
- **IP de datacenter.** Vale a ressalva acima: se o YouTube começar a exigir
  verificação, o primeiro passo é `npm run setup:ytdlp`; persistindo, o caminho é
  fornecer cookies de uma conta logada ao yt-dlp.

### Passo a passo na Oracle Cloud

> **Onde cada coisa roda:** os passos 1 a 3 são no navegador, no painel da Oracle.
> A partir do 4, você se conecta à VM por SSH e digita tudo lá dentro — nada disso
> roda no seu computador, e **não é preciso ter Linux** para usar.

**1. Criar a conta** em [cloud.oracle.com](https://cloud.oracle.com) → *Start for
free*. Pede cartão para verificação, mas o Always Free não cobra.

A **região de origem não pode ser trocada depois**, e é ela que determina a
disponibilidade de máquinas ARM. Se o objetivo é servidor brasileiro, `Brazil East
(São Paulo)` dá a menor latência de voz — mas costuma estar lotada de ARM. Vale
verificar antes de decidir.

**2. Criar a instância** em *Compute → Instances → Create instance*:

| Campo | Valor |
| --- | --- |
| Image | Ubuntu 22.04 ou 24.04 |
| Shape | `VM.Standard.A1.Flex` — 4 OCPU, 24 GB (é ARM, e é o Always Free) |
| SSH keys | gere um par e **guarde a chave privada** |

Se der **"Out of host capacity"**, é o problema clássico do ARM na Oracle. Troque
o *availability domain*, tente em outro horário, ou use `VM.Standard.E2.1.Micro`
(AMD, 1 GB RAM) — também Always Free e suficiente para algumas sessões.

**3. Nada de firewall a abrir.** O bot só faz conexões de saída; o Discord
conecta-se a partir dele. A porta 22 já vem liberada para o SSH.

**4. Conectar.** Você não instala Linux em lugar nenhum: o Linux é a VM alugada,
e do seu computador você só se conecta nela por SSH. Daí em diante, tudo o que
for digitado roda **na VM**, não na sua máquina.

<details>
<summary><b>No Windows</b> (o SSH já vem instalado; não precisa de PuTTY)</summary>

Guarde a chave que a Oracle gerou em `%USERPROFILE%\.ssh\`. Antes de usar, ajuste
as permissões — o OpenSSH recusa chave que outros usuários possam ler, e o erro
(`UNPROTECTED PRIVATE KEY FILE`) não diz o que fazer:

```powershell
icacls "$env:USERPROFILE\.ssh\oracle.key" /inheritance:r /grant:r "$($env:USERNAME):R"
```

Depois, no PowerShell ou Windows Terminal:

```powershell
ssh -i "$env:USERPROFILE\.ssh\oracle.key" ubuntu@IP_DA_INSTANCIA
```

</details>

<details>
<summary><b>No Linux ou macOS</b></summary>

```bash
chmod 600 ~/.ssh/oracle.key && ssh -i ~/.ssh/oracle.key ubuntu@IP_DA_INSTANCIA
```

</details>

Quando o prompt mudar para algo como `ubuntu@instancia:~$`, você está dentro da
VM. **Os comandos abaixo são todos digitados aí.**

**5. Instalar** (já dentro da VM):

```bash
git clone https://github.com/brunnoaires/hshBotMusic.git && sudo bash hshBotMusic/deploy/setup.sh
```

O [setup.sh](deploy/setup.sh) cria o usuário de sistema, instala em `/opt/botdc`,
baixa o yt-dlp da arquitetura certa e registra o serviço. Ele **não** instala o
Node por conta própria — se faltar, mostra o comando oficial para você conferir e
rodar. É o único passo que adiciona repositório de terceiros, e essa decisão fica
com você.

**6. Credenciais e comandos:**

```bash
sudo -u botdc cp /opt/botdc/.env.example /opt/botdc/.env && sudo -u botdc nano /opt/botdc/.env
```

Preencha `DISCORD_TOKEN` e `DISCORD_CLIENT_ID`, deixando `DISCORD_GUILD_ID`
**vazio**. Depois:

```bash
cd /opt/botdc && sudo -u botdc npm run deploy:commands && sudo systemctl start botdc
```

**7. Acompanhar** — é aqui que aparece quem vinculou e o que está tocando:

```bash
journalctl -u botdc -f
```

O serviço reinicia sozinho se cair e sobe junto com a máquina. Ao parar, mata o
grupo inteiro de processos — sem isso, ffmpeg e yt-dlp ficariam órfãos segurando
banda.

### Atualizando depois

```bash
sudo bash /opt/botdc/deploy/setup.sh
```

O script é idempotente: puxa o código novo, atualiza dependências e binários, e
reinicia o serviço. Não toca no `.env`.

A manutenção recorrente é atualizar o yt-dlp quando o YouTube mudar a extração —
o `setup.sh` acima já faz isso, ou isoladamente:

```bash
cd /opt/botdc && sudo -u botdc npm run setup:ytdlp && sudo systemctl restart botdc
```

---

## Configuração

Tudo vem do `.env`. Variáveis obrigatórias ausentes são apontadas pelo nome na
inicialização.

| Variável | Para que serve |
| --- | --- |
| `DISCORD_TOKEN` | Token do bot. **Obrigatório.** |
| `DISCORD_CLIENT_ID` | Application ID, usado no registro dos comandos. **Obrigatório.** |
| `DISCORD_GUILD_ID` | Servidor onde registrar os comandos. Vazio = global, que é o que você quer se outras pessoas vão usar. |
| `OWNER_USER_ID` | Opcional. Identifica de quem é a conta do Spotify abaixo. |
| `SPOTIFY_CLIENT_ID` | Opcional. Credencial da Web API. |
| `SPOTIFY_CLIENT_SECRET` | Opcional. Credencial da Web API. |
| `SPOTIFY_REFRESH_TOKEN` | Gerado por `npm run login:spotify`. Não expira. |
| `SPOTIFY_REDIRECT_URI` | Padrão `http://127.0.0.1:8888/callback`. Loopback obrigatório. |
| `POLL_INTERVAL_MS` | Intervalo de consulta à Web API. Padrão `3000`. |
| `DEFAULT_MODE` | `follow` ou `queue`. Padrão `follow`. |
| `SYNC_POSITION` | Começar no mesmo ponto do seu Spotify. Padrão ligado. |
| `ANNOUNCE_TRACKS` | Publicar o cartão a cada troca. Padrão ligado. |
| `MAX_SESSIONS` | Servidores tocando ao mesmo tempo. Padrão `10`. |
| `YTDLP_CONCURRENCY` | Chamadas ao yt-dlp em paralelo. Padrão `3`. |
| `LOG_LEVEL` | `debug`, `info`, `warn` ou `error`. Padrão `info`. |

---

## Comandos de terminal

| Comando | O que faz |
| --- | --- |
| `npm start` | Liga o bot |
| `npm run convite` | Imprime o link de convite com as permissões corretas |
| `npm run setup:ytdlp` | Baixa ou atualiza o yt-dlp |
| `npm run login:spotify` | Login no Spotify, imprime o refresh token |
| `npm run deploy:commands` | Registra os slash commands e limpa duplicatas |
| `npm run check` | Checagem offline, sem credenciais |
| `npm run test:audio` | Diagnóstico da cadeia de áudio |
| `npm run docs:pdf` | Gera `botdc-funcionalidades.pdf` |

### Diagnóstico

```bash
npm run check
```

Verifica binários, carregamento dos módulos, montagem dos slash commands, cache,
roteamento entre servidores e a lógica de detecção. Não precisa de token nem de
conta do Spotify.

```bash
npm run test:audio "Radiohead - Weird Fishes" 60
```

Testa a cadeia yt-dlp → ffmpeg isolada do Discord: procura a faixa, transcodifica
a partir do segundo 60 e confirma que sai ogg/opus válido. É por aqui que se
começa quando "o bot conecta mas não sai som".

Para logs detalhados, incluindo o ranking dos candidatos e o stderr do ffmpeg,
use `LOG_LEVEL=debug`.

---

## Limitações conhecidas

- **~3,4s de atraso** numa faixa que o bot nunca viu e que não estava na fila do
  Spotify — pular no meio de uma playlist, por exemplo. Sequência normal e faixas
  repetidas ficam em ~0.
- **O piso é o yt-dlp**, que gasta ~1,6s por chamada e não tem modo servidor. Para
  ir abaixo só trocando a fonte de áudio.
- **O match nem sempre é perfeito** — a escolha do vídeo é heurística.
- **Um canal de voz por servidor**, seguindo uma pessoa por vez.
- **Podcasts são ignorados** — só faixas de música.
- Se o YouTube apertar o cerco na extração, o `setup:ytdlp` atualiza o binário. É a
  manutenção recorrente deste tipo de bot.

---

## Estrutura

```
src/
  index.js           liga tudo: eventos do Discord -> sessões
  session.js         uma sessão por servidor, roteada por driver
  config.js          .env validado
  logger.js
  spotify/
    api.js           refresh token, faixa atual e fila
    presence.js      lê a atividade do Spotify na presence
    watcher.js       funde as duas fontes, deduplica, emite eventos
  audio/
    resolve.js       metadados -> URL de áudio (busca, ranking, cache)
    prefetch.js      resolve as próximas da fila antecipadamente
    cache.js         store JSON com expiração e LRU
    ytdlp.js         wrapper do binário
    ffmpeg.js        transcodificação para ogg/opus
    player.js        conexão de voz, fila, troca de faixa, retentativa
  discord/
    commands.js      slash commands e handlers
    nowplaying.js    cartão "Reproduzindo agora"
    progressbar.js   barra de progresso em PNG, sem dependências
    deploy.js        registro dos comandos
deploy/
  botdc.service      unidade systemd para rodar 24/7
  setup.sh           instala e atualiza numa máquina Linux
scripts/
  install-ytdlp.js   baixa o binário
  invite.js          monta o link de convite
  spotify-login.js   OAuth para obter o refresh token
  selfcheck.js       checagem offline
  test-audio.js      diagnóstico da cadeia de áudio
  make-pdf.js        gera a documentação em PDF
```

O `npm run docs:pdf` gera `botdc-funcionalidades.pdf`, com sete páginas cobrindo
o mesmo conteúdo em formato de consulta. Usa `pdf-lib`, que é devDependency.

---

## Documentos

- [Termos de Serviço](TERMS.md) e [Política de Privacidade](PRIVACY.md) — o
  Developer Portal do Discord exige um link público para os dois. Cole as URLs
  destes arquivos em **General Information → Terms of Service / Privacy Policy**.
- [Licença MIT](LICENSE)

Se você rodar sua própria instância, troque o responsável nos dois documentos:
quem hospeda é quem responde pelos dados de quem usa aquela instância.
