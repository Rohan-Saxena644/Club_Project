class StudySessionClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.token = null;
    this.userId = null;
    this.sessionCode = null;
    this.isHost = false;
    this.handlers = {};
  }

  async createSession(hostName) {
    const res = await fetch(`${this.serverUrl}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    this.token = data.token;
    this.userId = data.userId;
    this.sessionCode = data.sessionCode;
    this.isHost = data.isHost;

    return data;
  }

  async joinSession(sessionCode, username) {
    const res = await fetch(`${this.serverUrl}/api/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionCode, username })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    this.token = data.token;
    this.userId = data.userId;
    this.sessionCode = data.sessionCode;
    this.isHost = data.isHost;

    return data;
  }

  connect() {
    if (!this.token) throw new Error('No token. Call createSession() or joinSession() first');

    this.socket = io(this.serverUrl, {
      auth: { token: this.token }
    });

    this.socket.on('connect', () => this.emit('connected'));
    this.socket.on('disconnect', () => this.emit('disconnected'));
    this.socket.on('session:state', (data) => this.emit('sessionState', data));
    this.socket.on('member:joined', (data) => this.emit('memberJoined', data));
    this.socket.on('member:left', (data) => this.emit('memberLeft', data));
    this.socket.on('chat:message', (data) => this.emit('message', data));
    this.socket.on('session:ended', (data) => this.emit('sessionEnded', data));
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendMessage(message) {
    if (!this.socket) throw new Error('Not connected');
    this.socket.emit('chat:message', { message });
  }

  endSession() {
    if (!this.isHost) throw new Error('Only host can end session');
    if (!this.socket) throw new Error('Not connected');
    this.socket.emit('session:end');
  }

  leave() {
    this.disconnect();
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  emit(event, data) {
    if (this.handlers[event]) {
      this.handlers[event].forEach(h => h(data));
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StudySessionClient;
}
