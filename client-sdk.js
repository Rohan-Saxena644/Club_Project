/**
 * Study Session Platform - Client SDK Example
 * 
 * This file demonstrates how to integrate the study session platform
 * into your own application or build a custom client.
 */

class StudySessionClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.token = null;
    this.userId = null;
    this.sessionCode = null;
    this.isHost = false;
    this.eventHandlers = {};
  }

  /**
   * Create a new study session as host
   * @param {string} hostName - Name of the host
   * @returns {Promise<Object>} Session details
   */
  async createSession(hostName) {
    try {
      const response = await fetch(`${this.serverUrl}/api/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const data = await response.json();
      
      this.token = data.token;
      this.userId = data.userId;
      this.sessionCode = data.sessionCode;
      this.isHost = data.isHost;

      return data;
    } catch (error) {
      console.error('Create session error:', error);
      throw error;
    }
  }

  /**
   * Join an existing study session
   * @param {string} sessionCode - 6-character session code
   * @param {string} username - User's display name
   * @returns {Promise<Object>} Session details
   */
  async joinSession(sessionCode, username) {
    try {
      const response = await fetch(`${this.serverUrl}/api/sessions/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionCode, username })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to join session');
      }

      const data = await response.json();
      
      this.token = data.token;
      this.userId = data.userId;
      this.sessionCode = data.sessionCode;
      this.isHost = data.isHost;

      return data;
    } catch (error) {
      console.error('Join session error:', error);
      throw error;
    }
  }

  /**
   * Connect to the WebSocket server
   * Requires token from createSession() or joinSession()
   */
  connect() {
    if (!this.token) {
      throw new Error('No token available. Call createSession() or joinSession() first.');
    }

    // Load Socket.io client (ensure it's included in your HTML)
    if (typeof io === 'undefined') {
      throw new Error('Socket.io client not loaded. Include socket.io client script.');
    }

    this.socket = io(this.serverUrl, {
      auth: { token: this.token }
    });

    this.setupSocketListeners();
  }

  /**
   * Setup all WebSocket event listeners
   */
  setupSocketListeners() {
    // Connection events
    this.socket.on('connect', () => {
      console.log('Connected to study session');
      this.emit('connected');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from study session');
      this.emit('disconnected');
    });

    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      this.emit('error', error);
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
  }

  /**
   * Send a chat message
   * @param {string} message - Message content
   */
  sendMessage(message) {
    if (!this.socket) {
      throw new Error('Not connected. Call connect() first.');
    }

    this.socket.emit('chat:message', { message });
  }

  /**
   * Indicate that user is typing
   */
  startTyping() {
    if (this.socket) {
      this.socket.emit('typing:start');
    }
  }

  /**
   * Indicate that user stopped typing
   */
  stopTyping() {
    if (this.socket) {
      this.socket.emit('typing:stop');
    }
  }

  /**
   * End the session (host only)
   */
  endSession() {
    if (!this.isHost) {
      throw new Error('Only the host can end the session');
    }

    if (this.socket) {
      this.socket.emit('session:end');
    }
  }

  /**
   * Leave the session as host (session continues)
   */
  leaveAsHost() {
    if (!this.isHost) {
      throw new Error('Only the host can use this method');
    }

    if (this.socket) {
      this.socket.emit('host:leave');
    }
  }

  /**
   * Disconnect from the session
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
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
   * Emit an event to all registered handlers
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => handler(data));
    }
  }

  /**
   * Get session information
   * @returns {Promise<Object>} Session data
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

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to get session info');
      }

      return await response.json();
    } catch (error) {
      console.error('Get session info error:', error);
      throw error;
    }
  }
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

/**
 * Example 1: Create a session as host
 */
async function exampleCreateSession() {
  const client = new StudySessionClient('http://localhost:3000');

  try {
    // Create session
    const session = await client.createSession('John Doe');
    console.log('Session created:', session.sessionCode);

    // Connect to WebSocket
    client.connect();

    // Listen for events
    client.on('connected', () => {
      console.log('WebSocket connected!');
    });

    client.on('sessionState', (state) => {
      console.log('Session state:', state);
    });

    client.on('memberJoined', (member) => {
      console.log(`${member.username} joined the session`);
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
 * Example 2: Join an existing session
 */
async function exampleJoinSession() {
  const client = new StudySessionClient('http://localhost:3000');

  try {
    // Join session with code
    const session = await client.joinSession('A1B2C3', 'Jane Smith');
    console.log('Joined session:', session.sessionCode);

    // Connect to WebSocket
    client.connect();

    // Listen for messages
    client.on('message', (msg) => {
      console.log(`${msg.username}: ${msg.message}`);
    });

    // Listen for typing
    client.on('typingStart', (data) => {
      console.log(`${data.username} is typing...`);
    });

    // Send a message
    setTimeout(() => {
      client.sendMessage('Hello everyone!');
    }, 1000);

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 3: Complete chat application
 */
class SimpleChatApp {
  constructor() {
    this.client = new StudySessionClient('http://localhost:3000');
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('connected', () => {
      this.log('Connected to session');
    });

    this.client.on('sessionState', (state) => {
      this.log(`Current members: ${state.members.length}`);
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

    this.client.on('typingStart', (data) => {
      this.showTyping(data.username);
    });

    this.client.on('typingStop', () => {
      this.hideTyping();
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

  displayMessage(msg) {
    console.log(`[${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.username}: ${msg.message}`);
  }

  log(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }

  showTyping(username) {
    console.log(`${username} is typing...`);
  }

  hideTyping() {
    // Clear typing indicator
  }

  cleanup() {
    this.client.disconnect();
    console.log('Session ended and cleaned up');
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StudySessionClient, SimpleChatApp };
}
