use super::*;

/// A laptop whose disk refuses the vote neither gives it nor stands: counted and then given
/// again in the same term, it would let two laptops lead.
#[test]
fn a_vote_that_cannot_be_stored_is_not_given() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let refuse_votes = |server: &TestServer, on: bool| {
        let db = server.db.lock().unwrap();
        db.conn
            .execute_batch(if on {
                "CREATE TRIGGER vote_fails BEFORE INSERT ON settings WHEN NEW.key='cluster_voted_for' BEGIN SELECT RAISE(ABORT,'disk'); END"
            } else {
                "DROP TRIGGER vote_fails"
            })
            .unwrap();
    };
    refuse_votes(&b, true);
    refuse_votes(&c, true);
    let term = b.node.term();
    a.kill();
    std::thread::sleep(Duration::from_millis(2_500));
    assert_eq!(leader_index(&[&b, &c]), None, "nobody leads on votes that were not stored");
    let vote = b.node.handle_vote(&json!({
        "clusterId": b.status()["clusterId"],
        "term": b.node.term() + 1,
        "candidateId": c.node.host_id,
        "lastSeq": c.head(),
        "lastTerm": term + 1_000,
    }));
    assert_eq!(vote["granted"], false, "a vote that is not on disk is not given");
    refuse_votes(&b, false);
    refuse_votes(&c, false);
    wait_until("a leader once votes are stored again", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    b.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
}

/// A laptop is not taken in on top of a change the others have not confirmed: that change may be
/// another laptop being taken in, and the group changes by one laptop at a time.
#[test]
fn a_new_laptop_is_not_taken_in_before_earlier_changes_are_confirmed() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three_with(&dir, |cfg| {
        cfg.removable_after = Duration::from_secs(60);
    });
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    let new = crate::cluster::Member {
        host_id: "new-laptop".into(),
        url: "http://127.0.0.1:9".into(),
        name: None,
    };
    a.node.make_room_for(&new).unwrap();
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    let b_url = b.url.clone();
    drop(b);
    drop(c);
    // A change of the group that no other laptop has.
    a.node
        .add_member(&crate::cluster::Member { host_id: b_id, url: format!("{b_url}0"), name: None }, None)
        .unwrap();
    assert!(a.node.make_room_for(&new).is_err());
}


/// The offset to an earlier group's clock is kept across a restart while a race depends on it,
/// and dropped by a laptop that starts alone without a race.
#[test]
fn a_laptop_alone_without_a_race_starts_on_its_own_clock() {
    let _serial = serial();
    let dir = Dir::new();
    let restart_with_offset = |server: TestServer, name: &str| {
        crate::cluster::log::set_local(&server.db.lock().unwrap(), "cluster_clock_offset_ms", "5000")
            .unwrap();
        server.kill();
        TestServer::start(&dir.db(name), free_port(), "Laptop")
    };
    let idle = restart_with_offset(TestServer::start(&dir.db("idle"), free_port(), "Laptop"), "idle");
    assert_eq!(crate::cluster::clock::offset(), 0);
    assert_eq!(
        crate::cluster::log::setting(&idle.db.lock().unwrap(), "cluster_clock_offset_ms").as_deref(),
        Some("0")
    );
    let racing = TestServer::start(&dir.db("racing"), free_port(), "Laptop");
    racing.act("runners.create", json!({"name":"Zoë","status":"waiting"})).unwrap();
    press(&racing, "race.handoff").unwrap();
    let _racing = restart_with_offset(racing, "racing");
    assert_eq!(crate::cluster::clock::offset(), 5000);
    crate::cluster::clock::set_offset(0);
}

/// The full copy for a joining laptop is read while the leader's database stays free for
/// saving and for the signs of life: it holds everything saved before the copy started.
#[test]
fn a_full_copy_does_not_need_the_leaders_database_lock() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"})).unwrap();
    let held = a.db.lock().unwrap();
    let image = crate::cluster::log::serialize_file(&dir.db("a")).unwrap();
    drop(held);
    let mut target = Db::open(Path::new(":memory:")).unwrap();
    crate::cluster::log::install(&mut target, &image).unwrap();
    assert_eq!(target.runners().unwrap().len(), 1);
    assert_eq!(crate::cluster::log::head(&target).seq, a.head());
}

/// Taking in a laptop right after another one does not wait for the next sign of life: what the
/// first one still misses is sent to it at once.
#[test]
fn a_second_new_laptop_does_not_wait_for_the_next_sign_of_life() {
    let _serial = serial();
    let dir = Dir::new();
    let tune = |cfg: &mut Config| {
        cfg.heartbeat = Duration::from_secs(2);
        cfg.election_timeout = Duration::from_secs(30);
    };
    let a = TestServer::start_with(&dir.db("a"), free_port(), "Laptop A", tune);
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", tune);
    // A holds a runner, so B takes A's data and A keeps leading.
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    let at = Instant::now();
    assert!(a.node.group_settled());
    assert!(
        at.elapsed() < Duration::from_secs(1),
        "waited {:?} for the next sign of life",
        at.elapsed()
    );
}
