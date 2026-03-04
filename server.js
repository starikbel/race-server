const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let gameState = {
  players: [],
  obstacles: [],
  hostId: null,
  gameActive: false,
  width: 600,
  height: 800,
  obstacleSpeed: 3,
  generationInterval: 700
};

const ADMIN_PASSWORD = 'admin';
const MAX_PLAYERS = 17;

function generateName() {
  const names = ['Гонщик', 'Спидер', 'Вихрь', 'Молния'];
  return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100);
}

function createObstacle() {
  return {
    id: Math.random().toString(36).substring(2, 6),
    x: Math.random() * (gameState.width - 60) + 30,
    y: 0,
    w: 30,
    h: 30
  };
}

let gameLoop = null;
let obstacleGen = null;

function startGame() {
  gameState.gameActive = true;
  gameState.obstacles = [];
  // Сбрасываем состояние игроков (все живы)
  gameState.players.forEach(p => p.active = true);
  if (gameLoop) clearInterval(gameLoop);
  if (obstacleGen) clearInterval(obstacleGen);
  gameLoop = setInterval(updateGame, 50);
  obstacleGen = setInterval(() => {
    if (gameState.gameActive) {
      gameState.obstacles.push(createObstacle());
    }
  }, gameState.generationInterval);
  io.emit('gameStarted');
}

function stopGame() {
  if (gameLoop) clearInterval(gameLoop);
  if (obstacleGen) clearInterval(obstacleGen);
  gameLoop = null;
  obstacleGen = null;
  gameState.gameActive = false;
}

function updateGame() {
  if (!gameState.gameActive) return;

  // Двигаем препятствия
  gameState.obstacles.forEach(o => o.y += gameState.obstacleSpeed);
  gameState.obstacles = gameState.obstacles.filter(o => o.y < gameState.height);

  const active = gameState.players.filter(p => p.active);
  const crashed = new Set();
  const collisions = []; // для отталкивания

  // Столкновения с препятствиями
  for (let p of active) {
    for (let o of gameState.obstacles) {
      if (p.x - 15 < o.x + o.w && p.x + 15 > o.x &&
          gameState.height - 60 < o.y + o.h && gameState.height - 20 > o.y) {
        crashed.add(p.id);
        break;
      }
    }
  }

  // Столкновения между игроками и отталкивание
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const dist = Math.abs(a.x - b.x);
      if (dist < 30) {
        // Оба могут выбыть (по желанию)
        // crashed.add(a.id);
        // crashed.add(b.id);
        // Вместо выбывания добавим отталкивание
        collisions.push({ a, b });
      }
    }
  }

  // Отталкивание (разъезжаются)
  for (let { a, b } of collisions) {
    if (a.x < b.x) {
      a.x = Math.max(20, a.x - 5);
      b.x = Math.min(gameState.width - 50, b.x + 5);
    } else {
      a.x = Math.min(gameState.width - 50, a.x + 5);
      b.x = Math.max(20, b.x - 5);
    }
    // Отправляем обновленные позиции
    io.to('game').emit('playerMoved', { id: a.id, x: a.x });
    io.to('game').emit('playerMoved', { id: b.id, x: b.x });
  }

  // Обработка выбывших
  if (crashed.size) {
    gameState.players.forEach(p => {
      if (crashed.has(p.id)) {
        p.active = false;
        io.to(p.id).emit('playerCrashed'); // звук столкновения
      }
    });
    io.emit('playersUpdate', gameState.players);
  }

  // Проверка окончания игры
  const alive = gameState.players.filter(p => p.active).length;
  if (alive === 0) {
    stopGame();
    io.emit('gameOver', { winner: null });
  }

  io.emit('obstacles', gameState.obstacles);
}

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  socket.on('join', ({ name, isAdmin, password }) => {
    console.log(`Запрос на вход от ${socket.id}, админ: ${isAdmin}`);

    if (gameState.players.some(p => p.id === socket.id)) {
      socket.emit('error', 'Вы уже подключены');
      return;
    }

    if (isAdmin) {
      if (password === ADMIN_PASSWORD) {
        gameState.hostId = socket.id;
        socket.emit('hostStatus', true);
        console.log(`👑 Админ ${socket.id} назначен хостом`);
      } else {
        socket.emit('error', 'Неверный пароль админа');
        return;
      }
    }

    if (gameState.players.length >= MAX_PLAYERS) {
      socket.emit('error', 'Комната заполнена');
      return;
    }

    const player = {
      id: socket.id,
      name: name || generateName(),
      x: Math.random() * (gameState.width - 80) + 40,
      active: true,
      hue: (gameState.players.length * 30) % 360
    };
    gameState.players.push(player);

    if (!gameState.hostId) {
      gameState.hostId = socket.id;
      socket.emit('hostStatus', true);
      console.log(`👑 Первый игрок ${socket.id} стал хостом`);
    }

    socket.join('game');
    socket.emit('init', {
      players: gameState.players,
      obstacles: gameState.obstacles,
      gameActive: gameState.gameActive,
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
    console.log(`Попытка старта от ${socket.id}, хост: ${gameState.hostId}, игра активна: ${gameState.gameActive}`);
    if (socket.id === gameState.hostId && !gameState.gameActive) {
      // Сбрасываем игроков и препятствия
      gameState.players.forEach(p => p.active = true);
      gameState.obstacles = [];
      io.to('game').emit('playersUpdate', gameState.players);

      let count = 3;
      io.to('game').emit('countdown', count);
      const timer = setInterval(() => {
        count--;
        io.to('game').emit('countdown', count);
        if (count === 0) {
          clearInterval(timer);
          startGame();
        }
      }, 1000);
    }
  });

  socket.on('disconnect', () => {
    console.log('Отключился:', socket.id);
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) {
          io.to(gameState.hostId).emit('hostStatus', true);
        }
      }
      io.to('game').emit('playersUpdate', gameState.players);
    }
    socket.leave('game');
  });
});

server.listen(3000, () => {
  console.log('Сервер на порту 3000');
});