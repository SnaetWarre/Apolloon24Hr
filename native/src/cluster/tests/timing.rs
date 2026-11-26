use super::*;

#[test]
fn the_timing_laptop_goes_on_alone_by_itself_and_the_splits_join_again() {
    let _serial = serial();
    let dir = Dir::new();
    let tune = |c: &mut Config| c.auto_alone_after = Duration::from_millis(1_500);
    let a = TestServer::start_with(&dir.db("a"), free_port(), "Laptop A", tune);
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", tune);
    let c = TestServer::start_with(&dir.db("c"), free_port(), "Laptop C", tune);
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    c.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("three healthy laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    // Timing opens on C: C clocks; a press on B is refused.
    c.act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    wait_until("B knows C times", Duration::from_secs(5), || {
        b.status()["timing"]["self"] == false
    });
    assert!(
        press(&b, "race.handoff")
            .unwrap_err()
            .contains("Timing staat open op Laptop C")
    );
    press(&c, "race.handoff").unwrap();

    // The router dies for C: after a while C goes on alone and keeps clocking.
    c.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    wait_until("C goes on alone", Duration::from_secs(15), || {
        c.status()["state"] == "solo"
    });
    assert_eq!(c.status()["split"]["rank"], 1);
    press(&c, "race.handoff").unwrap();
    // A and B keep a majority and save what is no lap (Timing is on C).
    wait_until("A and B elect", Duration::from_secs(10), || {
        leader_index(&[&a, &b]).is_some()
    });
    b.act(
        "runners.create",
        json!({"name":"Alleen bij A en B", "runnerNumber":"88"}),
    )
    .unwrap();
    // C hands out the same number meanwhile, to someone else.
    c.act(
        "runners.create",
        json!({"name":"Alleen bij C", "runnerNumber":"88"}),
    )
    .unwrap();

    // B also sends Wout back to the registrations, not knowing C just put Wout on the track.
    let wout = b.db.lock().unwrap().rows("SELECT id FROM runners WHERE name='Wout'", &[]).unwrap()
        [0]["id"]
        .clone();
    b.act("runners.setStatus", json!({"id": wout, "status": "registered"}))
        .unwrap();

    // The network returns: C's split holds the Timing laptop, so A and B follow it, and C
    // first takes what A and B saved meanwhile.
    c.node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("one group again", Duration::from_secs(20), || {
        let split = c.status()["split"]["id"].clone();
        [&a, &b].iter().all(|s| s.status()["split"]["id"] == split) && all_healthy(&[&a, &b, &c])
    });
    for server in [&a, &b, &c] {
        // The lap the Timing laptop clocked alone stays, and so does the runner it put on the track.
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM laps"), 1);
        assert_eq!(
            server
                .count("SELECT COUNT(*) AS n FROM runners WHERE name='Wout' AND status='running'"),
            1
        );
        // What the majority confirmed while C was away is kept, once: also the runner whose
        // number C gave to someone else meanwhile, who comes in without that number.
        assert_eq!(
            server.count(
                "SELECT COUNT(*) AS n FROM runners WHERE name='Alleen bij A en B' AND runner_number IS NULL"
            ),
            1
        );
        assert_eq!(
            server.count(
                "SELECT COUNT(*) AS n FROM runners WHERE name='Alleen bij C' AND runner_number='88'"
            ),
            1
        );
    }
    // The laptops that followed say they worked apart, and where their own copy went.
    let notices: Vec<Value> = [&a, &b]
        .iter()
        .map(|s| s.status()["notice"].clone())
        .collect();
    assert!(
        notices.iter().any(|n| n
            .as_str()
            .is_some_and(|n| n.contains("werkte even apart") && n.contains("backup"))),
        "{notices:?}"
    );
    assert!(c.node.is_leader());
}

/// The Timing laptop loses the other two and the handoff is pressed in the same moment.
fn press_right_after_the_timing_laptop_is_cut_off(timing_leads: bool) {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    let (timing, others) = if timing_leads { (&a, [&b, &c]) } else { (&c, [&a, &b]) };
    assert_eq!(timing.node.is_leader(), timing_leads);
    timing
        .act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(timing, "race.handoff").unwrap();
    wait_until("the start on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
    });

    timing
        .node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let race = timing.db.lock().unwrap().race().unwrap();
    let pressed_at = crate::db::now();
    let pressed = Instant::now();
    timing
        .act(
            "race.handoff",
            json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":pressed_at}),
        )
        .expect("a press right after the outage began was refused");
    // Well inside the time a write may wait, and long before the laptop goes on alone unasked.
    assert!(
        pressed.elapsed() < timing.node.cfg.write_deadline / 2,
        "the press took {:?}",
        pressed.elapsed()
    );
    assert_eq!(timing.count("SELECT COUNT(*) AS n FROM laps"), 1);
    assert_eq!(
        timing.count("SELECT finished_at AS n FROM laps"),
        pressed_at,
        "the lap ends when the key was pressed"
    );
    assert_eq!(timing.status()["state"], "solo");
    // It keeps clocking, and the others take its laps when the network is back.
    press(timing, "race.handoff").unwrap();
    timing
        .node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("one group again", Duration::from_secs(20), || {
        let split = timing.status()["split"]["id"].clone();
        others.iter().all(|s| s.status()["split"]["id"] == split) && all_healthy(&[&a, &b, &c])
    });
    for server in others {
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM laps"), 2);
    }
}

#[test]
fn a_press_right_after_the_timing_laptop_is_cut_off_is_kept() {
    press_right_after_the_timing_laptop_is_cut_off(false);
}

#[test]
fn a_press_right_after_the_leading_timing_laptop_is_cut_off_is_kept() {
    press_right_after_the_timing_laptop_is_cut_off(true);
}

/// The leading Timing laptop's disk stalls on its own copy of a press: the press is confirmed
/// by the two others, and shows there, without waiting for it.
fn press_while_the_timing_laptop_disk_stalls(dir: &Dir) -> (TestServer, TestServer, TestServer, Duration) {
    let (a, b, c) = linked_three(dir);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    assert!(a.node.is_leader());
    a.act("cluster.openTiming", json!({"takeOver": false})).unwrap();
    press(&a, "race.handoff").unwrap();
    wait_until("the start on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
    });
    let stall = Duration::from_secs(3);
    *a.node.slow_disk.lock().unwrap() = stall;
    let pressed = Instant::now();
    let lap = press(&a, "race.handoff").unwrap()["lapId"].clone();
    let took = pressed.elapsed();
    assert!(lap.is_string());
    for other in [&b, &c] {
        assert_eq!(other.count("SELECT COUNT(*) AS n FROM laps"), 1);
    }
    (a, b, c, took)
}

#[test]
fn a_slow_disk_on_the_timing_laptop_does_not_hold_up_its_press() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c, took) = press_while_the_timing_laptop_disk_stalls(&dir);
    assert!(took < Duration::from_millis(1_500), "the press took {took:?}");
    // The next press, made while the first is still on its way to this disk, gets its own place.
    press(&a, "race.handoff").unwrap();
    *a.node.slow_disk.lock().unwrap() = Duration::ZERO;
    wait_until("two laps on every laptop", Duration::from_secs(15), || {
        same_heads(&[&a, &b, &c]) && [&a, &b, &c].iter().all(|s| s.count("SELECT COUNT(*) AS n FROM laps") == 2)
    });
}

#[test]
fn a_press_confirmed_by_the_others_survives_the_timing_laptop_failing() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c, _) = press_while_the_timing_laptop_disk_stalls(&dir);
    let lap = b.db.lock().unwrap().one("SELECT id AS n FROM laps", &[]).unwrap()["n"].clone();
    a.kill();
    wait_until("a new leader", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    b.act("runners.create", json!({"name":"Mitras","status":"waiting"}))
        .unwrap();
    for server in [&b, &c] {
        assert_eq!(
            server.db.lock().unwrap().one("SELECT id AS n FROM laps", &[]).unwrap()["n"],
            lap
        );
    }
}

/// The leader fails while the Timing laptop still reaches a second laptop: the press waits for
/// the takeover and the group stays whole.
#[test]
fn a_press_during_a_takeover_does_not_split_the_group() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    c.act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(&c, "race.handoff").unwrap();
    wait_until("the start on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
    });
    a.kill();
    press(&c, "race.handoff").unwrap();
    assert_eq!(c.status()["split"]["rank"], 0);
    assert_eq!(c.status()["members"].as_array().unwrap().len(), 3);
    wait_until("the lap on B", Duration::from_secs(5), || {
        b.count("SELECT COUNT(*) AS n FROM laps") == 1
    });
}
