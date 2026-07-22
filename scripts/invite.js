import { PermissionFlagsBits } from 'discord.js';
import { config } from '../src/config.js';

// Monta a URL de convite a partir das permissoes que o codigo realmente usa.
// Escrever a lista a mao no README foi o que deixou faltando as permissoes de
// mensagem quando o cartao "Reproduzindo agora" entrou.
const NECESSARIAS = {
  ViewChannel: 'ver o canal de texto onde /vincular for usado',
  SendMessages: 'publicar o cartao "Reproduzindo agora"',
  EmbedLinks: 'o cartao e um embed',
  AttachFiles: 'a barra de progresso vai como imagem anexada',
  ReadMessageHistory: 'apagar o cartao anterior a cada troca',
  Connect: 'entrar no canal de voz',
  Speak: 'tocar o audio',
};

const permissoes = Object.keys(NECESSARIAS).reduce(
  (total, nome) => total | PermissionFlagsBits[nome],
  0n,
);

const url = new URL('https://discord.com/oauth2/authorize');
url.search = new URLSearchParams({
  client_id: config.discord.clientId,
  // Sem "bot" o convite só instala os comandos e o bot NAO entra no servidor.
  scope: 'bot applications.commands',
  permissions: permissoes.toString(),
}).toString();

console.log('\n  Link de convite:\n');
console.log(`  ${url}\n`);

console.log('  Permissoes incluidas:');
for (const [nome, porque] of Object.entries(NECESSARIAS)) {
  console.log(`    ${nome.padEnd(20)} ${porque}`);
}

console.log(`
  Se o bot NAO entra no servidor depois de autorizar, verifique no
  Developer Portal (https://discord.com/developers/applications):

    Bot > Requires OAuth2 Code Grant .... tem que estar DESLIGADO
        Ligado, o Discord espera uma troca de codigo que nao existe aqui,
        e a autorizacao termina sem o bot entrar. E a causa mais comum.

    Bot > Public Bot ................... tem que estar LIGADO
        Desligado, so voce, dono da aplicacao, consegue adicionar o bot.

  E no servidor de destino: quem clica no link precisa da permissao
  "Gerenciar Servidor". Sem ela o servidor nem aparece na lista.
`);
