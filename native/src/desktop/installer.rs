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

/// Moves the unpacked binary and web-dist in place of the running ones (the old ones stay as
/// `.old` until the next update). A running binary may be renamed on every platform.
pub fn apply(unpacked: &Path, install_dir: &Path) -> Result<(), String> {
    let swap = |name: &str| -> Result<(), String> {
        let target = install_dir.join(name);
        let old = install_dir.join(format!("{name}.old"));
        let source = unpacked.join(name);
        if !source.exists() {
            return Ok(());
        }
        let _ = if old.is_dir() {
            std::fs::remove_dir_all(&old)
        } else {
            std::fs::remove_file(&old)
        };
        if target.exists() {
            std::fs::rename(&target, &old).map_err(|e| format!("{name}: {e}"))?;
        }
        if let Err(error) = std::fs::rename(&source, &target) {
            let _ = std::fs::rename(&old, &target);
            return Err(format!("{name}: {error}"));
        }
        Ok(())
    };
    swap("web-dist")?;
    swap(binary_name())?;
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
    fn apply_swaps_binary_and_web_dist_and_keeps_the_old_ones() {
        let root = std::env::temp_dir().join(format!("apolloon-apply-{}", std::process::id()));
        let (install, unpacked) = (root.join("app"), root.join("new"));
        std::fs::create_dir_all(install.join("web-dist")).unwrap();
        std::fs::create_dir_all(unpacked.join("web-dist")).unwrap();
        std::fs::write(install.join(binary_name()), "old").unwrap();
        std::fs::write(unpacked.join(binary_name()), "new").unwrap();
        std::fs::write(unpacked.join("web-dist/index.html"), "new").unwrap();
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
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
