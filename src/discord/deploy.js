import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const appId = config.discord.clientId;

// Registro no escopo de servidor e o modo de teste: aparece na hora, mas so
// naquele servidor. Se sobrar registro de servidor junto com o global, o Discord
// exibe os dois conjuntos e os comandos aparecem DUPLICADOS. Por isso, ao
// registrar globalmente, varremos os servidores e limpamos o que ficou para tras.

if (config.discord.guildId) {
  await rest.put(Routes.applicationGuildCommands(appId, config.discord.guildId), {
    body: commands,
  });

  console.log(`${commands.length} comandos registrados no servidor ${config.discord.guildId}.`);
  console.log(
    '\nAtencao: eles NAO aparecem em outros servidores, e se voce ja registrou\n' +
      'globalmente antes, vao aparecer DUPLICADOS aqui. Para o bot funcionar em\n' +
      'qualquer servidor sem duplicar, deixe DISCORD_GUILD_ID vazio e rode de novo.',
  );
  process.exit(0);
}

console.log('Registrando globalmente e limpando registros de servidor...\n');

// Lista os servidores do bot sem precisar abrir conexao de gateway.
const guilds = await rest.get(Routes.userGuilds());
let limpos = 0;

for (const guild of guilds) {
  try {
    const existentes = await rest.get(Routes.applicationGuildCommands(appId, guild.id));
    if (!existentes.length) continue;

    await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] });
    console.log(`  limpos ${existentes.length} comandos de servidor em "${guild.name}"`);
    limpos++;
  } catch (err) {
    // Sem o escopo applications.commands naquele servidor nao da para listar.
    // Nao e motivo para abortar o registro global.
    console.log(`  nao consegui verificar "${guild.name}": ${err.message}`);
  }
}

await rest.put(Routes.applicationCommands(appId), { body: commands });

console.log(`\n${commands.length} comandos registrados globalmente.`);
console.log(
  limpos
    ? `Duplicatas removidas de ${limpos} servidor(es).`
    : 'Nenhum registro de servidor sobrando — nao havia duplicata.',
);
console.log('O registro global pode levar ate 1h para propagar.');
