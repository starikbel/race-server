const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// ===== ПОДКЛЮЧАЕМ БАЗУ ПЛОХИХ СЛОВ ИЗ ОТДЕЛЬНОГО ФАЙЛА =====
const BAD_WORDS = require('./badWords.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Функция проверки имени
function validateName(name) {
  if (!name || name.length < 2 || name.length > 20) return false;
  
  const lowerName = name.toLowerCase().replace(/\s+/g, '');
  
  // Проверка на плохие слова
  for (let word of BAD_WORDS) {
    // Проверка на точное вхождение слова
    if (lowerName.includes(word.toLowerCase())) {
      console.log(`[FILTER] Заблокировано имя "${name}" (содержит "${word}")`);
      return false;
    }
    
    // Проверка на слова с заменой букв на похожие (leet-вариации)
    const leetVariations = word
      .replace(/a/g, '[a@4]')
      .replace(/e/g, '[e3]')
      .replace(/i/g, '[i1!]')
      .replace(/o/g, '[o0]')
      .replace(/s/g, '[s5$]');
    
    const leetRegex = new RegExp(leetVariations, 'i');
    if (leetRegex.test(lowerName)) {
      console.log(`[FILTER] Заблокировано имя "${name}" (leet-вариация "${word}")`);
      return false;
    }
  }
  
  // Проверка на спецсимволы (только буквы, цифры, подчёркивание и пробелы)
  const validRegex = /^[a-zA-Zа-яА-ЯёЁ0-9_ ]+$/;
  if (!validRegex.test(name)) {
    console.log(`[FILTER] Заблокировано имя "${name}" (недопустимые символы)`);
    return false;
  }
  
  return true;
}

// ===== РАСШИРЕННОЕ СОСТОЯНИЕ ДЛЯ АДМИНКИ =====
let bannedIPs = new Set();
let bannedUsers = new Map();
let adminLog = [];

function logAdmin(action, adminName, targetName, reason = '') {
  const entry = {
    time: new Date().toISOString(),
    admin: adminName,
    action: action,
    target: targetName,
    reason: reason
  };
  adminLog.unshift(entry);
  if (adminLog.length > 100) adminLog.pop();
  console.log(`[ADMIN] ${adminName} ${action} ${targetName} ${reason ? '('+reason+')' : ''}`);
}

// Создание таблиц
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS race (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whac (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snake (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guess (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Таблицы PostgreSQL созданы');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err);
  }
}
initDatabase();

// Функции для работы с лидерами
async function getTopScores(game, limit = 10) {
  try {
    const result = await pool.query(
      `SELECT name, score, date FROM ${game} ORDER BY score DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.error(`Ошибка получения лидеров для ${game}:`, err);
    return [];
  }
}

async function addScore(game, name, score) {
  try {
    await pool.query(
      `INSERT INTO ${game} (name, score) VALUES ($1, $2)`,
      [name, score]
    );
  } catch (err) {
    console.error(`Ошибка добавления счёта в ${game}:`, err);
  }
}

async function clearAllScores() {
  try {
    await pool.query('DELETE FROM race');
    await pool.query('DELETE FROM whac');
    await pool.query('DELETE FROM snake');
    await pool.query('DELETE FROM guess');
    console.log('✅ Все таблицы лидеров очищены');
  } catch (err) {
    console.error('Ошибка очистки таблиц:', err);
  }
}

// Состояние игры
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
      });
      
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
  const clientIP = socket.handshake.address;

  if (bannedIPs.has(clientIP)) {
    socket.emit('error', 'Ваш IP забанен');
    socket.disconnect();
    return;
  }

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
  }

  socket.on('join', ({ name, isAdmin, password }) => {
    // Жёсткая проверка имени
    if (!validateName(name)) {
      socket.emit('error', 'Недопустимое имя пользователя. Используйте только буквы и цифры, не менее 2 символов.');
      logAdmin('blocked_name', 'SYSTEM', name, 'Попытка использовать недопустимое имя');
      return;
    }

    if (gameState.players.some(p => p.id === socket.id)) {
      socket.emit('error', 'Вы уже подключены');
      return;
    }

    if (bannedUsers.has(socket.id)) {
      socket.emit('error', 'Вы забанены');
      return;
    }

    if (isAdmin && password === ADMIN_PASSWORD) {
      gameState.hostId = socket.id;
      socket.emit('hostStatus', true);
      logAdmin('admin_login', name, 'SYSTEM', 'Админ вошёл');
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
      hue: (gameState.players.length * 30) % 360,
      ip: clientIP
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
      socket.to('game').emit('bulletFired', {
        x, y, bulletId,
        ownerId: socket.id
      });
    }
  });

  socket.on('bulletHit', ({ bulletId, obstacleId }) => {
    gameState.obstacles = gameState.obstacles.filter(o => o.id !== obstacleId);
    io.to('game').emit('bulletHit', { bulletId, obstacleId });
  });

  // Админ-команды
  socket.on('adminKick', ({ targetId, reason, adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) {
      socket.emit('error', 'Только хост может кикать');
      return;
    }
    
    const target = gameState.players.find(p => p.id === targetId);
    if (target) {
      io.to(targetId).emit('error', `Вы были кикнуты: ${reason || 'Без причины'}`);
      io.to(targetId).emit('kicked');
      logAdmin('kick', admin.name, target.name, reason);
      
      gameState.players = gameState.players.filter(p => p.id !== targetId);
      io.to('game').emit('playersUpdate', gameState.players);
    }
  });

  socket.on('adminBan', ({ targetId, reason, adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) {
      socket.emit('error', 'Только хост может банить');
      return;
    }
    
    const target = gameState.players.find(p => p.id === targetId);
    if (target) {
      bannedUsers.set(targetId, { reason, admin: admin.name, time: Date.now(), name: target.name });
      if (target.ip) bannedIPs.add(target.ip);
      
      io.to(targetId).emit('error', `Вы были забанены: ${reason || 'Нарушение правил'}`);
      io.to(targetId).emit('banned');
      logAdmin('ban', admin.name, target.name, reason);
      
      gameState.players = gameState.players.filter(p => p.id !== targetId);
      io.to('game').emit('playersUpdate', gameState.players);
    }
  });

  socket.on('adminTransferHost', ({ targetId, adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) {
      socket.emit('error', 'Только хост может передавать права');
      return;
    }
    
    const target = gameState.players.find(p => p.id === targetId);
    if (target) {
      gameState.hostId = targetId;
      io.to('game').emit('hostStatus', targetId);
      io.to(targetId).emit('hostStatus', true);
      logAdmin('transfer_host', admin.name, target.name);
    }
  });

  socket.on('adminGetLogs', ({ adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) return;
    
    socket.emit('adminLogs', adminLog.slice(0, 50));
  });

  socket.on('adminGetBanned', ({ adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) return;
    
    const bannedList = Array.from(bannedUsers.entries()).map(([id, data]) => ({
      id, ...data
    }));
    socket.emit('adminBannedList', bannedList);
  });

  socket.on('adminUnban', ({ targetId, adminName }) => {
    const admin = gameState.players.find(p => p.id === socket.id);
    if (!admin || socket.id !== gameState.hostId) return;
    
    if (bannedUsers.has(targetId)) {
      const target = bannedUsers.get(targetId);
      bannedUsers.delete(targetId);
      logAdmin('unban', admin.name, target.name || targetId);
    }
  });

  socket.on('leave', () => {
    console.log('Игрок вышел по команде leave:', socket.id);
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const player = gameState.players[idx];
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) {
          io.to(gameState.hostId).emit('hostStatus', true);
        }
      }
      io.to('game').emit('playersUpdate', gameState.players);
      
      if (gameState.players.length === 0 && gameState.gameActive) {
        stopGame('noPlayers');
      }
    }
    socket.leave('game');
  });

  socket.on('disconnect', () => {
    console.log('Отключился:', socket.id);
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const player = gameState.players[idx];
      gameState.players.splice(idx, 1);
      if (socket.id === gameState.hostId) {
        gameState.hostId = gameState.players[0]?.id || null;
        if (gameState.hostId) {
          io.to(gameState.hostId).emit('hostStatus', true);
        }
      }
      io.to('game').emit('playersUpdate', gameState.players);
      
      if (gameState.players.length === 0 && gameState.gameActive) {
        stopGame('noPlayers');
      }
    }
    socket.leave('game');
  });

  socket.on('submitScore', async ({ game, name, score }) => {
    await addScore(game, name, score);
    const topScores = await getTopScores(game);
    io.emit('leaderboards', { 
      race: await getTopScores('race'), 
      whac: await getTopScores('whac'), 
      snake: await getTopScores('snake'),
      guess: await getTopScores('guess')
    });
  });

  socket.on('adminClearStats', async (password) => {
    if (password === ADMIN_PASSWORD) {
      await clearAllScores();
      io.emit('leaderboards', { race: [], whac: [], snake: [], guess: [] });
      logAdmin('clear_stats', 'ADMIN', 'ALL');
      console.log('Статистика очищена админом');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер гонки на порту ${PORT}`);
});
