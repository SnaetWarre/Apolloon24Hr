//! The group key: what the laptops of one group sign their requests and announcements to each
//! other with. Every laptop makes one by itself; a laptop that joins a group gets that group's
//! key in the answer to its join, so linking sets it up and nobody types or copies anything.
use super::{Node, log};
use crate::db::{Db, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) const SETTING: &str = "cluster_group_keys_json";
pub(crate) const HEADER: &str = "x-apolloon-group";
/// Keys of groups this laptop was in before stay valid, so the laptops it left behind can still
/// be told to follow, and a laptop that went on alone is still known when it comes back.
const KEPT: usize = 4;

pub(crate) fn stored(db: &Db) -> Vec<String> {
    serde_json::from_value(log::json_setting(db, SETTING)).unwrap_or_default()
}

/// The keys at startup. A group linked by a version without keys gets the same first key on
/// every laptop, from what they all hold, so it keeps working after the update.
pub(super) fn ensure(db: &Db, host_id: &str, cluster_id: &str) -> Result<Vec<String>> {
    let mut keys = stored(db);
    if keys.is_empty() {
        let linked = log::stored_members(db)
            .iter()
            .any(|m| m.host_id != host_id);
        keys.push(if linked {
            hex(&Sha256::digest(format!("apolloon-group-key\n{cluster_id}")))
        } else {
            format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
        });
        log::set_local(db, SETTING, &json!(keys).to_string())?;
    }
    Ok(keys)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA256.
fn hmac(key: &[u8], message: &[u8]) -> String {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    hex(&outer.finalize())
}

/// Signs the parts, one per line.
pub(crate) fn sign(key: &str, parts: &[&[u8]]) -> String {
    hmac(key.as_bytes(), &parts.join(&b"\n"[..]))
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// What an announcement is signed over: who it is and where it says it is.
pub(crate) fn beacon_proof(key: &str, host_id: &str, url: &str) -> String {
    sign(key, &[b"beacon", host_id.as_bytes(), url.as_bytes()])
}

impl Node {
    pub(crate) fn group_keys(&self) -> Vec<String> {
        self.keys.lock().unwrap().clone()
    }

    /// The key of the group this laptop joins; requests are signed with it from now on.
    pub(super) fn adopt_group_key(&self, key: &str) {
        if key.is_empty() || key.len() > 256 {
            return;
        }
        let mut keys = self.keys.lock().unwrap();
        if keys.first().is_some_and(|k| k == key) {
            return;
        }
        keys.retain(|k| k != key);
        keys.insert(0, key.to_owned());
        keys.truncate(KEPT);
        let _ = log::set_local(
            &self.db.lock().unwrap(),
            SETTING,
            &json!(*keys).to_string(),
        );
    }

    /// One signature per key this laptop holds, for the `x-apolloon-group` header.
    pub(crate) fn signatures(&self, method: &str, path: &str, body: &[u8]) -> String {
        self.group_keys()
            .iter()
            .map(|key| sign(key, &[method.as_bytes(), path.as_bytes(), body]))
            .collect::<Vec<_>>()
            .join(",")
    }

    /// Whether a request was signed by a laptop that holds one of this laptop's keys.
    pub(crate) fn signed(&self, method: &str, path: &str, body: &[u8], header: &str) -> bool {
        self.group_keys().iter().any(|key| {
            let expected = sign(key, &[method.as_bytes(), path.as_bytes(), body]);
            header.split(',').any(|given| same(given.trim(), &expected))
        })
    }

    /// Whether an announcement comes from a laptop that holds one of this laptop's keys. Only
    /// those may say where a laptop of this group is now.
    pub(crate) fn proves(&self, beacon: &Value) -> bool {
        let (Some(host_id), Some(url), Some(proof)) = (
            beacon["hostId"].as_str(),
            beacon["url"].as_str(),
            beacon["proof"].as_str(),
        ) else {
            return false;
        };
        self.group_keys()
            .iter()
            .any(|key| same(proof, &beacon_proof(key, host_id, url)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_hmac_sha256() {
        // RFC 4231, test case 2.
        assert_eq!(
            hmac(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert!(same(&sign("k", &[b"a", b"b"]), &sign("k", &[b"a", b"b"])));
        assert!(!same(&sign("k", &[b"a", b"b"]), &sign("k", &[b"ab"])));
    }

    #[test]
    fn a_group_linked_before_keys_existed_gets_one_key_on_every_laptop() {
        let laptop = |host: &str| {
            let db = Db::open(std::path::Path::new(":memory:")).unwrap();
            for member in ["a", "b"] {
                log::save_member(
                    &db,
                    &log::Member {
                        host_id: member.into(),
                        url: format!("http://{member}"),
                        name: None,
                    },
                )
                .unwrap();
            }
            ensure(&db, host, "group").unwrap()
        };
        assert_eq!(laptop("a"), laptop("b"));
        // A laptop on its own makes a key nobody else has, and keeps it.
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let own = ensure(&db, "a", "group").unwrap();
        assert_ne!(own, laptop("a"));
        assert_eq!(ensure(&db, "a", "group").unwrap(), own);
    }
}
