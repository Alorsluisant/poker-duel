const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 允許所有來源的連線，方便測試
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

let games = {}; // 用來儲存所有遊戲房間的狀態

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


// --- Socket.io 連線處理 ---

io.on('connection', (socket) => {
    console.log(`一個玩家已連接: ${socket.id}`);

    socket.on('createRoom', ({ playerName }) => {
        let roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        while(games[roomCode]) {
            roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        }
        
        games[roomCode] = {
            roomCode,
            players: [],
            deck: [],
            currentPlayerId: null,
            log: "等待玩家加入...",
        };

        const player = { id: socket.id, name: playerName, hp: 25, hand: [], playedCard: null };
        games[roomCode].players.push(player);

        socket.join(roomCode);
        console.log(`玩家 ${playerName} (${socket.id}) 創建了房間 ${roomCode}`);
        socket.emit('roomCreated', { roomCode });
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const room = games[roomCode];
        if (!room) return socket.emit('joinError', { message: '找不到此房間。' });
        if (room.players.length >= 2) return socket.emit('joinError', { message: '房間已滿。' });

        const player = { id: socket.id, name: playerName, hp: 25, hand: [], playedCard: null };
        room.players.push(player);
        socket.join(roomCode);
        console.log(`玩家 ${playerName} (${socket.id}) 加入了房間 ${roomCode}`);
        startGame(roomCode);
    });

    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = games[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.currentPlayerId !== socket.id) return;

        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            return console.error("無效的卡牌索引");
        }
        
        player.playedCard = player.hand.splice(cardIndex, 1)[0];

        const opponent = room.players.find(p => p.id !== socket.id);

        // 檢查是否兩邊都出牌了
        if (opponent && opponent.playedCard) {
            // 兩人都已出牌，揭曉結果
            revealAndResolveTurn(roomCode);
        } else {
            // 只有一人出牌，等待對手
            room.currentPlayerId = opponent.id;
            room.log = `等待 ${opponent.name} 出牌...`;
            broadcastGameState(roomCode);
        }
    });

    socket.on('disconnect', () => {
        console.log(`一個玩家已斷線: ${socket.id}`);
        for (const roomCode in games) {
            const room = games[roomCode];
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                socket.to(roomCode).emit('opponentLeft');
                delete games[roomCode];
                console.log(`房間 ${roomCode} 已因玩家斷線而關閉。`);
                break;
            }
        }
    });
});


// --- 遊戲流程控制 (伺服器) ---

function startGame(roomCode) {
    const room = games[roomCode];
    const deck = shuffleDeck(createDeck());
    
    room.players.forEach(player => {
        player.hand = deck.splice(0, 5);
    });

    room.deck = deck;
    room.currentPlayerId = room.players[Math.floor(Math.random() * 2)].id; // 隨機一位玩家先出牌
    room.log = `遊戲開始！輪到 ${room.players.find(p=>p.id === room.currentPlayerId).name} 出牌。`;

    broadcastGameState(roomCode);
    console.log(`房間 ${roomCode} 遊戲開始。`);
}

function revealAndResolveTurn(roomCode) {
    const room = games[roomCode];
    if (!room) return;

    const [p1, p2] = room.players;
    
    // 讓客戶端先看到雙方出的牌
    room.log = `${p1.name}出了 ${p1.playedCard.value}${p1.playedCard.suit} | ${p2.name}出了 ${p2.playedCard.value}${p2.playedCard.suit}`;
    broadcastGameState(roomCode);

    // 延遲一下再計算結果
    setTimeout(() => {
        if (!games[roomCode]) return; // 如果房間在這期間關閉了

        const p1Card = p1.playedCard, p2Card = p2.playedCard;
        const p1Type = getCardType(p1Card), p2Type = getCardType(p2Card);
        const p1Value = getCardValue(p1Card), p2Value = getCardValue(p2Card);
        
        let logMessages = [];

        // 傷害計算邏輯
        if (p1Type === 'attack' && p2Type !== 'counter') { p2.hp -= p1Value; logMessages.push(`${p1.name}造成${p1Value}傷害`); }
        if (p2Type === 'attack' && p1Type !== 'counter') { p1.hp -= p2Value; logMessages.push(`${p2.name}造成${p2Value}傷害`); }
        if (p1Type === 'counter' && p2Type === 'attack') { p2.hp -= p1Value; logMessages.push(`${p1.name}反擊${p1Value}傷害`); }
        if (p2Type === 'counter' && p1Type === 'attack') { p1.hp -= p2Value; logMessages.push(`${p2.name}反擊${p2Value}傷害`); }
        if (p1Type === 'heal') { p1.hp = Math.min(25, p1.hp + p1Value); logMessages.push(`${p1.name}恢復${p1Value}生命`); }
        if (p2Type === 'heal') { p2.hp = Math.min(25, p2.hp + p2Value); logMessages.push(`${p2.name}恢復${p2Value}生命`); }

        p1.hp = Math.max(0, p1.hp);
        p2.hp = Math.max(0, p2.hp);
        room.log = logMessages.length > 0 ? logMessages.join(', ') : "雙方平安無事。";

        // 檢查遊戲是否結束
        if (p1.hp <= 0 || p2.hp <= 0) {
            let message = "平手！";
            if (p1.hp > 0) message = `${p1.name} 獲勝！`;
            if (p2.hp > 0) message = `${p2.name} 獲勝！`;
            if (p1.hp <= 0 && p2.hp <= 0) message = "平手！";
            io.to(roomCode).emit('gameOver', { message });
            delete games[roomCode];
            return;
        }
        
        // 清理場面並抽牌
        p1.playedCard = null;
        p2.playedCard = null;
        if (room.deck.length > 0) p1.hand.push(room.deck.pop());
        if (room.deck.length > 0) p2.hand.push(room.deck.pop());

        if(p1.hand.length === 0 && p2.hand.length === 0){
            io.to(roomCode).emit('gameOver', { message: `牌庫抽乾，平手！` });
            delete games[roomCode];
            return;
        }

        // 輪到下一位玩家 (交換順序)
        room.currentPlayerId = room.currentPlayerId === p1.id ? p2.id : p1.id;
        room.log += ` | 輪到 ${room.players.find(p=>p.id === room.currentPlayerId).name} 出牌。`;

        broadcastGameState(roomCode);

    }, 2000); // 2秒後結算
}

function broadcastGameState(roomCode) {
    const room = games[roomCode];
    if (!room) return;

    const turnComplete = room.players.every(p => p.playedCard !== null);

    // 為每個玩家客製化遊戲狀態，隱藏對手手牌
    room.players.forEach(player => {
        const opponent = room.players.find(p => p.id !== player.id);
        const sanitizedState = {
            roomCode: room.roomCode,
            players: [
                {
                    id: player.id,
                    name: player.name,
                    hp: player.hp,
                    hand: player.hand,
                    handSize: player.hand.length,
                    playedCard: player.playedCard
                },
                {
                    id: opponent.id,
                    name: opponent.name,
                    hp: opponent.hp,
                    hand: [], // 不發送對手手牌
                    handSize: opponent.hand.length,
                    // 只有在回合結束時才揭露對手的牌
                    playedCard: turnComplete ? opponent.playedCard : null
                }
            ],
            currentPlayerId: room.currentPlayerId,
            log: room.log,
        };
        io.to(player.id).emit('updateGameState', sanitizedState);
    });
}

server.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});
