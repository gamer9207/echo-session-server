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
  console.log('Client connected:', socket.id); // <-- NEW LOG LINE

  // Create a session
  socket.on('create_session', () => {
    const sessionId = nanoid(10);
    sessions[sessionId] = { host: socket, guest: null };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by socket ${socket.id}`); // <-- NEW LOG LINE
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
    console.log(`Socket ${socket.id} joined session ${sessionId}`); // <-- NEW LOG LINE
  });

  // Playback events: play, pause, seek, etc.
  socket.on('playback_event', ({ sessionId, event, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', { event, data });
      console.log(`Host ${socket.id} sent playback event "${event}" to guest in session ${sessionId}`); // <-- NEW LOG LINE
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', { event, data });
      console.log(`Guest ${socket.id} sent playback event "${event}" to host in session ${sessionId}`); // <-- NEW LOG LINE
    }
  });

  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket || session.guest === socket) {
        const other = session.host === socket ? session.guest : session.host;
        if (other) other.emit('partner_left', {});
        if (session.host === socket) {
          console.log(`Host ${socket.id} disconnected, deleting session ${sessionId}`); // <-- NEW LOG LINE
          delete sessions[sessionId];
        } else {
          console.log(`Guest ${socket.id} disconnected from session ${sessionId}`); // <-- NEW LOG LINE
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
