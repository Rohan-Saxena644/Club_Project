/**
 * Study Session Platform - Client SDK
 * 
 * A comprehensive JavaScript SDK for integrating the study session platform
 * into your own applications or building custom clients.
 * 
 * @version 2.0.0
 * @license MIT
 */

class StudySessionClient {
  /**
   * Create a new Study Session Client
   * @param {string} serverUrl - The base URL of the server (e.g., 'http://localhost:3000')
   * @param {Object} options - Configuration options
   * @param {boolean} options.autoReconnect - Enable automatic reconnection (default: true)
   * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 1000)
   * @param {number} options.maxReconnectAttempts - Maximum reconnection attempts (default: 5)
   */
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.token = null;
    this.userId = null;
    this.sessionCode = null;
    this.isHost = false;
    this.eventHandlers = {};
    
    // Configuration
    this.config = {
      autoReconnect: options.autoReconnect !== false,
      reconnectDelay: options.reconnectDelay || 1000,
      maxReconnectAttempts: options.maxReconnectAttempts || 5
    };
    
    // Connection state
    this.reconnectAttempts = 0;
    this.isConnected = false;
  }

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  /**
   * Create a new study session as host
   * @param {string} hostName - Name of the host
   * @returns {Promise<Object>} Session details including sessionCode and token
   * @throws {Error} If session creation fails
   */
  async createSession(hostName) {
    try {
      const response = await fetch(`${this.serverUrl}/api/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create session');
      }

      this.token = data.token;
      this.userId = data.userId;
      this.sessionCode = data.sessionCode;
      this.isHost = data.isHost;

      this.emit('sessionCreated', data);
      return data;
    } catch (error) {
      console.error('[SDK] Create session error:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Join an existing study session
   * @param {string} sessionCode - 6-character session code
   * @param {string} username - User's display name
   * @returns {Promise<Object>} Session details including token
   * @throws {Error} If joining fails
   */
  async joinSession(sessionCode, username) {
    try {
      const response = await fetch(`${this.serverUrl}/api/sessions/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionCode, username })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to join session');
      }

      this.token = data.token;
      this.userId = data.userId;
      this.sessionCode = data.sessionCode;
      this.isHost = data.isHost;

      this.emit('sessionJoined', data);
      return data;
    } catch (error) {
      console.error('[SDK] Join session error:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get session information
   * @returns {Promise<Object>} Session data including members and status
   * @throws {Error} If not authenticated or session not found
   */
  async getSessionInfo() {
    if (!this.token || !this.sessionCode) {
      throw new Error('No active session');
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/sessions/${this.sessionCode}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get session info');
      }

      return data;
    } catch (error) {
      console.error('[SDK] Get session info error:', error);
      this.emit('error', error);
      throw error;
    }
  }

  // ============================================================================
  // WEBSOCKET CONNECTION
  // ============================================================================

  /**
   * Connect to the WebSocket server
   * Requires token from createSession() or joinSession()
   * @throws {Error} If no token is available or Socket.io is not loaded
   */
  connect() {
    if (!this.token) {
      throw new Error('No token available. Call createSession() or joinSession() first.');
    }

    if (typeof io === 'undefined') {
      throw new Error('Socket.io client not loaded. Include socket.io client script.');
    }

    this.socket = io(this.serverUrl, {
      auth: { token: this.token },
      reconnection: this.config.autoReconnect,
      reconnectionDelay: this.config.reconnectDelay,
      reconnectionAttempts: this.config.maxReconnectAttempts
    });

    this.setupSocketListeners();
  }

  /**
   * Setup all WebSocket event listeners
   * @private
   */
  setupSocketListeners() {
    // Connection events
    this.socket.on('connect', () => {
      console.log('[SDK] Connected to study session');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[SDK] Disconnected from study session:', reason);
      this.isConnected = false;
      this.emit('disconnected', { reason });
    });

    this.socket.on('connect_error', (error) => {
      console.error('[SDK] Connection error:', error);
      this.reconnectAttempts++;
      this.emit('connectionError', error);
      
      if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
        this.emit('maxReconnectAttemptsReached');
      }
    });

    // Session state
    this.socket.on('session:state', (data) => {
      this.emit('sessionState', data);
    });

    // Member events
    this.socket.on('member:joined', (data) => {
      this.emit('memberJoined', data);
    });

    this.socket.on('member:left', (data) => {
      this.emit('memberLeft', data);
    });

    // Host events
    this.socket.on('host:left', (data) => {
      this.emit('hostLeft', data);
    });

    this.socket.on('session:ended', (data) => {
      this.emit('sessionEnded', data);
    });

    this.socket.on('session:kicked', (data) => {
      this.emit('kicked', data);
      this.disconnect();
    });

    // Chat events
    this.socket.on('chat:message', (data) => {
      this.emit('message', data);
    });

    // Typing indicators
    this.socket.on('typing:start', (data) => {
      this.emit('typingStart', data);
    });

    this.socket.on('typing:stop', (data) => {
      this.emit('typingStop', data);
    });

    // Error events
    this.socket.on('error', (data) => {
      this.emit('serverError', data);
    });
  }

  /**
   * Disconnect from the session
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }

  /**
   * Check if currently connected
   * @returns {boolean} Connection status
   */
  isConnectionActive() {
    return this.isConnected && this.socket && this.socket.connected;
  }

  // ============================================================================
  // MESSAGING
  // ============================================================================

  /**
   * Send a chat message
   * @param {string} message - Message content
   * @throws {Error} If not connected
   */
  sendMessage(message) {
    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected. Call connect() first.');
    }

    this.socket.emit('chat:message', { message });
  }

  /**
   * Indicate that user is typing
   */
  startTyping() {
    if (this.socket && this.isConnected) {
      this.socket.emit('typing:start');
    }
  }

  /**
   * Indicate that user stopped typing
   */
  stopTyping() {
    if (this.socket && this.isConnected) {
      this.socket.emit('typing:stop');
    }
  }

  // ============================================================================
  // HOST CONTROLS
  // ============================================================================

  /**
   * End the session (host only)
   * @throws {Error} If not the host
   */
  endSession() {
    if (!this.isHost) {
      throw new Error('Only the host can end the session');
    }

    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected');
    }

    this.socket.emit('session:end');
  }

  /**
   * Leave the session as host (session continues)
   * @throws {Error} If not the host
   */
  leaveAsHost() {
    if (!this.isHost) {
      throw new Error('Only the host can use this method');
    }

    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected');
    }

    this.socket.emit('host:leave');
  }

  /**
   * Kick a member from the session (host only)
   * @param {string} userId - ID of the user to kick
   * @throws {Error} If not the host
   */
  kickMember(userId) {
    if (!this.isHost) {
      throw new Error('Only the host can kick members');
    }

    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected');
    }

    this.socket.emit('member:kick', userId);
  }

  // ============================================================================
  // MEMBER CONTROLS
  // ============================================================================

  /**
   * Leave the session (available to everyone)
   */
  leave() {
    if (this.socket && this.isConnected) {
      this.socket.emit('member:leave');
      this.disconnect();
    }
  }

  // ============================================================================
  // EVENT HANDLING
  // ============================================================================

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   * @returns {Function} Function to remove the handler
   */
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
    
    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Register a one-time event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  once(event, handler) {
    const onceHandler = (data) => {
      handler(data);
      this.off(event, onceHandler);
    };
    this.on(event, onceHandler);
  }

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function to remove
   */
  off(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
    }
  }

  /**
   * Remove all event handlers for an event
   * @param {string} event - Event name
   */
  removeAllListeners(event) {
    if (event) {
      delete this.eventHandlers[event];
    } else {
      this.eventHandlers = {};
    }
  }

  /**
   * Emit an event to all registered handlers
   * @private
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[SDK] Error in event handler for ${event}:`, error);
        }
      });
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get current user information
   * @returns {Object} User data
   */
  getCurrentUser() {
    return {
      userId: this.userId,
      username: this.socket?.username,
      sessionCode: this.sessionCode,
      isHost: this.isHost,
      isConnected: this.isConnected
    };
  }

  /**
   * Reset the client state
   */
  reset() {
    this.disconnect();
    this.token = null;
    this.userId = null;
    this.sessionCode = null;
    this.isHost = false;
    this.reconnectAttempts = 0;
    this.removeAllListeners();
  }
}

// ============================================================================
// SIMPLIFIED CHAT APPLICATION WRAPPER
// ============================================================================

/**
 * A simplified wrapper for building chat applications
 */
class SimpleChatApp {
  constructor(serverUrl) {
    this.client = new StudySessionClient(serverUrl);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('connected', () => {
      this.log('Connected to session', 'success');
    });

    this.client.on('disconnected', (data) => {
      this.log(`Disconnected: ${data.reason}`, 'warning');
    });

    this.client.on('sessionState', (state) => {
      this.log(`Session has ${state.members.length} member(s)`, 'info');
      state.messages.forEach(msg => this.displayMessage(msg));
    });

    this.client.on('memberJoined', (member) => {
      this.log(`${member.username} joined`, 'system');
    });

    this.client.on('memberLeft', (member) => {
      this.log(`${member.username} left`, 'system');
    });

    this.client.on('message', (msg) => {
      this.displayMessage(msg);
    });

    this.client.on('hostLeft', (data) => {
      this.log(data.message, 'warning');
    });

    this.client.on('sessionEnded', (data) => {
      this.log(data.message, 'error');
      setTimeout(() => this.cleanup(), 2000);
    });

    this.client.on('kicked', (data) => {
      this.log(data.message, 'error');
      setTimeout(() => this.cleanup(), 2000);
    });

    this.client.on('typingStart', (data) => {
      this.showTyping(data.username);
    });

    this.client.on('typingStop', () => {
      this.hideTyping();
    });

    this.client.on('error', (error) => {
      this.log(`Error: ${error.message}`, 'error');
    });
  }

  async createSession(hostName) {
    const data = await this.client.createSession(hostName);
    this.client.connect();
    return data;
  }

  async joinSession(code, username) {
    const data = await this.client.joinSession(code, username);
    this.client.connect();
    return data;
  }

  sendMessage(text) {
    this.client.sendMessage(text);
  }

  leave() {
    this.client.leave();
  }

  endSession() {
    this.client.endSession();
  }

  kickMember(userId) {
    this.client.kickMember(userId);
  }

  displayMessage(msg) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    console.log(`[${time}] ${msg.username}: ${msg.message}`);
  }

  log(message, type = 'info') {
    const emoji = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
      system: '📢'
    };
    console.log(`${emoji[type] || ''} [${type.toUpperCase()}] ${message}`);
  }

  showTyping(username) {
    console.log(`💬 ${username} is typing...`);
  }

  hideTyping() {
    // Clear typing indicator
  }

  cleanup() {
    this.client.reset();
    console.log('Session ended and cleaned up');
  }
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

/**
 * Example 1: Basic usage - Create and join sessions
 */
async function exampleBasicUsage() {
  const client = new StudySessionClient('http://localhost:3000');

  try {
    // Create session as host
    const session = await client.createSession('John Doe');
    console.log('Session created:', session.sessionCode);

    // Connect to WebSocket
    client.connect();

    // Listen for events
    client.on('connected', () => {
      console.log('Connected!');
    });

    client.on('message', (msg) => {
      console.log(`${msg.username}: ${msg.message}`);
    });

    // Send a message after 2 seconds
    setTimeout(() => {
      client.sendMessage('Welcome to the study session!');
    }, 2000);

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 2: Using the SimpleChatApp wrapper
 */
async function exampleSimpleChatApp() {
  const app = new SimpleChatApp('http://localhost:3000');

  try {
    // Create session
    const session = await app.createSession('Alice');
    console.log('Session code:', session.sessionCode);

    // Send messages
    setTimeout(() => {
      app.sendMessage('Hello everyone!');
    }, 1000);

    // End session after 10 seconds
    setTimeout(() => {
      app.endSession();
    }, 10000);

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 3: Advanced - Event handling and reconnection
 */
async function exampleAdvancedUsage() {
  const client = new StudySessionClient('http://localhost:3000', {
    autoReconnect: true,
    reconnectDelay: 2000,
    maxReconnectAttempts: 10
  });

  // Join existing session
  await client.joinSession('ABC123', 'Bob');
  client.connect();

  // Handle all events
  client.on('connected', () => console.log('✅ Connected'));
  client.on('disconnected', () => console.log('❌ Disconnected'));
  client.on('sessionState', (state) => console.log('Session state:', state));
  client.on('memberJoined', (m) => console.log(`${m.username} joined`));
  client.on('memberLeft', (m) => console.log(`${m.username} left`));
  client.on('message', (msg) => console.log(`${msg.username}: ${msg.message}`));
  
  // One-time events
  client.once('sessionEnded', () => {
    console.log('Session ended, cleaning up...');
    client.reset();
  });
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StudySessionClient, SimpleChatApp };
}
