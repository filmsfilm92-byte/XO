const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// ✅ FIX 4: Allow your known frontend URL(s) instead of '*'
// Add any new frontend URL here as another string in this array.
const allowedOrigins = [
  'https://wispy-limit-e7c7.polyplayers123.workers.dev'
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// ✅ FIX 1: Health check route so Railway knows server is alive
app.get('/', (req, res) => res.send('XO Game Server is running!'));

// Store all active game rooms
const rooms = {};

function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  if (board.every(cell => cell !== null)) return { winner: 'draw' };
  return null;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Create a new room
  socket.on('create-room', () => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomCode] = {
      players: [socket.id],
      board: Array(9).fill(null),
      currentTurn: 'X',
      scores: { X: 0, O: 0 }
    };
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerSymbol = 'X';
    socket.emit('room-created', { roomCode, symbol: 'X' });
  });

  // Join an existing room
  socket.on('join-room', (roomCode) => {
    const code = roomCode.trim().toUpperCase(); // ✅ FIX 2: sanitize code
    const room = rooms[code];
    if (!room) {
      socket.emit('error', 'Room not found. Check the code and try again.');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', 'Room is full. Try a different code.');
      return;
    }
    room.players.push(socket.id);
    socket.join(code);
    socket.roomCode = code;
    socket.playerSymbol = 'O';
    socket.emit('room-joined', { roomCode: code, symbol: 'O' });
    io.to(code).emit('game-start', {
      board: room.board,
      currentTurn: room.currentTurn,
      scores: room.scores
    });
  });

  // Handle a move
  socket.on('make-move', (index) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentTurn !== socket.playerSymbol) return;
    if (room.board[index] !== null) return;

    room.board[index] = socket.playerSymbol;
    const result = checkWinner(room.board);

    if (result) {
      if (result.winner !== 'draw') {
        room.scores[result.winner]++;
      }
      io.to(roomCode).emit('game-over', {
        board: room.board,
        result,
        scores: room.scores
      });
    } else {
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
      io.to(roomCode).emit('board-update', {
        board: room.board,
        currentTurn: room.currentTurn
      });
    }
  });

  // Rematch request
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
        scores: room.scores
      });
    } else {
      io.to(roomCode).emit('rematch-waiting');
    }
  });

  // ✅ FIX 3: Clean up room properly on disconnect
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      io.to(roomCode).emit('player-left');
      delete rooms[roomCode];
      console.log('Room deleted:', roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`XO Server running on port ${PORT}`));
