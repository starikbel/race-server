const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// ===== ПОПЫТКА ПОДКЛЮЧИТЬ БИБЛИОТЕКУ swearing-filter =====
let filter = null;
try {
  const SwearingFilter = require('swearing-filter');
  filter = new SwearingFilter({ languages: ['ru', 'en'] });
  console.log('✅ swearing-filter загружена');
} catch (e) {
  console.log('⚠️ swearing-filter не загружена, используем fallback');
}

// ===== FALLBACK-СПИСОК ПЛОХИХ СЛОВ =====
function isBadWordFallback(text) {
  const badWords = [
    'хуй', 'хуя', 'хую', 'хуем', 'хуи', 'пизда', 'пизды', 'пизде', 'пизду', 'пиздой',
    'бля', 'блять', 'блядь', 'ебан', 'ебать', 'ебучий', 'уебан', 'мудак', 'пидор',
    'сука', 'тварь', 'гнида', 'мразь', 'падла', 'сволочь', 'шлюха', 'проститутка',
    'гомик', 'петух', 'лох', 'чмо', 'дебил', 'даун', 'кретин', 'идиот', 'долбоеб',
    'fuck', 'fucking', 'fucker', 'shit', 'shitting', 'asshole', 'bitch', 'cunt', 'dick',
    'cock', 'pussy', 'whore', 'slut', 'bastard', 'wanker', 'twat', 'fag', 'retard'
  ];
  const lower = text.toLowerCase();
  for (let word of badWords) {
    if (lower.includes(word)) return true;
  }
  return false;
}

function validateName(name) {
  if (!name || name.length < 2 || name.length > 20) return false;

  let isBad = false;
  if (filter && typeof filter.isBad === 'function') {
    try { isBad = filter.isBad(name); } catch(e) {}
  }
  if (!isBad) isBad = isBadWordFallback(name);

  if (isBad) {
    console.log(`[FILTER] Заблокировано имя "${name}"`);
    return false;
  }

  const validRegex = /^[a-zA-Zа-яА-ЯёЁ0-9_ ]+$/;
  if (!validRegex.test(name)) {
    console.log(`[FILTER] Недопустимые символы в имени "${name}"`);
    return false;
  }
  return true;
}

// ===== ОСТАЛЬНАЯ ЧАСТЬ СЕРВЕРА =====
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const dbPath = path.join(__dirname, 'leaderboards.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS race (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS whac (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS snake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS guess (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('✅ Таблицы SQLite созданы');
});

function getTopScores(game, limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT name, score, date FROM ${game} ORDER BY score DESC LIMIT ?`, [limit], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function addScore(game, name, score) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO ${game} (name, score) VALUES (?, ?)`, [name, score], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

function clearAllScores() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM race', (err) => { if (err) reject(err); });
    db.run('DELETE FROM whac', (err) => { if (err) reject(err); });
    db.run('DELETE FROM snake', (err) => { if (err) reject(err); });
    db.run('DELETE FROM guess', (err) => { if (err) reject(err); });
    resolve();
  });
}

// ===== ИГРОВАЯ ЛОГИКА =====
let gameState = {
  players: [],
  obstacles: [],
  hostId: null,
  gameActive: false,
  startTime: 0,
  baseSpeed: 2,
  currentSpeed: 2,
  speedIncreaseInterval: 8,
  width: 600,
  height: 800,
  generationInterval: 600
};

const ADMIN_PASSWORD = 'admin';
const MAX_PLAYERS = 17;

function generateName() {
  const names = ['Гонщик', 'Спидер', 'Вихрь', 'Молния', 'Торнадо', 'Шторм'];
  let name;
  do {
    name = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 1000);
  } while (!validateName(name));
  return name;
}

function createObstacle() {
  return {
    id: Math.random().toString(36).substring(2, 8),
    x: Math.random() * (gameState.width - 60) + 30,
    y: 0,
    w: 30,
    h: 30
  };
}

let gameLoop = null;
let obstacleGen = null;
let speedTimer = null;

function getSpeedMultiplier() {
  const playerCount = gameState.players.length;
  if (playerCount <= 1) return 1.6;
  if (playerCount <= 3) return 1.3;
  return 1.0;
}

function startGame() {
  gameState.gameActive = true;
  gameState.startTime = Date.now();
  gameState.currentSpeed = gameState.baseSpeed * getSpeedMultiplier();
  gameState.obstacles = [];
  gameState.players.forEach(p => p.active = true);
  
  if (gameLoop) clearInterval(gameLoop);
  if (obstacleGen) clearInterval(obstacleGen);
  if (speedTimer) clearInterval(speedTimer);
  
  gameLoop = setInterval(updateGame, 50);
  obstacleGen = setInterval(() => {
    if (gameState.gameActive) gameState.obstacles.push(createObstacle());
  }, gameState.generationInterval);
  
  speedTimer = setInterval(() => {
    if (gameState.gameActive) {
      const multiplier = getSpeedMultiplier();
      gameState.currentSpeed += 0.4 * multiplier;
      console.log(`Скорость увеличена до ${gameState.currentSpeed.toFixed(1)} (игроков: ${gameState.players.length})`);
    }
  }, gameState.speedIncreaseInterval * 1000);
  
  io.emit('gameStarted');
  io.emit('speedUpdate', gameState.currentSpeed);
}

function stopGame(reason = 'normal') {
  if (gameLoop) clearInterval(gameLoop);
  if (obstacleGen) clearInterval(obstacleGen);
  if (speedTimer) clearInterval(speedTimer);
  gameLoop = null;
  obstacleGen = null;
  speedTimer = null;
  gameState.gameActive = false;
  
  if (reason === 'noPlayers') {
    io.emit('gameClosed', 'Нет активных игроков');
  }
}

function updateGame() {
  if (!gameState.gameActive) return;

  const hasActive = gameState.players.some(p => p.active);
  if (!hasActive) {
    stopGame('noPlayers');
    return;
  }

  gameState.obstacles.forEach(o => o.y += gameState.currentSpeed);
  
  const obstaclesAtBottom = gameState.obstacles.filter(o => o.y + o.h >= gameState.height);
  if (obstaclesAtBottom.length > 0) {
    const timeSurvived = Math.floor((Date.now() - gameState.startTime) / 1000);
    const score = timeSurvived * 10;
    gameState.players.forEach(p => p.active = false);
    io.emit('playersUpdate', gameState.players);
    io.emit('gameOver', { winner: null, score: score, reason: 'Препятствие достигло финиша' });
    stopGame();
    return;
  }
  
  gameState.obstacles = gameState.obstacles.filter(o => o.y < gameState.height);

  const active = gameState.players.filter(p => p.active);
  const crashed = new Set();

  for (let p of active) {
    for (let o of gameState.obstacles) {
      if (p.x - 15 < o.x + o.w && p.x + 15 > o.x &&
          gameState.height - 60 < o.y + o.h && gameState.height - 20 > o.y) {
        crashed.add(p.id);
        break;
      }
    }
  }

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const p1 = active[i];
      const p2 = active[j];
      const dist = Math.abs(p1.x - p2.x);
      if (dist < 35) {
        const overlap = 35 - dist;
        const force = overlap * 2.5;
        if (p1.x < p2.x) {
          p1.x = Math.max(20, p1.x - force);
          p2.x = Math.min(gameState.width - 50, p2.x + force);
        } else {
          p2.x = Math.max(20, p2.x - force);
          p1.x = Math.min(gameState.width - 50, p1.x + force);
        }
        io.emit('playerMoved', { id: p1.id, x: p1.x });
        io.emit('playerMoved', { id: p2.id, x: p2.x });
        io.emit('playerCollision', { id1: p1.id, id2: p2.id, force: force });
      }
    }
  }

  if (crashed.size) {
    gameState.players.forEach(p => {
      if (crashed.has(p.id)) {
        p.active = false;
        io.to(p.id).emit('playerCrashed');
      }
    });
    io.emit('playersUpdate', gameState.players);
  }

  const alive = gameState.players.filter(p => p.active).length;
  if (alive <= 1 && gameState.players.length > 1) {
    const winner = gameState.players.find(p => p.active);
    const timeSurvived = Math.floor((Date.now() - gameState.startTime) / 1000);
    const score = timeSurvived * 10;
    if (winner) {
      addScore('race', winner.name, score).then(async () => {
        const topScores = await getTopScores('race');
        io.emit('leaderboards', { 
          race: topScores, 
          whac: await getTopScores('whac'), 
          snake: await getTopScores('snake'),
          guess: await getTopScores('guess')
        });
      }).catch(console.error);
      io.emit('gameOver', { winner: winner.name, score: score });
    } else {
      io.emit('gameOver', { winner: null, score: 0 });
    }
    stopGame();
  }

  io.emit('obstacles', gameState.obstacles);
  io.emit('speedUpdate', gameState.currentSpeed);
}

io.on('connection', async (socket) => {
  console.log('Подключился:', socket.id);

  try {
    const [race, whac, snake, guess] = await Promise.all([
      getTopScores('race'),
      getTopScores('whac'),
      getTopScores('snake'),
      getTopScores('guess')
    ]);
    socket.emit('leaderboards', { race, whac, snake, guess });
  } catch (err) {
    console.error('Ошибка загрузки лидеров:', err);
    socket.emit('leaderboards', { race: [], whac: [], snake: [], guess: [] });
  }

  socket.on('join', ({ name, isAdmin, password }) => {
    console.log(`🔥 JOIN получен от ${socket.id}, имя: ${name}, isAdmin: ${isAdmin}`);

    if (!validateName(name)) {
      socket.emit('error', 'Недопустимое имя пользователя. Используйте только буквы, цифры, подчёркивание и пробелы.');
      return;
    }

    if (gameState.players.some(p => p.id === socket.id)) {
      socket.emit('error', 'Вы уже подключены');
      return;
    }

    if (isAdmin && password === ADMIN_PASSWORD) {
      gameState.hostId = socket.id;
      socket.emit('hostStatus', true);
    } else if (isAdmin) {
      socket.emit('error', 'Неверный пароль админа');
      return;
    }

    if (gameState.players.length >= MAX_PLAYERS) {
      socket.emit('error', 'Комната заполнена');
      return;
    }

    const player = {
      id: socket.id,
      name: name,
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
      obstacles: gameState.obstacles,
      gameActive: gameState.gameActive,
      hostId: gameState.hostId,
      width: gameState.width,
      height: gameState.height,
      currentSpeed: gameState.currentSpeed
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
          startGame();
        }
      }, 1000);
    }
  });

  socket.on('shoot', ({ x, y, bulletId }) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (player && player.active && gameState.gameActive) {
      socket.to('game').emit('bulletFired', { x, y, bulletId, ownerId: socket.id });
    }
  });

  socket.on('bulletHit', ({ bulletId, obstacleId }) => {
    gameState.obstacles = gameState.obstacles.filter(o => o.id !== obstacleId);
    io.to('game').emit('bulletHit', { bulletId, obstacleId });
  });

  socket.on('submitScore', async ({ game, name, score }) => {
    if (!validateName(name)) {
      console.log(`[FILTER] Отклонена попытка сохранить результат с недопустимым именем: ${name}`);
      return;
    }
    await addScore(game, name, score);
    const topScores = await getTopScores(game);
    io.emit('leaderboards', { 
      race: await getTopScores('race'), 
      whac: await getTopScores('whac'), 
      snake: await getTopScores('snake'),
      guess: await getTopScores('guess')
    });
  });

  socket.on('leave', () => {
    console.log('Игрок вышел по команде leave:', socket.id);
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) io.to(gameState.hostId).emit('hostStatus', true);
      }
      io.to('game').emit('playersUpdate', gameState.players);
      if (gameState.players.length === 0 && gameState.gameActive) stopGame('noPlayers');
    }
    socket.leave('game');
  });

  socket.on('disconnect', () => {
    console.log('Отключился:', socket.id);
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) io.to(gameState.hostId).emit('hostStatus', true);
      }
      io.to('game').emit('playersUpdate', gameState.players);
      if (gameState.players.length === 0 && gameState.gameActive) stopGame('noPlayers');
    }
    socket.leave('game');
  });

  socket.on('adminClearStats', async (password) => {
    if (password === ADMIN_PASSWORD) {
      await clearAllScores();
      io.emit('leaderboards', { race: [], whac: [], snake: [], guess: [] });
      console.log('Статистика очищена админом');
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Сервер гонки на порту ${PORT}`);
});
