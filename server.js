const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;

// In-memory storage (replace with database in production)
const sessions = new Map(); // sessionCode -> session data
const userSessions = new Map(); // userId -> sessionCode

// Session structure:
// {
//   code: string,
//   hostId: string,
//   hostName: string,
//   members: [{userId, username, socketId, joinedAt}],
//   messages: [{userId, username, message, timestamp}],
//   createdAt: timestamp,
//   status: 'active' | 'host-left' | 'ended'
// }

// Helper Functions
function generateSessionCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateUserId() {
  return crypto.randomBytes(8).toString('hex');
}

function createToken(userId, username, sessionCode, isHost = false) {
  return jwt.sign(
    { userId, username, sessionCode, isHost },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// REST API Endpoints

// Create a new session (Host)
app.post('/api/sessions/create', (req, res) => {
  const { hostName } = req.body;

  if (!hostName || hostName.trim().length === 0) {
    return res.status(400).json({ error: 'Host name is required' });
  }

  const sessionCode = generateSessionCode();
  const hostId = generateUserId();
  const token = createToken(hostId, hostName, sessionCode, true);

  const session = {
    code: sessionCode,
    hostId,
    hostName,
    members: [],
    messages: [],
    createdAt: Date.now(),
    status: 'active'
  };

  sessions.set(sessionCode, session);
  userSessions.set(hostId, sessionCode);

  res.json({
    success: true,
    sessionCode,
    token,
    userId: hostId,
    isHost: true
  });
});

// Join an existing session
app.post('/api/sessions/join', (req, res) => {
  const { sessionCode, username } = req.body;

  if (!sessionCode || !username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Session code and username are required' });
  }

  const session = sessions.get(sessionCode.toUpperCase());

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.status === 'ended') {
    return res.status(400).json({ error: 'Session has ended' });
  }

  const userId = generateUserId();
  const token = createToken(userId, username, sessionCode, false);

  userSessions.set(userId, sessionCode);

  res.json({
    success: true,
    sessionCode: session.code,
    token,
    userId,
    isHost: false,
    hostName: session.hostName,
    status: session.status
  });
});

// Get session info (authenticated)
app.get('/api/sessions/:code', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const session = sessions.get(req.params.code.toUpperCase());
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    success: true,
    session: {
      code: session.code,
      hostName: session.hostName,
      status: session.status,
      memberCount: session.members.length,
      members: session.members.map(m => ({
        username: m.username,
        joinedAt: m.joinedAt
      })),
      createdAt: session.createdAt
    }
  });
});

// WebSocket Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new Error('Authentication error: Invalid token'));
  }

  const session = sessions.get(decoded.sessionCode.toUpperCase());
  if (!session) {
    return next(new Error('Session not found'));
  }

  socket.userId = decoded.userId;
  socket.username = decoded.username;
  socket.sessionCode = decoded.sessionCode.toUpperCase();
  socket.isHost = decoded.isHost;

  next();
});

// WebSocket Connection Handler
io.on('connection', (socket) => {
  const session = sessions.get(socket.sessionCode);
  
  if (!session) {
    socket.disconnect();
    return;
  }

  console.log(`User ${socket.username} connected to session ${socket.sessionCode}`);

  // Add member to session
  const member = {
    userId: socket.userId,
    username: socket.username,
    socketId: socket.id,
    joinedAt: Date.now(),
    isHost: socket.isHost
  };

  // Check if user is reconnecting
  const existingMemberIndex = session.members.findIndex(m => m.userId === socket.userId);
  if (existingMemberIndex !== -1) {
    // Update socket ID for reconnection
    session.members[existingMemberIndex].socketId = socket.id;
  } else {
    session.members.push(member);
  }

  // Join the session room
  socket.join(socket.sessionCode);

  // Send current session state to the newly connected user
  socket.emit('session:state', {
    members: session.members.map(m => ({
      userId: m.userId,
      username: m.username,
      isHost: m.isHost,
      joinedAt: m.joinedAt
    })),
    messages: session.messages,
    status: session.status,
    hostName: session.hostName
  });

  // Notify others about the new member
  if (existingMemberIndex === -1) {
    socket.to(socket.sessionCode).emit('member:joined', {
      userId: socket.userId,
      username: socket.username,
      isHost: socket.isHost,
      joinedAt: member.joinedAt
    });
  }

  // Handle chat messages
  socket.on('chat:message', (data) => {
    const message = {
      messageId: crypto.randomBytes(4).toString('hex'),
      userId: socket.userId,
      username: socket.username,
      message: data.message,
      timestamp: Date.now()
    };

    session.messages.push(message);

    // Broadcast to all members including sender
    io.to(socket.sessionCode).emit('chat:message', message);
  });

  // Handle host leaving
  socket.on('host:leave', () => {
    if (!socket.isHost) {
      return socket.emit('error', { message: 'Only host can trigger this action' });
    }

    session.status = 'host-left';

    // Notify all members
    io.to(socket.sessionCode).emit('host:left', {
      message: `Host ${socket.username} has left the session. The session will continue without the host.`,
      timestamp: Date.now()
    });

    console.log(`Host ${socket.username} left session ${socket.sessionCode}`);
  });

  // Handle session end (host only)
  socket.on('session:end', () => {
    if (!socket.isHost) {
      return socket.emit('error', { message: 'Only host can end the session' });
    }

    session.status = 'ended';

    // Notify all members and disconnect them
    io.to(socket.sessionCode).emit('session:ended', {
      message: 'The session has been ended by the host',
      timestamp: Date.now()
    });

    // Clean up after a short delay
    setTimeout(() => {
      const socketsInRoom = io.sockets.adapter.rooms.get(socket.sessionCode);
      if (socketsInRoom) {
        socketsInRoom.forEach(socketId => {
          io.sockets.sockets.get(socketId)?.disconnect();
        });
      }
      sessions.delete(socket.sessionCode);
    }, 2000);

    console.log(`Session ${socket.sessionCode} ended by host`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User ${socket.username} disconnected from session ${socket.sessionCode}`);

    // Remove member from session
    const memberIndex = session.members.findIndex(m => m.socketId === socket.id);
    if (memberIndex !== -1) {
      const leftMember = session.members[memberIndex];
      session.members.splice(memberIndex, 1);

      // Notify others about member leaving
      socket.to(socket.sessionCode).emit('member:left', {
        userId: leftMember.userId,
        username: leftMember.username,
        isHost: leftMember.isHost,
        timestamp: Date.now()
      });

      // If host disconnected and didn't formally leave
      if (leftMember.isHost && session.status === 'active') {
        session.status = 'host-left';
        socket.to(socket.sessionCode).emit('host:left', {
          message: `Host ${socket.username} has disconnected. The session will continue.`,
          timestamp: Date.now()
        });
      }

      // Clean up empty sessions (except those with host-left status)
      if (session.members.length === 0 && session.status !== 'host-left') {
        setTimeout(() => {
          if (sessions.get(socket.sessionCode)?.members.length === 0) {
            sessions.delete(socket.sessionCode);
            console.log(`Session ${socket.sessionCode} deleted (empty)`);
          }
        }, 300000); // 5 minutes grace period
      }
    }

    userSessions.delete(socket.userId);
  });

  // Handle typing indicators
  socket.on('typing:start', () => {
    socket.to(socket.sessionCode).emit('typing:start', {
      userId: socket.userId,
      username: socket.username
    });
  });

  socket.on('typing:stop', () => {
    socket.to(socket.sessionCode).emit('typing:stop', {
      userId: socket.userId,
      username: socket.username
    });
  });
});

// Cleanup old sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > maxAge) {
      sessions.delete(code);
      console.log(`Cleaned up old session: ${code}`);
    }
  }
}, 3600000); // Run every hour

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready for connections`);
});

module.exports = { app, server, io };
