'use strict';

(function exposeRules(root, factory) {
    const rules = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = rules;
    } else {
        root.OkeyRules = rules;
    }
})(globalThis, function createRules() {
    const colors = ['red', 'black', 'yellow', 'blue'];

    function isWildOkey(tile) {
        return tile.isOkey === true || tile.color === 'joker';
    }

    function tileIdentity(tile) {
        if (tile.color === 'fake-joker') {
            return { color: tile.representedColor, value: tile.representedValue };
        }
        return { color: tile.color, value: tile.value };
    }

    function createMeldCandidates(tiles) {
        const candidatesByMask = new Map();

        function addCandidate(indices, type, score, slots) {
            let mask = 0;
            for (const index of indices) mask |= 1 << index;

            const existing = candidatesByMask.get(mask);
            if (!existing || score > existing.score) {
                candidatesByMask.set(mask, {
                    mask,
                    indices: [...indices],
                    type,
                    score,
                    slots,
                    tileIds: indices.map(index => tiles[index].id)
                });
            }
        }

        for (const color of colors) {
            for (let start = 1; start <= 13; start++) {
                for (let length = 2; length <= 13 - start + 1; length++) {
                    const values = Array.from({ length }, (_, index) => start + index);
                    if (values[values.length - 1] === 13 && start > 1) values.push(1);
                    if (values.length < 3) continue;
                    const used = new Set();
                    const indices = [];

                    function chooseRunTile(position) {
                        if (position === values.length) {
                            const slots = indices.map((index, slotIndex) => ({
                                color,
                                value: values[slotIndex],
                                tileId: tiles[index].id
                            }));
                            addCandidate(indices, 'run', values.reduce((sum, value) => sum + value, 0), slots);
                            return;
                        }

                        const value = values[position];
                        for (let index = 0; index < tiles.length; index++) {
                            const tile = tiles[index];
                            const identity = tileIdentity(tile);
                            const matches = identity.color === color && identity.value === value;
                            if ((!matches && !isWildOkey(tile)) || used.has(index)) continue;

                            used.add(index);
                            indices.push(index);
                            chooseRunTile(position + 1);
                            indices.pop();
                            used.delete(index);
                        }
                    }

                    chooseRunTile(0);
                }
            }
        }

        for (let value = 1; value <= 13; value++) {
            for (let length = 3; length <= 4; length++) {
                const used = new Set();
                const indices = [];
                const slotColors = [];

                function chooseSetTile(colorIndex) {
                    if (indices.length === length) {
                        const slots = indices.map((index, slotIndex) => ({
                            color: slotColors[slotIndex],
                            value,
                            tileId: tiles[index].id
                        }));
                        addCandidate(indices, 'set', value * length, slots);
                        return;
                    }
                    if (colorIndex === colors.length || indices.length + colors.length - colorIndex < length) return;

                    const color = colors[colorIndex];
                    for (let index = 0; index < tiles.length; index++) {
                        const tile = tiles[index];
                        const identity = tileIdentity(tile);
                        const matches = identity.color === color && identity.value === value;
                        if ((!matches && !isWildOkey(tile)) || used.has(index)) continue;

                        used.add(index);
                        indices.push(index);
                        slotColors.push(color);
                        chooseSetTile(colorIndex + 1);
                        slotColors.pop();
                        indices.pop();
                        used.delete(index);
                    }
                    chooseSetTile(colorIndex + 1);
                }

                chooseSetTile(0);
            }
        }

        return [...candidatesByMask.values()];
    }

    function indexCandidates(candidates, tileCount) {
        const byTile = Array.from({ length: tileCount }, () => []);
        for (const candidate of candidates) {
            for (const index of candidate.indices) byTile[index].push(candidate);
        }
        return byTile;
    }

    function getBestMeldPlan(tiles, reservedTileId = null) {
        if (!Array.isArray(tiles) || tiles.length === 0 || tiles.length > 30) return { score: 0, melds: [] };

        const byTile = indexCandidates(createMeldCandidates(tiles), tiles.length);
        const memo = new Map([[0, { score: 0, melds: [] }]]);

        function bestPlan(remainingMask) {
            if (memo.has(remainingMask)) return memo.get(remainingMask);

            const firstBit = remainingMask & -remainingMask;
            const firstIndex = 31 - Math.clz32(firstBit);
            let best = bestPlan(remainingMask ^ firstBit);
            if (tiles[firstIndex].id === reservedTileId) {
                memo.set(remainingMask, best);
                return best;
            }

            for (const candidate of byTile[firstIndex]) {
                if ((candidate.mask & remainingMask) !== candidate.mask) continue;

                const remainder = bestPlan(remainingMask ^ candidate.mask);
                const score = candidate.score + remainder.score;
                if (score > best.score) {
                    best = {
                        score,
                        melds: [{
                            type: candidate.type,
                            score: candidate.score,
                            tileIds: candidate.tileIds,
                            slots: candidate.slots
                        }, ...remainder.melds]
                    };
                }
            }

            memo.set(remainingMask, best);
            return best;
        }

        return bestPlan((1 << tiles.length) - 1);
    }

    function getBestMeldScore(tiles) {
        return getBestMeldPlan(tiles).score;
    }

    function findMeldPartition(tiles) {
        if (!Array.isArray(tiles) || tiles.length < 3 || tiles.length > 30) return null;

        const byTile = indexCandidates(createMeldCandidates(tiles), tiles.length);
        const memo = new Map([[0, { score: 0, melds: [] }]]);

        function bestPartition(remainingMask) {
            if (memo.has(remainingMask)) return memo.get(remainingMask);

            const firstBit = remainingMask & -remainingMask;
            const firstIndex = 31 - Math.clz32(firstBit);
            let best = null;

            for (const candidate of byTile[firstIndex]) {
                if ((candidate.mask & remainingMask) !== candidate.mask) continue;

                const remainder = bestPartition(remainingMask ^ candidate.mask);
                if (!remainder) continue;

                const score = candidate.score + remainder.score;
                if (!best || score > best.score) {
                    best = {
                        score,
                        melds: [{ type: candidate.type, score: candidate.score, tileIds: candidate.tileIds, slots: candidate.slots }, ...remainder.melds]
                    };
                }
            }

            memo.set(remainingMask, best);
            return best;
        }

        return bestPartition((1 << tiles.length) - 1);
    }

    function getAvailablePairs(tiles) {
        if (!Array.isArray(tiles)) return [];
        const groups = new Map();
        const wildTiles = [];
        for (const tile of tiles) {
            if (isWildOkey(tile)) {
                wildTiles.push(tile);
                continue;
            }
            const identity = tileIdentity(tile);
            const key = `${identity.color}:${identity.value}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(tile);
        }

        const pairs = [];
        const unpairedTiles = [];
        for (const group of groups.values()) {
            for (let index = 0; index + 1 < group.length; index += 2) {
                pairs.push(createPair(group[index], group[index + 1]));
            }
            if (group.length % 2 === 1) unpairedTiles.push(group[group.length - 1]);
        }

        while (wildTiles.length > 0 && unpairedTiles.length > 0) {
            pairs.push(createPair(unpairedTiles.pop(), wildTiles.pop()));
        }
        while (wildTiles.length >= 2) pairs.push(createPair(wildTiles.pop(), wildTiles.pop()));
        return pairs;
    }

    function createPair(first, second) {
        return {
            type: 'pair',
            score: (typeof first.value === 'number' ? first.value : first.representedValue || 0)
                + (typeof second.value === 'number' ? second.value : second.representedValue || 0),
            tileIds: [first.id, second.id]
        };
    }

    function findPairPartition(tiles) {
        if (!Array.isArray(tiles) || tiles.length < 2 || tiles.length % 2 !== 0) return null;
        const pairs = getAvailablePairs(tiles);
        return pairs.length * 2 === tiles.length ? pairs : null;
    }

    function countAvailablePairs(tiles) {
        return getAvailablePairs(tiles).length;
    }

    function getHandPenalty(tiles, hasOpened) {
        if (!hasOpened) return 202;
        return tiles.reduce((total, tile) => {
            const value = tile.color === 'fake-joker' ? tile.representedValue : tile.value;
            return total + (isWildOkey(tile) ? 101 : value);
        }, 0);
    }

    function canTakeOkey(tile, meld) {
        if (!tile || isWildOkey(tile) || !Array.isArray(meld?.slots)) return null;
        const identity = tileIdentity(tile);
        const jokerSlot = meld.slots.find(slot => {
            const meldTile = meld.tiles?.find(current => current.id === slot.tileId);
            return meldTile && isWildOkey(meldTile)
                && slot.color === identity.color && slot.value === identity.value;
        });
        return jokerSlot || null;
    }

    function canProcessPair(tiles, meld) {
        if (!Array.isArray(tiles) || tiles.length !== 2 || tiles.some(tile => !tile)
            || meld?.type !== 'pair' || !Array.isArray(meld.tiles) || meld.tiles.length < 2) return false;
        const pair = getAvailablePairs(tiles);
        if (pair.length !== 1) return false;

        const targetFace = meld.tiles.find(tile => !isWildOkey(tile));
        if (!targetFace) return true;
        const identity = tileIdentity(targetFace);
        return tiles.every(tile => isWildOkey(tile) || (
            tileIdentity(tile).color === identity.color && tileIdentity(tile).value === identity.value
        ));
    }

    function canProcessTile(tile, meld) {
        if (!tile || isWildOkey(tile) || !Number.isInteger(tile.value) || !Array.isArray(meld?.slots)) return null;

        const slots = meld.slots;
        const identity = tileIdentity(tile);
        if (meld.type === 'run') {
            const first = slots[0];
            const last = slots[slots.length - 1];
            if (!first || !last || identity.color !== first.color) return null;
            const wrapsAfterThirteen = slots.some(slot => slot.value === 13) && slots.some(slot => slot.value === 1);

            if (tile.value === first.value - 1 && tile.value >= 1) {
                return [{ color: identity.color, value: tile.value, tileId: tile.id }, ...slots];
            }
            if (tile.value === last.value + 1 && tile.value <= 13 && !(wrapsAfterThirteen && last.value === 1)) {
                return [...slots, { color: identity.color, value: tile.value, tileId: tile.id }];
            }
            if (last.value === 13 && tile.value === 1 && !slots.some(slot => slot.value === 1)) {
                return [...slots, { color: identity.color, value: tile.value, tileId: tile.id }];
            }
            return null;
        }

        if (meld.type === 'set' && slots.length < 4 && tile.value === slots[0]?.value && !slots.some(slot => slot.color === identity.color)) {
            return [...slots, { color: identity.color, value: tile.value, tileId: tile.id }];
        }

        return null;
    }

    function validateOpening(tiles, type, hasOpened = false) {
        if (type === 'pairs') {
            const melds = findPairPartition(tiles);
            const requiredPairs = hasOpened ? 1 : 5;
            return {
                valid: Boolean(melds) && melds.length >= requiredPairs,
                reason: !melds ? 'invalid-pairs' : melds.length < requiredPairs ? 'need-more-pairs' : null,
                score: melds ? melds.reduce((total, meld) => total + meld.score, 0) : 0,
                melds: melds || [],
                required: requiredPairs
            };
        }

        if (type !== 'series') {
            return { valid: false, reason: 'invalid-type', score: 0, melds: [], required: 101 };
        }

        const partition = findMeldPartition(tiles);
        const requiredScore = hasOpened ? 1 : 101;
        return {
            valid: Boolean(partition) && partition.score >= requiredScore,
            reason: !partition ? 'invalid-meld' : partition.score < requiredScore ? 'need-more-points' : null,
            score: partition ? partition.score : 0,
            melds: partition ? partition.melds : [],
            required: requiredScore
        };
    }

    function getBestOpeningPlan(tiles, type, hasOpened = false) {
        if (type === 'pairs') {
            let melds = [];
            for (const tile of tiles) {
                const remaining = tiles.filter(candidate => candidate.id !== tile.id);
                const candidatePairs = getAvailablePairs(remaining);
                if (candidatePairs.length > melds.length) melds = candidatePairs;
            }
            const required = hasOpened ? 1 : 5;
            return {
                valid: melds.length >= required,
                reason: melds.length >= required ? null : 'need-more-pairs',
                score: melds.reduce((total, meld) => total + meld.score, 0),
                melds,
                required
            };
        }

        if (type !== 'series') {
            return { valid: false, reason: 'invalid-type', score: 0, melds: [], required: 101 };
        }

        let plan = { score: 0, melds: [] };
        for (const tile of tiles) {
            const candidatePlan = getBestMeldPlan(tiles, tile.id);
            if (candidatePlan.score > plan.score) plan = candidatePlan;
        }
        const required = hasOpened ? 1 : 101;
        return {
            valid: plan.score >= required,
            reason: plan.score >= required ? null : 'need-more-points',
            score: plan.score,
            melds: plan.melds,
            required
        };
    }

    return {
        getBestMeldPlan,
        getBestMeldScore,
        findMeldPartition,
        findPairPartition,
        getAvailablePairs,
        countAvailablePairs,
        getHandPenalty,
        canTakeOkey,
        canProcessPair,
        canProcessTile,
        validateOpening,
        getBestOpeningPlan
    };
});
