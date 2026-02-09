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
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  JWT_SECRET: process.env.JWT_SECRET || (() => {
    console.warn('⚠️  WARNING: Using default JWT_SECRET. Set JWT_SECRET environment variable in production!');
    return 'default-secret-change-in-production-' + crypto.randomBytes(32).toString('hex');
  })(),
  PORT: process.env.PORT || 3000,
  MAX_SESSION_AGE: 24 * 60 * 60 * 1000, // 24 hours
  SESSION_CLEANUP_GRACE_PERIOD: 5 * 60 * 1000, // 5 minutes
  MAX_MESSAGE_LENGTH: 500,
  MAX_USERNAME_LENGTH: 30,
  MAX_MEMBERS_PER_SESSION: 50
};

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// DATA STORAGE (In-Memory)
// ============================================================================

const sessions = new Map(); // sessionCode -> session data
const userSessions = new Map(); // userId -> sessionCode

// Session structure:
// {
//   code: string,
//   hostId: string,
//   hostName: string,
//   members: [{userId, username, socketId, joinedAt, isHost}],
//   messages: [{messageId, userId, username, message, timestamp}],
//   createdAt: timestamp,
//   status: 'active' | 'host-left' | 'ended',
//   cleanupTimer: NodeJS.Timeout | null
// }

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique 6-character session code
 */
function generateSessionCode() {
  let code;
  let attempts = 0;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
    attempts++;
  } while (sessions.has(code) && attempts < 10);
  
  if (attempts >= 10) {
    throw new Error('Failed to generate unique session code');
  }
  
  return code;
}

/**
 * Generate a unique user ID
 */
function generateUserId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Create JWT token for authentication
 */
function createToken(userId, username, sessionCode, isHost = false) {
  return jwt.sign(
    { userId, username, sessionCode, isHost },
    CONFIG.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT_SECRET);
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return null;
  }
}

/**
 * Validate username
 */
function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }
  
  const trimmed = username.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Username cannot be empty' };
  }
  
  if (trimmed.length > CONFIG.MAX_USERNAME_LENGTH) {
    return { valid: false, error: `Username must be ${CONFIG.MAX_USERNAME_LENGTH} characters or less` };
  }
  
  // Check for invalid characters
  if (!/^[a-zA-Z0-9\s_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Username contains invalid characters' };
  }
  
  return { valid: true, username: trimmed };
}

/**
 * Validate message content
 */
function validateMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message is required' };
  }
  
  const trimmed = message.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  if (trimmed.length > CONFIG.MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message must be ${CONFIG.MAX_MESSAGE_LENGTH} characters or less` };
  }
  
  return { valid: true, message: trimmed };
}

/**
 * Clean up session after grace period
 */
function scheduleSessionCleanup(sessionCode) {
  const session = sessions.get(sessionCode);
  if (!session) return;
  
  // Clear existing timer
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }
  
  console.log(`[${sessionCode}] Scheduling cleanup in ${CONFIG.SESSION_CLEANUP_GRACE_PERIOD / 1000}s`);
  
  session.cleanupTimer = setTimeout(() => {
    const currentSession = sessions.get(sessionCode);
    if (currentSession && currentSession.members.length === 0) {
      sessions.delete(sessionCode);
      console.log(`[${sessionCode}] Session cleaned up (empty)`);
    }
  }, CONFIG.SESSION_CLEANUP_GRACE_PERIOD);
}

/**
 * Cancel scheduled cleanup
 */
function cancelSessionCleanup(sessionCode) {
  const session = sessions.get(sessionCode);
  if (session?.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
    console.log(`[${sessionCode}] Cleanup cancelled`);
  }
}

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

/**
 * Create a new session (Host)
 */
app.post('/api/sessions/create', (req, res) => {
  try {
    const { hostName } = req.body;
    
    const validation = validateUsername(hostName);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const sessionCode = generateSessionCode();
    const hostId = generateUserId();
    const token = createToken(hostId, validation.username, sessionCode, true);

    const session = {
      code: sessionCode,
      hostId,
      hostName: validation.username,
      members: [],
      messages: [],
      createdAt: Date.now(),
      status: 'active',
      cleanupTimer: null
    };

    sessions.set(sessionCode, session);
    userSessions.set(hostId, sessionCode);

    console.log(`[${sessionCode}] Session created by ${validation.username}`);

    res.json({
      success: true,
      sessionCode,
      token,
      userId: hostId,
      isHost: true
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * Join an existing session
 */
app.post('/api/sessions/join', (req, res) => {
  try {
    const { sessionCode, username } = req.body;

    if (!sessionCode) {
      return res.status(400).json({ error: 'Session code is required' });
    }

    const validation = validateUsername(username);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const session = sessions.get(sessionCode.toUpperCase());

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'ended') {
      return res.status(400).json({ error: 'Session has ended' });
    }

    // Check member limit
    if (session.members.length >= CONFIG.MAX_MEMBERS_PER_SESSION) {
      return res.status(400).json({ error: 'Session is full' });
    }

    const userId = generateUserId();
    const token = createToken(userId, validation.username, sessionCode.toUpperCase(), false);

    userSessions.set(userId, sessionCode.toUpperCase());

    console.log(`[${sessionCode.toUpperCase()}] ${validation.username} joined`);

    res.json({
      success: true,
      sessionCode: session.code,
      token,
      userId,
      isHost: false,
      hostName: session.hostName,
      status: session.status
    });
  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({ error: 'Failed to join session' });
  }
});

/**
 * Get session info (authenticated)
 */
app.get('/api/sessions/:code', (req, res) => {
  try {
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
          isHost: m.isHost,
          joinedAt: m.joinedAt
        })),
        createdAt: session.createdAt
      }
    });
  } catch (error) {
    console.error('Error getting session info:', error);
    res.status(500).json({ error: 'Failed to get session info' });
  }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

// ============================================================================
// WEBSOCKET AUTHENTICATION MIDDLEWARE
// ============================================================================

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

// ============================================================================
// WEBSOCKET CONNECTION HANDLER
// ============================================================================

io.on('connection', (socket) => {
  const session = sessions.get(socket.sessionCode);
  
  if (!session) {
    socket.disconnect();
    return;
  }

  // Cancel cleanup if scheduled
  cancelSessionCleanup(socket.sessionCode);

  console.log(`[${socket.sessionCode}] ${socket.username} connected (${socket.isHost ? 'HOST' : 'Member'})`);

  // Add or update member
  const existingMemberIndex = session.members.findIndex(m => m.userId === socket.userId);
  
  if (existingMemberIndex !== -1) {
    // Update socket ID for reconnection
    session.members[existingMemberIndex].socketId = socket.id;
    console.log(`[${socket.sessionCode}] ${socket.username} reconnected`);
  } else {
    // Add new member
    const member = {
      userId: socket.userId,
      username: socket.username,
      socketId: socket.id,
      joinedAt: Date.now(),
      isHost: socket.isHost
    };
    session.members.push(member);
  }

  // Join the session room
  socket.join(socket.sessionCode);

  // Send current session state
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

  // Notify others about the new member (only if not reconnecting)
  if (existingMemberIndex === -1) {
    socket.to(socket.sessionCode).emit('member:joined', {
      userId: socket.userId,
      username: socket.username,
      isHost: socket.isHost,
      joinedAt: Date.now()
    });
  }

  // ============================================================================
  // CHAT MESSAGE HANDLER
  // ============================================================================
  
  socket.on('chat:message', (data) => {
    try {
      const validation = validateMessage(data?.message);
      if (!validation.valid) {
        return socket.emit('error', { message: validation.error });
      }

      const message = {
        messageId: crypto.randomBytes(4).toString('hex'),
        userId: socket.userId,
        username: socket.username,
        message: validation.message,
        timestamp: Date.now()
      };

      session.messages.push(message);

      // Broadcast to all members including sender
      io.to(socket.sessionCode).emit('chat:message', message);
    } catch (error) {
      console.error(`[${socket.sessionCode}] Error sending message:`, error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // ============================================================================
  // HOST LEAVE HANDLER
  // ============================================================================
  
  socket.on('host:leave', () => {
    if (!socket.isHost) {
      return socket.emit('error', { message: 'Only host can trigger this action' });
    }

    session.status = 'host-left';

    io.to(socket.sessionCode).emit('host:left', {
      message: `Host ${socket.username} has left the session. The session will continue without the host.`,
      timestamp: Date.now()
    });

    console.log(`[${socket.sessionCode}] Host ${socket.username} left voluntarily`);
  });

  // ============================================================================
  // SESSION END HANDLER (Host Only)
  // ============================================================================
  
  socket.on('session:end', () => {
    if (!socket.isHost) {
      return socket.emit('error', { message: 'Only host can end the session' });
    }

    session.status = 'ended';

    io.to(socket.sessionCode).emit('session:ended', {
      message: 'The session has been ended by the host',
      timestamp: Date.now()
    });

    console.log(`[${socket.sessionCode}] Session ended by host`);

    // Clean up after a short delay
    setTimeout(() => {
      const socketsInRoom = io.sockets.adapter.rooms.get(socket.sessionCode);
      if (socketsInRoom) {
        socketsInRoom.forEach(socketId => {
          io.sockets.sockets.get(socketId)?.disconnect();
        });
      }
      sessions.delete(socket.sessionCode);
      console.log(`[${socket.sessionCode}] Session deleted`);
    }, 2000);
  });

  // ============================================================================
  // KICK MEMBER HANDLER (Host Only)
  // ============================================================================
  
  socket.on('member:kick', (targetUserId) => {
    if (!socket.isHost) {
      return socket.emit('error', { message: 'Only host can kick members' });
    }

    if (!targetUserId) {
      return socket.emit('error', { message: 'Target user ID is required' });
    }

    const targetMember = session.members.find(m => m.userId === targetUserId);

    if (!targetMember) {
      return socket.emit('error', { message: 'Member not found' });
    }

    if (targetMember.isHost) {
      return socket.emit('error', { message: 'Cannot kick the host' });
    }

    const targetSocket = io.sockets.sockets.get(targetMember.socketId);
    if (targetSocket) {
      targetSocket.emit('session:kicked', {
        message: 'You have been removed from the session by the host.',
        timestamp: Date.now()
      });
      targetSocket.disconnect(true);
      console.log(`[${socket.sessionCode}] ${targetMember.username} was kicked by host`);
    }
  });

  // ============================================================================
  // MEMBER LEAVE HANDLER
  // ============================================================================
  
  socket.on('member:leave', () => {
    console.log(`[${socket.sessionCode}] ${socket.username} requested to leave`);
    socket.disconnect();
  });

  // ============================================================================
  // TYPING INDICATORS
  // ============================================================================
  
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

  // ============================================================================
  // DISCONNECT HANDLER
  // ============================================================================
  
  socket.on('disconnect', () => {
    const session = sessions.get(socket.sessionCode);
    
    if (!session) {
      userSessions.delete(socket.userId);
      return;
    }

    console.log(`[${socket.sessionCode}] ${socket.username} disconnected`);

    const memberIndex = session.members.findIndex(m => m.socketId === socket.id);
    
    if (memberIndex !== -1) {
      const leftMember = session.members[memberIndex];
      
      // Remove from active members
      session.members.splice(memberIndex, 1);

      // Notify others
      socket.to(socket.sessionCode).emit('member:left', {
        userId: leftMember.userId,
        username: leftMember.username,
        isHost: leftMember.isHost,
        timestamp: Date.now()
      });

      // Handle host departure
      if (leftMember.isHost && session.status !== 'ended') {
        session.status = 'host-left';
        
        socket.to(socket.sessionCode).emit('host:left', {
          message: `The host (${leftMember.username}) has left. The session will remain open for discussion.`,
          timestamp: Date.now()
        });
        
        console.log(`[${socket.sessionCode}] Now in community mode (host left)`);
      }

      // Schedule cleanup if empty
      if (session.members.length === 0) {
        scheduleSessionCleanup(socket.sessionCode);
      }
    }

    userSessions.delete(socket.userId);
  });
});

// ============================================================================
// PERIODIC CLEANUP OF OLD SESSIONS
// ============================================================================

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > CONFIG.MAX_SESSION_AGE) {
      // Disconnect all members
      const socketsInRoom = io.sockets.adapter.rooms.get(code);
      if (socketsInRoom) {
        socketsInRoom.forEach(socketId => {
          const socket = io.sockets.sockets.get(socketId);
          socket?.emit('session:ended', {
            message: 'Session expired after 24 hours',
            timestamp: Date.now()
          });
          socket?.disconnect();
        });
      }
      
      sessions.delete(code);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired session(s)`);
  }
}, 3600000); // Run every hour

// ============================================================================
// ERROR HANDLERS
// ============================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(CONFIG.PORT, () => {
  console.log('='.repeat(60));
  console.log('📚 Study Session Platform');
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${CONFIG.PORT}`);
  console.log(`🔌 WebSocket server ready`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };
