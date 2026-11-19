//! Downloads a native package from the release feed, checks it against SHA256SUMS.txt and
//! swaps it in beside the running binary; the app then relaunches into it.
use super::updates::{AvailableUpdate, expected_sha256};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "apolloon-native.exe"
    } else {
        "apolloon-native"
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Downloads and unpacks into `<cache>/<version>`; returns the unpacked folder.
pub fn download(
    update: &AvailableUpdate,
    cache: &Path,
    progress: &dyn Fn(f64),
) -> Result<PathBuf, String> {
    let (name, url) = update
        .package
        .clone()
        .ok_or("geen pakket voor dit systeem")?;
    let sums_url = update.sums_url.clone().ok_or("SHA256SUMS.txt ontbreekt")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let sums = client
        .get(&sums_url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())?;
    let expected = expected_sha256(&sums, &name)
        .ok_or_else(|| format!("{name} staat niet in SHA256SUMS.txt"))?;
    let mut response = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = response.content_length().unwrap_or(0) as f64;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = response.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if total > 0.0 {
            progress(bytes.len() as f64 * 100.0 / total);
        }
    }
    if sha256_hex(&bytes) != expected {
        return Err("de controlesom klopt niet".into());
    }
    let dir = cache.join(&update.version);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let archive = dir.join(&name);
    std::fs::File::create(&archive)
        .and_then(|mut f| f.write_all(&bytes))
        .map_err(|e| e.to_string())?;
    let unpacked = dir.join("package");
    std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
    // bsdtar (Windows 10+, macOS) reads zip too; GNU tar reads the Linux .tar.gz.
    let status = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&unpacked)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || !unpacked.join(binary_name()).is_file() {
        return Err("het pakket kon niet worden uitgepakt".into());
    }
    Ok(unpacked)
}

fn copy_package_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_package_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        } else {
            return Err(std::io::Error::other("Onverwacht bestand in het updatepakket"));
        }
    }
    Ok(())
}

/// Stage the unpacked package on the installation filesystem, then swap it in place. The
/// download cache can live on a different volume. The old files stay as `.old`.
pub fn apply(unpacked: &Path, install_dir: &Path) -> Result<(), String> {
    if !unpacked.join(binary_name()).is_file() || !unpacked.join("web-dist/index.html").is_file() {
        return Err("Het updatepakket mist het programma of de browserbestanden.".into());
    }
    let staged = install_dir.join(format!(".update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staged).map_err(|error| error.to_string())?;
    let result = std::fs::copy(unpacked.join(binary_name()), staged.join(binary_name()))
        .and_then(|_| copy_package_dir(&unpacked.join("web-dist"), &staged.join("web-dist")))
        .map_err(|error| error.to_string())
        .and_then(|()| swap_package(&staged, install_dir));
    let _ = std::fs::remove_dir_all(staged);
    result
}

fn swap_package(unpacked: &Path, install_dir: &Path) -> Result<(), String> {
    let swap = |name: &str| -> Result<bool, String> {
        let target = install_dir.join(name);
        let old = install_dir.join(format!("{name}.old"));
        let source = unpacked.join(name);
        let had_target = target.exists();
        if old.exists() {
            let remove = if old.is_dir() {
                std::fs::remove_dir_all(&old)
            } else {
                std::fs::remove_file(&old)
            };
            remove.map_err(|e| format!("{name}: {e}"))?;
        }
        if had_target {
            std::fs::rename(&target, &old).map_err(|e| format!("{name}: {e}"))?;
        }
        if let Err(error) = std::fs::rename(&source, &target) {
            if had_target && let Err(rollback) = std::fs::rename(&old, &target) {
                return Err(format!("{name}: {error}. Terugzetten mislukt: {rollback}"));
            }
            return Err(format!("{name}: {error}"));
        }
        Ok(had_target)
    };
    let had_web = swap("web-dist")?;
    if let Err(error) = swap(binary_name()) {
        let rollback = std::fs::rename(install_dir.join("web-dist"), unpacked.join("web-dist"))
            .and_then(|_| {
                if had_web {
                    std::fs::rename(
                        install_dir.join("web-dist.old"),
                        install_dir.join("web-dist"),
                    )
                } else {
                    Ok(())
                }
            });
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}. Browserbestanden terugzetten mislukt: {rollback}"
            )),
        };
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            install_dir.join(binary_name()),
            std::fs::Permissions::from_mode(0o755),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_download_checks_the_archive_and_stages_the_package() {
        use std::io::{BufRead, BufReader};
        let root = std::env::temp_dir().join(format!("apolloon-download-{}", uuid::Uuid::new_v4()));
        let fixture = root.join("fixture");
        std::fs::create_dir_all(fixture.join("web-dist")).unwrap();
        std::fs::write(fixture.join(binary_name()), b"updated program").unwrap();
        std::fs::write(fixture.join("web-dist/index.html"), b"updated browser").unwrap();
        let name = "apolloon-test.tar.gz";
        let archive = root.join(name);
        assert!(Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&fixture)
            .arg(".")
            .status()
            .unwrap()
            .success());
        let bytes = std::fs::read(archive).unwrap();
        let sums = format!("{}  {name}\n", sha256_hex(&bytes));
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let feed = std::thread::spawn(move || {
            for (route, body) in [("/SHA256SUMS.txt", sums.as_bytes()), ("/package", &bytes)] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = BufReader::new(&mut socket);
                let mut line = String::new();
                request.read_line(&mut line).unwrap();
                assert!(line.starts_with(&format!("GET {route} ")));
                loop {
                    line.clear();
                    if request.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(body).unwrap();
            }
        });
        let update = AvailableUpdate {
            version: "7.8.9".into(),
            page_url: origin.clone(),
            download_url: None,
            package: Some((name.into(), format!("{origin}/package"))),
            sums_url: Some(format!("{origin}/SHA256SUMS.txt")),
            published_at: None,
        };
        let downloaded = download(&update, &root.join("cache"), &|_| {}).unwrap();
        feed.join().unwrap();
        let app = root.join("app");
        std::fs::create_dir(&app).unwrap();
        apply(&downloaded, &app).unwrap();
        assert_eq!(std::fs::read(app.join(binary_name())).unwrap(), b"updated program");
        assert_eq!(std::fs::read(app.join("web-dist/index.html")).unwrap(), b"updated browser");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_swaps_binary_and_web_dist_and_keeps_the_old_ones() {
        let run = uuid::Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("apolloon-apply-{run}"));
        let cache = std::env::var_os("APOLLOON_TEST_UPDATE_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let install = root.join("app");
        let unpacked = cache.join(format!("apolloon-unpacked-{run}"));
        std::fs::create_dir_all(install.join("web-dist")).unwrap();
        std::fs::create_dir_all(unpacked.join("web-dist")).unwrap();
        std::fs::write(install.join(binary_name()), "old").unwrap();
        std::fs::write(unpacked.join(binary_name()), "new").unwrap();
        std::fs::write(unpacked.join("web-dist/index.html"), "new").unwrap();
        let staged = unpacked.join("web-dist/index.html");
        std::fs::write(install.join("web-dist/index.html"), "old web").unwrap();
        std::fs::remove_file(&staged).unwrap();
        assert!(apply(&unpacked, &install).is_err());
        assert_eq!(
            std::fs::read_to_string(install.join(binary_name())).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(install.join("web-dist/index.html")).unwrap(),
            "old web"
        );
        std::fs::write(staged, "new").unwrap();
        apply(&unpacked, &install).unwrap();
        assert_eq!(
            std::fs::read_to_string(install.join(binary_name())).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(install.join(format!("{}.old", binary_name()))).unwrap(),
            "old"
        );
        assert!(install.join("web-dist/index.html").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(unpacked).unwrap();
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
