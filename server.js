const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Подключение к PostgreSQL (Render автоматически подставит DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // обязательно для Render
  }
});

// Создание таблиц при запуске
async function initDatabase() {
  try {
    // Таблица для гонки
    await pool.query(`
      CREATE TABLE IF NOT EXISTS race (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для игры "Бей баги"
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whac (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для змейки
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snake (
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
    console.log('✅ Все таблицы лидеров очищены');
  } catch (err) {
    console.error('Ошибка очистки таблиц:', err);
  }
}

// Состояние игры (гонка)
let gameState = {
  players: [],
  obstacles: [],
  hostId: null,
  gameActive: false,
  startTime: 0,
  baseSpeed: 2,
  currentSpeed: 2,
  maxSpeed: 8,
  speedIncreaseInterval: 10,
  lastSpeedIncrease: 0,
  width: 600,
  height: 800,
  generationInterval: 700
};

const ADMIN_PASSWORD = 'admin';
const MAX_PLAYERS = 17;

function generateName() {
  const names = ['Гонщик', 'Спидер', 'Вихрь', 'Молния', 'Торнадо', 'Шторм'];
  return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 1000);
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
let speedTimer = null;

function startGame() {
  gameState.gameActive = true;
  gameState.startTime = Date.now();
  gameState.currentSpeed = gameState.baseSpeed;
  gameState.lastSpeedIncrease = Date.now();
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
    if (gameState.gameActive && gameState.currentSpeed < gameState.maxSpeed) {
      gameState.currentSpeed += 0.5;
      console.log(`Скорость увеличена до ${gameState.currentSpeed}`);
    }
  }, gameState.speedIncreaseInterval * 1000);
  
  io.emit('gameStarted');
}

function stopGame() {
  if (gameLoop) clearInterval(gameLoop);
  if (obstacleGen) clearInterval(obstacleGen);
  if (speedTimer) clearInterval(speedTimer);
  gameLoop = null;
  obstacleGen = null;
  speedTimer = null;
  gameState.gameActive = false;
}

function updateGame() {
  if (!gameState.gameActive) return;

  gameState.obstacles.forEach(o => o.y += gameState.currentSpeed);
  gameState.obstacles = gameState.obstacles.filter(o => o.y < gameState.height);

  const active = gameState.players.filter(p => p.active);
  const crashed = new Set();

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

  // Столкновения между игроками + отталкивание
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const p1 = active[i];
      const p2 = active[j];
      const dist = Math.abs(p1.x - p2.x);
      if (dist < 30) {
        const overlap = 30 - dist;
        const force = overlap * 1.5;
        
        if (p1.x < p2.x) {
          p1.x = Math.max(20, p1.x - force);
          p2.x = Math.min(gameState.width - 50, p2.x + force);
        } else {
          p2.x = Math.max(20, p2.x - force);
          p1.x = Math.min(gameState.width - 50, p1.x + force);
        }
        
        io.emit('playerMoved', { id: p1.id, x: p1.x });
        io.emit('playerMoved', { id: p2.id, x: p2.x });
        io.emit('playerCollision', { id1: p1.id, id2: p2.id });
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
      // Сохраняем результат в PostgreSQL
      addScore('race', winner.name, score).then(async () => {
        const topScores = await getTopScores('race');
        io.emit('leaderboards', { 
          race: topScores, 
          whac: await getTopScores('whac'), 
          snake: await getTopScores('snake') 
        });
      });
      
      io.emit('gameOver', { winner: winner.name, score: score });
    } else {
      io.emit('gameOver', { winner: null, score: 0 });
    }
    stopGame();
  }

  io.emit('obstacles', gameState.obstacles);
}

io.on('connection', async (socket) => {
  console.log('Подключился:', socket.id);

  // Отправляем актуальные таблицы лидеров при подключении
  try {
    const [race, whac, snake] = await Promise.all([
      getTopScores('race'),
      getTopScores('whac'),
      getTopScores('snake')
    ]);
    socket.emit('leaderboards', { race, whac, snake });
  } catch (err) {
    console.error('Ошибка загрузки лидеров:', err);
  }

  socket.on('join', ({ name, isAdmin, password }) => {
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
      name: name || generateName(),
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
          startGame();
        }
      }, 1000);
    }
  });

  socket.on('leave', () => {
    console.log('Игрок вышел по команде leave:', socket.id);
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

  socket.on('disconnect', () => {
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

  // Обработка результатов из других игр (snake, whac)
  socket.on('submitScore', async ({ game, name, score }) => {
    await addScore(game, name, score);
    const topScores = await getTopScores(game);
    io.emit('leaderboards', { 
      race: await getTopScores('race'), 
      whac: await getTopScores('whac'), 
      snake: await getTopScores('snake') 
    });
  });

  // Админская команда очистки статистики
  socket.on('adminClearStats', async (password) => {
    if (password === ADMIN_PASSWORD) {
      await clearAllScores();
      io.emit('leaderboards', { race: [], whac: [], snake: [] });
      console.log('Статистика очищена админом');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер гонки на порту ${PORT}`);
});
