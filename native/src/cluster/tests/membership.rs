use super::*;

#[test]
fn a_lost_laptop_is_taken_out_and_a_spare_takes_its_place() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let c_id = c.status()["hostId"].as_str().unwrap().to_owned();
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    // Refused while it was only briefly away.
    assert!(
        a.act("cluster.removeLaptop", json!({"hostId": c_id}))
            .is_err()
    );
    wait_until("C is removable", Duration::from_secs(10), || {
        a.status()["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["hostId"] == c_id.as_str() && m["removable"] == true)
    });
    // Pressed on the follower B: forwarded to the leader.
    assert!(
        b.act("cluster.removeLaptop", json!({"hostId": c_id}))
            .unwrap()["name"]
            == "Laptop C"
    );
    wait_until("two laptops", Duration::from_secs(5), || {
        b.count("SELECT COUNT(*) AS n FROM cluster_members") == 2
    });
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": b.url})).unwrap();
    wait_until("the spare is in", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &d])
    });
    // The removed laptop comes back on: it is not taken back by itself and says so.
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("C hears it was removed", Duration::from_secs(10), || {
        !c.status()["removedFrom"].is_null()
    });
    assert_eq!(
        c.act("runners.create", json!({"name":"X"})).unwrap_err(),
        crate::cluster::REMOVED_MESSAGE
    );
    assert_eq!(a.status()["members"].as_array().unwrap().len(), 3);
    // Opnieuw koppelen takes it back in with the group's data.
    c.act("cluster.joinGroup", json!({"url": a.url, "rejoin": true}))
        .unwrap();
    wait_until("four laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c, &d])
    });
}

#[test]
fn a_spare_that_links_replaces_a_dead_laptop_and_the_group_survives_one_more_loss() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let c_id = c.status()["hostId"].as_str().unwrap().to_owned();
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    wait_until("C is removable", Duration::from_secs(10), || {
        [&a, &b].iter().any(|s| {
            s.status()["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["hostId"] == c_id.as_str() && m["removable"] == true)
        })
    });
    // Nobody clicks "Uit de groep halen": the spare links and takes the dead laptop's place.
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": b.url})).unwrap();
    wait_until("three laptops again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &d])
    });
    for server in [&a, &b, &d] {
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM cluster_members"),
            3
        );
    }
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == "Laptop C uit de groep gehaald")
    );
    // One more laptop drops out: the two that are left are a majority of three and save.
    let (gone, left) = if a.node.is_leader() {
        (&a, [&b, &d])
    } else {
        (&b, [&a, &d])
    };
    gone.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    wait_until(
        "a leader among the two left",
        Duration::from_secs(10),
        || leader_index(&left).is_some(),
    );
    left[0].act("runners.create", json!({"name":"Na"})).unwrap();
    wait_until("the write is on both", Duration::from_secs(5), || {
        left.iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners WHERE name='Na'") == 1)
    });
    // The replaced laptop comes back on: it is told it was taken out, as after the button.
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("C hears it was removed", Duration::from_secs(10), || {
        !c.status()["removedFrom"].is_null()
    });
}

#[test]
fn a_spare_that_links_while_every_laptop_answers_makes_the_group_one_larger() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("four laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c, &d])
    });
}

#[test]
fn the_retaining_laptop_reports_the_registration_merge() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    for name in ["Zoë", "Jan"] {
        a.act("runners.create", json!({"name":name})).unwrap();
    }
    b.act("runners.create", json!({"name":"Fien"})).unwrap();
    let answer = a.act("cluster.joinGroup", json!({"url":b.url})).unwrap();
    assert_eq!(answer["merged"], true);
    assert!(answer["backupFile"].is_null());
    wait_until("merged registrations", Duration::from_secs(10), || {
        [&a, &b].iter().all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 3)
    });
}

#[test]
fn simultaneous_presses_on_both_laptops_link_once_and_merge_the_registrations() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    a.act("runners.create", json!({"name":"Zoë","runnerNumber":"7"}))
        .unwrap();
    b.act("runners.create", json!({"name":"Jan","runnerNumber":"7"}))
        .unwrap();
    b.act("runners.create", json!({"name":" zoë "})).unwrap();
    let (a_url, b_url) = (a.url.clone(), b.url.clone());
    std::thread::scope(|scope| {
        let pressed_a = scope.spawn(|| a.act("cluster.joinGroup", json!({"url": b_url})));
        let pressed_b = scope.spawn(|| b.act("cluster.joinGroup", json!({"url": a_url})));
        pressed_a.join().unwrap().unwrap();
        pressed_b.join().unwrap().unwrap();
    });
    wait_until("one group of two", Duration::from_secs(10), || {
        all_healthy(&[&a, &b])
    });
    assert_eq!(a.status()["clusterId"], b.status()["clusterId"]);
    for server in [&a, &b] {
        // Zoë once, Jan kept although his number was taken.
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM runners"), 2);
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners WHERE runner_number='7'"),
            1
        );
    }
}

#[test]
fn a_linked_database_without_the_runtime_still_refuses_writes() {
    let _serial = serial();
    let dir = Dir::new();
    let path = dir.db("a");
    {
        let a = TestServer::start(&path, free_port(), "Laptop A");
        let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
        b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
        wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
        a.kill();
        b.kill();
    }
    let mut db = Db::open(&path).unwrap();
    assert!(
        db.mutation("runners.create", &json!({"name":"Solo"}))
            .is_err()
    );
}

#[test]
fn snapshot_install_keeps_this_laptops_identity() {
    let source = Db::open(Path::new(":memory:")).unwrap();
    crate::cluster::log::set_local(&source, "replication_cluster_id", "group").unwrap();
    crate::cluster::log::set_local(&source, "host_id", "leader").unwrap();
    source.exec("INSERT INTO runners(id,name,status,registration_source,created_at,updated_at) VALUES('r','Zoë','registered','manual',1,1)", &[]).unwrap();
    let image = crate::cluster::log::serialize(&source).unwrap();
    let mut target = Db::open(Path::new(":memory:")).unwrap();
    crate::cluster::log::set_local(&target, "host_id", "me").unwrap();
    assert_eq!(crate::cluster::log::install(&mut target, &image).unwrap(), "group");
    assert_eq!(
        crate::cluster::log::setting(&target, "host_id").as_deref(),
        Some("me")
    );
    assert_eq!(target.runners().unwrap().len(), 1);
}
