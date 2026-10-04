import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeltaStore } from '../server/deltas.ts';
import { applyDelta, applyListPatch, isDelta } from '../shared/delta.ts';

type Item = { id: string; name: string; laps: number };
type Body = { revision: number; items: Item[]; other: Item[]; race: { active: string | null }; host: string };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A new lap in front, a runner changed, removed, or moved: what writes do to the lists. */
function nextBody(body: Body, random: () => number, counter: { next: number }): Body {
  const items = [...body.items];
  const pick = () => Math.floor(random() * items.length);
  const roll = random();
  if (roll < 0.4 || items.length === 0) items.unshift({ id: `i${counter.next++}`, name: 'new', laps: 0 });
  else if (roll < 0.6) {
    const index = pick();
    items[index] = { ...items[index], laps: items[index].laps + 1 };
  } else if (roll < 0.75) items.splice(pick(), 1);
  else if (roll < 0.9) {
    const [moved] = items.splice(pick(), 1);
    items.splice(pick(), 0, moved);
  }
  return {
    revision: body.revision + 1,
    items,
    other: random() < 0.2 ? [...body.other, { id: `o${counter.next++}`, name: 'other', laps: 0 }] : body.other,
    race: random() < 0.3 ? { active: `r${counter.next++}` } : body.race,
    host: body.host,
  };
}

test('a delta rebuilds exactly the full response from any kept revision', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = seededRandom(seed);
    const counter = { next: 0 };
    const store = createDeltaStore<Body>({ alwaysSend: ['host'] });
    const history: Body[] = [];
    let body: Body = {
      revision: 1_000,
      items: Array.from({ length: 40 }, () => ({ id: `i${counter.next++}`, name: 'seed', laps: 1 })),
      other: [],
      race: { active: null },
      host: 'http://a',
    };
    for (let step = 0; step < 30; step += 1) {
      store.remember(body);
      history.push(body);
      body = nextBody(body, random, counter);
      for (const base of history.slice(-8)) {
        const delta = store.diff(base.revision, body);
        if (!delta) continue;
        // Over the wire and back, like a screen receives it.
        const received = JSON.parse(JSON.stringify(delta));
        assert.ok(isDelta(received));
        const rebuilt = applyDelta(JSON.parse(JSON.stringify(base)), received);
        assert.equal(
          JSON.stringify(rebuilt),
          JSON.stringify(body),
          `seed ${seed}, step ${step}, base ${base.revision}`
        );
      }
    }
  }
});

test('a new lap in front costs one item and a range', () => {
  const store = createDeltaStore<Body>();
  const items = Array.from({ length: 1_000 }, (_, index) => ({ id: `i${index}`, name: 'lap', laps: index }));
  const base: Body = { revision: 1, items, other: [], race: { active: 'a' }, host: 'h' };
  store.remember(base);
  const delta = store.diff(1, { ...base, revision: 2, items: [{ id: 'new', name: 'lap', laps: 0 }, ...items] });
  assert.deepEqual(delta, {
    since: 1,
    revision: 2,
    changes: {
      items: [{ id: 'new', name: 'lap', laps: 0 }, [0, 1_000]],
    },
  });
});

test('an unknown or newer revision, or mostly new content, is answered in full', () => {
  const store = createDeltaStore<Body>();
  const base: Body = {
    revision: 5,
    items: [{ id: 'a', name: 'a', laps: 0 }],
    other: [],
    race: { active: null },
    host: 'h',
  };
  store.remember(base);
  assert.equal(store.diff(4, base), null);
  assert.equal(store.diff(6, base), null);
  assert.equal(
    store.diff(5, {
      revision: 6,
      items: [{ id: 'b', name: 'b', laps: 1 }],
      other: [],
      race: { active: 'x' },
      host: 'i',
    }),
    null
  );
  assert.deepEqual(store.diff(5, { ...base, revision: 6 }), { since: 5, revision: 6, changes: {} });
});

test('only a fixed number of revisions is kept', () => {
  const store = createDeltaStore<Body>();
  const body = (revision: number): Body => ({ revision, items: [], other: [], race: { active: null }, host: 'h' });
  for (let revision = 1; revision <= 20; revision += 1) store.remember(body(revision));
  assert.equal(store.diff(1, body(21)), null);
  assert.ok(store.diff(20, body(21)));
});

test('a patch that does not fit the list it is applied to is refused', () => {
  assert.throws(() => applyListPatch([1, 2], [[0, 3]]), RangeError);
  assert.deepEqual(applyListPatch(['a', 'b', 'c'], [[1, 3], 'd', [0, 1]]), ['b', 'c', 'd', 'a']);
});
