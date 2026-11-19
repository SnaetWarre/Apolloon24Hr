//! Port of electron/server-config.ts: the `.env` file in the data folder and the server address,
//! and how to find the packaged web client.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerAddress {
    pub port: u16,
    pub public_port: u16,
    pub url: String,
}

pub fn parse_env_text(content: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(separator) = line.find('=').filter(|i| *i > 0) else {
            continue;
        };
        let key = line[..separator].trim();
        let mut value = line[separator + 1..].trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        if !key.is_empty() {
            values.insert(key.to_string(), value.to_string());
        }
    }
    values
}

fn read_port(value: Option<&String>, fallback: u16) -> u16 {
    value
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|p| *p > 0 && *p < 65536)
        .map(|p| p as u16)
        .unwrap_or(fallback)
}

pub fn resolve_server_address(env: &BTreeMap<String, String>) -> ServerAddress {
    let port = read_port(env.get("PORT"), 5173);
    let public_port = read_port(env.get("PUBLIC_APP_PORT"), port);
    ServerAddress {
        port,
        public_port,
        url: format!("http://127.0.0.1:{port}"),
    }
}

/// The default `.env`, written once (ensureEnvFile).
pub fn ensure_env_file(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join(".env");
    if !path.exists() {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&path, "PORT=5173\n")?;
    }
    Ok(path)
}

fn macos_bundle_resources(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.ends_with("MacOS")
        && contents.ends_with("Contents")
        && contents.parent()?.extension()? == "app"
    {
        return Some(contents.join("Resources"));
    }
    None
}

fn packaged_web_dir(exe: &Path) -> Option<PathBuf> {
    let parent = macos_bundle_resources(exe).or_else(|| exe.parent().map(Path::to_path_buf))?;
    let web = parent.join("web-dist");
    web.is_dir().then_some(web)
}

/// APOLLOON_WEB_DIR, else the packaged web client, else the dev path.
pub fn web_dir(env: Option<String>, exe: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = env.filter(|d| !d.trim().is_empty()) {
        return PathBuf::from(dir);
    }
    exe.as_deref()
        .and_then(packaged_web_dir)
        .unwrap_or_else(|| PathBuf::from("native/web-dist"))
}

pub fn current_web_dir() -> PathBuf {
    web_dir(
        std::env::var("APOLLOON_WEB_DIR").ok(),
        std::env::current_exe().ok(),
    )
}

pub fn packaged() -> bool {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(packaged_web_dir)
        .is_some()
}

/// A signed app must be replaced as a bundle to keep its signature valid.
#[cfg(feature = "desktop")]
pub fn can_update_in_place() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        macos_bundle_resources(&exe).is_none() && packaged_web_dir(&exe).is_some()
    })
}

/// Electron's userData: the app's own folder in the platform's settings location.
pub fn user_data_dir() -> PathBuf {
    const NAME: &str = "Apolloon Telsysteem";
    let home = || {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default()
    };
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData/Roaming"))
            .join(NAME)
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support").join(NAME)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"))
            .join(NAME)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_text_skips_comments_and_strips_quotes() {
        let env = parse_env_text("# x\nPORT = \"6000\"\n=bad\nNAME='a b'\nEMPTY=\nnoequals\n");
        assert_eq!(env["PORT"], "6000");
        assert_eq!(env["NAME"], "a b");
        assert_eq!(env["EMPTY"], "");
        assert_eq!(env.len(), 3);
    }
    #[test]
    fn server_address_falls_back_on_bad_ports() {
        let mut env = BTreeMap::new();
        assert_eq!(
            resolve_server_address(&env),
            ServerAddress {
                port: 5173,
                public_port: 5173,
                url: "http://127.0.0.1:5173".into()
            }
        );
        env.insert("PORT".into(), "8080".into());
        env.insert("PUBLIC_APP_PORT".into(), "70000".into());
        let address = resolve_server_address(&env);
        assert_eq!((address.port, address.public_port), (8080, 8080));
        env.insert("PUBLIC_APP_PORT".into(), "80".into());
        assert_eq!(resolve_server_address(&env).public_port, 80);
    }
    #[test]
    fn web_dir_prefers_env_then_beside_the_binary_then_dev() {
        let root = std::env::temp_dir().join(format!("apolloon-webdir-{}", std::process::id()));
        let exe = root.join("apolloon-native");
        assert_eq!(
            web_dir(Some("/x".into()), Some(exe.clone())),
            PathBuf::from("/x")
        );
        assert_eq!(
            web_dir(None, Some(exe.clone())),
            PathBuf::from("native/web-dist")
        );
        std::fs::create_dir_all(root.join("web-dist")).unwrap();
        assert_eq!(web_dir(Some(" ".into()), Some(exe)), root.join("web-dist"));
        let contents = root.join("Apolloon Telsysteem.app/Contents");
        let resources = contents.join("Resources/web-dist");
        std::fs::create_dir_all(&resources).unwrap();
        let bundle_exe = contents.join("MacOS/apolloon-native");
        assert_eq!(web_dir(None, Some(bundle_exe)), resources);
        std::fs::remove_dir_all(root).unwrap();
    }
}
