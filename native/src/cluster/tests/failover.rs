use super::*;

fn two_down_tune(cfg: &mut Config) {
    cfg.election_timeout = Duration::from_secs(2);
    cfg.write_deadline = Duration::from_secs(1);
    cfg.removable_after = Duration::from_secs(60);
}
/// Remembers who led each term and fails on a second leader in the same term.
fn one_leader_per_term(servers: &[&TestServer], seen: &mut HashMap<i64, String>) {
    for server in servers {
        let st = server.node.raft.lock().unwrap();
        if st.role == crate::cluster::raft::Role::Leader {
            let term = server.node.term();
            let first = seen
                .entry(term)
                .or_insert_with(|| server.node.host_id.clone());
            assert_eq!(first, &server.node.host_id, "two leaders in term {term}");
        }
    }
}
/// Kills the leader and one follower, leaves the third alone past its election timeout, and
/// restarts both from their own files.
fn two_down_and_back(
    dir: &Dir,
    a: TestServer,
    b: TestServer,
    c: &TestServer,
    while_down: impl FnOnce(),
) -> (TestServer, TestServer, Instant) {
    assert!(a.node.is_leader());
    let (a_port, b_port) = (a.port, b.port);
    a.kill();
    b.kill();
    while_down();
    // Long enough for C's election timer (2 to 4 s after the last heartbeat) to run out.
    std::thread::sleep(Duration::from_secs(5));
    let refused = c.act("runners.create", json!({"name":"Alleen op C"}));
    assert!(
        refused.is_err(),
        "C alone saved without a majority: {refused:?}"
    );
    let restarted = Instant::now();
    let a = TestServer::start_with(&dir.db("a"), a_port, "Laptop A", two_down_tune);
    let b = TestServer::start_with(&dir.db("b"), b_port, "Laptop B", two_down_tune);
    (a, b, restarted)
}
fn laps(server: &TestServer) -> i64 {
    server.count("SELECT COUNT(*) AS n FROM laps")
}
fn whole_again(a: &TestServer, b: &TestServer, c: &TestServer, seen: &mut HashMap<i64, String>) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !(all_healthy(&[a, b, c]) && same_heads(&[a, b, c])) {
        one_leader_per_term(&[a, b, c], seen);
        assert!(Instant::now() < deadline, "the group is not whole again");
        std::thread::sleep(Duration::from_millis(5));
    }
    for server in [a, b, c] {
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners WHERE name='Alleen op C'"),
            0
        );
    }
}

#[test]
fn after_two_laptops_were_down_the_group_leads_as_soon_as_a_restarted_laptop_answers() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three_with(&dir, two_down_tune);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&a, "race.handoff").unwrap();
    press(&a, "race.handoff").unwrap();
    wait_until("the lap on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c]) && laps(&c) == 1
    });

    let (a, b, restarted) = two_down_and_back(&dir, a, b, &c, || {});
    let mut seen = HashMap::new();
    while leader_index(&[&a, &b, &c]).is_none() {
        one_leader_per_term(&[&a, &b, &c], &mut seen);
        assert!(restarted.elapsed() < Duration::from_secs(20), "no leader");
        std::thread::sleep(Duration::from_millis(5));
    }
    let waited = restarted.elapsed();
    assert!(
        waited < Duration::from_secs(1),
        "a leader {waited:?} after the restart; the election timeout is 2 to 4 s"
    );
    whole_again(&a, &b, &c, &mut seen);
    press(&b, "race.handoff").unwrap();
    wait_until(
        "the new lap on every laptop",
        Duration::from_secs(5),
        || [&a, &b, &c].iter().all(|s| laps(s) == 2),
    );
}

#[test]
fn a_laptop_left_alone_without_the_last_confirmed_lap_does_not_lead_after_the_others_restart() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three_with(&dir, two_down_tune);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&a, "race.handoff").unwrap();
    press(&a, "race.handoff").unwrap();
    wait_until(
        "the first lap on every laptop",
        Duration::from_secs(5),
        || same_heads(&[&a, &b, &c]) && laps(&c) == 1,
    );
    // C's cable is out: A and B alone confirm the second lap.
    c.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    press(&a, "race.handoff").unwrap();
    assert_eq!(laps(&a), 2);
    wait_until("B holds the second lap", Duration::from_secs(5), || {
        laps(&b) == 2
    });
    assert_eq!(laps(&c), 1);

    let (a, b, _) = two_down_and_back(&dir, a, b, &c, || {
        c.node
            .isolated
            .store(false, std::sync::atomic::Ordering::Relaxed);
    });
    let mut seen = HashMap::new();
    whole_again(&a, &b, &c, &mut seen);
    assert!(
        !seen.values().any(|host| host == &c.node.host_id),
        "C led without the confirmed lap"
    );
    for server in [&a, &b, &c] {
        assert_eq!(laps(server), 2, "the confirmed lap is on every laptop");
    }
}
