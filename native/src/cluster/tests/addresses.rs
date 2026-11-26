use super::*;

/// Three linked laptops where A leads and gives `stale` as its own address.
fn linked_three_led_by_a_stale_address(
    dir: &Dir,
    stale: impl Fn(u16) -> String,
) -> (TestServer, TestServer, TestServer) {
    let port = free_port();
    let stale = stale(port);
    let a = TestServer::start_with(&dir.db("a"), port, "Laptop A", |c| c.self_url = stale);
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    let c = TestServer::start(&dir.db("c"), free_port(), "Laptop C");
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    c.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    (a, b, c)
}
fn followers_save(a: &TestServer, b: &TestServer, c: &TestServer) {
    wait_until("three healthy laptops", Duration::from_secs(10), || {
        all_healthy(&[a, b, c])
    });
    assert!(a.node.is_leader());
    for (follower, name) in [(b, "Op B"), (c, "Op C")] {
        follower
            .act("runners.create", json!({"name": name}))
            .unwrap();
    }
    wait_until(
        "every laptop has both runners",
        Duration::from_secs(5),
        || {
            same_heads(&[a, b, c])
                && [a, b, c].iter().all(|s| {
                    s.count("SELECT COUNT(*) AS n FROM runners WHERE name IN ('Op B','Op C')") == 2
                })
        },
    );
}

#[test]
fn followers_save_through_a_leader_that_started_before_its_network_was_up() {
    let _serial = serial();
    let dir = Dir::new();
    // A started without a network and still gives the address it had then.
    let (a, b, c) = linked_three_led_by_a_stale_address(&dir, |_| "http://localhost:1".into());
    for s in [&b, &c] {
        hear(s, &beacon(&a, &a.url, "Laptop A"));
    }
    followers_save(&a, &b, &c);
}

#[test]
fn followers_save_through_a_leader_whose_announcements_do_not_arrive() {
    let _serial = serial();
    let dir = Dir::new();
    // A gives the address it had on another network; nobody hears it announce the new one.
    let (a, b, c) =
        linked_three_led_by_a_stale_address(&dir, |port| format!("http://192.0.2.1:{port}"));
    followers_save(&a, &b, &c);
}

#[test]
fn followers_keep_saving_after_the_leader_gets_another_address() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    b.act("runners.create", json!({"name":"Voor"})).unwrap();
    // The leader moves to another network while the app keeps running.
    let moved = format!("http://localhost:{}", a.port);
    a.node.set_self_url(&moved);
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    wait_until(
        "every laptop stores the leader's new address",
        Duration::from_secs(10),
        || {
            [&a, &b, &c].iter().all(|s| {
                s.db.lock()
                    .unwrap()
                    .one(
                        "SELECT url FROM cluster_members WHERE host_id=?",
                        &[json!(a_id)],
                    )
                    .is_ok_and(|row| row["url"] == json!(moved))
            })
        },
    );
    assert!(a.node.is_leader());
    assert_eq!(a.status()["leader"]["url"], json!(moved));
    followers_save(&a, &b, &c);
}

#[test]
fn an_announcement_from_elsewhere_does_not_replace_the_address_the_leader_connects_from() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, _c) = linked_three(&dir);
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    hear(&b, &beacon(&a, "http://192.0.2.9:5173", "Laptop A"));
    let from = Some(std::net::IpAddr::from(std::net::Ipv4Addr::LOCALHOST));
    assert_eq!(b.node.leader_address(&a_id, &a.url, from), a.url);
    assert_eq!(b.node.leader_address(&a_id, &a.url, None), a.url);
}

#[test]
fn a_leader_that_gets_the_stored_address_of_another_laptop_keeps_that_laptop_in_the_group() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    a.node.set_self_url(&b.url);
    wait_until(
        "the leader stores its new address",
        Duration::from_secs(10),
        || {
            a.db.lock()
                .unwrap()
                .one("SELECT url FROM cluster_members WHERE host_id=?", &[json!(a_id)])
                .is_ok_and(|row| row["url"] == json!(b.url))
        },
    );
    assert_eq!(a.count("SELECT COUNT(*) AS n FROM cluster_members"), 3);
    drop(c);
}

#[test]
fn a_leader_at_the_stored_address_of_a_laptop_that_is_off_keeps_leading() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    drop(b);
    let term = a.node.term();
    a.node
        .add_member(
            &crate::cluster::Member {
                host_id: b_id.clone(),
                url: a.url.clone(),
                name: None,
            },
            None,
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert!(a.node.is_leader());
    assert_eq!(a.node.term(), term);
    let status = a.status();
    let off = status["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["hostId"] == json!(b_id))
        .unwrap();
    assert_eq!(off["reachable"], json!(false));
    let own = json!({"term": term, "leaderId": a.status()["hostId"], "leaderUrl": a.url});
    assert_eq!(a.node.handle_append(&own, None)["reason"], json!("self"));
    assert!(a.node.is_leader());
    c.act("runners.create", json!({"name":"Op C"})).unwrap();
}
