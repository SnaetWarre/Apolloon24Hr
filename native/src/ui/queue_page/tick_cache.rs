use super::*;
use std::hash::{DefaultHasher, Hash, Hasher};

#[derive(Default)]
pub(super) struct BoardCache {
    held: Option<Rows>,
}

struct Rows {
    version: u64,
    filtered: Vec<usize>,
    warming: Vec<usize>,
    waiting: Vec<usize>,
    ran: Vec<usize>,
    positions: std::rc::Rc<HashMap<String, usize>>,
}

impl BoardCache {
    pub(super) fn get<'a>(&mut self, s: &'a State) -> Board<'a> {
        let mut hash = DefaultHasher::new();
        (&s.snapshot["runners"], &s.queue_page.filter.text, s.queue_page.show_hidden).hash(&mut hash);
        let version = hash.finish();
        let all = s.snapshot["runners"].as_array().map_or(&[][..], Vec::as_slice);
        if self.held.as_ref().is_none_or(|rows| rows.version != version) {
            let b = board_data_uncached(s);
            let indices = |rows: &[&Value]| rows.iter().map(|r| all.iter().position(|v| std::ptr::eq(*r, v)).unwrap()).collect();
            self.held = Some(Rows {
                version,
                filtered: indices(&b.filtered),
                warming: indices(&b.warming),
                waiting: indices(&b.waiting),
                ran: indices(&b.ran),
                positions: b.positions,
            });
        }
        let rows = self.held.as_ref().unwrap();
        let values = |indices: &[usize]| indices.iter().map(|&i| &all[i]).collect();
        Board {
            filtered: values(&rows.filtered), warming: values(&rows.warming),
            waiting: values(&rows.waiting), ran: values(&rows.ran), positions: rows.positions.clone(),
        }
    }
}

pub(super) fn available_version(s: &State) -> impl Hash + '_ {
    let q = &s.queue_page;
    (
        &s.snapshot["runners"], &q.registrations, &q.available_search,
        q.available_open, brussels_moment(s.clock), s.dark, s.connected, s.busy, s.logos.len(),
    )
}

pub(super) fn clock_visible(s: &State, r: &Value) -> bool {
    let rects = &s.queue_page.rects;
    let Some(viewport) = rects.get(&format!("lane-{}", st(r, "status"))) else { return true };
    let Some(row) = rects.get(&format!("row-{}", st(r, "id"))) else { return true };
    row[0] < viewport[0] + viewport[2] && row[0] + row[2] > viewport[0]
        && row[1] < (viewport[1] + viewport[3]).min(s.queue_page.window_h)
        && row[1] + row[3] > viewport[1].max(0.0)
}
