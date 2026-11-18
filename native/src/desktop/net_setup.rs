//! OS part of server/net-setup.ts: pins the host's wired adapter to a static address for the
//! event LAN (with the firewall rules), and undoes that afterwards. The OS permission prompt
//! (UAC / pkexec / macOS password) appears on this laptop; the HTTP call returns at once and
//! the panel polls the profile until `lastElevation` settles.
use serde_json::{Value, json};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const UNDO_PHRASE: &str = "VOORBIJ";
const WINDOWS_UAC_CANCELLED_EXIT: i32 = 1223;
const WINDOWS_NO_WIRED_ADAPTER_EXIT: i32 = 11;
const MANUAL_HINT: &str =
    "Gebruik de handmatige stappen of download hieronder het script voor dit toestel.";
const ELEVATION_BUSY: &str = "Er wacht al een netwerkwijziging op toestemming. Bevestig of weiger die eerst op deze laptop en probeer het daarna opnieuw.";
pub const ELEVATION_WAIT_MS: i64 = 90_000;

fn no_wired() -> String {
    format!(
        "Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. {MANUAL_HINT}"
    )
}
fn port_env(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|p| *p > 0)
        .unwrap_or(fallback)
}
pub fn public_app_port() -> u16 {
    port_env("PUBLIC_APP_PORT", port_env("PORT", 5173))
}
pub fn discovery_port() -> u16 {
    port_env("CLUSTER_DISCOVERY_PORT", 45737)
}

pub fn parse_ipv4(value: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = value.trim().split('.').collect();
    if parts.len() != 4
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let mut o = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        o[i] = p.parse::<u16>().ok().filter(|v| *v <= 255)? as u8;
    }
    Some(o)
}
fn as_u32(o: [u8; 4]) -> u32 {
    u32::from_be_bytes(o)
}
fn prefix_mask(prefix: u32) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}
pub fn is_apipa(ip: &str) -> bool {
    parse_ipv4(ip).is_some_and(|o| o[0] == 169 && o[1] == 254)
}
pub fn is_private_lan(ip: &str) -> bool {
    parse_ipv4(ip).is_some_and(|[a, b, ..]| {
        (a == 192 && b == 168) || a == 10 || (a == 172 && (16..=31).contains(&b))
    })
}
pub fn same_subnet(a: &str, b: &str, prefix: u32) -> bool {
    match (parse_ipv4(a), parse_ipv4(b)) {
        (Some(l), Some(r)) => as_u32(l) & prefix_mask(prefix) == as_u32(r) & prefix_mask(prefix),
        _ => false,
    }
}
pub fn prefix_to_mask(prefix: u32) -> Option<String> {
    (8..=30).contains(&prefix).then(|| {
        let m = prefix_mask(prefix).to_be_bytes();
        format!("{}.{}.{}.{}", m[0], m[1], m[2], m[3])
    })
}
pub fn mask_to_prefix(mask: &str) -> Option<u32> {
    let m = as_u32(parse_ipv4(mask)?);
    let ones = m.leading_ones();
    (m == prefix_mask(ones) && (8..=30).contains(&ones)).then_some(ones)
}
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
pub fn is_wired_nm_type(kind: &str) -> bool {
    kind == "ethernet" || kind == "802-3-ethernet"
}
pub fn is_wireless_windows_adapter(alias: &str) -> bool {
    let a = alias.to_lowercase();
    [
        "wifi",
        "wi-fi",
        "wlan",
        "wireless",
        "draadloos",
        "bluetooth",
    ]
    .iter()
    .any(|n| a.contains(n))
}
pub fn is_wireless_mac_service(service: &str) -> bool {
    let s = service.to_lowercase();
    ["wifi", "wi-fi", "airport", "bluetooth", "iphone"]
        .iter()
        .any(|n| s.contains(n))
}

pub fn describe_elevation_failure(platform: &str, exit: Option<i32>, stderr: &str) -> String {
    let out = stderr.to_lowercase();
    if platform == "linux" {
        if out.contains("authentication agent") {
            return "Er kon geen wachtwoordvenster openen: op deze Linux-desktop draait geen polkit-agent. Start er een (bijvoorbeeld polkit-kde-authentication-agent-1 of hyprpolkitagent) en probeer opnieuw, of gebruik het Linux-script hieronder.".into();
        }
        if exit == Some(126) {
            return "De toestemming is geweigerd of het wachtwoordvenster werd gesloten. Er is niets veranderd.".into();
        }
        if exit == Some(127) {
            return "Het wachtwoord werd niet aanvaard. Er is niets veranderd.".into();
        }
    }
    if platform == "win32" {
        if exit == Some(WINDOWS_UAC_CANCELLED_EXIT) || out.contains("uac_cancelled") {
            return "De toestemming werd geweigerd (Nee in het Windows-venster). Er is niets veranderd.".into();
        }
        if exit == Some(WINDOWS_NO_WIRED_ADAPTER_EXIT) {
            return "Geen bedrade netwerkadapter gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet.".into();
        }
    }
    if platform == "darwin" && (out.contains("user canceled") || out.contains("-128")) {
        return "De toestemming werd geannuleerd. Er is niets veranderd.".into();
    }
    format!(
        "De netwerkwijziging is mislukt{}. Er is niets veranderd.",
        exit.map(|c| format!(" (code {c})")).unwrap_or_default()
    )
}

/// `nmcli -t -f NAME,DEVICE,TYPE connection show --active` (a colon inside a value is `\:`).
pub fn parse_nmcli_active(output: &str) -> Vec<(String, String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = Vec::new();
            let mut current = String::new();
            let mut chars = line.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\\' && chars.peek() == Some(&':') {
                    current.push(':');
                    chars.next();
                } else if c == ':' {
                    parts.push(std::mem::take(&mut current));
                } else {
                    current.push(c);
                }
            }
            parts.push(current);
            (parts.len() >= 3 && !parts[0].is_empty() && !parts[1].is_empty())
                .then(|| (parts[0].clone(), parts[1].clone(), parts[2].clone()))
        })
        .collect()
}
/// `KEY:value` lines; the first value of a key wins.
pub fn parse_nmcli_fields(output: &str) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in output.lines() {
        if let Some((k, v)) = line.split_once(':').filter(|(k, _)| !k.trim().is_empty()) {
            if !fields.iter().any(|(key, _)| key == k.trim()) {
                fields.push((k.trim().into(), v.trim().into()));
            }
        }
    }
    fields
}
/// `networksetup -listallhardwareports`: (port, device).
pub fn parse_hardware_ports(output: &str) -> Vec<(String, String)> {
    let mut ports = Vec::new();
    let mut current: Option<String> = None;
    for line in output.lines() {
        if let Some(port) = line.strip_prefix("Hardware Port:") {
            current = Some(port.trim().into());
        } else if let Some(device) = line.strip_prefix("Device:").map(str::trim) {
            if !device.is_empty() && device.chars().all(|c| c.is_ascii_alphanumeric()) {
                if let Some(port) = current.take() {
                    ports.push((port, device.into()));
                }
            }
        }
    }
    ports
}
/// `networksetup -getinfo`: (manual, ip, mask, router).
pub fn parse_networksetup_info(
    output: &str,
) -> (Option<bool>, Option<String>, Option<String>, Option<String>) {
    let lower = output.to_lowercase();
    let manual = if lower.contains("manual configuration") {
        Some(true)
    } else if lower.contains("dhcp configuration") {
        Some(false)
    } else {
        None
    };
    let pick = |label: &str| {
        output.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim().eq_ignore_ascii_case(label))
                .then(|| v.trim().to_string())
                .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("none"))
        })
    };
    (
        manual,
        pick("IP address"),
        pick("Subnet mask"),
        pick("Router"),
    )
}

#[derive(Debug, PartialEq)]
pub struct StaticRequest {
    pub ip: String,
    pub prefix: u32,
    pub gateway: Option<String>,
}

pub fn validate_static_request(input: &Value) -> Result<StaticRequest, String> {
    let octets = input["ip"]
        .as_str()
        .and_then(parse_ipv4)
        .ok_or("Dat is geen geldig IPv4-adres (bijv. 192.168.1.211).")?;
    let ip = format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]);
    if is_apipa(&ip) {
        return Err("169.254.x.x is een noodadres, geen vast adres. Kies een adres in je eigen netwerk (bijv. 192.168.1.211).".into());
    }
    let mut prefix = 24;
    let raw = &input["prefixLength"];
    if !(raw.is_null() || raw == "") {
        let p = raw
            .as_f64()
            .or_else(|| raw.as_str().and_then(|s| s.trim().parse().ok()));
        match p.filter(|p| p.fract() == 0.0 && (8.0..=30.0).contains(p)) {
            Some(p) => prefix = p as u32,
            None => return Err("Gebruik een normaal subnetmasker (aanbevolen: 24).".into()),
        }
    }
    let host_mask = !prefix_mask(prefix);
    let host = as_u32(octets) & host_mask;
    if host == 0 || host == host_mask {
        return Err(format!(
            "{ip} is het eerste of laatste adres van dit netwerk (/{prefix}) en werkt niet. Kies bijv. .211."
        ));
    }
    let mut gateway = None;
    if let Some(g) = input["gateway"].as_str().filter(|g| !g.trim().is_empty()) {
        let o = parse_ipv4(g).ok_or("De gateway is geen geldig IPv4-adres.")?;
        let g = format!("{}.{}.{}.{}", o[0], o[1], o[2], o[3]);
        if !same_subnet(&ip, &g, prefix) {
            return Err("De gateway moet in hetzelfde netwerk zitten als het vaste adres.".into());
        }
        gateway = Some(g);
    }
    Ok(StaticRequest {
        ip,
        prefix,
        gateway,
    })
}

pub fn linux_set_static_script(connection: &str, r: &StaticRequest) -> String {
    let q = sh_quote(connection);
    let gw = r
        .gateway
        .as_ref()
        .map(|g| format!(" ipv4.gateway {g}"))
        .unwrap_or_default();
    [
        format!(
            "nmcli con mod {q} ipv4.addresses {}/{}{gw} ipv4.dns '' ipv4.method manual",
            r.ip, r.prefix
        ),
        format!("nmcli con up {q}"),
        "if command -v ufw >/dev/null 2>&1; then".into(),
        format!(
            "  ufw allow {}/tcp >/dev/null 2>&1 || true",
            public_app_port()
        ),
        format!(
            "  ufw allow {}/udp >/dev/null 2>&1 || true",
            discovery_port()
        ),
        "fi".into(),
    ]
    .join("\n")
}
pub fn linux_revert_script(connection: &str) -> String {
    let q = sh_quote(connection);
    format!(
        "nmcli con mod {q} ipv4.method auto ipv4.addresses '' ipv4.gateway '' ipv4.dns ''\nnmcli con up {q}"
    )
}
pub fn mac_set_manual(service: &str, ip: &str, mask: &str, gateway: Option<&str>) -> String {
    format!(
        "networksetup -setmanual {} {ip} {mask}{}",
        sh_quote(service),
        gateway.map(|g| format!(" {g}")).unwrap_or_default()
    )
}
pub fn mac_revert(service: &str) -> String {
    format!("networksetup -setdhcp {}", sh_quote(service))
}
fn windows_select_wired() -> Vec<String> {
    vec![
        "$ErrorActionPreference = 'Stop'".into(),
        "$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object { if ($_.MediaType -match '802.3|Ethernet') { 0 } else { 1 } }".into(),
        "$adapter = $adapters | Where-Object { $_.Name -notmatch 'Wi-?Fi|WLAN|VPN|vEthernet|Virtual|Bluetooth' } | Select-Object -First 1".into(),
        format!("if (-not $adapter) {{ exit {WINDOWS_NO_WIRED_ADAPTER_EXIT} }}"),
    ]
}
/// Includes the firewall rules for the app port (TCP) and discovery (UDP).
pub fn windows_set_static_script(r: &StaticRequest) -> String {
    let (app, disc) = (public_app_port(), discovery_port());
    let gw = r
        .gateway
        .as_ref()
        .map(|g| format!(" -DefaultGateway '{g}'"))
        .unwrap_or_default();
    let mut lines = windows_select_wired();
    lines.extend([
        "$ifIndex = $adapter.ifIndex".into(),
        "Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^127\\.' } | ForEach-Object { Remove-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $_.IPAddress -Confirm:$false -ErrorAction SilentlyContinue }".into(),
        "Get-NetRoute -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | ForEach-Object { Remove-NetRoute -InterfaceIndex $ifIndex -DestinationPrefix $_.DestinationPrefix -NextHop $_.NextHop -Confirm:$false -ErrorAction SilentlyContinue }".into(),
        format!("New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress '{}' -PrefixLength {}{gw} | Out-Null", r.ip, r.prefix),
        "Set-NetIPInterface -InterfaceIndex $ifIndex -Dhcp Disabled | Out-Null".into(),
        if r.gateway.is_some() { "# Router-LAN: laat DNS met rust.".into() } else { "Set-DnsClientServerAddress -InterfaceIndex $ifIndex -ResetServerAddresses | Out-Null".into() },
        format!("if (-not (Get-NetFirewallRule -DisplayName 'Apolloon TCP {app}' -ErrorAction SilentlyContinue)) {{"),
        format!("  New-NetFirewallRule -DisplayName 'Apolloon TCP {app}' -Direction Inbound -Protocol TCP -LocalPort {app} -Action Allow -Profile Any | Out-Null"),
        "}".into(),
        format!("if (-not (Get-NetFirewallRule -DisplayName 'Apolloon UDP {disc}' -ErrorAction SilentlyContinue)) {{"),
        format!("  New-NetFirewallRule -DisplayName 'Apolloon UDP {disc}' -Direction Inbound -Protocol UDP -LocalPort {disc} -Action Allow -Profile Any | Out-Null"),
        "}".into(),
    ]);
    lines.join("\r\n")
}
pub fn windows_revert_script() -> String {
    let mut lines = windows_select_wired();
    lines.extend([
        "Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Enabled | Out-Null".into(),
        "Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses | Out-Null".into(),
        "Restart-NetAdapter -InterfaceIndex $adapter.ifIndex -Confirm:$false".into(),
    ]);
    lines.join("\r\n")
}
fn encoded_command(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}
pub fn windows_launcher_command(encoded: &str) -> String {
    let elevated = format!(
        "Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}'"
    );
    format!(
        "try {{ $p = {elevated}; if ($null -eq $p.ExitCode) {{ exit 0 }}; exit $p.ExitCode }} catch {{ [Console]::Error.WriteLine('UAC_CANCELLED'); exit {WINDOWS_UAC_CANCELLED_EXIT} }}"
    )
}

// The elevated change's state machine: waiting moves once to finished or failed.
static LAST: Mutex<Option<Value>> = Mutex::new(None);

pub fn last_elevation() -> Value {
    LAST.lock().unwrap().clone().unwrap_or(Value::Null)
}
fn settle(id: &str, state: &str, message: Option<String>) {
    let mut last = LAST.lock().unwrap();
    if let Some(v) = last
        .as_mut()
        .filter(|v| v["id"] == id && v["state"] == "waiting")
    {
        v["state"] = json!(state);
        v["message"] = json!(message);
    }
}
/// Starts one elevated change and follows its helper process.
pub fn start_elevation(mut command: Command) -> Result<Value, String> {
    let now = crate::db::now();
    {
        let last = LAST.lock().unwrap();
        if let Some(v) = last.as_ref() {
            if v["state"] == "waiting"
                && now - v["startedAt"].as_i64().unwrap_or(0) < ELEVATION_WAIT_MS
            {
                return Err(ELEVATION_BUSY.into());
            }
        }
    }
    let id = format!("{now}-{}", &crate::db::id()[..6]);
    let outcome = json!({"id":id,"state":"waiting","message":null,"startedAt":now});
    *LAST.lock().unwrap() = Some(outcome.clone());
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            let text = format!("Kon de toestemming niet vragen: {e}");
            settle(&id, "failed", Some(text.clone()));
            return Err(text);
        }
    };
    std::thread::spawn(move || match child.wait_with_output() {
        Ok(out) if out.status.success() => settle(&id, "finished", None),
        Ok(out) => settle(
            &id,
            "failed",
            Some(describe_elevation_failure(
                super::updates::platform(),
                out.status.code(),
                &String::from_utf8_lossy(&out.stderr),
            )),
        ),
        Err(e) => settle(
            &id,
            "failed",
            Some(format!("Kon de toestemming niet vragen: {e}")),
        ),
    });
    Ok(outcome)
}

fn run_quiet(file: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(file)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}
fn tool(name: &str) -> bool {
    let probe: &[&str] = match name {
        "networksetup" => &["-version"],
        "osascript" => &["-e", "return 1"],
        _ => &["--version"],
    };
    run_quiet(name, probe).is_some()
}

struct Adapter {
    name: String,
    address: String,
    prefix: Option<u32>,
    dhcp: Option<bool>,
    connection: Option<String>,
    nm_type: Option<String>,
}

fn read_adapters() -> Vec<Adapter> {
    let platform = super::updates::platform();
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let nm_active = (platform == "linux").then(|| {
        run_quiet(
            "nmcli",
            &[
                "-t",
                "-f",
                "NAME,DEVICE,TYPE",
                "connection",
                "show",
                "--active",
            ],
        )
        .map(|o| parse_nmcli_active(&o))
        .unwrap_or_default()
    });
    let mac_ports = (platform == "darwin").then(|| {
        run_quiet("networksetup", &["-listallhardwareports"])
            .map(|o| parse_hardware_ports(&o))
            .unwrap_or_default()
    });
    let win = (platform == "win32").then(|| {
        let cmd = "Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { \"dhcp`t$($_.InterfaceAlias)`t$($_.Dhcp)\" }";
        run_quiet("powershell.exe", &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_command(cmd)]).unwrap_or_default()
    });
    crate::host::addresses()
        .into_iter()
        .map(|(name, ip, _)| {
            let address = ip.to_string();
            let mut adapter = Adapter {
                prefix: Some(24),
                dhcp: None,
                connection: None,
                nm_type: None,
                name: name.clone(),
                address: address.clone(),
            };
            if let Some(v4) = interfaces.iter().find_map(|i| match &i.addr {
                if_addrs::IfAddr::V4(v) if v.ip == ip => Some(v.netmask),
                _ => None,
            }) {
                adapter.prefix = Some(u32::from(v4).leading_ones())
                    .filter(|p| (8..=30).contains(p))
                    .or(Some(24));
            }
            if let Some(active) = &nm_active {
                if let Some((conn, _, kind)) = active
                    .iter()
                    .find(|(_, d, _)| *d == name)
                    .or_else(|| active.iter().find(|(_, _, t)| is_wired_nm_type(t)))
                {
                    adapter.connection = Some(conn.clone());
                    adapter.nm_type = Some(kind.clone());
                    let method = run_quiet(
                        "nmcli",
                        &["-t", "-f", "ipv4.method", "connection", "show", conn],
                    )
                    .unwrap_or_default();
                    adapter.dhcp = match method
                        .split(':')
                        .nth(1)
                        .map(|m| m.trim().to_lowercase())
                        .as_deref()
                    {
                        Some("auto") => Some(true),
                        Some("manual") => Some(false),
                        _ => None,
                    };
                }
            }
            if let Some(ports) = &mac_ports {
                if let Some((service, _)) = ports.iter().find(|(_, d)| *d == name) {
                    adapter.connection = Some(service.clone());
                    let (manual, _, mask, _) = parse_networksetup_info(
                        &run_quiet("networksetup", &["-getinfo", service]).unwrap_or_default(),
                    );
                    adapter.dhcp = manual.map(|m| !m);
                    adapter.prefix = mask.as_deref().and_then(mask_to_prefix).or(adapter.prefix);
                }
            }
            if let Some(out) = &win {
                adapter.dhcp = out.lines().find_map(|l| {
                    let mut p = l.split('\t');
                    (p.next()? == "dhcp" && p.next()?.eq_ignore_ascii_case(&name))
                        .then(|| p.next().map(|v| v.trim().eq_ignore_ascii_case("enabled")))?
                });
            }
            adapter
        })
        .collect()
}

/// The same shape as shared/network.ts NetProfile.
pub fn profile() -> Value {
    let platform = super::updates::platform();
    let adapters = read_adapters();
    let manager = adapters.iter().find_map(|a| {
        a.connection.as_ref().map(|c| {
            if platform == "darwin" {
                format!("macOS-netwerkdienst: {c}")
            } else {
                format!("NetworkManager: {c}")
            }
        })
    });
    let primary = adapters.first();
    let primary_wired = primary.and_then(|p| match platform {
        "win32" => Some(!is_wireless_windows_adapter(&p.name)),
        "linux" => p.nm_type.as_deref().map(is_wired_nm_type),
        "darwin" => p.connection.as_deref().map(|c| !is_wireless_mac_service(c)),
        _ => None,
    });
    let (method, hint) = match platform {
        "win32" => (
            json!("uac"),
            json!("Windows vraagt om toestemming (klik op Ja)"),
        ),
        "linux" if tool("nmcli") && tool("pkexec") => {
            (json!("pkexec"), json!("Linux vraagt om je wachtwoord"))
        }
        "darwin" if tool("networksetup") && tool("osascript") => {
            (json!("osascript"), json!("macOS vraagt om je wachtwoord"))
        }
        _ => (Value::Null, Value::Null),
    };
    let to_json = |a: &Adapter| json!({"name":a.name,"address":a.address,"prefixLength":a.prefix,"dhcp":a.dhcp,"connection":a.connection});
    let apipa = primary.is_some_and(|p| is_apipa(&p.address));
    json!({
        "platform": platform,
        "windows": platform == "win32",
        "elevateMethod": method,
        "elevateHint": hint,
        "manager": manager,
        "adapters": adapters.iter().map(to_json).collect::<Vec<_>>(),
        "primary": primary.map(to_json),
        "apipa": apipa,
        "suggestion": primary.filter(|p| !apipa && is_private_lan(&p.address)).map(|p| json!({"ip":p.address,"prefixLength":p.prefix.unwrap_or(24),"gateway":null})),
        "eventUrl": primary.filter(|_| !apipa).map(|p| format!("http://{}:{}", p.address, public_app_port())),
        "primaryWired": primary_wired,
        "lastElevation": last_elevation(),
    })
}

fn primary_connection(adapters: &[Adapter]) -> Option<String> {
    let primary = adapters.first().filter(|p| !is_apipa(&p.address))?;
    match super::updates::platform() {
        "linux" => {
            let active = parse_nmcli_active(&run_quiet(
                "nmcli",
                &[
                    "-t",
                    "-f",
                    "NAME,DEVICE,TYPE",
                    "connection",
                    "show",
                    "--active",
                ],
            )?);
            let wired: Vec<_> = active
                .into_iter()
                .filter(|(_, _, t)| is_wired_nm_type(t))
                .collect();
            wired
                .iter()
                .find(|(_, d, _)| *d == primary.name)
                .or(wired.first())
                .map(|(n, _, _)| n.clone())
        }
        "darwin" => primary
            .connection
            .clone()
            .filter(|s| !is_wireless_mac_service(s)),
        _ => None,
    }
}

fn launch(
    verb: &str,
    windows: impl FnOnce() -> String,
    linux: impl FnOnce(&str) -> String,
    mac: impl FnOnce(&str) -> Option<String>,
) -> Value {
    let started = |r: Result<Value, String>| match r {
        Ok(o) => json!({"ok":true,"elevated":true,"elevationId":o["id"]}),
        Err(e) => json!({"ok":false,"error":e}),
    };
    let failed = |e: String| json!({"ok":false,"error":e});
    match super::updates::platform() {
        "win32" => {
            let mut c = Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &windows_launcher_command(&encoded_command(&windows())),
            ]);
            started(start_elevation(c))
        }
        "linux" => {
            if !tool("nmcli") || !tool("pkexec") {
                return failed(format!(
                    "Automatisch {verb} kan hier niet (NetworkManager of pkexec ontbreekt). {MANUAL_HINT}"
                ));
            }
            let Some(connection) = primary_connection(&read_adapters()) else {
                return failed(no_wired());
            };
            let file = std::env::temp_dir().join(format!(
                "apolloon-net-{}-{}.sh",
                crate::db::now(),
                std::process::id()
            ));
            let written = std::fs::write(
                &file,
                format!("#!/bin/sh\nset -eu\n{}\n", linux(&connection)),
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700));
            }
            if let Err(e) = written {
                return failed(format!("Kon de toestemming niet vragen: {e}"));
            }
            let mut c = Command::new("pkexec");
            c.arg("sh").arg(&file);
            let result = started(start_elevation(c));
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(120));
                let _ = std::fs::remove_file(file);
            });
            result
        }
        "darwin" => {
            if !tool("networksetup") || !tool("osascript") {
                return failed(format!("Automatisch {verb} kan hier niet. {MANUAL_HINT}"));
            }
            let Some(service) = primary_connection(&read_adapters()) else {
                return failed(no_wired());
            };
            let Some(inner) = mac(&service) else {
                return failed("Ongeldig subnetmasker.".into());
            };
            let mut c = Command::new("osascript");
            c.args([
                "-e",
                &format!(
                    "do shell script \"{}\" with administrator privileges",
                    escape_applescript(&inner)
                ),
            ]);
            started(start_elevation(c))
        }
        _ => failed(format!(
            "Automatisch {verb} werkt niet op dit systeem. {MANUAL_HINT}"
        )),
    }
}

pub fn make_static(input: &Value) -> Value {
    let r = match validate_static_request(input) {
        Ok(r) => r,
        Err(e) => return json!({"ok":false,"error":e}),
    };
    launch(
        "vastzetten",
        || windows_set_static_script(&r),
        |c| linux_set_static_script(c, &r),
        |s| prefix_to_mask(r.prefix).map(|m| mac_set_manual(s, &r.ip, &m, r.gateway.as_deref())),
    )
}

pub fn revert_dhcp(input: &Value) -> Value {
    if input["eventOver"] != true {
        return json!({"ok":false,"error":"Bevestig eerst dat het evenement helemaal voorbij is."});
    }
    if input["confirmText"]
        .as_str()
        .map(|t| t.trim().to_uppercase())
        .as_deref()
        != Some(UNDO_PHRASE)
    {
        return json!({"ok":false,"error":format!("Typ eerst {UNDO_PHRASE} om te bevestigen.")});
    }
    launch(
        "terugzetten",
        windows_revert_script,
        linux_revert_script,
        |s| Some(mac_revert(s)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_masks_and_subnets() {
        assert_eq!(parse_ipv4(" 192.168.1.2 "), Some([192, 168, 1, 2]));
        assert!(
            parse_ipv4("256.1.1.1").is_none()
                && parse_ipv4("1.2.3").is_none()
                && parse_ipv4("a.b.c.d").is_none()
        );
        assert!(
            is_apipa("169.254.3.4") && is_private_lan("172.20.0.1") && !is_private_lan("8.8.8.8")
        );
        assert!(
            same_subnet("192.168.1.2", "192.168.1.200", 24)
                && !same_subnet("192.168.1.2", "192.168.2.2", 24)
        );
        assert_eq!(prefix_to_mask(24).as_deref(), Some("255.255.255.0"));
        assert_eq!(prefix_to_mask(31), None);
        assert_eq!(mask_to_prefix("255.255.252.0"), Some(22));
        assert_eq!(mask_to_prefix("255.0.255.0"), None);
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(escape_applescript(r#"a"b\"#), r#"a\"b\\"#);
    }
    #[test]
    fn static_requests_are_validated_like_the_server() {
        let ok = validate_static_request(
            &json!({"ip":"192.168.1.211","prefixLength":24,"gateway":"192.168.1.1"}),
        )
        .unwrap();
        assert_eq!(
            ok,
            StaticRequest {
                ip: "192.168.1.211".into(),
                prefix: 24,
                gateway: Some("192.168.1.1".into())
            }
        );
        assert!(
            validate_static_request(&json!({"ip":"169.254.1.1"}))
                .unwrap_err()
                .contains("noodadres")
        );
        assert!(
            validate_static_request(&json!({"ip":"192.168.1.0"}))
                .unwrap_err()
                .contains("eerste of laatste")
        );
        assert!(
            validate_static_request(&json!({"ip":"192.168.1.5","prefixLength":31}))
                .unwrap_err()
                .contains("subnetmasker")
        );
        assert!(
            validate_static_request(&json!({"ip":"192.168.1.5","gateway":"10.0.0.1"}))
                .unwrap_err()
                .contains("hetzelfde netwerk")
        );
        assert_eq!(
            validate_static_request(&json!({"ip":"10.0.0.5","prefixLength":"16"}))
                .unwrap()
                .prefix,
            16
        );
    }
    #[test]
    fn system_tool_output_is_parsed() {
        assert_eq!(
            parse_nmcli_active("Wired\\: 1:enp3s0:802-3-ethernet\nwifi:wlan0:802-11-wireless\n\n"),
            vec![
                ("Wired: 1".into(), "enp3s0".into(), "802-3-ethernet".into()),
                ("wifi".into(), "wlan0".into(), "802-11-wireless".into())
            ]
        );
        assert_eq!(
            parse_nmcli_fields("IP4.ADDRESS[1]:10.0.0.2/24\nIP4.GATEWAY:10.0.0.1\nIP4.GATEWAY:x")
                [1],
            ("IP4.GATEWAY".into(), "10.0.0.1".into())
        );
        assert_eq!(
            parse_hardware_ports(
                "Hardware Port: Ethernet\nDevice: en0\nEthernet Address: x\n\nHardware Port: Wi-Fi\nDevice: en1\n"
            ),
            vec![
                ("Ethernet".into(), "en0".into()),
                ("Wi-Fi".into(), "en1".into())
            ]
        );
        let info = parse_networksetup_info(
            "Manual Configuration\nIP address: 192.168.1.5\nSubnet mask: 255.255.255.0\nRouter: none\n",
        );
        assert_eq!(
            info,
            (
                Some(true),
                Some("192.168.1.5".into()),
                Some("255.255.255.0".into()),
                None
            )
        );
        assert!(is_wireless_windows_adapter("Wi-Fi 2") && !is_wireless_windows_adapter("Ethernet"));
        assert!(is_wired_nm_type("ethernet") && !is_wired_nm_type("wifi"));
    }
    #[test]
    fn scripts_quote_names_and_open_the_firewall() {
        let r = StaticRequest {
            ip: "192.168.1.211".into(),
            prefix: 24,
            gateway: None,
        };
        let linux = linux_set_static_script("Wired 'x'", &r);
        assert!(linux.starts_with("nmcli con mod 'Wired '\\''x'\\''' ipv4.addresses 192.168.1.211/24 ipv4.dns '' ipv4.method manual"));
        assert!(linux.contains("ufw allow") && linux.contains("/udp"));
        let win = windows_set_static_script(&r);
        assert!(
            win.contains("New-NetFirewallRule -DisplayName 'Apolloon TCP")
                && win.contains("-ResetServerAddresses")
        );
        assert!(windows_launcher_command("QQ==").contains("'-EncodedCommand','QQ=='"));
        assert_eq!(
            mac_set_manual("Ethernet", "10.0.0.2", "255.0.0.0", Some("10.0.0.1")),
            "networksetup -setmanual 'Ethernet' 10.0.0.2 255.0.0.0 10.0.0.1"
        );
        assert!(
            revert_dhcp(&json!({"eventOver":true,"confirmText":"nee"}))["error"]
                .as_str()
                .unwrap()
                .contains("VOORBIJ")
        );
        assert!(describe_elevation_failure("win32", Some(1223), "").contains("geweigerd"));
        assert_eq!(
            describe_elevation_failure("linux", Some(3), ""),
            "De netwerkwijziging is mislukt (code 3). Er is niets veranderd."
        );
    }
}
