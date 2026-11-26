use super::*;

#[test]
fn frozen_leader_does_not_hold_up_an_election_or_a_timing_press() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three_with(&dir, |cfg| {
        cfg.election_timeout = Duration::from_secs(1);
    });
    b.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&b, "race.handoff").unwrap();
    press(&b, "race.handoff").unwrap();
    let laps = |s: &TestServer| s.db.lock().unwrap().history().unwrap()["laps"].clone();
    let before = laps(&b);
    let term = a.node.term();
    assert_eq!(before.as_array().unwrap().len(), 1);
    wait_until("the first lap on all laptops", Duration::from_secs(2), || {
        [&a, &c].iter().all(|s| laps(s) == before)
    });

    // The server keeps accepting TCP connections, but cannot answer votes or writes.
    {
        let _frozen = a.node.raft.lock().unwrap();
        std::thread::sleep(a.node.cfg.heartbeat * 3);
        for follower in [&b, &c] {
            assert_eq!(follower.node.term(), term);
            assert_eq!(follower.status()["leader"]["hostId"], a.node.host_id);
        }
    }
    wait_until("three healthy laptops", Duration::from_secs(2), || {
        all_healthy(&[&a, &b, &c])
    });

    std::thread::scope(|scope| {
        let _frozen = a.node.raft.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(2_800);
        let (send, saved) = std::sync::mpsc::channel();
        let follower = &b;
        scope.spawn(move || {
            let _ = send.send(press(follower, "race.handoff"));
        });
        while leader_index(&[&b, &c]).is_none() {
            assert!(Instant::now() < deadline, "the frozen peer delayed the election");
            std::thread::sleep(Duration::from_millis(25));
        }
        saved
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("the press waited for the frozen leader's HTTP response")
            .unwrap();
    });

    let after = laps(&b);
    let after = after.as_array().unwrap();
    assert_eq!(after.len(), 2);
    assert!(after.contains(&before[0]));
    wait_until("the same two laps on all laptops", Duration::from_secs(5), || {
        [&a, &c].iter().all(|s| laps(s).as_array() == Some(after))
    });
}

#[test]
fn three_laptops_link_replicate_fail_over_restart_and_catch_up() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let cluster_id = a.status()["clusterId"].clone();
    for server in [&a, &b, &c] {
        assert_eq!(server.status()["clusterId"], cluster_id);
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners"),
            1,
            "the group's data was copied"
        );
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM cluster_members"), 3);
    }
    assert!(a.node.is_leader());

    // Writes on a follower go to the leader and are on a majority before the press answers.
    c.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&c, "race.handoff").unwrap();
    press(&b, "race.handoff").unwrap();
    // Through the real HTTP route the screens use.
    let created: Value = reqwest::blocking::Client::new()
        .post(format!("{}/api/action/runners.create", b.url))
        .json(&json!({"name":"Mitras"}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(created["name"], "Mitras");
    let laps = |s: &TestServer| s.count("SELECT COUNT(*) AS n FROM laps");
    assert_eq!(laps(&b), 1, "the follower shows its own press at once");
    wait_until("every laptop holds the lap", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c]) && [&a, &b, &c].iter().all(|s| laps(s) == 1)
    });
    let state = |s: &TestServer| s.db.lock().unwrap().snapshot(0).unwrap()["race"].clone();
    assert_eq!(state(&a), state(&c));
    // A follower's /api/state carries the group status the screens show.
    let state_of_c = || -> Value {
        reqwest::blocking::get(format!("{}/api/state", c.url))
            .unwrap()
            .json()
            .unwrap()
    };
    wait_until(
        "C's screen shows a healthy group",
        Duration::from_secs(5),
        || state_of_c()["cluster"]["state"] == "healthy",
    );
    let snapshot = state_of_c();
    assert_eq!(
        snapshot["cluster"]["leader"]["hostId"],
        a.status()["hostId"]
    );

    // The leader dies: B and C elect a new one and keep saving.
    let a_path = dir.db("a");
    let a_port = a.port;
    a.kill();
    wait_until("a new leader", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    press(&c, "race.handoff").unwrap();
    assert_eq!(laps(&c), 2);
    wait_until(
        "B holds the lap clocked after the failover",
        Duration::from_secs(5),
        || laps(&b) == 2,
    );
    let degraded = b.status();
    assert_eq!(degraded["state"], "degraded");
    assert_eq!(
        degraded["members"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["reachable"] != true)
            .count(),
        1
    );

    // A restarts from its own file and catches up through the log.
    let a = TestServer::start(&a_path, a_port, "Laptop A");
    assert!(!a.node.is_leader(), "a restarted laptop follows");
    wait_until("A catches up", Duration::from_secs(10), || {
        same_heads(&[&a, &b, &c]) && laps(&a) == 2
    });
    wait_until("the group is whole again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    assert_eq!(state(&a), state(&b));
    // Writes made on the restarted laptop work again.
    a.act("runners.create", json!({"name":"Lien"})).unwrap();
    wait_until("Lien everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners WHERE name='Lien'") == 1)
    });
    // The group clock: followers measured the leader, offsets on one machine stay near zero.
    assert!(crate::cluster::clock::offset().abs() < 50);
}

#[test]
fn a_cut_off_leader_saves_nothing_and_takes_the_majority_data_when_it_returns() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    a.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // The cut-off leader cannot reach a second laptop: the press is refused, never silently kept.
    let refused = a.act("runners.create", json!({"name":"Alleen op A"}));
    assert!(refused.is_err(), "{refused:?}");
    wait_until("B and C elect a leader", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    b.act("runners.create", json!({"name":"Op de meerderheid"}))
        .unwrap();
    assert_eq!(a.status()["writable"], false);
    // The cable is back: A follows the new leader, its unconfirmed write is gone and it has the majority's data.
    a.node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("A reconciles", Duration::from_secs(15), || {
        same_heads(&[&a, &b, &c])
            && a.count("SELECT COUNT(*) AS n FROM runners WHERE name='Op de meerderheid'") == 1
            && a.count("SELECT COUNT(*) AS n FROM runners WHERE name='Alleen op A'") == 0
    });
    wait_until("healthy again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    assert!(!a.node.is_leader());
}

#[test]
fn a_write_the_majority_never_confirmed_is_not_kept_on_the_leader() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    let off = |s: &TestServer, v: bool| {
        s.node
            .isolated
            .store(v, std::sync::atomic::Ordering::Relaxed)
    };
    let named = |s: &TestServer, name: &str| {
        s.count(&format!(
            "SELECT COUNT(*) AS n FROM runners WHERE name='{name}'"
        ))
    };
    let head = a.head();
    off(&b, true);
    off(&c, true);
    let refused = a.act("runners.create", json!({"name":"Onbevestigd"}));
    let answer = refused.unwrap_err();
    assert!(
        [crate::cluster::NOT_CONFIRMED_MESSAGE, crate::cluster::NO_LEADER_MESSAGE].contains(&answer.as_str()),
        "{answer}"
    );
    // The leader's own data, which its screens read, never held the write.
    assert_eq!(named(&a, "Onbevestigd"), 0);
    assert_eq!(a.head(), head);
    let state: Value = reqwest::blocking::get(format!("{}/api/state", a.url))
        .unwrap()
        .json()
        .unwrap();
    assert!(!state.to_string().contains("Onbevestigd"));

    // A press on the Timing laptop is the exception: the lap stays, also without the others.
    a.act("runners.create", json!({"name":"Te laat"})).unwrap_err();
    off(&b, false);
    off(&c, false);
    wait_until("the group works again", Duration::from_secs(15), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    let timing = [&a, &b, &c][leader_index(&[&a, &b, &c]).unwrap()];
    let others: Vec<&TestServer> = [&a, &b, &c]
        .into_iter()
        .filter(|s| s.port != timing.port)
        .collect();
    for name in ["Zoë", "Wout"] {
        timing
            .act("runners.create", json!({"name":name,"status":"waiting"}))
            .unwrap();
    }
    timing
        .act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(timing, "race.handoff").unwrap();
    off(others[0], true);
    off(others[1], true);
    let _ = press(timing, "race.handoff");
    assert_eq!(timing.count("SELECT COUNT(*) AS n FROM laps"), 1);
    assert_eq!(named(timing, "Te laat"), 0);

    // The others return: the write that was answered as not saved appears nowhere.
    off(others[0], false);
    off(others[1], false);
    wait_until("the group works again", Duration::from_secs(20), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    let leader = [&a, &b, &c][leader_index(&[&a, &b, &c]).unwrap()];
    leader
        .act("runners.create", json!({"name":"Bevestigd"}))
        .unwrap();
    wait_until("every laptop holds the next write", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c]) && [&a, &b, &c].iter().all(|s| named(s, "Bevestigd") == 1)
    });
    for server in [&a, &b, &c] {
        assert_eq!(named(server, "Onbevestigd"), 0);
        assert_eq!(named(server, "Te laat"), 0);
    }
}

/// A leader that inherits an unconfirmed change from an earlier term may not call it saved
/// before a change of its own term is on a majority: until then a laptop that led in between
/// can still win and replace it.
#[test]
fn a_change_answered_as_saved_survives_three_leader_losses_in_a_row() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    let off = |s: &TestServer, v: bool| {
        s.node
            .isolated
            .store(v, std::sync::atomic::Ordering::Relaxed)
    };
    // A change a leader stored in its own data and could not send on, like a Timing press.
    let store_unsent = |s: &TestServer, key: &str| {
        crate::cluster::log::record(&mut s.db.lock().unwrap(), "test.unsent", None, |db| {
            crate::cluster::log::set_replicated(db, key, &json!(true)).map(|_| Value::Null)
        })
        .unwrap();
    };
    let holds = |s: &TestServer, key: &str| {
        crate::cluster::log::setting(&s.db.lock().unwrap(), key).is_some()
    };
    let first_term = a.node.term();
    let place = a.head() + 1;

    // 1. Leader A stores a change and fails before another laptop has it.
    off(&a, true);
    off(&b, true);
    store_unsent(&a, "from-a");
    assert_eq!(a.head(), place);

    // 2. B wins the next term with C's vote, stores a change at the same place and fails before
    //    sending anything. Written as what that election and write leave on disk, so that B
    //    fails at exactly that moment.
    for server in [&b, &c] {
        let db = server.db.lock().unwrap();
        crate::cluster::log::set_local(&db, "cluster_epoch", &(first_term + 1).to_string()).unwrap();
        crate::cluster::log::set_local(
            &db,
            "cluster_voted_for",
            &format!("{}:{}", first_term + 1, b.node.host_id),
        )
        .unwrap();
    }
    store_unsent(&b, "from-b");
    assert_eq!(b.head(), place);

    // 3. A returns, wins with C's vote, copies its old change to C and reports the group settled.
    off(&a, false);
    wait_until("A leads again and its log is on a majority", Duration::from_secs(15), || {
        a.node.is_leader() && a.node.term() > first_term + 1 && a.node.log_settled()
    });
    assert!(holds(&c, "from-a"));

    // 4. A fails again and B returns.
    off(&a, true);
    off(&b, false);
    wait_until("B and C work together", Duration::from_secs(20), || {
        leader_index(&[&b, &c]).is_some() && same_heads(&[&b, &c])
    });

    // 5. Whichever of the two leads, the change that was reported as saved is still there.
    for server in [&b, &c] {
        assert!(holds(server, "from-a"), "the saved change is gone");
        assert!(!holds(server, "from-b"));
    }
    off(&a, false);
    wait_until("three healthy laptops", Duration::from_secs(20), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    for server in [&a, &b, &c] {
        assert!(holds(server, "from-a"));
        assert!(!holds(server, "from-b"));
    }
}
