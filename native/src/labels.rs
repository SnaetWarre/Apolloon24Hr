//! Labels and deduplicated logos keep the schema and membership rules of the Electron app.
use crate::db::{Db, Result, id, now, required};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub fn canonical(name: &str) -> &str {
    match name.trim().to_lowercase().as_str() {
        "1ste jaars" | "1e jaar" | "1e jaars" | "eerste jaar" | "eerste jaars" => "1ste jaar",
        _ => name.trim(),
    }
}
impl Db {
    pub fn label(&self, id: &str) -> Result<Value> {
        self.labels(None)?
            .into_iter()
            .find(|l| l["id"] == id)
            .ok_or("Label niet gevonden".into())
    }
    pub fn label_mutation(&self, method: &str, input: &Value) -> Result<Value> {
        match method {
            "labels.uploadFile" => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(required(input, "dataBase64")?)
                    .map_err(|_| "Geen leesbare afbeelding")?;
                if bytes.len() > 25 * 1024 * 1024 {
                    return Err("Het bestand is te groot (maximaal 25 MB).".into());
                }
                let png = crate::logo::prepare(&bytes)?;
                self.label_mutation("labels.uploadImage",&json!({"mime":"image/png","dataBase64":base64::engine::general_purpose::STANDARD.encode(png)}))
            }
            "labels.uploadImage" => {
                let mime = required(input, "mime")?;
                let encoded = required(input, "dataBase64")?;
                if !["image/png", "image/webp"].contains(&mime)
                    || encoded.is_empty()
                    || encoded.len() > 1_000_000
                {
                    return Err("Ongeldig logo: gebruik PNG of WebP tot 750 kB.".into());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| "Ongeldig logo")?;
                let mut hash = Sha256::new();
                hash.update(mime.as_bytes());
                hash.update(&bytes);
                let id = format!("{:x}", hash.finalize())[..32].to_string();
                self.exec("INSERT OR IGNORE INTO label_images(id,mime,data_base64,created_at) VALUES(?,?,?,?)",&[json!(id),json!(mime),json!(base64::engine::general_purpose::STANDARD.encode(bytes)),json!(now())])?;
                Ok(json!({"imageUrl":format!("/api/label-images/{id}")}))
            }
            "labels.create" | "labels.update" => {
                let updating = method == "labels.update";
                let mut label = if updating {
                    self.label(required(input, "id")?)?
                } else {
                    json!({"id":id(),"color":"#3b82f6","kind":"custom","imageUrl":null,"targetLaps":null,"sortOrder":null,"createdAt":now()})
                };
                let fields = if updating { &input["fields"] } else { input };
                for k in [
                    "name",
                    "color",
                    "icon",
                    "kind",
                    "imageUrl",
                    "targetLaps",
                    "sortOrder",
                ] {
                    if let Some(v) = fields.get(k) {
                        if ["targetLaps", "sortOrder"].contains(&k) {
                            if !v.is_null() && v.as_u64().is_none() {
                                return Err("Een positief geheel getal is vereist".into());
                            }
                        } else if !(k == "imageUrl" && v.is_null()) && !v.is_string() {
                            return Err(format!("Ongeldig labelveld: {k}"));
                        }
                        let value = v.as_str().map(|s| json!(s.trim())).unwrap_or(v.clone());
                        if updating && ["name", "color", "icon", "kind"].contains(&k) && value == ""
                        {
                            continue;
                        }
                        label[k] = value;
                    }
                }
                let name = label["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Een label heeft een naam nodig")?;
                if self
                    .rows(
                        "SELECT id FROM labels WHERE name=? COLLATE NOCASE AND id<>?",
                        &[json!(canonical(name)), label["id"].clone()],
                    )?
                    .len()
                    > 0
                {
                    return Err("Er bestaat al een label met deze naam".into());
                }
                if !updating && label["icon"].as_str().is_none_or(|s| s.is_empty()) {
                    label["icon"] = json!(name.chars().take(2).collect::<String>().to_uppercase());
                }
                if label["color"] == "" {
                    label["color"] = json!("#3b82f6");
                }
                if label["kind"] == "" {
                    label["kind"] = json!("custom");
                }
                label["updatedAt"] = json!(now());
                if updating {
                    self.exec("UPDATE labels SET name=?,color=?,icon=?,kind=?,image_url=?,target_laps=?,sort_order=?,updated_at=? WHERE id=?",&[label["name"].clone(),label["color"].clone(),label["icon"].clone(),label["kind"].clone(),label["imageUrl"].clone(),label["targetLaps"].clone(),label["sortOrder"].clone(),label["updatedAt"].clone(),label["id"].clone()])?;
                } else {
                    self.exec("INSERT INTO labels(id,name,color,icon,kind,image_url,target_laps,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",&[label["id"].clone(),label["name"].clone(),label["color"].clone(),label["icon"].clone(),label["kind"].clone(),label["imageUrl"].clone(),label["targetLaps"].clone(),label["sortOrder"].clone(),label["createdAt"].clone(),label["updatedAt"].clone()])?;
                }
                Ok(label)
            }
            "labels.delete" => {
                let id = required(input, "id")?;
                self.label(id)?;
                self.exec("DELETE FROM runner_labels WHERE label_id=?", &[json!(id)])?;
                self.exec("DELETE FROM labels WHERE id=?", &[json!(id)])?;
                Ok(json!({"ok":true}))
            }
            "labels.addRunner" | "labels.removeRunner" => {
                let runner = required(input, "runnerId")?;
                let id = required(input, "labelId")?;
                if method == "labels.addRunner" {
                    let label = self.label(id)?;
                    self.runner(runner)?;
                    if label["kind"] == "speedteam" {
                        self.exec("DELETE FROM runner_labels WHERE runner_id=? AND label_id IN (SELECT id FROM labels WHERE kind='speedteam' AND id<>?)",&[json!(runner),json!(id)])?;
                    }
                    self.exec(
                        "INSERT OR IGNORE INTO runner_labels(runner_id,label_id) VALUES(?,?)",
                        &[json!(runner), json!(id)],
                    )?;
                } else {
                    self.exec(
                        "DELETE FROM runner_labels WHERE runner_id=? AND label_id=?",
                        &[json!(runner), json!(id)],
                    )?;
                }
                Ok(json!({"ok":true}))
            }
            _ => Err("Onbekende labelactie".into()),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_reject_duplicate_names_and_switch_speedteam() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let label = db
            .mutation("labels.create", &json!({"name":"Team","kind":"speedteam"}))
            .unwrap();
        assert_eq!(label["icon"], "TE");
        assert_eq!(label["kind"], "speedteam");
        assert!(
            db.mutation("labels.create", &json!({"name":"team"}))
                .is_err()
        );
        let r = db
            .mutation(
                "runners.create",
                &json!({"name":"A","labels":["Speedteam White","Dames"]}),
            )
            .unwrap();
        db.mutation(
            "labels.addRunner",
            &json!({"labelId":label["id"],"runnerId":r["id"]}),
        )
        .unwrap();
        let r = db.runner(r["id"].as_str().unwrap()).unwrap();
        assert_eq!(r["labels"].as_array().unwrap().len(), 2);
        assert!(
            !r["labels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l["name"] == "Speedteam White")
        );
        assert!(
            db.mutation(
                "labels.update",
                &json!({"id":label["id"],"fields":{"name":"Dames"}})
            )
            .is_err()
        );
        assert_eq!(
            db.label(label["id"].as_str().unwrap()).unwrap()["name"],
            "Team"
        );
    }
    #[test]
    fn logo_upload_is_content_addressed_and_retained_after_label_deletion() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let image = json!({"mime":"image/png","dataBase64":"aGVsbG8="});
        let a = db.mutation("labels.uploadImage", &image).unwrap();
        let b = db.mutation("labels.uploadImage", &image).unwrap();
        assert_eq!(a, b);
        assert_eq!(db.rows("SELECT * FROM label_images", &[]).unwrap().len(), 1);
        assert!(
            db.mutation(
                "labels.uploadImage",
                &json!({"mime":"text/html","dataBase64":"aGVsbG8="})
            )
            .is_err()
        );
    }
}
