//! Planning helpers for pre-race linking. Applying a plan requires the replicated runtime.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub number: Option<String>,
}

fn identity(person: &Person) -> (String, String, String) {
    let name = person
        .name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let email = person.email.trim().to_lowercase();
    let phone = person
        .phone
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '.' && *c != '-')
        .collect::<String>()
        .to_lowercase();
    (name, email, phone)
}

#[derive(Debug, PartialEq, Eq)]
pub struct MergePlan {
    /// Each existing person is paired at most once, even when names/contact details repeat.
    pub matched: Vec<(String, String)>,
    pub add: Vec<(String, Option<String>)>,
}

pub fn plan_merge(existing: &[Person], incoming: &[Person]) -> MergePlan {
    let mut people: HashMap<_, VecDeque<_>> = HashMap::new();
    let mut numbers: std::collections::HashSet<String> =
        existing.iter().filter_map(|p| p.number.clone()).collect();
    for person in existing {
        people
            .entry(identity(person))
            .or_default()
            .push_back(person.id.clone());
    }
    let mut plan = MergePlan {
        matched: Vec::new(),
        add: Vec::new(),
    };
    for person in incoming {
        if let Some(id) = people
            .get_mut(&identity(person))
            .and_then(VecDeque::pop_front)
        {
            plan.matched.push((person.id.clone(), id));
        } else {
            let number = person
                .number
                .clone()
                .filter(|n| !n.is_empty() && numbers.insert(n.clone()));
            plan.add.push((person.id.clone(), number));
        }
    }
    plan
}

/// Zero completed laps can still mean the first runner is currently on the track.
pub fn may_merge(race_started_at: Option<i64>, race_finished_at: Option<i64>, laps: u64) -> bool {
    race_started_at.is_none() && race_finished_at.is_none() && laps == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn person(id: &str, name: &str, email: &str, phone: &str, number: &str) -> Person {
        Person {
            id: id.into(),
            name: name.into(),
            email: email.into(),
            phone: phone.into(),
            number: Some(number.into()),
        }
    }
    #[test]
    fn matches_identity_once_and_keeps_people_with_colliding_numbers() {
        let existing = vec![person(
            "a",
            "Zoë  Jans",
            "ZOE@example.org",
            "+32 123-45",
            "7",
        )];
        let incoming = vec![
            person("b", " zoë jans ", "zoe@example.org", "+32.123 45", "7"),
            person("c", "Zoë Jans", "zoe@example.org", "+32 12345", "7"),
            person("d", "Other", "other@example.org", "123", "7"),
        ];
        assert_eq!(
            plan_merge(&existing, &incoming),
            MergePlan {
                matched: vec![("b".into(), "a".into())],
                add: vec![("c".into(), None), ("d".into(), None)]
            }
        );
    }
    #[test]
    fn an_active_first_lap_is_not_a_prerace_database() {
        assert!(may_merge(None, None, 0));
        assert!(!may_merge(Some(123), None, 0));
        assert!(!may_merge(Some(123), Some(456), 0));
        assert!(!may_merge(None, None, 1));
    }
}
