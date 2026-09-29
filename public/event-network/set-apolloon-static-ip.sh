#!/bin/sh
# Apolloon vast IP instellen: Linux (NetworkManager) en macOS.
# Werkt op Debian, Ubuntu en Arch (met NetworkManager) en op macOS.
#
# Gebruik (eenmalig per laptop, kabel erin):
#   sudo sh set-apolloon-static-ip.sh 192.168.1.211
#   sudo sh set-apolloon-static-ip.sh 192.168.1.211 192.168.1.1   # met router/gateway
# Zonder argumenten stelt het script vragen.
#
# Aanbevolen plan (zelfde switch, /24 overal):
#   Laptop 1: 192.168.10.11   Laptop 2: 192.168.10.12   Laptop 3: 192.168.10.13
#   Geen gateway op een losse switch; wel een gateway als er een router is.
set -eu

IP="${1:-}"
GW="${2:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Opnieuw starten met sudo (wachtwoord nodig)..."
  exec sudo -E sh "$0" "$@"
fi

OS="$(uname -s)"

valid_ip() {
  echo "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || return 1
  for octet in $(echo "$1" | tr '.' ' '); do
    [ "$octet" -ge 0 ] 2>/dev/null && [ "$octet" -le 255 ] 2>/dev/null || return 1
  done
  case "$1" in
    169.254.*) return 1;;
    *.0|*.255) return 1;;
  esac
  return 0
}

current_ip() {
  if [ "$OS" = "Darwin" ]; then
    for iface in $(ifconfig -l); do
      case "$iface" in lo*|awdl*|bridge*|utun*|llw*) continue;; esac
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
      if [ -n "$ip" ]; then echo "$ip"; return 0; fi
    done
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

if [ -z "$IP" ]; then
  detected=$(current_ip || true)
  printf "Vast IP voor deze laptop [%s]: " "$detected"
  read -r IP
  [ -z "$IP" ] && IP="$detected"
  if [ -z "$GW" ]; then
    printf "Gateway (leeg laten zonder router): "
    read -r GW
  fi
fi

if ! valid_ip "$IP"; then
  echo "FOUT: '$IP' is geen bruikbaar vast adres (geen 169.254.x.x, niet eindigend op .0/.255)." >&2
  exit 1
fi
if [ -n "$GW" ] && ! valid_ip "$GW"; then
  echo "FOUT: gateway '$GW' is geen geldig adres." >&2
  exit 1
fi

if [ "$OS" = "Darwin" ]; then
  SERVICE=$(networksetup -listallhardwareports 2>/dev/null | awk '
    /^Hardware Port:/ { port=$0; sub(/^Hardware Port: /, "", port) }
    /^Device:/ { dev=$2; if (port !~ /Wi-Fi|Bluetooth|Thunderbolt Bridge/i) { print port; exit } }')
  if [ -z "$SERVICE" ]; then
    echo "FOUT: geen bedrade netwerkdienst gevonden. Steek de kabel erin." >&2
    exit 1
  fi
  echo "Dienst: $SERVICE | vast IP: $IP/24 ${GW:+gateway: $GW}"
  printf "Doorgaan? [j/N] "
  read -r ANSWER
  case "$ANSWER" in j|J|y|Y) ;; *) echo "Afgebroken."; exit 0;; esac
  if [ -n "$GW" ]; then
    networksetup -setmanual "$SERVICE" "$IP" 255.255.255.0 "$GW"
  else
    networksetup -setmanual "$SERVICE" "$IP" 255.255.255.0
  fi
  echo "OK. Schermen verbinden met: http://$IP:5173"
  exit 0
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "FOUT: NetworkManager (nmcli) niet gevonden. Op Arch: installeer networkmanager en gebruik nmtui," >&2
  echo "of stel het adres handmatig in via je desktop-netwerkinstellingen." >&2
  exit 1
fi

CON=$(nmcli -t -f NAME,DEVICE,TYPE connection show --active 2>/dev/null | awk -F: '$3 ~ /ethernet|802-3/ {print $1; exit}')
if [ -z "$CON" ]; then
  echo "FOUT: geen actieve bedrade verbinding. Steek de kabel erin." >&2
  exit 1
fi
echo "Verbinding: $CON | vast IP: $IP/24 ${GW:+gateway: $GW}"
printf "Doorgaan? [j/N] "
read -r ANSWER
case "$ANSWER" in j|J|y|Y) ;; *) echo "Afgebroken."; exit 0;; esac

if [ -n "$GW" ]; then
  nmcli con mod "$CON" ipv4.addresses "$IP/24" ipv4.gateway "$GW" ipv4.dns "" ipv4.method manual
else
  nmcli con mod "$CON" ipv4.addresses "$IP/24" ipv4.dns "" ipv4.method manual
fi
nmcli con up "$CON"

if command -v ufw >/dev/null 2>&1; then
  ufw allow 5173/tcp >/dev/null 2>&1 || true
  echo "Firewall: poort 5173/tcp opengezet (ufw)."
fi

echo "OK. Schermen verbinden met: http://$IP:5173"
