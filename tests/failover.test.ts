import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseLaptop, type GroupAnswer } from '../src/app/useFailover.ts';

const B = 'http://192.168.1.11:3000';
const C = 'http://192.168.1.12:3000';

function answer(url: string, writable: boolean, ownReachable: boolean): GroupAnswer {
  return {
    url,
    status: {
      writable,
      members: [
        { hostId: 'own', reachable: ownReachable },
        { hostId: 'other', reachable: true },
      ],
    },
  };
}

test('a screen moves early once a working group says it lost the screen laptop', () => {
  const answers = [answer(B, true, false), answer(C, true, false)];
  assert.equal(chooseLaptop(answers, 'own', false, 1_900), null, 'a blip shorter than two seconds never moves it');
  assert.equal(chooseLaptop(answers, 'own', false, 2_000), B);
  assert.equal(chooseLaptop([{ url: B, status: null }, answer(C, true, false)], 'own', false, 2_000), C);
});

test('a screen waits while its laptop still answers or the group still reaches it', () => {
  assert.equal(chooseLaptop([answer(B, true, false)], 'own', true, 5_000), null, 'its laptop is back');
  assert.equal(chooseLaptop([answer(B, true, true)], 'own', false, 5_000), null, 'the others still reach it');
  assert.equal(chooseLaptop([answer(B, false, false)], 'own', false, 5_000), null, 'the others have no leader yet');
  assert.equal(chooseLaptop([answer(B, true, false)], null, false, 5_000), null, 'it never learned its laptop');
});

test('after eight seconds a screen moves to any laptop that answers, a working one first', () => {
  assert.equal(chooseLaptop([answer(B, false, true), answer(C, true, true)], 'own', false, 8_000), C);
  assert.equal(chooseLaptop([answer(B, false, true)], null, true, 8_000), B);
  assert.equal(chooseLaptop([{ url: B, status: null }], 'own', false, 8_000), null);
});
