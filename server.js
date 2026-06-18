const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

// ─── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://wispy-limit-e7c7.polyplayers123.workers.dev'
];
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});

app.use(express.json());

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('PolyPlayers Server is running!'));

// ─── AUTH ROUTES ────────────────────────────────────────────────────────────

async function generatePolyId() {
  while (true) {
    const id = 'POLY#' + Math.floor(1000 + Math.random() * 9000);
    const { data } = await supabase
      .from('players')
      .select('poly_id')
      .eq('poly_id', id)
      .single();
    if (!data) return id;
  }
}

// SIGN UP
app.post('/auth/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: existing } = await supabase
    .from('players')
    .select('id')
    .eq('username', username.toLowerCase())
    .single();
  if (existing)
    return res.status(400).json({ error: 'Username already taken' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const polyId = await generatePolyId();

  const { data: player, error } = await supabase
    .from('players')
    .insert({
      username: username.toLowerCase(),
      display_name: username,
      password_hash: hashedPassword,
      poly_id: polyId,
      wins: 0,
      losses: 0,
      draws: 0
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Could not create account' });

  const token = jwt.sign({ id: player.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    player: {
      id: player.id,
      username: player.display_name,
      poly_id: player.poly_id,
      wins: 0, losses: 0, draws: 0
    }
  });
});

// LOG IN
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const { data: player } = await supabase
    .from('players')
    .select('*')
    .eq('username', username.toLowerCase())
    .single();

  if (!player)
    return res.status(400).json({ error: 'Username not found' });

  const valid = await bcrypt.compare(password, player.password_hash);
  if (!valid)
    return res.status(400).json({ error: 'Wrong password' });

  const token = jwt.sign({ id: player.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    player: {
      id: player.id,
      username: player.display_name,
      poly_id: player.poly_id,
      wins: player.wins,
      losses: player.losses,
      draws: player.draws
    }
  });
});

// GET PLAYER PROFILE
app.get('/player/:polyId', async (req, res) => {
  const { data: player } = await supabase
    .from('players')
    .select('display_name, poly_id, wins, losses, draws')
    .eq('poly_id', req.params.polyId.toUpperCase())
    .single();
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json(player);
});

// ─── XO GAME LOGIC ──────────────────────────────────────────────────────────
const rooms = {};

function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a], line: [a,b,c] };
  }
  if (board.every(cell => cell !== null)) return { winner: 'draw' };
  return null;
}

// ─── SOCKET EVENTS ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { data: player } = await supabase
        .from('players')
        .select('id, display_name, poly_id, wins, losses, draws')
        .eq('id', decoded.id)
        .single();
      if (player) {
        socket.playerId = player.id;
        socket.playerName = player.display_name;
        socket.polyId = player.poly_id;
        socket.emit('authenticated', player);
      }
    } catch (e) {
      socket.emit('auth-error', 'Invalid session, please log in again');
    }
  });

  socket.on('create-room', (game = 'xo') => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomCode] = {
      game,
      players: [{ id: socket.id, playerId: socket.playerId, name: socket.playerName }],
      board: Array(9).fill(null),
      currentTurn: 'X',
      scores: { X: 0, O: 0 }
    };
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerSymbol = 'X';
    socket.emit('room-created', { roomCode, symbol: 'X', game });
  });

  socket.on('join-room', (roomCode) => {
    const code = roomCode.trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found. Check the code and try again.');
    if (room.players.length >= 2) return socket.emit('error', 'Room is full.');

    room.players.push({ id: socket.id, playerId: socket.playerId, name: socket.playerName });
    socket.join(code);
    socket.roomCode = code;
    socket.playerSymbol = 'O';
    socket.emit('room-joined', { roomCode: code, symbol: 'O' });
    io.to(code).emit('game-start', {
      board: room.board,
      currentTurn: room.currentTurn,
      scores: room.scores,
      players: room.players.map(p => p.name)
    });
  });

  socket.on('make-move', (index) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentTurn !== socket.playerSymbol) return;
    if (room.board[index] !== null) return;

    room.board[index] = socket.playerSymbol;
    const result = checkWinner(room.board);

    if (result) {
      if (result.winner !== 'draw') room.scores[result.winner]++;
      io.to(roomCode).emit('game-over', { board: room.board, result, scores: room.scores });
    } else {
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
      io.to(roomCode).emit('board-update', { board: room.board, currentTurn: room.currentTurn });
    }
  });

  socket.on('rematch', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);
    if (room.rematchVotes.size === 2) {
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
      room.board = Array(9).fill(null);
      room.rematchVotes = new Set();
      io.to(roomCode).emit('game-start', {
        board: room.board,
        currentTurn: room.currentTurn,
        scores: room.scores,
        players: room.players.map(p => p.name)
      });
    } else {
      io.to(roomCode).emit('rematch-waiting');
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      io.to(roomCode).emit('player-left');
      delete rooms[roomCode];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PolyPlayers Server running on port ${PORT}`));
