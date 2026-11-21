//! Beheer › Systeem & herstel › Laptops koppelen against two real linked Rust servers: Koppelen
//! by address links them, and "Alleen verder werken" leaves the group once the other is gone.
use super::*;
use crate::cluster::tests::{TestServer, beacon, free_port, hear, serial, wait_until};
use rune::{Env, Runtime};

fn update(rt: &mut Runtime<State>, predicate: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(45);
    while !predicate(&rt.state) {
        assert!(
            Instant::now() < deadline,
            "UI did not settle: {}",
            rt.state.error
        );
        rt.update_if(|state, tx| poll(state, 0.0, tx));
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn click(rt: &mut Runtime<State>, key: &str) {
    rt.frame(1.0 / 60.0);
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("Missing UI control {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

#[test]
fn koppelen_links_two_laptops_and_alleen_verder_werken_leaves_the_group() {
    let _serial = serial();
    let memory = std::path::Path::new(":memory:");
    let a = TestServer::start(memory, free_port(), "Laptop A");
    let b = TestServer::start(memory, free_port(), "Laptop B");
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    let mut state = init_with_url(a.url.clone());
    state.page = 8;
    state.admin_section = 6;
    let mut rt = Runtime::new(
        state,
        view,
        (1366.0, 1080.0),
        Env {
            system_dark: false,
            scale: 1.0,
        },
    );
    rt.frame(0.0);
    update(&mut rt, |s| {
        s.connected && s.snapshot["cluster"]["enabled"] == true
    });
    assert_eq!(rt.state.snapshot["cluster"]["state"], "solo");

    // Koppelen by address: confirm, then both laptops form one group.
    click(&mut rt, "cluster-manual");
    click(&mut rt, "cluster-url");
    rt.paste(&b.url);
    rt.frame(1.0 / 60.0);
    // The typed address enables the button on the next frame.
    rt.frame(1.0 / 60.0);
    click(&mut rt, "cluster-manual-join");
    assert_eq!(
        rt.state.confirm.as_ref().map(|c| c.method.as_str()),
        Some("cluster.joinGroup")
    );
    click(&mut rt, "confirm");
    update(&mut rt, |s| !s.busy && s.notice == "Gekoppeld.");
    wait_until("two laptops in one group", Duration::from_secs(10), || {
        [&a, &b]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM cluster_members") == 2)
            && a.status()["state"] == "healthy"
    });
    // A had the runner: B took A's data.
    assert_eq!(
        b.count("SELECT COUNT(*) AS n FROM runners WHERE name='Zoë'"),
        1
    );
    update(&mut rt, |s| {
        s.snapshot["cluster"]["members"]
            .as_array()
            .is_some_and(|m| m.len() == 2)
    });

    // Every screen announces the new group.
    update(&mut rt, |s| {
        s.group
            .toast
            .as_ref()
            .is_some_and(|t| t.title == "Gekoppeld met Laptop B")
    });
    rt.frame(1.0 / 60.0);
    assert!(rt.find("group-toast").is_some(), "the join is announced");

    // Groep testen: a change reaches both laptops and is gone again, the runners untouched.
    let host_b = b.status()["hostId"].as_str().unwrap().to_owned();
    update(&mut rt, |s| s.snapshot["cluster"]["state"] == "healthy" || s.snapshot["cluster"]["state"] == "degraded");
    rt.frame(1.0 / 60.0);
    assert!(rt.find(&format!("setup-laptop-{host_b}")).is_some(), "B has a card");
    click(&mut rt, "cluster-test");
    assert!(rt.state.group.testing);
    update(&mut rt, |s| !s.busy && !s.group.testing);
    assert_eq!(rt.state.group.test["ok"], true, "{}", rt.state.error);
    assert_eq!(rt.state.group.test["total"], 2);
    rt.frame(1.0 / 60.0);
    let at = rt.state.group.test["at"].clone();
    assert!(rt.find(&format!("cluster-test-{at}-{host_b}")).is_some());
    assert_eq!(b.count("SELECT COUNT(*) AS n FROM runners"), 1);
    assert_eq!(
        b.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'cluster_probe:%'"),
        0
    );

    // B breaks for good: A has no majority, and the operator goes on alone.
    b.kill();
    update(&mut rt, |s| s.snapshot["cluster"]["state"] == "no-majority");
    click(&mut rt, "cluster-alone");
    assert_eq!(
        rt.state.confirm.as_ref().map(|c| c.method.as_str()),
        Some("cluster.continueAlone")
    );
    click(&mut rt, "confirm");
    update(&mut rt, |s| {
        !s.busy && s.notice.starts_with("Deze laptop werkt alleen verder")
    });
    assert_eq!(a.count("SELECT COUNT(*) AS n FROM cluster_members"), 1);
    assert_eq!(a.status()["state"], "solo");
    assert_eq!(a.status()["split"]["rank"], 1);
    // Saving works again on the laptop that went on alone.
    a.act("runners.create", json!({"name":"Wout"})).unwrap();
}

#[test]
fn a_joining_or_resyncing_laptop_counts_as_busy_like_the_reference() {
    use super::admin_system::busy_state;
    assert!(busy_state(&json!({"busy": "joining"})));
    assert!(busy_state(&json!({"busy": "resyncing"})));
    assert!(!busy_state(&json!({"busy": null})));
    assert!(!busy_state(&json!({})));
}

#[test]
fn groep_maken_links_three_laptops_gives_roles_and_tests_the_group() {
    let _serial = serial();
    let memory = std::path::Path::new(":memory:");
    let a = TestServer::start(memory, free_port(), "Laptop A");
    let b = TestServer::start(memory, free_port(), "Laptop B");
    let c = TestServer::start(memory, free_port(), "Laptop C");
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    // A hears B and C on the network.
    hear(&a, &beacon(&b, &b.url, "Laptop B"));
    hear(&a, &beacon(&c, &c.url, "Laptop C"));
    let mut state = init_with_url(a.url.clone());
    state.page = 8;
    state.admin_section = 0;
    let mut rt = Runtime::new(state, view, (1366.0, 1400.0), Env { system_dark: false, scale: 1.0 });
    rt.frame(0.0);
    update(&mut rt, |s| {
        s.snapshot["cluster"]["nearby"].as_array().is_some_and(|n| n.len() == 2)
    });
    // Voorbereiding leads to Groep maken.
    click(&mut rt, "preparation-group-open");
    assert_eq!(rt.state.admin_section, 6);
    rt.frame(1.0 / 60.0);
    assert!(rt.find("group-setup").is_some());
    assert!(rt.find("setup-step-1").is_some());

    // One button links both found laptops, one after the other.
    click(&mut rt, "setup-link-all");
    assert_eq!(rt.state.confirm.as_ref().map(|c| c.method.as_str()), Some("cluster.linkAll"));
    click(&mut rt, "confirm");
    update(&mut rt, |s| !s.busy && s.notice.starts_with("2 laptops gekoppeld"));
    wait_until("three laptops in one group", Duration::from_secs(15), || {
        [&a, &b, &c].iter().all(|s| s.count("SELECT COUNT(*) AS n FROM cluster_members") == 3)
    });
    assert_eq!(c.count("SELECT COUNT(*) AS n FROM runners WHERE name='Zoë'"), 1);
    update(&mut rt, |s| s.snapshot["cluster"]["members"].as_array().is_some_and(|m| m.len() == 3));

    // Roles: two presets and one name of our own, on every laptop.
    let id = |s: &TestServer| s.status()["hostId"].as_str().unwrap().to_owned();
    let (host_a, host_b, host_c) = (id(&a), id(&b), id(&c));
    rt.frame(1.0 / 60.0);
    click(&mut rt, &format!("setup-role-{host_a}-timing"));
    update(&mut rt, |s| !s.busy);
    click(&mut rt, &format!("setup-role-{host_b}-wachtrij"));
    update(&mut rt, |s| !s.busy);
    click(&mut rt, &format!("setup-role-{host_c}"));
    rt.paste("Reserve");
    rt.frame(1.0 / 60.0);
    rt.frame(1.0 / 60.0);
    click(&mut rt, &format!("setup-role-save-{host_c}"));
    update(&mut rt, |s| !s.busy && s.notice == "Laptop C is nu Reserve.");
    let roles = |s: &TestServer| -> Vec<(String, Value)> {
        s.status()["members"].as_array().unwrap().iter()
            .map(|m| (m["hostId"].as_str().unwrap().to_owned(), m["role"].clone()))
            .collect()
    };
    wait_until("the roles are on every laptop", Duration::from_secs(5), || {
        [&a, &b, &c].iter().all(|s| {
            let r = roles(s);
            r.contains(&(host_a.clone(), json!("Timing")))
                && r.contains(&(host_b.clone(), json!("Wachtrij")))
                && r.contains(&(host_c.clone(), json!("Reserve")))
        })
    });
    // The sidebar of this laptop names its role.
    update(&mut rt, |s| super::cluster_setup::own_role(s).as_deref() == Some("Timing"));
    rt.frame(1.0 / 60.0);
    assert!(rt.find("laptop-role").is_some(), "the sidebar shows the role");
    assert!(rt.find(&format!("setup-role-tag-{host_b}")).is_some());

    // Groep testen: all three confirm, in plain words.
    update(&mut rt, |s| s.snapshot["cluster"]["state"] == "healthy");
    click(&mut rt, "cluster-test");
    update(&mut rt, |s| !s.busy && !s.group.testing);
    assert_eq!(rt.state.group.test["ok"], true, "{}", rt.state.error);
    assert_eq!(rt.state.group.test["total"], 3);
    rt.frame(1.0 / 60.0);
    assert!(rt.find("setup-test-verdict").is_some());
    assert!(rt.find("setup-step-3").is_some());
    assert_eq!(c.count("SELECT COUNT(*) AS n FROM runners"), 1);
}
