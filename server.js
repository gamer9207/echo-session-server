const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const sessions = {}; // sessionId -> { host, guest, ready, pendingSong, queue }

app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create_session', () => {
    const sessionId = nanoid(10);
    sessions[sessionId] = {
      host: socket,
      guest: null,
      ready: { host: false, guest: false },
      pendingSong: null,
      queue: []
    };
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
    // Send current queue to new guest
    socket.emit('queue_updated', { queue: session.queue });
    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  // Playback events: play, pause, seek, etc.
  socket.on('playback_event', ({ sessionId, event, data, position }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const payload = { event, position, data };
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', payload);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', payload);
    }
  });

  // Change song event sync: now saves for sync protocol
  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;
    if (session.host) session.host.emit('prepare_song', { data });
    if (session.guest) session.guest.emit('prepare_song', { data });
  });

  // Each client signals ready after buffering
  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) {
      session.ready.host = true;
    } else if (session.guest === socket) {
      session.ready.guest = true;
    }

    if (session.ready.host && session.ready.guest) {
      if (session.host) session.host.emit('sync_play', { data: session.pendingSong });
      if (session.guest) session.guest.emit('sync_play', { data: session.pendingSong });
      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  // --- Auto-sync: relay playback position between clients ---
  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_position', { position });
    }
  });

  // --- Common queue sync ---
  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;
    // Prevent duplicates
    if (!session.queue.some(s => s.videoId === song.videoId)) {
      session.queue.push(song);
    }
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('remove_from_queue', ({ sessionId, videoId }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = session.queue.filter(s => s.videoId !== videoId);
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('move_in_queue', ({ sessionId, oldIndex, newIndex }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const queue = session.queue;
    if (
      oldIndex < 0 ||
      oldIndex >= queue.length ||
      newIndex < 0 ||
      newIndex > queue.length
    ) return;
    const [song] = queue.splice(oldIndex, 1);
    queue.splice(newIndex, 0, song);
    session.queue = queue;
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('clear_queue', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = [];
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket || session.guest === socket) {
        const other = session.host === socket ? session.guest : session.host;
        if (other) other.emit('partner_left', {});
        if (session.host === socket) {
          delete sessions[sessionId];
        } else {
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
