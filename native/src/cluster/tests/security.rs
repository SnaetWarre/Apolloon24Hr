use super::*;

/// A request the way another device on the network sends it: no group key.
fn unsigned(method: reqwest::Method, url: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = reqwest::blocking::Client::new()
        .request(method, url)
        .header("x-apolloon-app-version", crate::cluster::APP_VERSION);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().unwrap();
    (response.status().as_u16(), response.json().unwrap_or(Value::Null))
}

#[test]
fn a_device_outside_the_group_cannot_write_or_read_through_the_laptop_endpoints() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    // Linking gave all three the leader's key; none of them shows it.
    assert_eq!(a.node.group_keys()[0], b.node.group_keys()[0]);
    assert_eq!(a.node.group_keys()[0], c.node.group_keys()[0]);
    assert!(!a.status().to_string().contains(&a.node.group_keys()[0]));
    // It is in no backup and in no copy of the data either: both are the database, the key is not in it.
    let key = a.node.group_keys()[0].clone();
    let image = crate::cluster::log::serialize(&a.db.lock().unwrap()).unwrap();
    assert!(!image.windows(key.len()).any(|w| w == key.as_bytes()));
    let status = a.status();
    let head = a.head();
    let runners = a.count("SELECT COUNT(*) AS n FROM runners");
    let append = json!({"type": "append", "body": {
        "clusterId": status["clusterId"], "split": status["split"]["id"], "term": a.node.term() + 5,
        "leaderId": "someone-else", "leaderUrl": "http://127.0.0.1:9",
    }});
    let write = json!({"method": "race.clear", "input": {}, "origin": "phone", "requestId": "r1"});
    for (method, target, path, body) in [
        (reqwest::Method::POST, &a, "/api/cluster/write", Some(write)),
        (reqwest::Method::POST, &b, "/api/cluster/peer", Some(append)),
        (reqwest::Method::GET, &a, "/api/cluster/snapshot", None),
        (reqwest::Method::GET, &a, "/api/cluster/probe?id=x", None),
        (reqwest::Method::POST, &a, "/api/cluster/split/common", Some(json!({"marks": []}))),
        (reqwest::Method::POST, &a, "/api/cluster/split/merge", Some(json!({}))),
    ] {
        let (code, answer) = unsigned(method, &format!("{}{path}", target.url), body);
        assert_eq!((code, &answer["code"]), (401, &json!("not_in_group")), "{path}");
    }
    // A signature made with another key is no better than none.
    let forged = reqwest::blocking::Client::new()
        .get(format!("{}/api/cluster/snapshot", a.url))
        .header(
            crate::cluster::key::HEADER,
            crate::cluster::key::sign("not-the-key", &[b"GET", b"/api/cluster/snapshot", b""]),
        )
        .send()
        .unwrap();
    assert_eq!(forged.status().as_u16(), 401);
    // Nobody outside the group tells a laptop to follow another group, or moves it once its
    // race started.
    let follow = json!({"url": "http://127.0.0.1:9", "clusterId": "other", "follow": status["clusterId"]});
    let (code, _) = unsigned(reqwest::Method::POST, &format!("{}/api/cluster/invite", b.url), Some(follow));
    assert_eq!(code, 409);
    press(&a, "race.handoff").unwrap();
    wait_until("the lap is everywhere", Duration::from_secs(5), || same_heads(&[&a, &b, &c]));
    let invite = json!({"url": "http://127.0.0.1:9", "clusterId": "other"});
    let (code, _) = unsigned(reqwest::Method::POST, &format!("{}/api/cluster/invite", c.url), Some(invite));
    assert_eq!(code, 409);
    // Nothing of that reached the group, and the laptops still save through each other.
    assert!(a.node.is_leader());
    assert_eq!(a.head(), head + 1);
    assert_eq!(a.count("SELECT COUNT(*) AS n FROM runners"), runners);
    c.act("runners.create", json!({"name": "Op C"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b, &c]));
}

#[test]
fn an_announcement_without_the_group_key_does_not_move_a_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
    let (a, b) = if a.node.is_leader() { (a, b) } else { (b, a) };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    // Another device announces itself under B's id, at its own address.
    let elsewhere = format!("http://127.0.0.1:{}", free_port());
    let mut spoofed = beacon(&b, &elsewhere, "Laptop B");
    for proof in [Value::Null, json!(crate::cluster::beacon_proof("not-the-key", &b_id, &elsewhere))] {
        spoofed["proof"] = proof;
        hear(&a, &spoofed);
        a.node.maintain();
        let address = |s: &TestServer| {
            s.node.members().into_iter().find(|m| m.host_id == b_id).unwrap().url
        };
        assert_eq!(address(&a), b.url);
        assert_eq!(
            a.node.leader_address(&b_id, &b.url, Some("127.0.0.1".parse().unwrap())),
            b.url
        );
    }
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b]));
    assert_eq!(b.count("SELECT COUNT(*) AS n FROM runners"), 1);
}
