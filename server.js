const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const allowedOrigins = ['https://wispy-limit-e7c7.polyplayers123.workers.dev'];
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://wispy-limit-e7c7.polyplayers123.workers.dev');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.send('PolyPlayers Server is running!'));

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: player } = await supabase
      .from('players').select('*').eq('id', decoded.id).single();
    if (!player) return res.status(401).json({ error: 'Player not found' });
    req.player = player;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
async function generatePolyId() {
  while (true) {
    const id = 'POLY#' + Math.floor(1000 + Math.random() * 9000);
    const { data } = await supabase.from('players').select('poly_id').eq('poly_id', id).single();
    if (!data) return id;
  }
}

app.post('/auth/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: existing } = await supabase.from('players').select('id').eq('username', username.toLowerCase()).single();
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const polyId = await generatePolyId();

  const { data: player, error } = await supabase.from('players').insert({
    username: username.toLowerCase(), display_name: username,
    password_hash: hashedPassword, poly_id: polyId, wins: 0, losses: 0, draws: 0
  }).select().single();

  if (error) return res.status(500).json({ error: 'Could not create account' });
  const token = jwt.sign({ id: player.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, player: { id: player.id, username: player.display_name, poly_id: player.poly_id, wins: 0, losses: 0, draws: 0 } });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const { data: player } = await supabase.from('players').select('*').eq('username', username.toLowerCase()).single();
  if (!player) return res.status(400).json({ error: 'Username not found' });

  const valid = await bcrypt.compare(password, player.password_hash);
  if (!valid) return res.status(400).json({ error: 'Wrong password' });

  const token = jwt.sign({ id: player.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, player: { id: player.id, username: player.display_name, poly_id: player.poly_id, wins: player.wins, losses: player.losses, draws: player.draws } });
});

app.get('/player/:polyId', async (req, res) => {
  const { data: player } = await supabase.from('players').select('id, display_name, poly_id, wins, losses, draws').eq('poly_id', req.params.polyId.toUpperCase()).single();
  if (!player) return res.status(404).json({ error: 'Player not found' });
  res.json(player);
});

// ─── FRIENDS ─────────────────────────────────────────────────────────────────
app.post('/friends/request', authMiddleware, async (req, res) => {
  const { poly_id } = req.body;
  const { data: target } = await supabase.from('players').select('id, display_name, poly_id').eq('poly_id', poly_id.toUpperCase()).single();
  if (!target) return res.status(404).json({ error: 'Player not found' });
  if (target.id === req.player.id) return res.status(400).json({ error: 'You cannot add yourself' });

  const { data: existing } = await supabase.from('friends')
    .select('id, status')
    .or(`and(requester_id.eq.${req.player.id},receiver_id.eq.${target.id}),and(requester_id.eq.${target.id},receiver_id.eq.${req.player.id})`)
    .single();

  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
    return res.status(400).json({ error: 'Friend request already sent' });
  }

  await supabase.from('friends').insert({ requester_id: req.player.id, receiver_id: target.id, status: 'pending' });

  // Notify via socket if online
  const targetSocket = [...io.sockets.sockets.values()].find(s => s.playerId === target.id);
  if (targetSocket) {
    targetSocket.emit('friend-request', { from: req.player.display_name, poly_id: req.player.poly_id, id: req.player.id });
  }

  res.json({ success: true, message: `Friend request sent to ${target.display_name}` });
});

app.post('/friends/accept', authMiddleware, async (req, res) => {
  const { requester_id } = req.body;
  await supabase.from('friends').update({ status: 'accepted' })
    .eq('requester_id', requester_id).eq('receiver_id', req.player.id);

  const { data: requester } = await supabase.from('players').select('id, display_name, poly_id').eq('id', requester_id).single();
  const requesterSocket = [...io.sockets.sockets.values()].find(s => s.playerId === requester_id);
  if (requesterSocket) {
    requesterSocket.emit('friend-accepted', { by: req.player.display_name, poly_id: req.player.poly_id });
  }

  res.json({ success: true });
});

app.post('/friends/decline', authMiddleware, async (req, res) => {
  const { requester_id } = req.body;
  await supabase.from('friends').delete().eq('requester_id', requester_id).eq('receiver_id', req.player.id);
  res.json({ success: true });
});

// Returns which of the given player IDs currently have an active socket
app.post('/players/online', authMiddleware, async (req, res) => {
  const { ids } = req.body; // array of player ids
  const onlineIds = [...io.sockets.sockets.values()]
    .map(s => s.playerId)
    .filter(Boolean);
  const onlineSet = new Set(onlineIds);
  const result = {};
  (ids || []).forEach(id => { result[id] = onlineSet.has(id); });
  res.json(result);
});

app.get('/friends', authMiddleware, async (req, res) => {
  const { data: friends } = await supabase.from('friends')
    .select('*, requester:requester_id(id, display_name, poly_id), receiver:receiver_id(id, display_name, poly_id)')
    .or(`requester_id.eq.${req.player.id},receiver_id.eq.${req.player.id}`)
    .eq('status', 'accepted');

  const list = (friends || []).map(f => {
    const other = f.requester_id === req.player.id ? f.receiver : f.requester;
    return { id: other.id, display_name: other.display_name, poly_id: other.poly_id };
  });
  res.json(list);
});

app.get('/friends/requests', authMiddleware, async (req, res) => {
  const { data: requests } = await supabase.from('friends')
    .select('*, requester:requester_id(id, display_name, poly_id)')
    .eq('receiver_id', req.player.id).eq('status', 'pending');
  res.json(requests || []);
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────
app.post('/messages/send', authMiddleware, async (req, res) => {
  const { receiver_id, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

  const { data: msg } = await supabase.from('messages').insert({
    sender_id: req.player.id, receiver_id, content: content.trim()
  }).select().single();

  // Deliver live if receiver is online
  const receiverSocket = [...io.sockets.sockets.values()].find(s => s.playerId === receiver_id);
  if (receiverSocket) {
    receiverSocket.emit('new-message', {
      id: msg.id, sender_id: req.player.id,
      sender_name: req.player.display_name,
      content: msg.content, created_at: msg.created_at
    });
  }

  res.json({ success: true, message: msg });
});

app.get('/messages/:friendId', authMiddleware, async (req, res) => {
  const { friendId } = req.params;
  const { data: messages } = await supabase.from('messages')
    .select('*, sender:sender_id(display_name)')
    .or(`and(sender_id.eq.${req.player.id},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${req.player.id})`)
    .order('created_at', { ascending: true })
    .limit(100);
  res.json(messages || []);
});

// ─── XO GAME ─────────────────────────────────────────────────────────────────
const rooms = {};
function checkWinner(board) {
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a], line: [a,b,c] };
  }
  if (board.every(cell => cell !== null)) return { winner: 'draw' };
  return null;
}

// ─── SOCKETS ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { data: player } = await supabase.from('players').select('id, display_name, poly_id, wins, losses, draws').eq('id', decoded.id).single();
      if (player) {
        socket.playerId = player.id;
        socket.playerName = player.display_name;
        socket.polyId = player.poly_id;
        socket.emit('authenticated', player);
      }
    } catch (e) { socket.emit('auth-error', 'Invalid session'); }
  });

  socket.on('create-room', () => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomCode] = {
      players: [{ id: socket.id, playerId: socket.playerId, name: socket.playerName }],
      board: Array(9).fill(null), currentTurn: 'X', scores: { X: 0, O: 0 }
    };
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerSymbol = 'X';
    socket.emit('room-created', { roomCode, symbol: 'X' });
  });

  socket.on('join-room', (roomCode) => {
    const code = roomCode.trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found.');
    if (room.players.length >= 2) return socket.emit('error', 'Room is full.');
    room.players.push({ id: socket.id, playerId: socket.playerId, name: socket.playerName });
    socket.join(code);
    socket.roomCode = code;
    socket.playerSymbol = 'O';
    socket.emit('room-joined', { roomCode: code, symbol: 'O' });
    io.to(code).emit('game-start', { board: room.board, currentTurn: room.currentTurn, scores: room.scores, players: room.players.map(p => p.name) });
  });

  socket.on('make-move', (index) => {
    const room = rooms[socket.roomCode];
    if (!room || room.currentTurn !== socket.playerSymbol || room.board[index]) return;
    room.board[index] = socket.playerSymbol;
    const result = checkWinner(room.board);
    if (result) {
      if (result.winner !== 'draw') room.scores[result.winner]++;
      io.to(socket.roomCode).emit('game-over', { board: room.board, result, scores: room.scores });
    } else {
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
      io.to(socket.roomCode).emit('board-update', { board: room.board, currentTurn: room.currentTurn });
    }
  });

  socket.on('rematch', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);
    if (room.rematchVotes.size === 2) {
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
      room.board = Array(9).fill(null);
      room.rematchVotes = new Set();
      io.to(socket.roomCode).emit('game-start', { board: room.board, currentTurn: room.currentTurn, scores: room.scores, players: room.players.map(p => p.name) });
    } else {
      io.to(socket.roomCode).emit('rematch-waiting');
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      io.to(socket.roomCode).emit('player-left');
      delete rooms[socket.roomCode];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PolyPlayers Server running on port ${PORT}`));
