//! Beheer › Systeem & herstel › Laptops koppelen against two real linked Rust servers: Koppelen
//! by address links them, and "Alleen verder werken" leaves the group once the other is gone.
use super::*;
use crate::cluster::tests::{TestServer, free_port, serial, wait_until};
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
