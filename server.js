const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const sessions = {}; // sessionId -> { host: socket, guest: socket, ready: { host: false, guest: false }, pendingSong: null }

app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create_session', () => {
    const sessionId = nanoid(10);
    sessions[sessionId] = { host: socket, guest: null, ready: { host: false, guest: false }, pendingSong: null };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by socket ${socket.id}`);
  });

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
    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  // Playback events: play, pause, seek, etc.
  socket.on('playback_event', ({ sessionId, event, data, position }) => {
    const session = sessions[sessionId];
    if (!session) return;
    // Pass position as top-level for sync protocol
    const payload = { event, position, data };
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', payload);
      // console.log(`Host ${socket.id} sent playback event "${event}" to guest in session ${sessionId}`);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', payload);
      // console.log(`Guest ${socket.id} sent playback event "${event}" to host in session ${sessionId}`);
    }
  });

  // Change song event sync: now saves for sync protocol
  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    // Save the pending song data for session
    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;

    // Emit to both clients: "prepare_song" (buffer but don't play yet)
    if (session.host) session.host.emit('prepare_song', { data });
    if (session.guest) session.guest.emit('prepare_song', { data });

    // console.log(`Song change requested for session ${sessionId}. Waiting for both clients to be ready.`);
  });

  // Each client signals ready after buffering
  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) {
      session.ready.host = true;
      // console.log(`Host in session ${sessionId} is ready.`);
    } else if (session.guest === socket) {
      session.ready.guest = true;
      // console.log(`Guest in session ${sessionId} is ready.`);
    }

    // When both ready, emit sync_play to both
    if (session.ready.host && session.ready.guest) {
      if (session.host) session.host.emit('sync_play', { data: session.pendingSong });
      if (session.guest) session.guest.emit('sync_play', { data: session.pendingSong });
      // console.log(`Both clients ready in session ${sessionId}. Sent sync_play.`);
      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  // --- Auto-sync: relay playback position between clients ---
socket.on('playback_position', ({ sessionId, position }) => {
  const session = sessions[sessionId];
  if (!session) return;
  // Only relay host's position to guest
  if (session.host === socket && session.guest) {
    session.guest.emit('playback_position', { position });
  }
  // Do NOT relay guest's position to host!
});

  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket || session.guest === socket) {
        const other = session.host === socket ? session.guest : session.host;
        if (other) other.emit('partner_left', {});
        if (session.host === socket) {
          // console.log(`Host ${socket.id} disconnected, deleting session ${sessionId}`);
          delete sessions[sessionId];
        } else {
          // console.log(`Guest ${socket.id} disconnected from session ${sessionId}`);
          session.guest = null;
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});
