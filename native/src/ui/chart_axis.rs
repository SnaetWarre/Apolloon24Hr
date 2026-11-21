use rune::TextStyle;

const LABEL_GAP: f32 = 8.0;

pub(super) struct LabelSlot {
    pub(super) x: f32,
    pub(super) width: f32,
}

impl LabelSlot {
    pub(super) fn new<'a>(x: f32, lines: impl IntoIterator<Item = &'a str>, font: TextStyle) -> Self {
        let width = lines
            .into_iter()
            .map(|line| rune::text::measure(line, &[], font, None).0.ceil())
            .fold(0.0, f32::max);
        Self { x, width }
    }

    fn clears(&self, next: &Self) -> bool {
        next.x - self.x >= (self.width + next.width) / 2.0 + LABEL_GAP
    }
}

pub(super) fn visible_labels(ticks: &[LabelSlot]) -> Vec<usize> {
    // Keep a regular cadence; include the end tick only when it still fits.
    for stride in 1..=ticks.len() {
        let mut visible: Vec<_> = (0..ticks.len()).step_by(stride).collect();
        if !visible.windows(2).all(|pair| ticks[pair[0]].clears(&ticks[pair[1]])) {
            continue;
        }
        let last = ticks.len() - 1;
        if visible.last().is_some_and(|&i| i != last && ticks[i].clears(&ticks[last])) {
            visible.push(last);
        }
        return visible;
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_day_labels_thin_on_a_narrow_plot() {
        let hours = |width: f32| {
            (0..24)
                .map(|i| LabelSlot { x: width / 24.0 * (i as f32 + 0.5), width: 42.0 })
                .collect::<Vec<_>>()
        };
        assert_eq!(visible_labels(&hours(1200.0)), (0..24).collect::<Vec<_>>());
        assert_eq!(visible_labels(&hours(480.0)), (0..24).step_by(3).collect::<Vec<_>>());
    }

    #[test]
    fn uneven_ticks_respect_both_label_widths_and_keep_clear_endpoints() {
        let ticks = [(0.0, 10.0), (15.0, 10.0), (40.0, 30.0), (60.0, 20.0), (80.0, 20.0), (115.0, 30.0)]
            .map(|(x, width)| LabelSlot { x, width });
        assert_eq!(visible_labels(&ticks), [0, 2, 4, 5]);
        assert_eq!(visible_labels(&ticks[..2]), [0]);
        assert_eq!(visible_labels(&ticks[..1]), [0]);
        assert!(visible_labels(&[]).is_empty());
    }
}
