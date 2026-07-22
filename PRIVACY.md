# Política de Privacidade — botdc

**Última atualização:** 22 de julho de 2026

O botdc é um bot de Discord auto-hospedado e de código aberto que reproduz num
canal de voz a música que você está ouvindo no Spotify.

Cada instalação é operada de forma independente. **O responsável por esta
instância é Brunno Aires.** Se você usa o bot em outro servidor, o responsável é
quem hospeda aquela instância.

O código-fonte está disponível em
[github.com/brunnoaires/hshBotMusic](https://github.com/brunnoaires/hshBotMusic)
e pode ser auditado por qualquer pessoa.

## O que o bot acessa

**Sua atividade do Spotify, publicada pelo Discord.** Quando você conecta o
Spotify à sua conta do Discord e mantém "Exibir o Spotify como seu status"
ligado, o Discord publica o que você está ouvindo. O bot lê daí: nome da faixa,
artista, álbum, identificador da faixa e horários de início e fim.

Isso só acontece depois que **você** usa o comando `/vincular`. O bot recebe
eventos de presença do servidor por exigência da API do Discord, mas descarta
imediatamente tudo que não seja de quem rodou o comando.

**Identificadores necessários ao funcionamento.** Seu ID de usuário do Discord, o
ID do servidor e o ID do canal onde o comando foi usado — para saber quem seguir
e onde publicar.

**Conta do Spotify do operador.** Se o operador ligou a Web API opcional, o bot
consulta a faixa atual e a fila **da conta dele**, usando uma autorização que ele
mesmo concedeu. Isso nunca é estendido às contas de outras pessoas.

## O que o bot não acessa

- **O conteúdo das suas mensagens.** O bot não solicita o intent de conteúdo de
  mensagem do Discord. Tecnicamente não recebe o texto do que você escreve.
- **Sua senha do Spotify, ou qualquer credencial sua.** Não há login, não há
  autorização a conceder. Nada é pedido a você.
- **O controle do seu Spotify.** O bot só observa; não pausa, não pula, não altera
  nada na sua conta.
- **Áudio do canal de voz.** O bot entra em modo surdo e não recebe o que você fala.

## O que é guardado em disco

Um único arquivo, `cache/resolve.json`, com duas coisas:

| O que | Para quê |
| --- | --- |
| Identificador de faixa do Spotify → identificador de vídeo do YouTube | não repetir a busca a cada vez que a mesma música toca |
| Endereço temporário de áudio do YouTube | evitar reprocessar a mesma faixa; expira sozinho |

**Nenhum identificador de usuário, de servidor ou de canal é gravado.** O arquivo
não permite saber quem ouviu o quê: é apenas uma lista de faixas que já passaram
por esta instância, sem vínculo com pessoas. Ele é limitado às 2000 entradas mais
recentes e pode ser apagado a qualquer momento sem prejuízo.

Todo o resto — quem está sendo seguido, o que está tocando, a fila — existe apenas
na memória e desaparece quando a sessão termina ou o bot reinicia.

## Terceiros

- **Discord** — provê a plataforma e a atividade do Spotify. Sujeito à
  [Política de Privacidade do Discord](https://discord.com/privacy).
- **Spotify** — apenas para a conta do operador, quando a Web API opcional está
  ligada. Sujeito à [Política de Privacidade do Spotify](https://www.spotify.com/legal/privacy-policy/).
- **YouTube** — de onde o áudio é obtido. As requisições partem do servidor que
  hospeda o bot; **o seu endereço de IP não é enviado ao YouTube**.

Nenhum dado é vendido, alugado ou compartilhado com anunciantes. Não há analytics,
rastreamento nem publicidade.

## Retenção

| Dado | Por quanto tempo |
| --- | --- |
| Sessão (quem está sendo seguido, faixa atual, fila) | até `/desvincular`, o canal esvaziar, ou o bot reiniciar |
| Endereço de áudio em cache | até a expiração natural, tipicamente algumas horas |
| Mapa faixa → vídeo | até o operador apagar o arquivo, ou o limite de 2000 entradas descartar |

## Como parar

Qualquer um destes encerra imediatamente a leitura da sua atividade:

- usar `/desvincular` no servidor
- desligar "Exibir o Spotify como seu status" nas configurações do Discord
- desconectar o Spotify da sua conta do Discord
- ficar como Invisível
- sair do servidor onde o bot está

Como nenhum dado pessoal é persistido, não há histórico seu a remover. Para pedir
que o operador apague o cache da instância, use o contato abaixo.

## Menores de idade

O bot segue os requisitos de idade dos [Termos de Serviço do Discord](https://discord.com/terms).
Não é direcionado a crianças e não coleta dados de identificação de ninguém.

## Alterações

Alterações são publicadas nesta página, com a data no topo atualizada. O histórico
completo de mudanças fica visível no repositório.

## Contato

Abra uma issue em
[github.com/brunnoaires/hshBotMusic/issues](https://github.com/brunnoaires/hshBotMusic/issues).
