#!/bin/sh
# Apolloon adres terugzetten op automatisch (DHCP): Linux en macOS.
# Alleen uitvoeren als het evenement HELEMAAL voorbij is, anders werkt
# school-wifi thuis niet maar het evenement-netwerk ook niet meer.
#
# Gebruik: sudo sh revert-apolloon-dhcp.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Opnieuw starten met sudo (wachtwoord nodig)..."
  exec sudo -E sh "$0" "$@"
fi

printf "Is het evenement helemaal voorbij? Typ VOORBIJ om te bevestigen: "
read -r ANSWER
if [ "$ANSWER" != "VOORBIJ" ]; then
  echo "Afgebroken (typ exact VOORBIJ)."
  exit 1
fi

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  SERVICE=$(networksetup -listallhardwareports 2>/dev/null | awk '
    /^Hardware Port:/ { port=$0; sub(/^Hardware Port: /, "", port) }
    /^Device:/ { dev=$2; if (port !~ /Wi-Fi|Bluetooth|Thunderbolt Bridge/i) { print port; exit } }')
  if [ -z "$SERVICE" ]; then
    echo "FOUT: geen bedrade netwerkdienst gevonden." >&2
    exit 1
  fi
  networksetup -setdhcp "$SERVICE"
  echo "OK ($SERVICE haalt het adres weer automatisch op)."
  exit 0
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "FOUT: NetworkManager (nmcli) niet gevonden. Zet het adres handmatig terug op automatisch (DHCP)" >&2
  echo "via je desktop-netwerkinstellingen." >&2
  exit 1
fi

CON=$(nmcli -t -f NAME,DEVICE,TYPE connection show --active 2>/dev/null | awk -F: '$3 ~ /ethernet|802-3/ {print $1; exit}')
if [ -z "$CON" ]; then
  echo "FOUT: geen actieve bedrade verbinding gevonden." >&2
  exit 1
fi
nmcli con mod "$CON" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
nmcli con up "$CON"
echo "OK ($CON haalt het adres weer automatisch op)."
