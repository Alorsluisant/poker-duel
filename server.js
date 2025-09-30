const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

let games = {};
let publicRooms = {};

// --- 卡牌遊戲核心邏輯 ---
function createDeck() {
    const suits = ['♠️', '♥️', '♦️', '♣️'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return suits.flatMap(suit => values.map(value => ({ suit, value })));
}
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}
function getCardValue(card) {
    if (!card?.value) return 0;
    const valueMap = { 'A': 1, 'J': 1, 'Q': 2, 'K': 11 };
    return valueMap[card.value] || parseInt(card.value);
}
function getCardType(card) {
    if (!card?.suit) return 'none';
    if (['♠️', '♣️'].includes(card.suit)) return 'attack';
    if (card.suit === '♦️') return 'counter';
    if (card.suit === '♥️') return 'heal';
}

// --- 大廳廣播 ---
function broadcastPublicRooms() {
    io.to('lobby').emit('updatePublicRooms', Object.values(publicRooms));
}

// --- Socket.io 連線處理 ---
io.on('connection', (socket) => {
    console.log(`一個玩家已連接: ${socket.id}`);
    socket.join('lobby');
    socket.emit('updatePublicRooms', Object.values(publicRooms));

    socket.on('createRoom', ({ playerName, isPublic }) => {
        let roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        while(games[roomCode]) {
            roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        }
        
        const player = { id: socket.id, name: playerName, hp: 25, hand: [], playedCard: null, wins: 0, readyForRematch: false };
        games[roomCode] = {
            roomCode,
            players: [player],
            deck: [],
            currentPlayerId: null,
            log: "等待玩家加入...",
            isPublic: isPublic
        };

        if (isPublic) {
            publicRooms[roomCode] = { roomCode, hostName: playerName, playerCount: 1 };
            broadcastPublicRooms();
        }

        socket.leave('lobby');
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const room = games[roomCode];
        if (!room) return socket.emit('joinError', { message: '找不到此房間。' });
        if (room.players.length >= 2) return socket.emit('joinError', { message: '房間已滿。' });

        // 從既有玩家繼承勝場 (如果是連續對戰)
        const opponent = room.players[0];
        const player = { id: socket.id, name: playerName, hp: 25, hand: [], playedCard: null, wins: 0, readyForRematch: false };
        room.players.push(player);

        socket.leave('lobby');
        socket.join(roomCode);
        
        if (room.isPublic) {
            delete publicRooms[roomCode];
            broadcastPublicRooms();
        }
        startGame(roomCode);
    });

    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = games[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.currentPlayerId !== socket.id || player.playedCard) return; // 修復: 不是你的回合或已出牌，則無法操作

        if (cardIndex < 0 || cardIndex >= player.hand.length) return;
        player.playedCard = player.hand.splice(cardIndex, 1)[0];

        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent && opponent.playedCard) {
            revealAndResolveTurn(roomCode);
        } else {
            room.currentPlayerId = opponent.id;
            room.log = `等待 ${opponent.name} 出牌...`;
            broadcastGameState(roomCode);
        }
    });
    
    socket.on('requestRematch', ({ roomCode }) => {
        const room = games[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.readyForRematch = true;
        
        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent && opponent.readyForRematch) {
            // 雙方都準備好了，開始新的一局
            const p1Wins = room.players[0].wins;
            const p2Wins = room.players[1].wins;
            startGame(roomCode);
            // 繼承勝場
            room.players[0].wins = p1Wins;
            room.players[1].wins = p2Wins;
            broadcastGameState(roomCode);
        } else {
            io.to(roomCode).emit('rematchStatus', { message: `${player.name} 想要再玩一局！`});
        }
    });

    socket.on('disconnect', () => {
        console.log(`一個玩家已斷線: ${socket.id}`);
        for (const roomCode in games) {
            const room = games[roomCode];
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                socket.to(roomCode).emit('opponentLeft');
                if (publicRooms[roomCode]) delete publicRooms[roomCode];
                delete games[roomCode];
                broadcastPublicRooms();
                break;
            }
        }
    });
});

// --- 遊戲流程控制 ---
function startGame(roomCode) {
    const room = games[roomCode];
    const deck = shuffleDeck(createDeck());
    room.players.forEach(p => {
        p.hp = 25;
        p.hand = deck.splice(0, 5);
        p.playedCard = null;
        p.readyForRematch = false;
    });
    room.deck = deck;
    room.currentPlayerId = room.players[Math.floor(Math.random() * 2)].id;
    room.log = `遊戲開始！輪到 ${room.players.find(p=>p.id === room.currentPlayerId).name} 出牌。`;
    broadcastGameState(roomCode);
}

function revealAndResolveTurn(roomCode) {
    const room = games[roomCode];
    if (!room) return;
    const [p1, p2] = room.players;
    room.log = `${p1.name}出了 ${p1.playedCard.value}${p1.playedCard.suit} | ${p2.name}出了 ${p2.playedCard.value}${p2.playedCard.suit}`;
    broadcastGameState(roomCode);

    setTimeout(() => {
        if (!games[roomCode]) return;
        let logMessages = [];
        const p1Type = getCardType(p1.playedCard), p2Type = getCardType(p2.playedCard);
        const p1Value = getCardValue(p1.playedCard), p2Value = getCardValue(p2.playedCard);

        if (p1Type === 'attack' && p2Type !== 'counter') { p2.hp -= p1Value; logMessages.push(`${p1.name}造成${p1Value}傷害`); }
        if (p2Type === 'attack' && p1Type !== 'counter') { p1.hp -= p2Value; logMessages.push(`${p2.name}造成${p2Value}傷害`); }
        if (p1Type === 'counter' && p2Type === 'attack') { p2.hp -= p1Value; logMessages.push(`${p1.name}反擊${p1Value}傷害`); }
        if (p2Type === 'counter' && p1Type === 'attack') { p1.hp -= p2Value; logMessages.push(`${p2.name}反擊${p2Value}傷害`); }
        if (p1Type === 'heal') { p1.hp = Math.min(25, p1.hp + p1Value); logMessages.push(`${p1.name}恢復${p1Value}生命`); }
        if (p2Type === 'heal') { p2.hp = Math.min(25, p2.hp + p2Value); logMessages.push(`${p2.name}恢復${p2Value}生命`); }
        p1.hp = Math.max(0, p1.hp); p2.hp = Math.max(0, p2.hp);
        room.log = logMessages.length > 0 ? logMessages.join(', ') : "雙方平安無事。";

        if (p1.hp <= 0 || p2.hp <= 0) {
            let message;
            if (p1.hp > p2.hp) { message = `${p1.name} 獲勝！`; p1.wins++; }
            else if (p2.hp > p1.hp) { message = `${p2.name} 獲勝！`; p2.wins++; }
            else { message = "平手！"; }
            io.to(roomCode).emit('gameOver', { message, gameState: sanitizeAndPackageState(roomCode) });
            return;
        }

        p1.playedCard = null; p2.playedCard = null;
        if (room.deck.length > 0) p1.hand.push(room.deck.pop());
        if (room.deck.length > 0) p2.hand.push(room.deck.pop());
        if(p1.hand.length === 0 && p2.hand.length === 0){
            io.to(roomCode).emit('gameOver', { message: `牌庫抽乾，平手！`, gameState: sanitizeAndPackageState(roomCode) });
            return;
        }
        room.currentPlayerId = room.currentPlayerId === p1.id ? p2.id : p1.id;
        room.log += ` | 輪到 ${room.players.find(p=>p.id === room.currentPlayerId).name} 出牌。`;
        broadcastGameState(roomCode);
    }, 2000);
}

function sanitizeAndPackageState(roomCode) {
    const room = games[roomCode];
    if (!room) return {};
    const turnComplete = room.players.every(p => p.playedCard !== null);
    // 這是一個簡化的打包函式，主要用於 gameOver 事件
    return {
        roomCode: room.roomCode,
        players: room.players.map(p => ({
            id: p.id, name: p.name, hp: p.hp, hand: p.hand,
            handSize: p.hand.length, playedCard: p.playedCard, wins: p.wins
        })),
        currentPlayerId: room.currentPlayerId,
        log: room.log,
    };
}


function broadcastGameState(roomCode) {
    const room = games[roomCode];
    if (!room) return;
    const turnComplete = room.players.every(p => p.playedCard !== null);
    room.players.forEach(player => {
        const opponent = room.players.find(p => p.id !== player.id);
        const stateForPlayer = {
            roomCode: room.roomCode,
            players: [
                { id: player.id, name: player.name, hp: player.hp, hand: player.hand, handSize: player.hand.length, playedCard: player.playedCard, wins: player.wins },
                opponent ? { id: opponent.id, name: opponent.name, hp: opponent.hp, hand: [], handSize: opponent.hand.length, playedCard: turnComplete ? opponent.playedCard : null, wins: opponent.wins } : null
            ].filter(p => p),
            currentPlayerId: room.currentPlayerId,
            log: room.log,
        };
        io.to(player.id).emit('updateGameState', stateForPlayer);
    });
}

server.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});

