const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const sessions = new Map();

function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createToken(userId, username, sessionCode, isHost) {
  return jwt.sign({ userId, username, sessionCode, isHost }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

app.post('/api/sessions/create', (req, res) => {
  const { hostName } = req.body;
  if (!hostName) return res.status(400).json({ error: 'Name required' });

  const sessionCode = generateCode();
  const hostId = crypto.randomBytes(8).toString('hex');
  const token = createToken(hostId, hostName, sessionCode, true);

  sessions.set(sessionCode, {
    code: sessionCode,
    hostId,
    members: [],
    messages: []
  });

  res.json({ success: true, sessionCode, token, userId: hostId, isHost: true });
});

app.post('/api/sessions/join', (req, res) => {
  const { sessionCode, username } = req.body;
  if (!sessionCode || !username) return res.status(400).json({ error: 'Code and name required' });

  const session = sessions.get(sessionCode.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const userId = crypto.randomBytes(8).toString('hex');
  const token = createToken(userId, username, sessionCode.toUpperCase(), false);

  res.json({ success: true, sessionCode: session.code, token, userId, isHost: false });
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));

  const decoded = verifyToken(token);
  if (!decoded) return next(new Error('Invalid token'));

  const session = sessions.get(decoded.sessionCode);
  if (!session) return next(new Error('Session not found'));

  socket.userId = decoded.userId;
  socket.username = decoded.username;
  socket.sessionCode = decoded.sessionCode;
  socket.isHost = decoded.isHost;
  next();
});

io.on('connection', (socket) => {
  const session = sessions.get(socket.sessionCode);
  if (!session) return socket.disconnect();

  const member = {
    userId: socket.userId,
    username: socket.username,
    socketId: socket.id,
    isHost: socket.isHost
  };

  const existing = session.members.findIndex(m => m.userId === socket.userId);
  if (existing !== -1) {
    session.members[existing] = member;
  } else {
    session.members.push(member);
  }

  socket.join(socket.sessionCode);

  socket.emit('session:state', {
    members: session.members,
    messages: session.messages
  });

  socket.to(socket.sessionCode).emit('member:joined', member);

  socket.on('chat:message', (data) => {
    const message = {
      messageId: crypto.randomBytes(4).toString('hex'),
      userId: socket.userId,
      username: socket.username,
      message: data.message,
      timestamp: Date.now()
    };
    session.messages.push(message);
    io.to(socket.sessionCode).emit('chat:message', message);
  });

  socket.on('session:end', () => {
    if (!socket.isHost) return;
    io.to(socket.sessionCode).emit('session:ended', { message: 'Session ended' });
    setTimeout(() => {
      sessions.delete(socket.sessionCode);
    }, 1000);
  });

  socket.on('disconnect', () => {
    const idx = session.members.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) {
      const member = session.members[idx];
      session.members.splice(idx, 1);
      socket.to(socket.sessionCode).emit('member:left', member);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

