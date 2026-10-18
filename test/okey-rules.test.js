'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../public/okey-rules');

function makeTiles(entries) {
    return entries.map(([color, value], id) => ({ id, color, value }));
}

test('recognizes runs and uses jokers for missing values', () => {
    const run = makeTiles([['red', 4], ['red', 5], ['red', 6]]);
    const jokerRun = makeTiles([['red', 4], ['joker', 'J'], ['red', 6]]);

    assert.equal(rules.findMeldPartition(run).score, 15);
    assert.equal(rules.findMeldPartition(jokerRun).score, 15);
    assert.equal(rules.findMeldPartition(jokerRun).melds[0].slots[1].value, 5);
});

test('allows 13-1 wrap runs but rejects 13-1-2 runs', () => {
    const wrapped = makeTiles([['red', 12], ['red', 13], ['red', 1]]);
    const invalidWrap = makeTiles([['red', 13], ['red', 1], ['red', 2]]);

    assert.equal(rules.findMeldPartition(wrapped).score, 26);
    assert.equal(rules.findMeldPartition(invalidWrap), null);
    assert.equal(rules.canProcessTile({ id: 10, color: 'red', value: 2 }, {
        type: 'run',
        slots: [
            { color: 'red', value: 12 },
            { color: 'red', value: 13 },
            { color: 'red', value: 1 }
        ]
    }), null);
});

test('uses the actual okey as a wildcard and the fake okey as its face value', () => {
    const hand = makeTiles([['red', 4], ['red', 6]]);
    hand.push({ id: 2, color: 'blue', value: 8, isOkey: true });
    const fakeOkeyRun = [
        { id: 3, color: 'red', value: 4 },
        { id: 4, color: 'fake-joker', value: 'J', representedColor: 'red', representedValue: 5 },
        { id: 5, color: 'red', value: 6 }
    ];

    assert.equal(rules.findMeldPartition(hand).score, 15);
    assert.equal(rules.findMeldPartition(fakeOkeyRun).score, 15);
    assert.equal(rules.getHandPenalty([{ id: 6, color: 'fake-joker', value: 'J', representedValue: 8 }], true), 8);
});

test('assigns the actual okey the missing value in a run', () => {
    const hand = [
        { id: 1, color: 'red', value: 6 },
        { id: 2, color: 'red', value: 11, isOkey: true },
        { id: 3, color: 'red', value: 8 },
        { id: 4, color: 'red', value: 9 }
    ];
    const plan = rules.getBestOpeningPlan(hand, 'series');
    const okeySlot = plan.melds.flatMap(meld => meld.slots).find(slot => slot.tileId === 2);

    assert.equal(plan.score, 30);
    assert.deepEqual(
        plan.melds.flatMap(meld => meld.slots).map(slot => slot.value),
        [6, 7, 8, 9]
    );
    assert.deepEqual(okeySlot, { color: 'red', value: 7, tileId: 2 });
});

test('recognizes a matching pair added to an opened pair meld', () => {
    const handPair = makeTiles([['blue', 8], ['blue', 8]]);
    const openedPair = {
        type: 'pair',
        tiles: makeTiles([['blue', 8], ['blue', 8]])
    };
    const differentPair = {
        type: 'pair',
        tiles: makeTiles([['red', 8], ['red', 8]])
    };

    assert.equal(rules.canProcessPair(handPair, openedPair), true);
    assert.equal(rules.canProcessPair(handPair, differentPair), false);
});

test('allows replacing an okey only with the face it represents', () => {
    const actualTile = { id: 8, color: 'red', value: 5 };
    const wrongTile = { id: 9, color: 'blue', value: 5 };
    const okeyTile = { id: 10, color: 'blue', value: 8, isOkey: true };
    const meld = {
        type: 'run',
        tiles: [{ id: 7, color: 'red', value: 4 }, okeyTile, { id: 11, color: 'red', value: 6 }],
        slots: [
            { color: 'red', value: 4, tileId: 7 },
            { color: 'red', value: 5, tileId: 10 },
            { color: 'red', value: 6, tileId: 11 }
        ]
    };

    assert.equal(rules.canTakeOkey(actualTile, meld).tileId, okeyTile.id);
    assert.equal(rules.canTakeOkey(wrongTile, meld), null);
    assert.equal(rules.getHandPenalty([okeyTile], true), 101);
});

test('marks tiles that can extend a run or complete a set', () => {
    const run = rules.findMeldPartition(makeTiles([['red', 4], ['joker', 'J'], ['red', 6]])).melds[0];
    const set = rules.findMeldPartition(makeTiles([['red', 7], ['blue', 7], ['joker', 'J']])).melds[0];

    assert.ok(rules.canProcessTile({ id: 10, color: 'red', value: 3 }, run));
    assert.ok(rules.canProcessTile({ id: 11, color: 'red', value: 7 }, run));
    assert.equal(rules.canProcessTile({ id: 12, color: 'blue', value: 7 }, run), null);
    assert.ok(rules.canProcessTile({ id: 13, color: 'yellow', value: 7 }, set));
    assert.equal(rules.canProcessTile({ id: 14, color: 'red', value: 7 }, set), null);
});

test('returns a disjoint meld plan for bot decisions', () => {
    const hand = makeTiles([
        ['red', 1], ['red', 2], ['red', 3], ['red', 4],
        ['blue', 8], ['black', 8], ['yellow', 8]
    ]);
    const plan = rules.getBestMeldPlan(hand);

    assert.equal(plan.score, 34);
    assert.equal(new Set(plan.melds.flatMap(meld => meld.tileIds)).size, 7);
});

test('recognizes same-value melds and rejects duplicate-color runs', () => {
    const set = makeTiles([['red', 7], ['blue', 7], ['yellow', 7]]);
    const invalidRun = makeTiles([['red', 5], ['red', 5], ['red', 6]]);

    assert.equal(rules.findMeldPartition(set).score, 21);
    assert.equal(rules.findMeldPartition(invalidRun), null);
});

test('sums the highest non-overlapping melds in a hand', () => {
    const hand = makeTiles([
        ...Array.from({ length: 13 }, (_, index) => ['red', index + 1]),
        ['blue', 10], ['blue', 11], ['blue', 12]
    ]);

    assert.equal(rules.getBestMeldScore(hand), 124);
    assert.equal(rules.validateOpening(hand, 'series').valid, true);
});

test('requires 101 points for an initial series opening', () => {
    const hand = makeTiles(Array.from({ length: 13 }, (_, index) => ['red', index + 1]));

    assert.equal(rules.validateOpening(hand, 'series').score, 91);
    assert.equal(rules.validateOpening(hand, 'series').reason, 'need-more-points');
    assert.equal(rules.validateOpening(hand, 'series', true).valid, true);
});

test('requires five valid pairs for an initial pair opening', () => {
    const pairs = makeTiles([
        ['red', 2], ['red', 2], ['blue', 4], ['blue', 4], ['yellow', 6], ['yellow', 6],
        ['black', 8], ['black', 8], ['red', 10], ['red', 10]
    ]);

    assert.equal(rules.countAvailablePairs(pairs), 5);
    assert.equal(rules.validateOpening(pairs, 'pairs').valid, true);
    assert.equal(rules.validateOpening(pairs.slice(0, 8), 'pairs').reason, 'need-more-pairs');
});

test('calculates end-of-hand penalties for unopened hands and jokers', () => {
    const hand = makeTiles([['red', 7], ['joker', 'J'], ['blue', 3]]);

    assert.equal(rules.getHandPenalty(hand, false), 202);
    assert.equal(rules.getHandPenalty(hand, true), 111);
});

test('builds an automatic opening from the best complete melds and leaves unmatched tiles', () => {
    const hand = makeTiles([
        ['red', 1], ['red', 2], ['red', 3], ['red', 4], ['red', 5], ['red', 6],
        ['red', 7], ['red', 8], ['red', 9], ['red', 10], ['red', 11], ['red', 12], ['red', 13],
        ['blue', 10], ['blue', 11], ['blue', 12], ['yellow', 2]
    ]);
    const plan = rules.getBestOpeningPlan(hand, 'series');

    assert.equal(plan.valid, true);
    assert.equal(plan.score, 124);
    assert.equal(new Set(plan.melds.flatMap(meld => meld.tileIds)).size, 16);
    assert.equal(plan.melds.flatMap(meld => meld.tileIds).includes(hand[16].id), false);
});

test('builds an automatic opening from available pairs without requiring every tile to pair', () => {
    const hand = makeTiles([
        ['red', 2], ['red', 2], ['blue', 4], ['blue', 4], ['yellow', 6], ['yellow', 6],
        ['black', 8], ['black', 8], ['red', 10], ['red', 10], ['yellow', 12], ['yellow', 12], ['blue', 1]
    ]);
    const plan = rules.getBestOpeningPlan(hand, 'pairs');

    assert.equal(plan.valid, true);
    assert.equal(plan.melds.length, 6);
    assert.equal(new Set(plan.melds.flatMap(meld => meld.tileIds)).size, 12);
});

test('keeps at least one tile for the mandatory final discard when opening', () => {
    const hand = makeTiles([
        ...Array.from({ length: 13 }, (_, index) => ['red', index + 1]),
        ['blue', 10], ['blue', 11], ['blue', 12], ['yellow', 1]
    ]);
    const plan = rules.getBestOpeningPlan(hand, 'series');

    assert.equal(plan.valid, true);
    assert.ok(plan.melds.flatMap(meld => meld.tileIds).length < hand.length);
});

test('rejects an unmatched tile in a selected opening', () => {
    const selected = makeTiles([['red', 4], ['red', 5], ['red', 6], ['blue', 9]]);

    assert.equal(rules.validateOpening(selected, 'series').reason, 'invalid-meld');
});
