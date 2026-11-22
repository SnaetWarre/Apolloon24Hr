use super::*;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) enum Need {
    None,
    Recent(usize),
    Runner(String, usize),
    #[default]
    Full,
}
pub(super) type Request = Arc<Mutex<Need>>;

impl Need {
    pub(super) fn route(route: &str) -> Self {
        let (path, query) = route.split_once('?').unwrap_or((route, ""));
        match path.trim_end_matches('/') {
            "" => Self::Recent(7),
            "/queue" => Self::None,
            "/timing" => Self::Recent(5),
            "/admin" => {
                let section = query.split('&').find_map(|s| s.strip_prefix("section="));
                match section {
                    None | Some("preparation" | "runners" | "labels" | "public" | "activity" | "system") => Self::None,
                    _ => Self::Full,
                }
            }
            _ => Self::Full,
        }
    }
    pub(super) fn profile(self, id: &str) -> Self {
        match self {
            Self::None | Self::Runner(..) => Self::Runner(id.into(), 10),
            _ => Self::Full,
        }
    }
    pub(super) fn scope(&self) -> &str {
        match self { Self::None => "none", Self::Recent(_) => "recent", Self::Runner(..) => "runner", Self::Full => "full" }
    }
    pub(super) fn matches(&self, reply: &Value) -> bool {
        reply["scope"] == self.scope() && match self {
            Self::Runner(id, n) => reply["runnerId"] == id.as_str() && reply["limit"].as_u64() == Some(*n as u64),
            Self::Recent(n) => reply["limit"].as_u64() == Some(*n as u64),
            _ => true,
        }
    }
    pub(super) fn append(&self, path: &mut String) {
        if self == &Self::Full { return; }
        let mut url = reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("historyScope", self.scope());
            match self {
                Self::Recent(n) => { query.append_pair("historyLimit", &n.to_string()); }
                Self::Runner(id, n) => { query.append_pair("historyRunnerId", id).append_pair("historyLimit", &n.to_string()); }
                _ => {}
            }
        }
        *path = format!("{}?{}", url.path(), url.query().unwrap());
    }
    pub(super) fn reply(&self, snapshot: &mut Value) -> Value {
        if let Some(reply) = snapshot.as_object_mut().and_then(|s| s.remove("stateHistory")) { return reply; }
        if self == &Self::None && snapshot["historyScope"] == "none" {
            return json!({"scope":"none","laps":[],"events":[],"revision":snapshot["revision"],"cursor":format!("{}.lean-none", snapshot["historyEpoch"].as_str().unwrap_or(""))});
        }
        Value::Null
    }
}

pub(super) fn wanted(s: &State) -> Need {
    if s.history["scope"] == "full" { return Need::Full; }
    if !s.route_seen.is_empty() {
        let path = s.route_seen.split('?').next().unwrap_or("").trim_end_matches('/');
        if !ROUTES.iter().any(|r| r.trim_end_matches('/') == path) { return Need::Full; }
        if path == "/admin" && Need::route(&s.route_seen) == Need::Full { return Need::Full; }
    }
    let route = if s.page == 8 {
        format!("/admin?section={}", SECTIONS.get(s.admin_section).unwrap_or(&"unknown"))
    } else { ROUTES.get(s.page).unwrap_or(&"unknown").to_string() };
    let need = Need::route(&route);
    if s.page == 1 { return need; }
    match s.pending_profile.as_deref().or_else(|| s.profile.as_ref().map(|f| f.runner_id())) {
        Some(id) => need.profile(id),
        None => need,
    }
}

pub(super) fn publish(s: &mut State) {
    let need = wanted(s);
    let mut request = s.history_request.lock().unwrap();
    if *request != need {
        *request = need;
        if s.history["scope"] != "full" {
            s.history = Value::Null;
            s.history_index = Default::default();
            s.history_pending.clear();
            s.history_version = s.history_version.wrapping_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn routes_modals_unknown_routes_and_encoded_runner_ids() {
        for (path, expected) in [("/", Need::Recent(7)), ("/timing", Need::Recent(5)),
            ("/queue", Need::None), ("/admin", Need::None), ("/admin?section=laps", Need::Full),
            ("/admin?section=new", Need::Full), ("/new-screen", Need::Full)] {
            assert_eq!(Need::route(path), expected);
        }
        for section in SECTIONS { assert_eq!(Need::route(&format!("/admin?section={section}")), if section == "laps" { Need::Full } else { Need::None }); }
        assert_eq!(Need::None.profile("a"), Need::Runner("a".into(), 10));
        assert_eq!(Need::Recent(5).profile("a"), Need::Full);
        let mut path = "/api/state?history=1".into();
        Need::Runner("a&scope=full ?/é".into(), 10).append(&mut path);
        let url = reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
        assert_eq!(url.query_pairs().find(|p| p.0 == "historyRunnerId").unwrap().1, "a&scope=full ?/é");
    }

    #[test]
    fn atomic_scope_changes_markers_old_servers_and_sticky_full() {
        let mut synced = Synced::default();
        *synced.request.lock().unwrap() = Need::Recent(5);
        assert!(!synced.state_path(Some("token"), None).contains("after="));
        let reply = json!({"scope":"recent","limit":5,"cursor":"old.recent","revision":8,"laps":[{"id":"a"}],"events":[]});
        synced.take_scoped(reply.clone(), &Need::Recent(5)).unwrap();
        let path = synced.state_path(Some("token"), None);
        assert!(path.contains("after=token"));
        assert!(!path.contains("since="));
        *synced.request.lock().unwrap() = Need::Full;
        assert!(!synced.state_path(Some("token"), None).contains("after="));
        assert!(!synced.state_path(Some("token"), None).contains("since="));
        *synced.request.lock().unwrap() = Need::Runner("a".into(), 10);
        assert!(!synced.state_path(Some("token"), None).contains("after="));
        assert_eq!(synced.take_scoped(reply, &Need::Recent(5)), Some(Default::default()));
        assert!(synced.take_scoped(json!({"error":"failed"}), &Need::Runner("a".into(),10)).is_none());
        let runner = json!({"scope":"runner","runnerId":"a","limit":10,"cursor":"restart.runner","revision":1,"laps":[],"events":[]});
        synced.take_scoped(runner, &Need::Runner("a".into(),10)).unwrap();
        assert_eq!(synced.history["laps"], json!([]));
        let stale = json!({"scope":"full","cursor":"restart.1","revision":0,"laps":[{"id":"stale"}],"events":[]});
        assert_eq!(synced.take_scoped(stale,&Need::Runner("a".into(),10)),Some(Default::default()));
        assert!(!synced.full_loaded);
        assert_eq!(synced.loaded_need,Some(Need::Runner("a".into(),10)));
        let full = json!({"scope":"full","cursor":"other.1","revision":0,"laps":[{"id":"b"}],"events":[]});
        synced.take_scoped(full, &Need::Runner("a".into(),10)).unwrap();
        *synced.request.lock().unwrap() = Need::None;
        assert_eq!(synced.need(), Need::Full);
        assert!(!synced.state_path(Some("token"), None).contains("historyScope"));
        assert!(synced.state_path(Some("token"), None).contains("since=other.1"));
    }

    fn render(snapshot: &Value, history: &Value, page: usize, section: usize, profile: Option<&str>) -> Vec<u8> {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.fixture = true;
        s.connected = true;
        s.clock = 20_000_000;
        s.page = page;
        s.admin_section = section;
        s.snapshot = snapshot.clone();
        s.history = history.clone();
        if let Some(id) = profile {
            let runner = snapshot["runners"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap();
            s.profile = Some(profile::Form::new(runner, &Value::Null));
        }
        let mut rt = Runtime::new(s, view, (1366.0, 1080.0), Env { system_dark:false, scale:1.0 });
        for _ in 0..3 { rt.frame(1.0); }
        serde_json::to_vec(&rt.elements().iter().map(|e| json!([e.key,e.role,e.label,e.text,e.target,format!("{:?}",e.fill),format!("{:?}",e.text_color)])).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn scoped_elements_equal_full_history_after_ties_edits_undo_imports_and_labels() {
        let db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        db.exec("INSERT INTO runners(id,name,runner_number,status,created_at,updated_at) VALUES('a','Alpha','1','registered',0,0),('b','Beta','2','registered',0,0)", &[]).unwrap();
        for i in 0..24 {
            db.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,60000,'spacebar',?,'[]')",
                &[json!(format!("lap-{i}")),json!(if i%2==0 {"a"} else {"b"}),json!(i/2+1),json!(i*60000),json!((i/2+1)*120000),json!(i)]).unwrap();
        }
        for edit in ["UPDATE laps SET duration_ms=duration_ms", "UPDATE laps SET duration_ms=59000 WHERE id='lap-20'", "DELETE FROM laps WHERE id='lap-23'",
            "INSERT INTO laps SELECT 'imported',runner_id,lap_number+1,started_at,finished_at+1,duration_ms,source,created_at+1,labels_json FROM laps WHERE id='lap-22'",
            "UPDATE laps SET labels_json='[{\"id\":\"old-label\",\"name\":\"Edited\",\"color\":\"#123456\"}]' WHERE id='lap-21'"] {
            db.exec(edit,&[]).unwrap();
            let snapshot = db.race_snapshot().unwrap();
            let full = db.history().unwrap();
            for (page, section) in [(0,0),(1,0),(2,0),(8,0),(8,1),(8,2),(8,3),(8,4),(8,5),(8,6)] {
                let need = if page==8 && section==2 {Need::Full} else {Need::route(ROUTES[page])};
                let lean = match need { Need::Recent(n)=>db.history_scope("recent",None,n).unwrap(), Need::None=>json!({"scope":"none","laps":[],"events":[]}), _=>full.clone() };
                assert_eq!(render(&snapshot,&full,page,section,None),render(&snapshot,&lean,page,section,None),"page {page}, section {section}, edit {edit}");
            }
            let runner = db.history_scope("runner",Some("a"),10).unwrap();
            assert_eq!(runner["laps"].as_array().unwrap().len(),10);
            for page in [0,1,2,8] {
                let lean = if page==1 || page==8 {&runner} else {&full};
                assert_eq!(render(&snapshot,&full,page,1,Some("a")),render(&snapshot,lean,page,1,Some("a")),"profile page {page}, edit {edit}");
            }
        }
        assert!(db.history_scope("runner",None,10).is_err());
        assert!(db.history_scope("runner",Some("missing"),10).unwrap()["laps"].as_array().unwrap().is_empty());
    }
}
