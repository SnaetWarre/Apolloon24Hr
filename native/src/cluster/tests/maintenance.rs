use super::*;

#[test]
fn restore_and_clear_replace_the_data_on_every_linked_laptop_after_a_safety_copy_on_the_leader() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    // A backup on follower B holds one runner.
    let backup = crate::backups::create_reason(&dir.db("b"), "manual").unwrap();
    for name in ["Wout", "Mitras"] {
        c.act("runners.create", json!({"name": name})).unwrap();
    }
    wait_until("three runners everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 3)
    });
    // Restore pressed on B: B reads its backup, the leader keeps a safety copy and replaces the data everywhere.
    let restored = b
        .act("backups.restore", json!({"fileName": backup["fileName"]}))
        .unwrap();
    assert_eq!(restored["runners"], 1);
    let safety = restored["safetyBackup"].as_str().unwrap().to_owned();
    assert!(safety.contains("-pre-restore-"));
    // The safety copy is on the laptop that led the write, whichever that was.
    let keeper = [("a", &a), ("b", &b), ("c", &c)]
        .into_iter()
        .find(|(_, s)| restored["safetyHostUrl"] == json!(s.url))
        .expect("the safety copy names a laptop of the group");
    assert!(
        crate::backups::file(&dir.db(keeper.0), &safety).is_ok(),
        "the safety copy is on the leader"
    );
    wait_until("the restore is everywhere", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
            && [&a, &b, &c]
                .iter()
                .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 1)
    });
    // The group itself survives a restore.
    wait_until("healthy after the restore", Duration::from_secs(5), || {
        all_healthy(&[&a, &b, &c])
    });
    // Clearing everything, pressed on C.
    let cleared = c.act("race.clear", json!({"runners": true})).unwrap();
    assert!(
        cleared["safetyBackup"]
            .as_str()
            .unwrap()
            .contains("-pre-clear-")
    );
    wait_until("cleared everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 0)
    });
}

#[test]
fn an_unreachable_laptop_and_its_return_are_listed_in_activity_on_every_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    wait_until("listed as unreachable", Duration::from_secs(10), || {
        activity_summaries(&b)
            .iter()
            .any(|s| s == "Laptop C is niet bereikbaar")
    });
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("listed as back", Duration::from_secs(10), || {
        [&a, &b, &c].iter().all(|s| {
            activity_summaries(s)
                .iter()
                .any(|s| s == "Laptop C is weer bereikbaar")
        })
    });
    assert_eq!(
        activity_summaries(&a)
            .iter()
            .filter(|s| s.as_str() == "Laptop C is niet bereikbaar")
            .count(),
        1
    );
}
