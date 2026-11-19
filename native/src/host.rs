//! Prefer physical wired LAN addresses, using the same ranking as the existing server.
use serde_json::{Value, json};
use std::{
    net::Ipv4Addr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
pub fn score(name: &str, address: Ipv4Addr) -> i32 {
    let name = name.to_lowercase();
    if [
        "lo",
        "docker",
        "br-",
        "veth",
        "virbr",
        "zt",
        "tailscale",
        "tun",
        "tap",
        "wg",
        "vmnet",
        "vboxnet",
    ]
    .iter()
    .any(|p| name.starts_with(p))
    {
        return -1;
    }
    let o = address.octets();
    let mut n = 10;
    if o[0] == 192 && o[1] == 168 {
        n += 100;
    } else if o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) {
        n += 90;
    } else if o[0] == 169 && o[1] == 254 {
        n += 5;
    }
    if ["en", "eth", "eno", "ens", "enp", "ethernet"]
        .iter()
        .any(|p| name.starts_with(p))
    {
        n += 200;
    } else if ["wl", "wlan", "wifi", "wi-fi"]
        .iter()
        .any(|p| name.starts_with(p))
    {
        n += 20;
    }
    n
}
pub fn addresses() -> Vec<(String, Ipv4Addr, Ipv4Addr)> {
    let mut addresses = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| {
            if interface.is_loopback() {
                return None;
            }
            let if_addrs::IfAddr::V4(v4) = interface.addr else {
                return None;
            };
            let score = score(&interface.name, v4.ip);
            if score <= 0 {
                return None;
            }
            let broadcast = v4
                .broadcast
                .unwrap_or_else(|| Ipv4Addr::from(u32::from(v4.ip) | !u32::from(v4.netmask)));
            Some((score, interface.name, v4.ip, broadcast))
        })
        .collect::<Vec<_>>();
    addresses.sort_by_key(|a| std::cmp::Reverse(a.0));
    addresses
        .into_iter()
        .map(|(_, name, ip, broadcast)| (name, ip, broadcast))
        .collect()
}
pub fn address() -> String {
    if let Ok(host) = std::env::var("PUBLIC_HOST") {
        if !host.trim().is_empty() {
            return host.trim().into();
        }
    }
    static CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some((time, host)) = &*cache {
        if time.elapsed() < Duration::from_secs(1) {
            return host.clone();
        }
    }
    let host = addresses()
        .first()
        .map(|(_, ip, _)| ip.to_string())
        .unwrap_or_else(|| "localhost".into());
    *cache = Some((Instant::now(), host.clone()));
    host
}
pub fn name() -> String {
    std::env::var("CLUSTER_LAPTOP_NAME")
        .ok()
        .or_else(|| {
            hostname::get()
                .ok()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "Deze laptop".into())
        .trim()
        .split('.')
        .next()
        .unwrap_or("Deze laptop")
        .chars()
        .take(64)
        .collect()
}
pub fn info(port: u16) -> Value {
    let host = address();
    let port = std::env::var("PUBLIC_APP_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(port);
    json!({"hostIpHint":host,"port":port,"url":format!("http://{host}:{port}")})
}
pub fn origin(screen: &str, remote: std::net::IpAddr) -> String {
    let screen = if screen == "/" {
        "Start"
    } else {
        [
            ("/timing", "Timing"),
            ("/queue", "Wachtrij"),
            ("/admin", "Beheer"),
            ("/analysis", "Analyse"),
            ("/tactics", "Tactiek"),
            ("/display/inside", "Binnenscherm"),
            ("/display/outside", "Buitenscherm"),
            ("/display/competitions", "Competitiescherm"),
        ]
        .into_iter()
        .find(|(p, _)| screen.starts_with(p))
        .map(|(_, name)| name)
        .unwrap_or("Ander scherm")
    };
    let remote = match remote {
        std::net::IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(std::net::IpAddr::V4)
            .unwrap_or(remote),
        _ => remote,
    };
    format!(
        "{screen} · {}",
        if remote.is_loopback() {
            format!("laptop {} ({})", name(), address())
        } else {
            format!("browser {remote}")
        }
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wired_physical_addresses_win_and_virtual_adapters_are_excluded() {
        assert!(
            score("en0", "192.168.1.2".parse().unwrap())
                > score("wlan0", "192.168.1.3".parse().unwrap())
        );
        assert!(
            score("en0", "10.0.0.2".parse().unwrap()) > score("en1", "185.1.2.3".parse().unwrap())
        );
        assert!(score("docker0", "172.17.0.1".parse().unwrap()) < 0);
        assert!(origin("/queue", "10.0.0.3".parse().unwrap()).ends_with("browser 10.0.0.3"));
    }
}
