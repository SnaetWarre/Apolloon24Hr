use std::collections::HashMap;

type Link = Option<usize>;

struct Node {
    left: Link,
    right: Link,
    parent: Link,
    size: usize,
    priority: u64,
}

#[derive(Default)]
pub(super) struct Order {
    root: Link,
    nodes: Vec<Node>,
    free: Vec<usize>,
    ids: HashMap<String, usize>,
    sequence: u64,
}

impl Order {
    fn size(&self, root: Link) -> usize {
        root.map_or(0, |i| self.nodes[i].size)
    }

    fn update(&mut self, root: usize) {
        let node = &self.nodes[root];
        self.nodes[root].size = 1 + self.size(node.left) + self.size(node.right);
    }

    fn child(&mut self, root: usize, child: Link, right: bool) {
        if right {
            self.nodes[root].right = child;
        } else {
            self.nodes[root].left = child;
        }
        if let Some(child) = child {
            self.nodes[child].parent = Some(root);
        }
        self.update(root);
    }

    fn split(&mut self, root: Link, count: usize) -> (Link, Link) {
        let Some(root) = root else {
            return (None, None);
        };
        let left = self.size(self.nodes[root].left);
        self.nodes[root].parent = None;
        if count <= left {
            let (a, b) = self.split(self.nodes[root].left, count);
            self.child(root, b, false);
            (a, Some(root))
        } else {
            let (a, b) = self.split(self.nodes[root].right, count - left - 1);
            self.child(root, a, true);
            (Some(root), b)
        }
    }

    fn merge(&mut self, left: Link, right: Link) -> Link {
        let root = match (left, right) {
            (Some(a), Some(b)) if self.nodes[a].priority < self.nodes[b].priority => {
                let child = self.merge(self.nodes[a].right, right);
                self.child(a, child, true);
                Some(a)
            }
            (Some(_), Some(b)) => {
                let child = self.merge(left, self.nodes[b].left);
                self.child(b, child, false);
                Some(b)
            }
            (a, None) | (None, a) => a,
        };
        if let Some(root) = root {
            self.nodes[root].parent = None;
        }
        root
    }

    pub fn position(&self, id: &str) -> Option<usize> {
        let mut node = *self.ids.get(id)?;
        let mut index = self.size(self.nodes[node].left);
        while let Some(parent) = self.nodes[node].parent {
            if self.nodes[parent].right == Some(node) {
                index += self.size(self.nodes[parent].left) + 1;
            }
            node = parent;
        }
        Some(index)
    }

    pub fn insert(&mut self, index: usize, id: String) {
        self.sequence = self.sequence.wrapping_add(0x9e3779b97f4a7c15);
        let mut priority = self.sequence;
        priority = (priority ^ (priority >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        priority = (priority ^ (priority >> 27)).wrapping_mul(0x94d049bb133111eb);
        let node = Node {
            left: None,
            right: None,
            parent: None,
            size: 1,
            priority: priority ^ (priority >> 31),
        };
        let slot = if let Some(slot) = self.free.pop() {
            self.nodes[slot] = node;
            slot
        } else {
            self.nodes.push(node);
            self.nodes.len() - 1
        };
        self.ids.insert(id, slot);
        let (left, right) = self.split(self.root, index);
        let left = self.merge(left, Some(slot));
        self.root = self.merge(left, right);
    }

    pub fn remove(&mut self, id: &str) {
        let Some(index) = self.position(id) else {
            return;
        };
        let slot = self.ids.remove(id).unwrap();
        let (left, rest) = self.split(self.root, index);
        let (_, right) = self.split(rest, 1);
        self.root = self.merge(left, right);
        self.free.push(slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_match_a_vector_after_insertions_removals_and_slot_reuse() {
        let mut order = Order::default();
        let mut rows = Vec::new();
        for i in 0..2000 {
            let at = (i * 173) % (rows.len() + 1);
            let id = format!("row-{i}");
            order.insert(at, id.clone());
            rows.insert(at, id);
            if i % 3 == 0 {
                let at = (i * 43) % rows.len();
                let id = rows.remove(at);
                order.remove(&id);
                assert_eq!(order.position(&id), None);
            }
            for (index, id) in rows.iter().enumerate() {
                assert_eq!(order.position(id), Some(index));
            }
        }
        assert!(order.nodes.len() <= rows.len() + 1);
    }
}
