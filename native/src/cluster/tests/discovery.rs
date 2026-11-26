use super::*;

#[test]
fn the_leader_stores_the_address_and_name_a_laptop_announces() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
    // Whichever laptop ended up leading stores what the other one announces.
    let (a, b) = if a.node.is_leader() { (a, b) } else { (b, a) };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    // B is now announced under another address (a new lease) and a new computer name.
    let moved = format!("http://localhost:{}", b.port);
    hear(&a, &beacon(&b, &moved, "Nieuwe naam"));
    let stored = |s: &TestServer| {
        s.db.lock().unwrap().one("SELECT m.url, n.name FROM cluster_members m LEFT JOIN cluster_member_names n USING(host_id) WHERE host_id=?", &[json!(b_id)]).unwrap()
    };
    wait_until(
        "the new address is stored on both laptops",
        Duration::from_secs(10),
        || {
            [&a, &b]
                .iter()
                .all(|s| stored(s)["url"] == json!(moved) && stored(s)["name"] == "Nieuwe naam")
        },
    );
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == &format!("Nieuwe naam heeft een nieuw adres: localhost:{}", b.port))
    );
    // Replication keeps working at the new address.
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b]));
}

#[test]
fn a_fresh_laptop_links_by_itself_and_the_group_says_so() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", |c| {
        c.auto_link = true
    });
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    hear(&b, &beacon(&a, &a.url, "Laptop A"));
    assert_eq!(b.status()["nearby"][0]["link"], "join");
    wait_until("B linked by itself", Duration::from_secs(10), || {
        all_healthy(&[&a, &b])
    });
    for server in [&a, &b] {
        let linked = server.status()["autoLink"]["linked"].clone();
        assert_eq!(linked[0]["name"], "Laptop B", "{linked}");
        assert_eq!(linked[0]["with"], "Laptop A");
    }
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == "Laptop B vanzelf gekoppeld met Laptop A")
    );
    assert_eq!(b.count("SELECT COUNT(*) AS n FROM runners"), 1);
}

#[test]
fn the_group_test_sees_a_mark_arrive_and_leave_on_every_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let runners = |s: &TestServer| s.count("SELECT COUNT(*) AS n FROM runners");
    let before = [runners(&a), runners(&b), runners(&c)];

    // Started on a follower: the mark goes through the leader and every laptop reports it.
    let result = c.act("cluster.testGroup", json!({})).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!((result["reached"].as_i64(), result["total"].as_i64()), (Some(3), Some(3)));
    assert_eq!(result["inStep"], true);
    for laptop in result["laptops"].as_array().unwrap() {
        assert!(laptop["addedMs"].as_u64().is_some() && laptop["removedMs"].as_u64().is_some());
    }
    // Nothing is left behind, and no race data changed.
    wait_until("the mark is gone everywhere", Duration::from_secs(5), || {
        [&a, &b, &c].iter().all(|s| {
            s.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'cluster_probe:%'") == 0
        })
    });
    assert_eq!([runners(&a), runners(&b), runners(&c)], before);

    // A laptop that is off is reported as not reached; the others still pass.
    c.kill();
    let result = a.act("cluster.testGroup", json!({})).unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["reached"], 2);
    let missing: Vec<_> = result["laptops"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["ok"] != true)
        .map(|l| l["name"].clone())
        .collect();
    assert_eq!(missing, vec![json!("Laptop C")]);
}
