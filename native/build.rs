fn main() {
    println!("cargo:rerun-if-env-changed=APOLLOON_APP_VERSION");
    let version = std::env::var("APOLLOON_APP_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").expect("package version"));
    println!("cargo:rustc-env=APOLLOON_VERSION={version}");
    println!("cargo:rustc-env=APOLLOON_PEER_VERSION=native-{version}");
}
