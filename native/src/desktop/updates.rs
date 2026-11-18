//! Port of electron/update-check.ts, update-flow.ts and updates.ts: the newest version on the
//! public release feed, and the steps from finding it to running it. Nothing installs by itself:
//! someone chooses the moment, and never while the race runs.
//!
//! A packaged native build updates itself from the feed's `apolloon-native-<platform>` archive
//! (checked against SHA256SUMS.txt); without one for this platform, the status links to the
//! installer to download by hand, as the Electron app does on macOS.
use serde_json::{Value, json};
use std::cmp::Ordering;

pub const RELEASES_REPO: &str = "SnaetWarre/apolloon-releases";
pub const RELEASES_PAGE: &str = "https://github.com/SnaetWarre/apolloon-releases/releases";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/SnaetWarre/apolloon-releases/releases/latest";
pub const CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;
pub const FIRST_CHECK_DELAY_SECS: u64 = 10;
pub const RACE_RUNNING: &str = "De wedstrijd loopt. Installeer de update pas na de wedstrijd.";
const NOT_CLOSED: &str =
    "Apolloon sloot niet af, dus de installatie is niet afgerond. Start Apolloon opnieuw.";
const DOWNLOAD_FAILED: &str = "Automatisch downloaden lukte niet. Download het installatiebestand zelf, of probeer later opnieuw.";

#[derive(Clone, Debug, PartialEq)]
pub struct AvailableUpdate {
    pub version: String,
    pub page_url: String,
    /// The installer for this operating system, to download by hand.
    pub download_url: Option<String>,
    /// The native package this build can install itself, with SHA256SUMS.txt.
    pub package: Option<(String, String)>,
    pub sums_url: Option<String>,
    pub published_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Idle,
    Checking {
        checked_at: Option<i64>,
    },
    Current {
        checked_at: i64,
    },
    Unreachable {
        checked_at: i64,
    },
    Available {
        checked_at: i64,
        update: AvailableUpdate,
        problem: Option<String>,
    },
    Downloading {
        checked_at: i64,
        update: AvailableUpdate,
        percent: u8,
    },
    Ready {
        checked_at: i64,
        update: AvailableUpdate,
        problem: Option<String>,
    },
    Installing {
        checked_at: i64,
        update: AvailableUpdate,
    },
}

impl Status {
    pub fn name(&self) -> &'static str {
        match self {
            Status::Idle => "idle",
            Status::Checking { .. } => "checking",
            Status::Current { .. } => "current",
            Status::Unreachable { .. } => "unreachable",
            Status::Available { .. } => "available",
            Status::Downloading { .. } => "downloading",
            Status::Ready { .. } => "ready",
            Status::Installing { .. } => "installing",
        }
    }
    fn checked_at(&self) -> Option<i64> {
        match self {
            Status::Idle => None,
            Status::Checking { checked_at } => *checked_at,
            Status::Current { checked_at } | Status::Unreachable { checked_at } => {
                Some(*checked_at)
            }
            Status::Available { checked_at, .. }
            | Status::Downloading { checked_at, .. }
            | Status::Ready { checked_at, .. }
            | Status::Installing { checked_at, .. } => Some(*checked_at),
        }
    }
    pub fn update(&self) -> Option<&AvailableUpdate> {
        match self {
            Status::Available { update, .. }
            | Status::Downloading { update, .. }
            | Status::Ready { update, .. }
            | Status::Installing { update, .. } => Some(update),
            _ => None,
        }
    }
    /// The same JSON shape as Electron's UpdateStatus.
    pub fn to_json(&self) -> Value {
        let mut v = json!({"state":self.name(),"checkedAt":self.checked_at()});
        if let Some(u) = self.update() {
            v["update"] = json!({"version":u.version,"pageUrl":u.page_url,"downloadUrl":u.download_url,"publishedAt":u.published_at});
        }
        match self {
            Status::Available { problem, .. } | Status::Ready { problem, .. } => {
                v["problem"] = json!(problem)
            }
            Status::Downloading { percent, .. } => v["percent"] = json!(percent),
            _ => {}
        }
        v
    }
}

/// Compares `major.minor.patch`; a pre-release such as 4.3.0-beta.1 comes before 4.3.0.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parse(v: &str) -> ([i64; 3], Option<String>) {
        let v = v.trim();
        let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p.split('-').next().unwrap_or("").to_string())),
            None => (v, None),
        };
        let mut parts = [0i64; 3];
        for (i, part) in core.split('.').take(3).enumerate() {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            parts[i] = digits.parse().unwrap_or(0);
        }
        (parts, pre)
    }
    let (l, lp) = parse(a);
    let (r, rp) = parse(b);
    l.cmp(&r).then_with(|| match (lp, rp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
}

fn assets(release: &Value) -> Vec<(String, String)> {
    release["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|asset| {
                    Some((
                        asset["name"].as_str()?.to_string(),
                        asset["browser_download_url"].as_str()?.to_string(),
                    ))
                })
                .filter(|(_, url)| url.starts_with("https://github.com/"))
                .collect()
        })
        .unwrap_or_default()
}

/// The installer electron-builder makes for this platform ("win32", "darwin", "linux").
pub fn pick_installer(assets: &[(String, String)], platform: &str, arch: &str) -> Option<String> {
    let extension = match platform {
        "win32" => ".exe",
        "darwin" => ".dmg",
        _ => ".AppImage",
    };
    let installers: Vec<_> = assets
        .iter()
        .filter(|(name, _)| name.ends_with(extension))
        .collect();
    let names: Vec<&str> = if arch == "x64" {
        vec!["x64", "x86_64", "amd64"]
    } else {
        vec![arch]
    };
    installers
        .iter()
        .find(|(name, _)| names.iter().any(|n| name.contains(n)))
        .or(installers.first())
        .map(|(_, url)| url.clone())
}

/// The native package from .github/workflows/native-packages.yml for this platform.
pub fn pick_native_package(
    assets: &[(String, String)],
    platform: &str,
) -> Option<(String, String)> {
    let name = match platform {
        "win32" => "apolloon-native-windows.zip",
        "darwin" => "apolloon-native-macos.tar.gz",
        _ => "apolloon-native-linux.tar.gz",
    };
    assets.iter().find(|(n, _)| n == name).cloned()
}

/// Reads GitHub's "latest release" answer; None when it is not a usable release.
pub fn read_release(release: &Value, platform: &str, arch: &str) -> Option<AvailableUpdate> {
    let tag = release["tag_name"].as_str()?;
    let bare = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let mut parts = bare.splitn(3, '.');
    let numeric = |p: Option<&str>, whole: bool| {
        p.is_some_and(|p| {
            let digits = p.chars().take_while(|c| c.is_ascii_digit()).count();
            digits > 0 && (!whole || digits == p.len())
        })
    };
    if !(numeric(parts.next(), true) && numeric(parts.next(), true) && numeric(parts.next(), false))
    {
        return None;
    }
    let page_url = release["html_url"]
        .as_str()
        .filter(|u| u.starts_with("https://github.com/"))
        .unwrap_or(RELEASES_PAGE)
        .to_string();
    let published_at = release["published_at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis());
    let all = assets(release);
    Some(AvailableUpdate {
        version: bare.to_string(),
        page_url,
        download_url: pick_installer(&all, platform, arch),
        package: pick_native_package(&all, platform),
        sums_url: all
            .iter()
            .find(|(n, _)| n == "SHA256SUMS.txt")
            .map(|(_, u)| u.clone()),
        published_at,
    })
}

pub fn release_page(version: &str) -> String {
    format!(
        "{RELEASES_PAGE}/tag/v{}",
        version.trim_start_matches(['v', 'V'])
    )
}

/// Only addresses of the releases repository are opened from the update notice.
pub fn is_release_url(url: &str) -> bool {
    url.strip_prefix("https://github.com/")
        .is_some_and(|rest| rest.starts_with(&format!("{RELEASES_REPO}/")))
}

/// The note left before installing: did the app come back as that version?
pub fn install_outcome(note: Option<&str>, current: &str) -> Option<(String, bool)> {
    let v: Value = serde_json::from_str(note?).ok()?;
    let version = v["version"].as_str()?.to_string();
    let ok = compare_versions(current, &version) != Ordering::Less;
    Some((version, ok))
}

/// The sha256 of `file` in a `sha256sum` listing.
pub fn expected_sha256(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file && hash.len() == 64)
            .then(|| hash.to_lowercase())
    })
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// Which state may follow which. Every change of the status goes through this table.
pub fn can_move(from: &str, to: &str) -> bool {
    let next: &[&str] = match from {
        "idle" => &["checking"],
        "checking" => &[
            "checking",
            "current",
            "unreachable",
            "available",
            "downloading",
        ],
        "current" | "unreachable" | "available" => &["checking"],
        "downloading" => &["downloading", "ready", "available"],
        "ready" => &["installing"],
        "installing" => &["ready"],
        _ => &[],
    };
    next.contains(&to)
}

/// One request to the release feed, with the platform's installers picked out.
pub fn check_release(current: &str, now: i64) -> Status {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .and_then(|c| {
            c.get(LATEST_RELEASE_API)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", format!("Apolloon-Telsysteem/{current}"))
                .send()
        });
    let Ok(response) = response.and_then(|r| r.error_for_status()) else {
        return Status::Unreachable { checked_at: now };
    };
    let Some(update) = response
        .json::<Value>()
        .ok()
        .and_then(|v| read_release(&v, platform(), arch()))
    else {
        return Status::Unreachable { checked_at: now };
    };
    if compare_versions(&update.version, current) == Ordering::Greater {
        Status::Available {
            checked_at: now,
            update,
            problem: None,
        }
    } else {
        Status::Current { checked_at: now }
    }
}

/// The update steps without network or files, so tests drive them directly.
pub struct Flow {
    pub status: Status,
    pub in_app: bool,
    needs_restart: bool,
    pub log: Vec<String>,
}

impl Flow {
    pub fn new(in_app: bool) -> Self {
        Flow {
            status: Status::Idle,
            in_app,
            needs_restart: false,
            log: Vec::new(),
        }
    }
    fn set(&mut self, next: Status) -> bool {
        if !can_move(self.status.name(), next.name()) {
            self.log.push(format!(
                "Update status {} cannot become {}; kept {}",
                self.status.name(),
                next.name(),
                self.status.name()
            ));
            return false;
        }
        self.status = next;
        true
    }
    /// Starts a check; false when a download, a waiting update or an install holds the status.
    pub fn begin_check(&mut self) -> bool {
        let checked_at = self.status.checked_at();
        self.set(Status::Checking { checked_at })
    }
    /// The check's result. Returns the update to download when this build installs it itself.
    pub fn finish_check(
        &mut self,
        previous: &Status,
        result: Status,
        now: i64,
    ) -> Option<AvailableUpdate> {
        if let Status::Available { update, .. } = &result {
            if self.in_app && update.package.is_some() && update.sums_url.is_some() {
                let update = update.clone();
                self.log
                    .push(format!("Update available: {}; downloading", update.version));
                self.set(Status::Downloading {
                    checked_at: now,
                    update: update.clone(),
                    percent: 0,
                });
                return Some(update);
            }
        }
        // Offline at the event: keep showing an update found earlier instead of forgetting it.
        let next = if matches!(result, Status::Unreachable { .. })
            && matches!(previous, Status::Available { .. })
        {
            previous.clone()
        } else {
            result
        };
        self.set(next);
        if let Status::Available { update, .. } = &self.status {
            self.log
                .push(format!("Update available: {}", update.version));
        }
        None
    }
    pub fn progress(&mut self, percent: f64) {
        if let Status::Downloading {
            checked_at,
            update,
            percent: was,
        } = &self.status
        {
            let whole = percent.floor().clamp(0.0, 100.0) as u8;
            if whole != *was {
                let next = Status::Downloading {
                    checked_at: *checked_at,
                    update: update.clone(),
                    percent: whole,
                };
                self.set(next);
            }
        }
    }
    pub fn downloaded(&mut self, result: Result<(), String>, now: i64) {
        let Some(update) = self.status.update().cloned() else {
            return;
        };
        match result {
            Ok(()) => {
                self.log.push(format!(
                    "Update {} downloaded and ready to install",
                    update.version
                ));
                self.set(Status::Ready {
                    checked_at: now,
                    update,
                    problem: None,
                });
            }
            Err(error) => {
                self.log.push(format!("Update download failed: {error}"));
                self.set(Status::Available {
                    checked_at: now,
                    update,
                    problem: Some(DOWNLOAD_FAILED.into()),
                });
            }
        }
    }
    /// None when the app is about to restart into the new version, or the reason it did not.
    pub fn install(
        &mut self,
        race_active: &dyn Fn() -> bool,
        backup: impl FnOnce() -> Result<(), String>,
        apply: impl FnOnce(&AvailableUpdate) -> Result<(), String>,
    ) -> Option<String> {
        let Status::Ready {
            checked_at, update, ..
        } = self.status.clone()
        else {
            return Some("Er is geen update klaar om te installeren.".into());
        };
        if self.needs_restart {
            return Some(NOT_CLOSED.into());
        }
        if race_active() {
            return Some(RACE_RUNNING.into());
        }
        self.set(Status::Installing {
            checked_at,
            update: update.clone(),
        });
        let back = |flow: &mut Flow, problem: Option<String>| {
            flow.set(Status::Ready {
                checked_at,
                update: update.clone(),
                problem,
            });
        };
        if let Err(error) = backup() {
            back(self, None);
            return Some(format!(
                "De backup vooraf mislukte, dus de update is niet geïnstalleerd: {error}"
            ));
        }
        // The race may have started during the backup.
        if race_active() {
            back(self, None);
            return Some(RACE_RUNNING.into());
        }
        if let Err(error) = apply(&update) {
            let text = format!("De update is niet geïnstalleerd: {error}");
            back(self, Some(text.clone()));
            return Some(text);
        }
        self.log.push(format!(
            "Installing update {} and restarting",
            update.version
        ));
        None
    }
    /// Someone kept the app open when it closed to install ("Blijven").
    pub fn quit_cancelled(&mut self) {
        if let Status::Installing { checked_at, update } = self.status.clone() {
            self.needs_restart = true;
            self.log
                .push("Closing to install was cancelled; the update did not install".into());
            self.set(Status::Ready {
                checked_at,
                update,
                problem: Some(NOT_CLOSED.into()),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::*;
    #[test]
    fn versions_compare_numerically_with_prereleases_first() {
        assert_eq!(compare_versions("4.10.0", "4.9.9"), Greater);
        assert_eq!(compare_versions("v4.3.0", "4.3.0"), Equal);
        assert_eq!(compare_versions("4.3.0-beta.1", "4.3.0"), Less);
        assert_eq!(compare_versions("4.3.0", "4.3.0-beta.2"), Greater);
        assert_eq!(compare_versions("4.3.0-beta.1", "4.3.0-beta.2"), Less);
        assert_eq!(compare_versions("4.3", "4.3.0"), Equal);
    }
    fn release() -> Value {
        json!({"tag_name":"v4.4.0","html_url":"https://github.com/SnaetWarre/apolloon-releases/releases/tag/v4.4.0","published_at":"2026-11-01T10:00:00Z","assets":[
            {"name":"Apolloon-4.4.0-arm64.AppImage","browser_download_url":"https://github.com/a/arm.AppImage"},
            {"name":"Apolloon-4.4.0-x86_64.AppImage","browser_download_url":"https://github.com/a/x64.AppImage"},
            {"name":"Apolloon Setup 4.4.0.exe","browser_download_url":"https://github.com/a/setup.exe"},
            {"name":"evil.dmg","browser_download_url":"https://evil.example/x.dmg"},
            {"name":"apolloon-native-linux.tar.gz","browser_download_url":"https://github.com/a/linux.tar.gz"},
            {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/a/SHA256SUMS.txt"}]})
    }
    #[test]
    fn release_picks_the_installer_for_this_platform() {
        let linux = read_release(&release(), "linux", "x64").unwrap();
        assert_eq!(linux.version, "4.4.0");
        assert_eq!(
            linux.download_url.as_deref(),
            Some("https://github.com/a/x64.AppImage")
        );
        assert_eq!(
            linux.package.unwrap().1,
            "https://github.com/a/linux.tar.gz"
        );
        assert_eq!(linux.published_at, Some(1_793_527_200_000));
        assert_eq!(
            read_release(&release(), "win32", "x64")
                .unwrap()
                .download_url
                .as_deref(),
            Some("https://github.com/a/setup.exe")
        );
        let mac = read_release(&release(), "darwin", "arm64").unwrap();
        assert_eq!((mac.download_url, mac.package), (None, None));
        assert!(read_release(&json!({"tag_name":"latest"}), "linux", "x64").is_none());
        assert!(read_release(&json!({}), "linux", "x64").is_none());
    }
    #[test]
    fn helpers_match_the_electron_rules() {
        assert!(is_release_url(
            "https://github.com/SnaetWarre/apolloon-releases/releases/tag/v1.0.0"
        ));
        assert!(!is_release_url("https://github.com/other/repo/"));
        assert!(!is_release_url(
            "http://github.com/SnaetWarre/apolloon-releases/x"
        ));
        assert_eq!(
            install_outcome(Some(r#"{"version":"4.4.0"}"#), "4.4.0"),
            Some(("4.4.0".into(), true))
        );
        assert_eq!(
            install_outcome(Some(r#"{"version":"4.4.0"}"#), "4.3.0"),
            Some(("4.4.0".into(), false))
        );
        assert_eq!(install_outcome(Some("x"), "1.0.0"), None);
        let h = "a".repeat(64);
        assert_eq!(
            expected_sha256(
                &format!("{h}  apolloon-native-linux.tar.gz\n"),
                "apolloon-native-linux.tar.gz"
            ),
            Some(h)
        );
        assert_eq!(
            release_page("v1.2.3"),
            format!("{RELEASES_PAGE}/tag/v1.2.3")
        );
    }
    #[test]
    fn flow_downloads_installs_and_refuses_during_the_race() {
        let update = read_release(&release(), "linux", "x64").unwrap();
        let available = Status::Available {
            checked_at: 1,
            update: update.clone(),
            problem: None,
        };
        let mut flow = Flow::new(true);
        assert!(flow.begin_check());
        assert_eq!(
            flow.finish_check(&Status::Idle, available.clone(), 1),
            Some(update.clone())
        );
        assert!(
            !flow.begin_check(),
            "a download is not replaced by a new check"
        );
        flow.progress(42.7);
        assert_eq!(flow.status.to_json()["percent"], 42);
        flow.downloaded(Ok(()), 2);
        assert_eq!(flow.status.name(), "ready");
        assert_eq!(
            flow.install(&|| true, || Ok(()), |_| Ok(())).as_deref(),
            Some(RACE_RUNNING)
        );
        let failed = flow
            .install(&|| false, || Err("schijf vol".into()), |_| Ok(()))
            .unwrap();
        assert!(failed.contains("backup vooraf mislukte"));
        assert_eq!(flow.status.name(), "ready");
        assert_eq!(flow.install(&|| false, || Ok(()), |_| Ok(())), None);
        assert_eq!(flow.status.name(), "installing");
        flow.quit_cancelled();
        assert_eq!(flow.status.to_json()["problem"], NOT_CLOSED);
        assert_eq!(
            flow.install(&|| false, || Ok(()), |_| Ok(())).as_deref(),
            Some(NOT_CLOSED)
        );

        let mut manual = Flow::new(false);
        manual.begin_check();
        assert_eq!(
            manual.finish_check(&Status::Idle, available.clone(), 1),
            None
        );
        assert_eq!(manual.status.name(), "available");
        manual.begin_check();
        manual.finish_check(&available, Status::Unreachable { checked_at: 5 }, 5);
        assert_eq!(
            manual.status, available,
            "offline keeps the update found earlier"
        );
    }
}
