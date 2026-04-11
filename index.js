const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
console.log('🔍 DATABASE_URL:', process.env.DATABASE_URL ? '✅ УСТАНОВЛЕНА' : '❌ НЕ УСТАНОВЛЕНА');
console.log('🔍 Первые 50 символов:', process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 50) : 'none');
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let gameState = {
  players: [],
  hostId: null,
  gameActive: false,
  width: 600,
  height: 800
};

io.on('connection', (socket) => {
  console.log('✅ Новое соединение:', socket.id);

  socket.on('join', ({ name, isAdmin }) => {
    console.log(`🔥 JOIN получен от ${socket.id}, имя: ${name}, isAdmin: ${isAdmin}`);

    const player = {
      id: socket.id,
      name: name || 'Гонщик',
      x: Math.random() * (gameState.width - 80) + 40,
      active: true,
      hue: (gameState.players.length * 30) % 360
    };
    gameState.players.push(player);

    if (!gameState.hostId) {
      gameState.hostId = socket.id;
      socket.emit('hostStatus', true);
    }

    socket.join('game');
    socket.emit('init', {
      players: gameState.players,
      obstacles: [],
      gameActive: false,
      hostId: gameState.hostId,
      width: gameState.width,
      height: gameState.height
    });
    io.to('game').emit('playersUpdate', gameState.players);
  });

  socket.on('move', (x) => {
    const p = gameState.players.find(p => p.id === socket.id);
    if (p && p.active && gameState.gameActive) {
      p.x = Math.max(20, Math.min(gameState.width - 50, x));
      socket.to('game').emit('playerMoved', { id: socket.id, x: p.x });
    }
  });

  socket.on('startGame', () => {
    if (socket.id === gameState.hostId && !gameState.gameActive) {
      let count = 3;
      io.to('game').emit('countdown', count);
      const timer = setInterval(() => {
        count--;
        io.to('game').emit('countdown', count);
        if (count === 0) {
          clearInterval(timer);
          gameState.gameActive = true;
          io.emit('gameStarted');
        }
      }, 1000);
    }
  });

  socket.on('disconnect', () => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) io.to(gameState.hostId).emit('hostStatus', true);
      }
      io.to('game').emit('playersUpdate', gameState.players);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер гонки на порту ${PORT}`);
});
