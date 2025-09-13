const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const sessions = {}; // sessionId -> { host: socket, guest: socket }

// Add a root route for health checks and uptime monitoring
app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  // Create a session
  socket.on('create_session', () => {
    const sessionId = nanoid(10);
    sessions[sessionId] = { host: socket, guest: null };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
  });

  // Join a session
  socket.on('join_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) {
      socket.emit('error', { message: 'Session not found.' });
      return;
    }
    if (session.guest) {
      socket.emit('error', { message: 'Session is full.' });
      return;
    }
    session.guest = socket;
    socket.join(sessionId);
    session.host.emit('guest_joined', {});
    socket.emit('session_joined', { sessionId });
  });

  // Playback events: play, pause, seek, etc.
  socket.on('playback_event', ({ sessionId, event, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    // Broadcast to other participant only
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', { event, data });
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', { event, data });
    }
  });

  // Leaving/disconnect handling
  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket || session.guest === socket) {
        // Notify the other participant
        const other = session.host === socket ? session.guest : session.host;
        if (other) other.emit('partner_left', {});
        // Remove session if host leaves, or clear guest if guest leaves
        if (session.host === socket) {
          delete sessions[sessionId];
        } else {
          session.guest = null;
        }
      }
    }
  });
});

// Use Render's dynamic PORT if available
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});

