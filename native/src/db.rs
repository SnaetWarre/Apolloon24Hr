//! Schema-17 storage. Every operator action and its undo snapshot share one durable transaction.
use rusqlite::{
    Connection, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
        + crate::cluster::clock::offset()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
        Value::Number(v) => v
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(v.as_f64().unwrap_or_default())),
        Value::String(v) => SqlValue::Text(v.clone()),
        _ => SqlValue::Text(v.to_string()),
    }
}
pub struct Db {
    pub conn: Connection,
    pub revision: i64,
    changes: tokio::sync::watch::Sender<u64>,
    epoch: String,
    /// Set by the linked-laptop runtime: every statement `exec` runs is recorded for replication.
    pub capture: std::cell::RefCell<Option<crate::cluster::log::Capture>>,
}
macro_rules! runner_select {
    () => { "SELECT r.id,r.runner_number AS runnerNumber,r.name,r.target_laps AS targetLaps,r.historical_avg_ms AS historicalAvgMs,r.historical_best_ms AS historicalBestMs,r.registration_source AS registrationSource,COALESCE(r.notes,'') AS notes,json_extract(r.registration_json,'$.estimatedPace') AS estimatedPace,r.created_at AS createdAt,r.updated_at AS updatedAt,r.status,r.status_since AS statusSince,r.queue_index AS queueIndex,r.hidden_at AS queueHiddenAt,COUNT(l.id) AS lapCount,MIN(CASE WHEN l.duration_ms BETWEEN 20000 AND 600000 THEN l.duration_ms END) AS bestLapMs,MAX(CASE WHEN l.duration_ms BETWEEN 20000 AND 600000 THEN l.duration_ms END) AS slowestLapMs,ROUND(AVG(CASE WHEN l.duration_ms BETWEEN 20000 AND 600000 THEN l.duration_ms END)) AS averageLapMs,COALESCE(SUM(l.duration_ms),0) AS totalTimeMs,(SELECT duration_ms FROM laps WHERE runner_id=r.id ORDER BY finished_at DESC LIMIT 1) AS lastLapMs FROM runners r LEFT JOIN laps l ON l.runner_id=r.id" };
}
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let conn = Connection::open(path).map_err(err)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(err)?;
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        if tables > 0 && version != 17 {
            return Err(format!(
                "Schema {version} wordt niet ondersteund; open eerst met Apolloon 5.3.1."
            ));
        }
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;").map_err(err)?;
        conn.execute_batch(include_str!("schema.sql"))
            .map_err(err)?;
        conn.execute_batch(
            "INSERT OR IGNORE INTO race_state(id) VALUES(1); PRAGMA user_version=17;",
        )
        .map_err(err)?;
        let db = Self::from_connection(conn, now())?;
        if tables == 0 {
            db.exec(
                "INSERT INTO settings(key,value) VALUES('schema_version','17')",
                &[],
            )?;
            let labels: Vec<Value> =
                serde_json::from_str(include_str!("default-labels.json")).map_err(err)?;
            for label in labels {
                db.exec("INSERT OR IGNORE INTO labels(id,name,color,icon,kind,image_url,target_laps,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1700000000000,1700000000000)",&[label["id"].clone(),label["name"].clone(),label["color"].clone(),label["icon"].clone(),label["kind"].clone(),label["imageUrl"].clone(),label["targetLaps"].clone(),label["sortOrder"].clone()])?;
            }
        }
        if db.rows("PRAGMA quick_check", &[])?[0]["quick_check"] != "ok" {
            return Err("Databasecontrole mislukt".into());
        }
        Ok(db)
    }
    pub(crate) fn from_connection(conn: Connection, revision: i64) -> Result<Self> {
        let (changes, _) = tokio::sync::watch::channel(0u64);
        let committed = changes.clone();
        conn.commit_hook(Some(move || {
            committed.send_modify(|version| *version = version.wrapping_add(1));
            crate::latency::notify();
            false
        })).map_err(err)?;
        let rolled_back = changes.clone();
        conn.rollback_hook(Some(move || {
            rolled_back.send_modify(|version| *version = version.wrapping_add(1));
        })).map_err(err)?;
        Ok(Self { conn, revision, changes, epoch: id(), capture: Default::default() })
    }
    pub fn change_token(&self) -> String {
        format!("{}.{}.{}", self.epoch, self.revision, self.conn.total_changes())
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }
    pub(crate) fn read_snapshot(&self) -> Result<Self> {
        let mode: String = self.conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).map_err(err)?;
        let conn = if mode.eq_ignore_ascii_case("wal") {
            let conn = Connection::open_with_flags(
                self.conn.path().ok_or("Databasepad ontbreekt")?,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ).map_err(err)?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
            conn.execute_batch("BEGIN").map_err(err)?;
            conn.query_row("SELECT id FROM race_state LIMIT 1", [], |_| Ok(())).map_err(err)?;
            conn
        } else {
            let mut conn = Connection::open_in_memory().map_err(err)?;
            rusqlite::backup::Backup::new(&self.conn, &mut conn).map_err(err)?
                .run_to_completion(128, std::time::Duration::from_millis(1), None).map_err(err)?;
            conn
        };
        conn.execute_batch("PRAGMA query_only=ON").map_err(err)?;
        Self::from_connection(conn, self.revision)
    }
    pub fn rows(&self, sql: &str, args: &[Value]) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let values: Vec<_> = args.iter().map(sql_value).collect();
        let mut rows = stmt.query(params_from_iter(values.iter())).map_err(err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(err)? {
            let mut object = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match row.get_ref(i).map_err(err)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    ValueRef::Blob(_) => return Err("Onverwachte binaire kolom".into()),
                };
                object.insert(name.clone(), v);
            }
            out.push(Value::Object(object));
        }
        Ok(out)
    }
    pub fn one(&self, sql: &str, args: &[Value]) -> Result<Value> {
        self.rows(sql, args)?
            .into_iter()
            .next()
            .ok_or_else(|| "Niet gevonden".into())
    }
    pub fn exec(&self, sql: &str, args: &[Value]) -> Result<usize> {
        let values: Vec<_> = args.iter().map(sql_value).collect();
        let changed = self
            .conn
            .execute(sql, params_from_iter(values.iter()))
            .map_err(err)?;
        if let Some(capture) = self.capture.borrow_mut().as_mut() {
            capture.record(sql, args);
        }
        Ok(changed)
    }
    pub fn labels(&self, runner: Option<&str>) -> Result<Vec<Value>> {
        let select = "SELECT l.id,l.name,l.color,l.icon,l.kind,l.image_url AS imageUrl,l.target_laps AS targetLaps,l.sort_order AS sortOrder,l.created_at AS createdAt,l.updated_at AS updatedAt FROM labels l";
        match runner { Some(id) => self.rows(&format!("{select} JOIN runner_labels rl ON rl.label_id=l.id WHERE rl.runner_id=? ORDER BY CASE l.kind WHEN 'speedteam' THEN 0 WHEN 'zustervereniging' THEN 1 WHEN 'association' THEN 1 WHEN 'andere' THEN 2 WHEN 'group' THEN 2 ELSE 3 END,l.name COLLATE NOCASE"), &[json!(id)]), None => self.rows(&format!("{select} ORDER BY CASE l.kind WHEN 'speedteam' THEN 0 WHEN 'zustervereniging' THEN 1 WHEN 'association' THEN 1 WHEN 'andere' THEN 2 WHEN 'group' THEN 2 ELSE 3 END,l.name COLLATE NOCASE"), &[]) }
    }
    pub fn race(&self) -> Result<Value> {
        let mut v = self.one("SELECT id,active_runner_id AS activeRunnerId,active_started_at AS activeStartedAt,race_started_at AS raceStartedAt,race_finished_at AS raceFinishedAt,active_labels_json AS activeLabels FROM race_state WHERE id=1", &[])?;
        v["activeLabels"] = parse_labels(&v["activeLabels"]);
        Ok(v)
    }
    pub fn runners(&self) -> Result<Vec<Value>> {
        let mut runners = self.rows(concat!(runner_select!(), " GROUP BY r.id ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'warming_up' THEN 2 WHEN 'ran' THEN 3 ELSE 4 END,r.queue_index,r.name"), &[])?;
        let mut labels = std::collections::HashMap::<String, Vec<Value>>::new();
        for mut label in self.rows(
            "SELECT rl.runner_id AS runnerId, l.id,l.name,l.color,l.icon,l.kind,l.image_url AS imageUrl,l.target_laps AS targetLaps,l.sort_order AS sortOrder,l.created_at AS createdAt,l.updated_at AS updatedAt
             FROM runner_labels rl JOIN labels l ON l.id=rl.label_id
             ORDER BY CASE l.kind WHEN 'speedteam' THEN 0 WHEN 'zustervereniging' THEN 1 WHEN 'association' THEN 1 WHEN 'andere' THEN 2 WHEN 'group' THEN 2 ELSE 3 END,l.name COLLATE NOCASE",
            &[],
        )? {
            let id = label.as_object_mut().unwrap().remove("runnerId").unwrap();
            if let Value::String(id) = id {
                labels.entry(id).or_default().push(label);
            }
        }
        for runner in &mut runners {
            let id = runner["id"].as_str().unwrap_or_default();
            runner["labels"] = json!(labels.remove(id).unwrap_or_default());
            runner["hiddenFromQueue"] = json!(!runner["queueHiddenAt"].is_null());
        }
        Ok(runners)
    }
    pub fn runner(&self, id: &str) -> Result<Value> {
        let mut runner = self
            .one(
                concat!(runner_select!(), " WHERE r.id=? GROUP BY r.id"),
                &[json!(id)],
            )
            .map_err(|error| {
                if error == "Niet gevonden" {
                    "Loper niet gevonden".into()
                } else {
                    error
                }
            })?;
        runner["labels"] = json!(self.labels(Some(id))?);
        runner["hiddenFromQueue"] = json!(!runner["queueHiddenAt"].is_null());
        Ok(runner)
    }
    pub(crate) fn race_snapshot(&self) -> Result<Value> {
        let undo = self.rows("SELECT json_extract(payload_json,'$.kind') AS kind FROM handoff_history WHERE undone=0 ORDER BY created_at DESC,rowid DESC LIMIT 1", &[])?.first().map(|v| v["kind"].clone()).unwrap_or(Value::Null);
        Ok(
            json!({"runners":self.runners()?,"labels":self.labels(None)?,"race":self.race()?,"nextUndo":undo,"revision":self.revision,"settings":self.settings()?}),
        )
    }
    pub fn snapshot(&self, port: u16) -> Result<Value> {
        let mut state = self.race_snapshot()?;
        state["host"] = crate::host::info(port);
        Ok(state)
    }
    pub fn mutation(&mut self, method: &str, input: &Value) -> Result<Value> {
        self.mutation_from(
            method,
            input,
            &format!(
                "Vanzelf · laptop {} ({})",
                crate::host::name(),
                crate::host::address()
            ),
        )
    }
    pub fn mutation_from(&mut self, method: &str, input: &Value, origin: &str) -> Result<Value> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(err)?;
        // Existing group databases require the replicated runtime, never silently operate solo.
        let replicated = self.capture.borrow().is_some();
        if !replicated
            && !self
                .rows("SELECT 1 FROM cluster_members LIMIT 1", &[])?
                .is_empty()
        {
            return Err("Gekoppelde database: de Rust replicatie moet actief zijn voordat wijzigingen zijn toegestaan.".into());
        }
        let audit = crate::activity::Prepared::new(self, method, input);
        let result = self.apply(method, input)?;
        if let Some(summary) = audit.summary(self, &result) {
            self.exec(
                "INSERT INTO activity_log(id,occurred_at,action,summary,origin) VALUES(?,?,?,?,?)",
                &[
                    json!(id()),
                    json!(now()),
                    json!(method),
                    json!(summary),
                    json!(origin),
                ],
            )?;
        }
        if replicated {
            crate::cluster::log::seal(self, method, &result)?;
        }
        let _trace = if crate::latency::enabled() && method == "race.handoff" {
            result["lapId"].as_str().map(|lap| crate::latency::commit_context(vec![(crate::latency::handoff_id(input), lap.to_owned())]))
        } else { None };
        transaction.commit().map_err(err)?;
        if method == "race.handoff" { crate::latency::handoff("local_commit", input, result["lapId"].as_str()); }
        self.revision += 1;
        Ok(result)
    }
    fn apply(&self, method: &str, input: &Value) -> Result<Value> {
        match method {
            "backups.applyRestore" => self.restore_event_data(input),
            "race.clear" => self.clear_race(input),
            "runners.merge" => self.merge_registrations(input),
            "runners.create" => self.create_runner(input),
            "runners.importCsv" | "runners.importXlsx" => self.import_runners(method, input),
            "runners.setStatus" => {
                let runner = required(input, "id")?;
                let to = required(input, "status")?;
                let from =
                    self.one("SELECT status FROM runners WHERE id=?", &[json!(runner)])?["status"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                if from == to {
                    return Ok(json!({"ok":true}));
                }
                if from == "running"
                    || !["registered", "warming_up", "waiting"].contains(&to)
                    || (from == "ran" && to == "registered")
                {
                    return Err(
                        "Deze loper kan niet naar die status. Wissel actieve lopers via Timing."
                            .into(),
                    );
                }
                self.exec("UPDATE runners SET status=?,queue_index=CASE WHEN ?='waiting' THEN (SELECT COALESCE(MAX(queue_index),-1)+1 FROM runners) ELSE NULL END,status_since=?,hidden_at=NULL WHERE id=?", &[json!(to),json!(to),json!(input["statusSince"].as_i64().unwrap_or_else(now)),json!(runner)])?;
                self.runner(runner)
            }
            "runners.reorder" => {
                let ids = input["ids"]
                    .as_array()
                    .ok_or("Volledige wachtrij vereist")?;
                let waiting = self.rows("SELECT id FROM runners WHERE status='waiting'", &[])?;
                let unique: std::collections::HashSet<_> =
                    ids.iter().filter_map(Value::as_str).collect();
                if unique.len() != ids.len()
                    || unique.len() != waiting.len()
                    || waiting
                        .iter()
                        .any(|r| !unique.contains(r["id"].as_str().unwrap_or("")))
                {
                    return Err("De volledige wachtrijvolgorde is vereist".into());
                }
                for (i, id) in ids.iter().enumerate() {
                    self.exec(
                        "UPDATE runners SET queue_index=? WHERE id=?",
                        &[json!(i), id.clone()],
                    )?;
                }
                Ok(json!({"ok":true}))
            }
            "race.startNext" | "race.handoff" | "race.finish" | "race.undoLastHandoff" => {
                self.timing(method, input)
            }
            "runners.delete" => {
                let runner = required(input, "id")?;
                let r=self.one("SELECT status,(SELECT COUNT(*) FROM laps WHERE runner_id=r.id) AS laps FROM runners r WHERE id=?", &[json!(runner)])?;
                if r["status"] == "running" || r["laps"].as_i64().unwrap_or(0) > 0 {
                    return Err("Een actieve loper of loper met rondes blijft bewaard".into());
                }
                self.exec("DELETE FROM runners WHERE id=?", &[json!(runner)])?;
                Ok(json!({"ok":true}))
            }
            "runners.hide" | "runners.unhide" => {
                let runner = required(input, "id")?;
                let r = self.one("SELECT status FROM runners WHERE id=?", &[json!(runner)])?;
                if method == "runners.hide" && r["status"] != "ran" {
                    return Err("Alleen gelopen lopers kunnen verborgen worden".into());
                }
                self.exec(
                    "UPDATE runners SET hidden_at=? WHERE id=?",
                    &[
                        if method == "runners.hide" {
                            json!(now())
                        } else {
                            Value::Null
                        },
                        json!(runner),
                    ],
                )?;
                Ok(json!({"ok":true}))
            }
            _ => self.manage(method, input),
        }
    }
    pub(crate) fn write_race(&self, race: &Value) -> Result<()> {
        if race["activeRunnerId"].is_null() != race["activeStartedAt"].is_null()
            || (race["raceStartedAt"].is_null()
                && (!race["activeRunnerId"].is_null() || !race["raceFinishedAt"].is_null()))
            || (!race["raceFinishedAt"].is_null() && !race["activeRunnerId"].is_null())
        {
            return Err("Ongeldige racetoestand".into());
        }
        self.exec("UPDATE race_state SET active_runner_id=?,active_started_at=?,race_started_at=?,race_finished_at=?,active_labels_json=? WHERE id=1", &[race["activeRunnerId"].clone(),race["activeStartedAt"].clone(),race["raceStartedAt"].clone(),race["raceFinishedAt"].clone(),json!(historical_labels(&race["activeLabels"]))])?;
        Ok(())
    }
    fn timing(&self, method: &str, input: &Value) -> Result<Value> {
        let race = self.race()?;
        if input.get("activeRunnerId").is_none()
            || input.get("activeStartedAt").is_none()
            || input["activeRunnerId"] != race["activeRunnerId"]
            || input["activeStartedAt"] != race["activeStartedAt"]
        {
            return Err(TIMING_CHANGED.into());
        }
        if method == "race.undoLastHandoff" {
            let entry=self.one("SELECT id,payload_json AS payload FROM handoff_history WHERE undone=0 ORDER BY created_at DESC,rowid DESC LIMIT 1", &[])?;
            let payload: Value =
                serde_json::from_str(entry["payload"].as_str().ok_or("Ongeldige undo")?)
                    .map_err(err)?;
            if !race["raceFinishedAt"].is_null() && payload["kind"] != "finish" {
                return Err("Hervat de race eerst".into());
            }
            for lap in payload["lapIds"].as_array().ok_or("Ongeldige undo")? {
                self.exec("DELETE FROM laps WHERE id=?", std::slice::from_ref(lap))?;
            }
            for q in payload["queueEntries"].as_array().ok_or("Ongeldige undo")? {
                if q["status"] == "waiting" && !q["queueIndex"].is_null() {
                    self.exec("UPDATE runners SET queue_index=queue_index+1 WHERE status='waiting' AND queue_index>=? AND id!=?", &[q["queueIndex"].clone(),q["runnerId"].clone()])?;
                }
                self.exec("UPDATE runners SET status=?,queue_index=?,status_since=?,hidden_at=? WHERE id=?", &[q["status"].clone(),q["queueIndex"].clone(),q["statusSince"].clone(),q["hiddenAt"].clone(),q["runnerId"].clone()])?;
            }
            let mut old = payload["raceState"].clone();
            if !old["activeRunnerId"].is_null()
                && self
                    .rows(
                        "SELECT id FROM runners WHERE id=?",
                        &[old["activeRunnerId"].clone()],
                    )?
                    .is_empty()
            {
                old["activeRunnerId"] = Value::Null;
                old["activeStartedAt"] = Value::Null;
                old["activeLabels"] = json!([]);
            }
            self.write_race(&old)?;
            self.exec(
                "UPDATE handoff_history SET undone=1 WHERE id=?",
                &[entry["id"].clone()],
            )?;
            return Ok(json!({"ok":true,"deletedLapIds":payload["lapIds"]}));
        }
        let finishing = method == "race.finish";
        if finishing && (race["raceStartedAt"].is_null() || !race["raceFinishedAt"].is_null()) {
            return Err("De race is nog niet gestart of al afgesloten".into());
        }
        if !finishing && !race["raceFinishedAt"].is_null() && input["resume"] != true {
            return Err("Bevestig eerst dat je de race hervat".into());
        }
        if method == "race.startNext" && !race["activeRunnerId"].is_null() {
            return Err("Er loopt al een loper".into());
        }
        let next = if finishing {
            Value::Null
        } else {
            let first = self.rows("SELECT id FROM runners WHERE status='waiting' ORDER BY queue_index,status_since LIMIT 1", &[])?.first().map(|r|r["id"].clone()).unwrap_or(Value::Null);
            // The baton went to the runner the Timing screen showed, even if the queue moved since.
            match input.get("nextRunnerId").filter(|shown| !shown.is_null() && **shown != first) {
                Some(shown) => {
                    if self.rows("SELECT id FROM runners WHERE id=? AND status='waiting'", std::slice::from_ref(shown))?.is_empty() {
                        return Err(TIMING_CHANGED.into());
                    }
                    shown.clone()
                }
                None => first,
            }
        };
        if !finishing && race["activeRunnerId"].is_null() && next.is_null() {
            return Err("Niemand staat klaar in de wachtrij".into());
        }
        let clock = now();
        let max_age = if finishing { 600_000 } else { 20_000 };
        let pressed = input["pressedAt"]
            .as_i64()
            .filter(|p| *p >= clock - max_age && *p <= clock + 1000)
            .unwrap_or(clock)
            .max(race["activeStartedAt"].as_i64().unwrap_or(0));
        let lap = if !finishing && !race["activeRunnerId"].is_null() {
            json!(id())
        } else {
            Value::Null
        };
        let queue=self.rows("SELECT id AS runnerId,status,queue_index AS queueIndex,status_since AS statusSince,hidden_at AS hiddenAt FROM runners WHERE id=? OR id=?", &[race["activeRunnerId"].clone(),next.clone()])?;
        let payload = json!({"kind":if finishing {"finish"} else {"handoff"},"raceState":race,"queueEntries":queue,"lapIds":if lap.is_null(){vec![]}else{vec![lap.clone()]}});
        self.exec(
            "INSERT INTO handoff_history(id,created_at,payload_json) VALUES(?,?,?)",
            &[json!(id()), json!(pressed), json!(payload.to_string())],
        )?;
        if !lap.is_null() {
            let started = race["activeStartedAt"].as_i64().unwrap_or(pressed);
            let duration = input["measuredDurationMs"]
                .as_i64()
                .filter(|d| *d >= 0 && (*d - (pressed - started)).abs() <= 250)
                .unwrap_or(pressed - started);
            self.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,(SELECT COUNT(*)+1 FROM laps WHERE runner_id=?),?,?,?,'spacebar',?,?)", &[lap.clone(),race["activeRunnerId"].clone(),race["activeRunnerId"].clone(),json!(started),json!(pressed),json!(duration),json!(pressed),json!(historical_labels(&race["activeLabels"]))])?;
        }
        if !race["activeRunnerId"].is_null() {
            self.exec("UPDATE runners SET status='ran',queue_index=NULL,status_since=?,hidden_at=NULL WHERE id=? AND status='running'", &[json!(pressed),race["activeRunnerId"].clone()])?;
        }
        if !next.is_null() {
            self.exec("UPDATE runners SET status='running',queue_index=NULL,status_since=?,hidden_at=NULL WHERE id=?", &[json!(pressed),next.clone()])?;
        }
        let labels = match next.as_str() {
            Some(id) => json!(self.labels(Some(id))?),
            None => json!([]),
        };
        let new = json!({"activeRunnerId":next,"activeStartedAt":if next.is_null(){Value::Null}else{json!(pressed)},"raceStartedAt":if race["raceStartedAt"].is_null(){json!(pressed)}else{race["raceStartedAt"].clone()},"raceFinishedAt":if finishing{json!(pressed)}else{Value::Null},"activeLabels":labels});
        self.write_race(&new)?;
        Ok(json!({"ok":true,"lapId":lap,"startedRunnerId":next}))
    }
}
const TIMING_CHANGED: &str =
    "Timingstatus is gewijzigd. Controleer de huidige loper en probeer opnieuw.";
pub fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Veld {key} ontbreekt"))
}

/// Expand older compact historical labels exactly as the reference parser does.
pub fn parse_labels(value: &Value) -> Value {
    let parsed: Value = value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let Some(labels) = parsed.as_array() else {
        return json!([]);
    };
    json!(labels.iter().filter_map(|label| {
        if ["id","name","color","icon","kind"].iter().any(|key|!label[key].is_string()){return None;}
        let mut output=json!({"id":label["id"],"name":label["name"],"color":label["color"],"icon":label["icon"],"kind":label["kind"],"imageUrl":label["imageUrl"].as_str(),"targetLaps":label["targetLaps"].as_i64(),"sortOrder":label["sortOrder"].as_i64()});
        for key in ["createdAt","updatedAt"] {if let Some(n)=label[key].as_i64(){output[key]=json!(n);}}
        Some(output)
    }).collect::<Vec<_>>())
}
pub fn historical_labels(labels: &Value) -> String {
    let result:Vec<_>=labels.as_array().into_iter().flatten().map(|label| {
        let mut output=json!({"id":label["id"],"name":label["name"],"color":label["color"],"icon":label["icon"],"kind":label["kind"]});
        if label["imageUrl"].as_str().is_some_and(|s|!s.is_empty()){output["imageUrl"]=label["imageUrl"].clone();}
        output
    }).collect();
    json!(result).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        db: Db,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("apolloon-native-test-{}", id()));
            let db = Db::open(&path.join("app.db")).unwrap();
            Self { db, path }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    fn create(db: &mut Db, name: &str) -> String {
        db.mutation("runners.create", &json!({"name":name,"status":"waiting"}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn press(db: &mut Db, method: &str, at: i64) -> Result<Value> {
        let race = db.race()?;
        db.mutation(method,&json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":at}))
    }
    fn press_showing(db: &mut Db, seen: &Value, next: &str) -> Result<Value> {
        db.mutation("race.handoff", &json!({"activeRunnerId":seen["activeRunnerId"],"activeStartedAt":seen["activeStartedAt"],"nextRunnerId":next}))
    }
    #[test]
    fn handoff_starts_the_runner_the_timing_screen_showed_after_a_queue_reorder() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        let x = create(&mut f.db, "X");
        let y = create(&mut f.db, "Y");
        press(&mut f.db, "race.handoff", now()).unwrap();
        // The Timing screen's last poll: A runs, X is next.
        let seen = f.db.race().unwrap();
        // The queue desk moves Y to the front before the press arrives.
        f.db.mutation("runners.reorder", &json!({"ids":[y, x]})).unwrap();
        let answer = press_showing(&mut f.db, &seen, &x).unwrap();
        assert_eq!(answer["startedRunnerId"], x);
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], x);
        assert_eq!(f.db.history().unwrap()["laps"][0]["runnerId"], a);
        let status = |db: &Db, id: &str| db.one("SELECT status,queue_index FROM runners WHERE id=?", &[json!(id)]).unwrap();
        assert_eq!(status(&f.db, &y)["status"], "waiting");
        // Undo puts X back in line and A back on the track.
        press(&mut f.db, "race.undoLastHandoff", now()).unwrap();
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
        assert_eq!(status(&f.db, &x)["status"], "waiting");
        assert_eq!(status(&f.db, &y)["status"], "waiting");
        // The press after that starts Y, who is first now.
        let answer = press(&mut f.db, "race.handoff", now()).unwrap();
        assert_eq!(answer["startedRunnerId"], y);
    }
    #[test]
    fn handoff_is_refused_when_the_shown_runner_left_the_queue() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        let x = create(&mut f.db, "X");
        let y = create(&mut f.db, "Y");
        press(&mut f.db, "race.handoff", now()).unwrap();
        let seen = f.db.race().unwrap();
        f.db.mutation("runners.setStatus", &json!({"id":x,"status":"registered"})).unwrap();
        assert!(press_showing(&mut f.db, &seen, &x).is_err());
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
        assert_eq!(f.db.history().unwrap()["laps"].as_array().unwrap().len(), 0);
        assert_eq!(press_showing(&mut f.db, &seen, &y).unwrap()["startedRunnerId"], y);
    }
    #[test]
    fn handoff_and_undo_restore_the_exact_runner_and_queue() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        let b = create(&mut f.db, "B");
        let start = now() - 15000;
        press(&mut f.db, "race.handoff", start).unwrap();
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
        press(&mut f.db, "race.handoff", start + 12000).unwrap();
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], b);
        let history = f.db.history().unwrap();
        assert_eq!(history["laps"][0]["runnerId"], a);
        assert_eq!(history["laps"][0]["durationMs"], 12000);
        press(&mut f.db, "race.undoLastHandoff", now()).unwrap();
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
        assert_eq!(f.db.race().unwrap()["activeStartedAt"], start);
        assert_eq!(f.db.history().unwrap()["laps"].as_array().unwrap().len(), 0);
        assert_eq!(
            f.db.one("SELECT status FROM runners WHERE id=?", &[json!(b)])
                .unwrap()["status"],
            "waiting"
        );
    }
    #[test]
    fn stale_press_is_rejected_without_a_second_lap_or_activity() {
        let mut f = Fixture::new();
        create(&mut f.db, "A");
        create(&mut f.db, "B");
        press(&mut f.db, "race.handoff", now() - 10000).unwrap();
        let race = f.db.race().unwrap();
        let input = json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":now()});
        f.db.mutation("race.handoff", &input).unwrap();
        let before = f.db.history().unwrap();
        let rev = f.db.revision;
        assert!(f.db.mutation("race.handoff", &input).is_err());
        assert_eq!(f.db.history().unwrap(), before);
        assert_eq!(f.db.revision, rev);
    }
    #[test]
    fn finish_does_not_count_an_unfinished_lap_and_undo_reopens_it() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        press(&mut f.db, "race.handoff", now() - 10000).unwrap();
        let before = f.db.race().unwrap();
        press(&mut f.db, "race.finish", now()).unwrap();
        assert!(f.db.race().unwrap()["activeRunnerId"].is_null());
        assert_eq!(f.db.history().unwrap()["laps"], json!([]));
        press(&mut f.db, "race.undoLastHandoff", now()).unwrap();
        assert_eq!(f.db.race().unwrap(), before);
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
    }
    #[test]
    fn an_operator_cannot_remove_a_runner_from_the_track() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        press(&mut f.db, "race.handoff", now()).unwrap();
        assert!(
            f.db.mutation("runners.setStatus", &json!({"id":a,"status":"waiting"}))
                .is_err()
        );
        assert!(f.db.mutation("runners.delete", &json!({"id":a})).is_err());
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], a);
    }
    #[test]
    fn reordering_must_include_each_waiting_runner_once() {
        let mut f = Fixture::new();
        let a = create(&mut f.db, "A");
        let b = create(&mut f.db, "B");
        assert!(
            f.db.mutation("runners.reorder", &json!({"ids":[a,a]}))
                .is_err()
        );
        f.db.mutation("runners.reorder", &json!({"ids":[b,a]}))
            .unwrap();
        press(&mut f.db, "race.handoff", now()).unwrap();
        assert_eq!(f.db.race().unwrap()["activeRunnerId"], b);
    }
    #[test]
    fn persisted_race_survives_reopening() {
        let mut f = Fixture::new();
        create(&mut f.db, "A");
        press(&mut f.db, "race.handoff", now()).unwrap();
        let expected = f.db.race().unwrap();
        let reopened = Db::open(&f.path.join("app.db")).unwrap();
        assert_eq!(reopened.race().unwrap(), expected);
    }
}
