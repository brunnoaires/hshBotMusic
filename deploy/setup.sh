#!/usr/bin/env bash
#
# Instala o botdc como servico systemd numa maquina Linux limpa.
# Testado no alvo tipico: Ubuntu ou Oracle Linux numa VM Always Free.
#
#   sudo bash deploy/setup.sh
#
# Idempotente: rodar de novo atualiza o codigo e as dependencias sem
# reconfigurar nada. Nao toca no .env, que e sempre criado por voce.

set -euo pipefail

REPO="${REPO:-https://github.com/brunnoaires/hshBotMusic.git}"
DESTINO="${DESTINO:-/opt/botdc}"
USUARIO="${USUARIO:-botdc}"
SERVICO="botdc"

vermelho() { printf '\033[31m%s\033[0m\n' "$*"; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
passo()    { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  vermelho "Rode com sudo: sudo bash deploy/setup.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
passo "Verificando o Node"

# Instalar Node por conta propria significaria adicionar repositorio de
# terceiros sem voce ver. Melhor conferir e, se faltar, mostrar o comando
# oficial para voce rodar conscientemente.
if command -v node >/dev/null 2>&1; then
  MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
else
  MAIOR=0
fi

if [ "$MAIOR" -lt 20 ]; then
  vermelho "Node 20+ e necessario (encontrado: ${MAIOR:-nenhum})."
  echo
  echo "Instale primeiro, com o repositorio oficial do Node:"
  echo
  if command -v apt-get >/dev/null 2>&1; then
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/node.sh"
    echo "  less /tmp/node.sh        # confira antes de executar"
    echo "  sudo bash /tmp/node.sh && sudo apt-get install -y nodejs"
  else
    echo "  curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/node.sh"
    echo "  less /tmp/node.sh        # confira antes de executar"
    echo "  sudo bash /tmp/node.sh && sudo dnf install -y nodejs"
  fi
  echo
  echo "Depois rode este script de novo."
  exit 1
fi
verde "Node $(node -v) — ok"

# ---------------------------------------------------------------------------
passo "Garantindo git"

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq git
  else
    dnf install -y -q git
  fi
fi
verde "git $(git --version | awk '{print $3}') — ok"

# ---------------------------------------------------------------------------
passo "Usuario de sistema '$USUARIO'"

if id "$USUARIO" >/dev/null 2>&1; then
  verde "ja existe"
else
  # Sem shell de login: a conta serve so para rodar o servico.
  useradd --system --shell /usr/sbin/nologin --home-dir "$DESTINO" "$USUARIO"
  verde "criado"
fi

# ---------------------------------------------------------------------------
passo "Codigo em $DESTINO"

if [ -d "$DESTINO/.git" ]; then
  sudo -u "$USUARIO" -H git -C "$DESTINO" pull --ff-only
  verde "atualizado"
else
  mkdir -p "$DESTINO"
  chown "$USUARIO:$USUARIO" "$DESTINO"
  sudo -u "$USUARIO" -H git clone --depth 1 "$REPO" "$DESTINO"
  verde "clonado"
fi

# ---------------------------------------------------------------------------
passo "Dependencias e binarios"

cd "$DESTINO"
sudo -u "$USUARIO" -H npm install --omit=dev --no-audit --no-fund
# Baixa o yt-dlp certo para a arquitetura da maquina (x86_64 ou ARM).
sudo -u "$USUARIO" -H npm run setup:ytdlp

# ---------------------------------------------------------------------------
passo "Servico systemd"

install -m 644 "$DESTINO/deploy/$SERVICO.service" "/etc/systemd/system/$SERVICO.service"
systemctl daemon-reload
systemctl enable "$SERVICO" >/dev/null 2>&1
verde "instalado e habilitado no boot"

# ---------------------------------------------------------------------------
if [ -f "$DESTINO/.env" ]; then
  passo "Reiniciando o servico"
  systemctl restart "$SERVICO"
  sleep 2
  systemctl is-active --quiet "$SERVICO" && verde "rodando" || vermelho "falhou — veja: journalctl -u $SERVICO -n 40"
else
  passo "Falta o .env"
  cat <<TEXTO

O bot ainda nao pode subir: preencha as credenciais.

  sudo -u $USUARIO cp $DESTINO/.env.example $DESTINO/.env
  sudo -u $USUARIO nano $DESTINO/.env

Preencha DISCORD_TOKEN e DISCORD_CLIENT_ID, e deixe DISCORD_GUILD_ID VAZIO
para os comandos valerem em qualquer servidor. Depois:

  cd $DESTINO && sudo -u $USUARIO npm run deploy:commands
  sudo systemctl start $SERVICO
  journalctl -u $SERVICO -f

TEXTO
fi
