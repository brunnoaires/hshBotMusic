/**
 * Limita quantas tarefas rodam ao mesmo tempo, enfileirando o excedente.
 *
 * Existe por causa do yt-dlp: todas as chamadas saem do mesmo IP, e uma rajada
 * de requisicoes ao YouTube leva a 429 — que degrada o bot para todo mundo, nao
 * so para quem causou a rajada.
 *
 * A tarefa e recebida como funcao em vez de expor adquirir/liberar soltos: assim
 * a vaga sempre volta, mesmo quando a tarefa lanca.
 */
export function criarSemaforo(limite) {
  const maximo = Math.max(1, limite);
  const esperando = [];
  let ativos = 0;

  const adquirir = () => {
    if (ativos < maximo) {
      ativos++;
      return Promise.resolve();
    }
    return new Promise((liberado) => esperando.push(liberado));
  };

  const liberar = () => {
    const proximo = esperando.shift();
    // Passa a vaga direto para quem espera, em vez de decrementar e reabrir.
    // Decrementar abriria uma janela em que uma chamada nova furaria a fila.
    if (proximo) proximo();
    else ativos--;
  };

  return {
    async executar(tarefa) {
      await adquirir();
      try {
        return await tarefa();
      } finally {
        liberar();
      }
    },

    status() {
      return { ativos, esperando: esperando.length, limite: maximo };
    },
  };
}
