const express = require('express');
const http = require('http');
const path = require('path');
const { randomBytes, randomInt, randomUUID } = require('crypto');
const { Server } = require('socket.io');
const OkeyRules = require('./public/okey-rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_request, response) => {
    response.status(200).json({ status: 'ok' });
});

function createDeck() {
    const colors = ['red', 'black', 'yellow', 'blue'];
    let deck = [];
    let id = 1;

    for (let set = 0; set < 2; set++) {
        for (let color of colors) {
            for (let num = 1; num <= 13; num++) {
                deck.push({ id: id++, color: color, value: num });
            }
        }
    }
    deck.push({ id: id++, color: 'fake-joker', value: 'J' });
    deck.push({ id: id++, color: 'fake-joker', value: 'J' });

    for (let index = deck.length - 1; index > 0; index--) {
        const swapIndex = randomInt(index + 1);
        [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
}

const games = new Map();
const gamesBySocket = new Map();
const reconnectTimers = new Map();
const RECONNECT_GRACE_MS = 45_000;

function createRoomCode() {
    let roomCode;
    do {
        roomCode = randomBytes(3).toString('hex').toUpperCase();
    } while (games.has(roomCode));
    return roomCode;
}

function createPlayer(socket, name, reconnectToken, isHost = false) {
    return {
        id: randomUUID(),
        socketId: socket.id,
        reconnectToken,
        name: name.trim().slice(0, 20) || 'Oyuncu',
        isBot: false,
        isHost,
        connected: true,
        tiles: [],
        hasDrawn: false,
        hasOpened: false,
        openingMode: null,
        totalPoints: 0
    };
}

function getGameForSocket(socket) {
    return gamesBySocket.get(socket.id);
}

function getPlayerForSocket(game, socket) {
    return game?.players.find(player => player.socketId === socket.id);
}

function sendLobbyState(game) {
    io.to(game.roomCode).emit('lobby-state', {
        roomCode: game.roomCode,
        hostId: game.players.find(player => player.isHost)?.id,
        players: game.players.map(player => ({
            id: player.id,
            name: player.name,
            isBot: player.isBot,
            connected: player.connected,
            isHost: player.isHost
        })),
        gameStarted: game.gameStarted
    });
}

function addBotPlayers(game) {
    while (game.players.length < 4) {
        const seat = game.players.length + 1;
        game.players.push({
            id: randomUUID(),
            socketId: null,
            reconnectToken: null,
            name: `Bot ${seat}`,
            isBot: true,
            isHost: false,
            connected: true,
            tiles: [],
            hasDrawn: false,
            hasOpened: false,
            openingMode: null,
            totalPoints: 0
        });
    }
}

function startHand(game) {
    const deck = createDeck();
    const indicatorIndex = deck.findIndex(tile => tile.color !== 'fake-joker');
    const indicator = deck.splice(indicatorIndex, 1)[0];
    const okeyColor = indicator.color;
    const okeyValue = indicator.value === 13 ? 1 : indicator.value + 1;
    for (const tile of deck) {
        if (tile.color === okeyColor && tile.value === okeyValue) tile.isOkey = true;
        if (tile.color === 'fake-joker') {
            tile.representedColor = okeyColor;
            tile.representedValue = okeyValue;
        }
    }
    for (const player of game.players) {
        player.tiles = deck.splice(0, player === game.players[0] ? 22 : 21);
        player.hasDrawn = player === game.players[0];
        player.hasOpened = false;
        player.openingMode = null;
    }
    game.deck = deck;
    game.indicator = indicator;
    game.okey = { color: okeyColor, value: okeyValue };
    game.discardPiles = game.players.map(() => []);
    game.openedMelds = [];
    game.nextMeldId = 1;
    game.currentTurnIndex = 0;
    game.gameStarted = true;
    game.gameOver = false;
    game.firstTurn = true;
    game.result = null;
}

function awardPenalty(player, amount = 101) {
    player.totalPoints += amount;
}

function finishHand(game, winner, reason, winningTile = null) {
    if (game.gameOver) return;

    const multiplier = reason === 'went-out'
        ? (winningTile?.isOkey ? 2 : 1) * (game.players.find(player => player.id === winner)?.openingMode === 'pairs' ? 2 : 1)
        : 1;
    const penalties = game.players.map(player => ({
        playerId: player.id,
        name: player.name,
        opened: player.hasOpened,
        handPenalty: OkeyRules.getHandPenalty(player.tiles, player.hasOpened),
        points: 0,
        totalPoints: player.totalPoints
    }));

    if (reason === 'stock-empty') {
        for (const entry of penalties) entry.points = entry.handPenalty;
        const ranked = [...penalties].sort((first, second) => first.handPenalty - second.handPenalty);
        winner = ranked[0].handPenalty === ranked[1].handPenalty ? null : ranked[0].playerId;
    } else {
        for (const entry of penalties) {
            if (entry.playerId === winner) {
                entry.points = -101 * multiplier;
            } else if (!entry.opened) {
                entry.points = 202 * multiplier;
            } else {
                entry.points = entry.handPenalty * multiplier;
            }
        }
    }
    for (const entry of penalties) {
        const player = game.players.find(current => current.id === entry.playerId);
        player.totalPoints += entry.points;
        entry.totalPoints = player.totalPoints;
    }
    game.gameOver = true;
    game.result = {
        winnerId: winner,
        reason,
        multiplier,
        lastDiscardWasOkey: Boolean(winningTile?.isOkey),
        penalties
    };
}

function storeOpenedMelds(game, player, melds, openingMode) {
    const handTilesById = new Map(player.tiles.map(tile => [tile.id, tile]));
    const openedTileIds = new Set(melds.flatMap(meld => meld.tileIds));
    player.tiles = player.tiles.filter(tile => !openedTileIds.has(tile.id));
    player.hasOpened = true;
    player.openingMode = openingMode;

    for (const meld of melds) {
        game.openedMelds.push({
            id: game.nextMeldId++,
            ownerId: player.id,
            ownerName: player.name,
            type: meld.type,
            score: meld.score,
            slots: meld.slots || null,
            tiles: meld.tileIds.map(id => handTilesById.get(id))
        });
    }
}

function canPlayerProcessTile(player, tile, meld) {
    if (player.openingMode !== 'series' || meld.type === 'pair') return null;
    return OkeyRules.canProcessTile(tile, meld);
}

function processPairIntoMeld(player, tiles, meld) {
    const tileIds = new Set(tiles.map(tile => tile.id));
    player.tiles = player.tiles.filter(tile => !tileIds.has(tile.id));
    meld.tiles.push(...tiles);
    const face = meld.tiles.find(tile => !tile.isOkey && tile.color !== 'fake-joker');
    const value = face?.value || meld.tiles.find(tile => tile.color === 'fake-joker')?.representedValue || 0;
    meld.score = value * meld.tiles.length;
}

function processTileIntoMeld(player, tile, meld, nextSlots) {
    player.tiles = player.tiles.filter(handTile => handTile.id !== tile.id);
    const meldTilesById = new Map(meld.tiles.map(meldTile => [meldTile.id, meldTile]));
    meldTilesById.set(tile.id, tile);
    meld.slots = nextSlots;
    meld.tiles = nextSlots.map(slot => meldTilesById.get(slot.tileId));
    meld.score = meld.type === 'run'
        ? nextSlots.reduce((total, slot) => total + slot.value, 0)
        : nextSlots[0].value * nextSlots.length;
}

function performBotMeldActions(game, player) {
    if (!player.hasOpened) {
        const seriesPlan = OkeyRules.getBestOpeningPlan(player.tiles, 'series');
        const pairPlan = OkeyRules.getBestOpeningPlan(player.tiles, 'pairs');
        if (seriesPlan.valid) {
            storeOpenedMelds(game, player, seriesPlan.melds, 'series');
        } else if (pairPlan.valid) {
            storeOpenedMelds(game, player, pairPlan.melds, 'pairs');
        }
    }

    if (!player.hasOpened) return;
    if (player.openingMode === 'pairs') {
        for (const pair of OkeyRules.getAvailablePairs(player.tiles)) {
            if (player.tiles.length <= 2) break;
            const tiles = pair.tileIds.map(id => player.tiles.find(tile => tile.id === id));
            const targetMeld = game.openedMelds.find(meld => OkeyRules.canProcessPair(tiles, meld));
            if (targetMeld) processPairIntoMeld(player, tiles, targetMeld);
        }
        return;
    }

    for (const tile of [...player.tiles]) {
        const targetMeld = game.openedMelds.find(meld => canPlayerProcessTile(player, tile, meld));
        if (targetMeld && player.tiles.length > 1) {
            processTileIntoMeld(player, tile, targetMeld, canPlayerProcessTile(player, tile, targetMeld));
        }
    }
}

function getBotDiscardIndex(tiles) {
    let lowestUtility = Infinity;
    let candidates = [];

    tiles.forEach((tile, index) => {
        if (tile.isOkey || tile.color === 'joker') return;
        const tileValue = Number.isInteger(tile.value) ? tile.value : tile.representedValue;

        let utility = 0;
        for (const otherTile of tiles) {
            if (otherTile.id === tile.id) continue;
            const otherValue = Number.isInteger(otherTile.value) ? otherTile.value : otherTile.representedValue;
            const tileColor = tile.color === 'fake-joker' ? tile.representedColor : tile.color;
            const otherColor = otherTile.color === 'fake-joker' ? otherTile.representedColor : otherTile.color;
            if (otherColor === tileColor && Number.isInteger(otherValue)) {
                const distance = Math.abs(otherValue - tileValue);
                if (distance === 0) utility += 2.5;
                else if (distance === 1) utility += 4;
                else if (distance === 2) utility += 1.5;
            }
            if (otherValue === tileValue && otherColor !== tileColor) utility += 1.5;
        }

        utility -= tileValue / 100;
        if (utility < lowestUtility) {
            lowestUtility = utility;
            candidates = [index];
        } else if (utility === lowestUtility) {
            candidates.push(index);
        }
    });

    if (candidates.length === 0) return Math.floor(Math.random() * tiles.length);
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function checkBotTurn(game) {
    const currentPlayer = game.players[game.currentTurnIndex];
    if (currentPlayer && currentPlayer.isBot && game.gameStarted && !game.gameOver) {
        setTimeout(() => {
            if (games.get(game.roomCode) !== game || !game.gameStarted || game.gameOver || !currentPlayer.isBot) return;

            const playerIndex = game.players.indexOf(currentPlayer);
            if (game.deck.length > 0) {
                currentPlayer.tiles.push(game.deck.pop());
            } else {
                const leftPlayerIndex = (playerIndex + game.players.length - 1) % game.players.length;
                const leftDiscardPile = game.discardPiles[leftPlayerIndex];
                const discardedTile = leftDiscardPile[leftDiscardPile.length - 1];
                if (!discardedTile) {
                    finishHand(game, null, 'stock-empty');
                    broadcastState(game);
                    return;
                }

                let opening = null;
                let processMeld = null;
                if (currentPlayer.hasOpened && currentPlayer.openingMode === 'series') {
                    processMeld = game.openedMelds.find(meld => canPlayerProcessTile(currentPlayer, discardedTile, meld));
                } else if (!currentPlayer.hasOpened) {
                    const handWithDiscard = [...currentPlayer.tiles, discardedTile];
                    opening = ['series', 'pairs']
                        .map(type => ({ type, plan: OkeyRules.getBestOpeningPlan(handWithDiscard, type) }))
                        .find(candidate => candidate.plan.valid
                            && candidate.plan.melds.some(meld => meld.tileIds.includes(discardedTile.id)));
                }
                if (!opening && !processMeld) {
                    finishHand(game, null, 'stock-empty');
                    broadcastState(game);
                    return;
                }

                leftDiscardPile.pop();
                currentPlayer.tiles.push(discardedTile);
                currentPlayer.hasDrawn = true;
                if (opening) {
                    storeOpenedMelds(game, currentPlayer, opening.plan.melds, opening.type);
                } else {
                    processTileIntoMeld(currentPlayer, discardedTile, processMeld,
                        canPlayerProcessTile(currentPlayer, discardedTile, processMeld));
                }
            }

            currentPlayer.hasDrawn = true;
            performBotMeldActions(game, currentPlayer);
            if (currentPlayer.tiles.length > 0) {
                const discardIndex = getBotDiscardIndex(currentPlayer.tiles);
                const discardedTile = currentPlayer.tiles.splice(discardIndex, 1)[0];
                if (game.openedMelds.some(meld => game.players.some(owner =>
                    canPlayerProcessTile(owner, discardedTile, meld)))) {
                    awardPenalty(currentPlayer);
                }
                game.discardPiles[playerIndex].push(discardedTile);
                if (currentPlayer.tiles.length === 0) {
                    finishHand(game, currentPlayer.id, 'went-out', discardedTile);
                }
            }
            currentPlayer.hasDrawn = false;
            if (game.gameOver) {
                broadcastState(game);
                return;
            }
            game.currentTurnIndex = (game.currentTurnIndex + 1) % game.players.length;
            broadcastState(game);
            checkBotTurn(game);
        }, 1500);
    }
}

io.on('connection', (socket) => {
    console.log('Oyuncu bağlandı:', socket.id);

    socket.on('create-room', (payload = {}) => {
        if (gamesBySocket.has(socket.id)) {
            socket.emit('room-error', 'Yeni oda kurmadan önce mevcut odadan ayrıl.');
            return;
        }
        const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : '';
        const roomCode = createRoomCode();
        const playerToken = randomUUID();
        const player = createPlayer(socket, name || 'Oyuncu 1', playerToken, true);
        const game = {
            roomCode,
            players: [player],
            gameStarted: false,
            gameOver: false
        };
        games.set(roomCode, game);
        gamesBySocket.set(socket.id, game);
        socket.join(roomCode);
        socket.emit('room-created', { roomCode, playerToken });
        socket.emit('player-session', { roomCode, playerToken, playerId: player.id });
        sendLobbyState(game);
    });

    socket.on('join-room', (payload = {}) => {
        const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode.trim().toUpperCase() : '';
        const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : '';
        const playerToken = typeof payload?.playerToken === 'string' ? payload.playerToken : '';
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('room-error', 'Bu oda bulunamadı veya kapatıldı.');
            return;
        }

        const reconnectingPlayer = playerToken
            ? game.players.find(player => player.reconnectToken === playerToken && !player.connected)
            : null;
        if (reconnectingPlayer) {
            const timer = reconnectTimers.get(reconnectingPlayer.id);
            if (timer) clearTimeout(timer);
            reconnectTimers.delete(reconnectingPlayer.id);
            reconnectingPlayer.socketId = socket.id;
            reconnectingPlayer.connected = true;
            reconnectingPlayer.isBot = false;
            reconnectingPlayer.name = reconnectingPlayer.name.replace(/ \(Bot\)$/, '');
            gamesBySocket.set(socket.id, game);
            socket.join(roomCode);
            socket.emit('player-session', { roomCode, playerToken, playerId: reconnectingPlayer.id });
            sendLobbyState(game);
            if (game.gameStarted) broadcastState(game);
            return;
        }
        if (playerToken && game.players.some(player => player.reconnectToken === playerToken)) {
            socket.emit('room-error', 'Bu oyuncu hesabı zaten odada bağlı.');
            return;
        }

        if (game.gameStarted) {
            socket.emit('room-error', 'Bu oyun zaten başladı; davet bağlantısıyla oyuncu tekrar bağlanmalı.');
            return;
        }
        if (game.players.length >= 4) {
            socket.emit('room-error', 'Oda dolu. Oda sahibinden botlarla başlatmasını isteyin.');
            return;
        }
        if (gamesBySocket.has(socket.id)) {
            socket.emit('room-error', 'Zaten başka bir odadasın.');
            return;
        }

        const newPlayerToken = randomUUID();
        const player = createPlayer(socket, name || `Oyuncu ${game.players.length + 1}`, newPlayerToken);
        game.players.push(player);
        gamesBySocket.set(socket.id, game);
        socket.join(roomCode);
        socket.emit('player-session', { roomCode, playerToken: newPlayerToken, playerId: player.id });
        sendLobbyState(game);
    });

    socket.on('start-room-game', () => {
        const game = getGameForSocket(socket);
        const player = getPlayerForSocket(game, socket);
        if (!game || !player?.isHost || game.gameStarted) return;
        addBotPlayers(game);
        startHand(game);
        sendLobbyState(game);
        broadcastState(game);
        checkBotTurn(game);
    });

    socket.on('next-hand', () => {
        const game = getGameForSocket(socket);
        const player = getPlayerForSocket(game, socket);
        if (!game?.gameStarted || !game.gameOver || !player?.isHost) return;
        startHand(game);
        broadcastState(game);
    });

    socket.on('draw-tile', () => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const player = getPlayerForSocket(game, socket);
        if (!player) return;
        if (game.players[game.currentTurnIndex]?.id !== player.id) {
            awardPenalty(player);
            socket.emit('action-error', 'Sıra sende değil.');
            broadcastState(game);
            return;
        }
        if (player.hasDrawn) {
            socket.emit('action-error', 'Bu tur zaten taş çektin.');
            return;
        }
        if (game.deck.length === 0) {
            const playerIndex = game.players.indexOf(player);
            const leftPlayerIndex = (playerIndex + game.players.length - 1) % game.players.length;
            const discardPile = game.discardPiles[leftPlayerIndex];
            if (discardPile.length === 0) {
                finishHand(game, null, 'stock-empty');
                broadcastState(game);
            } else {
                socket.emit('action-error', 'Deste bitti; solundaki oyuncunun son taşını alıp el açmalısın.');
            }
            return;
        }

        player.tiles.push(game.deck.pop());
        player.hasDrawn = true;
        broadcastState(game);
    });

    socket.on('draw-discard', () => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const player = getPlayerForSocket(game, socket);
        if (!player) return;
        if (game.players[game.currentTurnIndex]?.id !== player.id) {
            awardPenalty(player);
            socket.emit('action-error', 'Sıra sende değil.');
            broadcastState(game);
            return;
        }
        if (player.hasDrawn) {
            socket.emit('action-error', 'Bu tur zaten taş çektin.');
            return;
        }

        const playerIndex = game.players.indexOf(player);
        const leftPlayerIndex = (playerIndex + game.players.length - 1) % game.players.length;
        const discardPile = game.discardPiles[leftPlayerIndex];
        const discardedTile = discardPile[discardPile.length - 1];
        if (!discardedTile) {
            if (game.deck.length === 0) {
                finishHand(game, null, 'stock-empty');
                broadcastState(game);
                return;
            }
            socket.emit('action-error', 'Atılan taş yok.');
            return;
        }

        let opening = null;
        let processMeld = null;
        if (player.hasOpened && player.openingMode === 'series') {
            processMeld = game.openedMelds.find(meld => canPlayerProcessTile(player, discardedTile, meld));
        } else if (!player.hasOpened) {
            const handWithDiscard = [...player.tiles, discardedTile];
            opening = ['series', 'pairs']
                .map(type => ({ type, plan: OkeyRules.getBestOpeningPlan(handWithDiscard, type) }))
                .find(candidate => candidate.plan.valid
                    && candidate.plan.melds.some(meld => meld.tileIds.includes(discardedTile.id)));
        }
        if (!opening && !processMeld) {
            awardPenalty(player);
            socket.emit('action-error', player.hasOpened
                ? 'Solundaki taşı ancak masadaki perine işleyebiliyorsan alabilirsin. +101 ceza.'
                : 'Solundaki taşı yalnızca o taşla birlikte el açabiliyorsan alabilirsin. +101 ceza.');
            if (game.deck.length === 0) finishHand(game, null, 'stock-empty');
            broadcastState(game);
            return;
        }

        discardPile.pop();
        player.tiles.push(discardedTile);
        player.hasDrawn = true;
        if (opening) {
            storeOpenedMelds(game, player, opening.plan.melds, opening.type);
        } else {
            processTileIntoMeld(player, discardedTile, processMeld, canPlayerProcessTile(player, discardedTile, processMeld));
        }
        broadcastState(game);
    });

    socket.on('open-meld', (payload) => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const { type } = payload && typeof payload === 'object' ? payload : {};

        const player = getPlayerForSocket(game, socket);
        if (!player || game.players[game.currentTurnIndex]?.id !== player.id || !player.hasDrawn) {
            socket.emit('action-error', 'Per açmak için önce sıranda taş çekmelisin.');
            return;
        }
        if (game.firstTurn) {
            socket.emit('action-error', 'İlk başlayan oyuncu önce 22 taşından birini atmalı.');
            return;
        }
        if (player.hasOpened) {
            socket.emit('action-error', 'Elini bu turda zaten açtın.');
            return;
        }
        const result = OkeyRules.getBestOpeningPlan(player.tiles, type, player.hasOpened);
        if (!result.valid) {
            const message = result.reason === 'need-more-points'
                ? `Per toplamın ${result.score}. Açmak için en az ${result.required} puan gerekli.`
                : result.reason === 'need-more-pairs'
                    ? `Açmak için en az ${result.required} çift gerekli; elinde ${result.melds.length} çift var.`
                    : type === 'pairs'
                        ? 'Eldeki taşlar geçerli çift oluşturmuyor.'
                        : 'Eldeki taşlar geçerli per oluşturmuyor.';
            socket.emit('action-error', message);
            return;
        }

        storeOpenedMelds(game, player, result.melds, type);
        broadcastState(game);
    });

    socket.on('process-tile', (payload) => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const { tileId, meldId } = payload && typeof payload === 'object' ? payload : {};
        const player = getPlayerForSocket(game, socket);
        if (!player || game.players[game.currentTurnIndex]?.id !== player.id || !player.hasDrawn || !player.hasOpened) {
            socket.emit('action-error', 'Taş işlemek için açmış olmalı ve sıranda olmalısın.');
            return;
        }
        if (!Number.isSafeInteger(tileId) || !Number.isSafeInteger(meldId)) {
            socket.emit('action-error', 'İşlenecek taşı ve peri seç.');
            return;
        }

        const tile = player.tiles.find(handTile => handTile.id === tileId);
        const meld = game.openedMelds.find(openedMeld => openedMeld.id === meldId);
        if (player.tiles.length <= 1) {
            socket.emit('action-error', 'Son taşını pere işleyemezsin; bitiş taşı olarak atmalısın.');
            return;
        }
        const nextSlots = tile && meld ? canPlayerProcessTile(player, tile, meld) : null;
        if (!nextSlots) {
            socket.emit('action-error', 'Bu taş seçilen pere işlek değil.');
            return;
        }

        processTileIntoMeld(player, tile, meld, nextSlots);
        broadcastState(game);
    });

    socket.on('process-pair', (payload) => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const { tileIds, meldId } = payload && typeof payload === 'object' ? payload : {};
        const player = getPlayerForSocket(game, socket);
        if (!player || game.players[game.currentTurnIndex]?.id !== player.id || !player.hasDrawn
            || player.openingMode !== 'pairs') {
            socket.emit('action-error', 'Çift işlemek için çift açmış olmalı ve sıranda taş çekmiş olmalısın.');
            return;
        }
        if (!Array.isArray(tileIds) || tileIds.length !== 2 || new Set(tileIds).size !== 2
            || tileIds.some(id => !Number.isSafeInteger(id)) || !Number.isSafeInteger(meldId)) {
            socket.emit('action-error', 'İşlemek için aynı çifte ait iki taş seç.');
            return;
        }
        if (player.tiles.length <= 2) {
            socket.emit('action-error', 'Bitiş taşını çift olarak işleyemezsin; atmalısın.');
            return;
        }

        const tiles = tileIds.map(id => player.tiles.find(tile => tile.id === id));
        const meld = game.openedMelds.find(openedMeld => openedMeld.id === meldId);
        if (tiles.some(tile => !tile) || !OkeyRules.canProcessPair(tiles, meld)) {
            socket.emit('action-error', 'Seçtiğin iki taş açık olan çiftle aynı değil.');
            return;
        }
        processPairIntoMeld(player, tiles, meld);
        broadcastState(game);
    });

    socket.on('take-oke', (payload) => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver) return;

        const { tileId, meldId } = payload && typeof payload === 'object' ? payload : {};
        const player = getPlayerForSocket(game, socket);
        if (!player || game.players[game.currentTurnIndex]?.id !== player.id || !player.hasDrawn || !player.hasOpened
            || player.openingMode !== 'series') {
            socket.emit('action-error', 'Okey almak için seri açmış olmalı ve sıranda taş çekmiş olmalısın.');
            return;
        }
        if (!Number.isSafeInteger(tileId) || !Number.isSafeInteger(meldId)) {
            socket.emit('action-error', 'Okeyin yerine koyacağın taşı ve peri seç.');
            return;
        }

        const tile = player.tiles.find(handTile => handTile.id === tileId);
        const meld = game.openedMelds.find(openedMeld => openedMeld.id === meldId);
        const okeySlot = tile && meld ? OkeyRules.canTakeOkey(tile, meld) : null;
        if (!okeySlot || player.tiles.length <= 1) {
            socket.emit('action-error', 'Seçtiğin taş bu perin okeyinin yerine geçmiyor veya son taşın.');
            return;
        }

        const replacedOkey = meld.tiles.find(meldTile => meldTile.id === okeySlot.tileId);
        if (!replacedOkey) {
            socket.emit('action-error', 'Perdeki okey bulunamadı.');
            return;
        }
        const nextSlots = meld.slots.map(slot => slot.tileId === okeySlot.tileId
            ? { ...slot, tileId: tile.id }
            : slot);
        processTileIntoMeld(player, tile, meld, nextSlots);
        player.tiles.push(replacedOkey);
        broadcastState(game);
    });

    socket.on('discard-tile', (tileId) => {
        const game = getGameForSocket(socket);
        if (!game?.gameStarted || game.gameOver || !Number.isSafeInteger(tileId)) return;

        const player = getPlayerForSocket(game, socket);
        if (!player) return;
        if (game.players[game.currentTurnIndex]?.id !== player.id || !player.hasDrawn) {
            awardPenalty(player);
            socket.emit('action-error', 'Taş atmak için sıra sende ve taş çekmiş olmalısın. +101 ceza.');
            broadcastState(game);
            return;
        }
        const index = player.tiles.findIndex(t => t.id === tileId);
        if (index !== -1) {
            const discarded = player.tiles.splice(index, 1)[0];
            const playerIndex = game.players.indexOf(player);
            const canBeProcessed = game.openedMelds.some(meld => game.players.some(owner =>
                canPlayerProcessTile(owner, discarded, meld)));
            if (canBeProcessed) awardPenalty(player);
            game.discardPiles[playerIndex].push(discarded);
            player.hasDrawn = false;
            if (game.firstTurn) game.firstTurn = false;
            if (player.tiles.length === 0 && player.hasOpened) {
                finishHand(game, player.id, 'went-out', discarded);
            }
            if (game.gameOver) {
                broadcastState(game);
                return;
            }
            game.currentTurnIndex = (game.currentTurnIndex + 1) % game.players.length;
            broadcastState(game);
            checkBotTurn(game);
        }
    });

    socket.on('leave-table', () => {
        const game = getGameForSocket(socket);
        const player = getPlayerForSocket(game, socket);
        if (game && player) {
            if (game.gameStarted && !game.gameOver) {
                player.socketId = null;
                player.connected = false;
                player.isBot = true;
                player.name = `${player.name} (Bot)`;
                if (player.isHost) {
                    const nextHost = game.players.find(candidate => candidate !== player
                        && candidate.connected && !candidate.isBot);
                    if (nextHost) {
                        player.isHost = false;
                        nextHost.isHost = true;
                    }
                }
                broadcastState(game);
            } else {
                game.players = game.players.filter(current => current !== player);
                if (player.isHost && game.players.length) game.players[0].isHost = true;
                if (game.players.length === 0) games.delete(game.roomCode);
                else sendLobbyState(game);
            }
        }
        gamesBySocket.delete(socket.id);
        if (game) socket.leave(game.roomCode);
        socket.emit('return-menu');
        if (game?.gameStarted && !game.gameOver) checkBotTurn(game);
    });

    socket.on('disconnect', () => {
        const game = getGameForSocket(socket);
        const player = getPlayerForSocket(game, socket);
        gamesBySocket.delete(socket.id);
        if (game && player) {
            player.socketId = null;
            player.connected = false;
            sendLobbyState(game);
            const timer = setTimeout(() => {
                reconnectTimers.delete(player.id);
                if (player.connected || !games.has(game.roomCode)) return;
                player.isBot = true;
                player.name = `${player.name} (Bot)`;
                if (player.isHost) {
                    const nextHost = game.players.find(candidate => candidate.connected && !candidate.isBot);
                    if (nextHost) {
                        player.isHost = false;
                        nextHost.isHost = true;
                    }
                    else if (!game.gameStarted) {
                        games.delete(game.roomCode);
                        io.to(game.roomCode).emit('room-error', 'Oda sahibi ayrıldığı için oda kapatıldı.');
                        return;
                    }
                }
                if (game.gameStarted) {
                    if (!game.players.some(candidate => candidate.connected && !candidate.isBot)) {
                        games.delete(game.roomCode);
                        io.to(game.roomCode).emit('room-error', 'Odada bağlı oyuncu kalmadığı için oyun kapatıldı.');
                        return;
                    }
                    broadcastState(game);
                    checkBotTurn(game);
                } else {
                    sendLobbyState(game);
                }
            }, RECONNECT_GRACE_MS);
            reconnectTimers.set(player.id, timer);
        }
        console.log('Oyuncu ayrıldı:', socket.id);
    });
});

function broadcastState(game) {
    for (const [socketId, connectedGame] of gamesBySocket) {
        if (connectedGame !== game) continue;
        const viewer = game.players.find(player => player.socketId === socketId);
        if (!viewer) continue;
        const viewerIndex = game.players.indexOf(viewer);
        const leftPlayerIndex = (viewerIndex + game.players.length - 1) % game.players.length;
        const orderedPlayers = game.players.map((_, index) =>
            game.players[(viewerIndex + index) % game.players.length]);
        io.to(socketId).emit('game-state', {
            myPlayerId: viewer.id,
            players: orderedPlayers.map(player => ({
                id: player.id,
                name: player.name,
                isBot: player.isBot,
                connected: player.connected,
                isHost: player.isHost,
                ...(player.id === viewer.id
                    ? {
                        tiles: player.tiles,
                        hasDrawn: player.hasDrawn,
                        hasOpened: player.hasOpened,
                        openingMode: player.openingMode,
                        totalPoints: player.totalPoints
                    }
                    : {
                        hasOpened: player.hasOpened,
                        openingMode: player.openingMode,
                        totalPoints: player.totalPoints
                    })
            })),
            deckCount: game.deck.length,
            topDiscard: game.discardPiles[leftPlayerIndex]?.[game.discardPiles[leftPlayerIndex].length - 1] || null,
            indicator: game.indicator,
            okey: game.okey,
            firstTurn: game.firstTurn,
            currentTurnIndex: (game.currentTurnIndex - viewerIndex + game.players.length) % game.players.length,
            openedMelds: game.openedMelds,
            gameStarted: game.gameStarted,
            gameOver: game.gameOver,
            result: game.result
        });
    }
}

function listenOnPort(port) {
    const handleListening = () => {
        server.removeListener('error', handleError);
        console.log(`Okey 101 Sunucusu Hazır: http://localhost:${port}`);
    };

    const handleError = (error) => {
        server.removeListener('listening', handleListening);
        if (error.code === 'EADDRINUSE' && process.env.PORT === undefined) {
            console.warn(`Port ${port} kullanımda; ${port + 1} deneniyor.`);
            listenOnPort(port + 1);
            return;
        }

        console.error(`Sunucu ${port} portunda başlatılamadı: ${error.message}`);
        process.exitCode = 1;
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
    server.listen(port, '0.0.0.0');
}

listenOnPort(Number(process.env.PORT) || 3000);