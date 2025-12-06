const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },

  // ---- CRITICAL FIXES ----
  transports: ["polling", "websocket"],  // Fix for Nothing Phone 3 Pro
  allowEIO3: true,                       // Better backward compatibility
  pingInterval: 25000,                   // Prevents random disconnects
  pingTimeout: 60000                     // Render free plan slow wakeups
});

const sessions = {}; 
// Format: { host, guest, ready, pendingSong, queue, profiles }

app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // ---------------- CREATE SESSION ----------------
  socket.on('create_session', () => {
    const sessionId = nanoid(10);

    sessions[sessionId] = {
      host: socket,
      guest: null,
      ready: { host: false, guest: false },
      pendingSong: null,
      queue: [],
      profiles: { host: null, guest: null }
    };

    socket.join(sessionId);
    socket.emit('session_created', { sessionId });

    console.log(`Session created: ${sessionId} by ${socket.id}`);
  });

  // ---------------- JOIN SESSION ----------------
  socket.on('join_session', ({ sessionId }) => {
    const session = sessions[sessionId];

    if (!session) {
      socket.emit('invalid_session', { message: 'Invalid session code.' });
      return;
    }
    if (session.guest) {
      socket.emit('session_full', { message: 'Session is full.' });
      return;
    }

    session.guest = socket;
    socket.join(sessionId);

    session.host.emit('guest_joined');
    socket.emit('session_joined', { sessionId });

    socket.emit('queue_updated', { queue: session.queue });

    if (session.profiles.host || session.profiles.guest) {
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  // ---------------- PROFILE SYNC ----------------
  socket.on('send_profile', ({ username, profileImagePath }) => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];

      if (session.host === socket) {
        session.profiles.host = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);

      } else if (session.guest === socket) {
        session.profiles.guest = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);
      }
    }
  });

  // ---------------- PLAYBACK EVENTS ----------------
  socket.on('playback_event', ({ sessionId, event, data, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const payload = { event, position, data };

    if (session.host === socket && session.guest)
      session.guest.emit('playback_event', payload);
    else if (session.guest === socket && session.host)
      session.host.emit('playback_event', payload);
  });

  // ---------------- SONG CHANGE SYNC ----------------
  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;

    if (session.host) session.host.emit('prepare_song', { data });
    if (session.guest) session.guest.emit('prepare_song', { data });
  });

  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) session.ready.host = true;
    else if (session.guest === socket) session.ready.guest = true;

    if (session.ready.host && session.ready.guest) {
      session.host?.emit('sync_play', { data: session.pendingSong });
      session.guest?.emit('sync_play', { data: session.pendingSong });

      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  // ---------------- POSITION SYNC ----------------
  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (session.host === socket && session.guest)
      session.guest.emit('playback_position', { position });
  });

  // ---------------- QUEUE OPS ----------------
  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;

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

    const q = session.queue;
    if (oldIndex < 0 || oldIndex >= q.length || newIndex < 0 || newIndex > q.length) return;

    const [song] = q.splice(oldIndex, 1);
    q.splice(newIndex, 0, song);

    session.queue = q;
    io.to(sessionId).emit('queue_updated', { queue: q });
  });

  socket.on('update_queue', ({ sessionId, queue }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.queue = queue;
    io.to(sessionId).emit('queue_updated', { queue });
  });

  socket.on('clear_queue', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.queue = [];
    io.to(sessionId).emit('queue_updated', { queue: [] });
  });

  // ---------------- LEAVE SESSION ----------------
  socket.on('leave_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const isHost = session.host === socket;
    const other = isHost ? session.guest : session.host;

    if (other) {
      other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
    }

    if (isHost) delete sessions[sessionId];
    else {
      session.guest = null;
      session.profiles.guest = null;
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    socket.leave(sessionId);
  });

  // ---------------- DISCONNECT (SAFE VERSION) ----------------
  socket.on('disconnect', () => {
    console.log("Socket disconnected:", socket.id);

    // Wait 10 seconds before destroying session
    setTimeout(() => {
      for (const sessionId in sessions) {
        const session = sessions[sessionId];

        if (session.host === socket || session.guest === socket) {
          const isHost = session.host === socket;
          const other = isHost ? session.guest : session.host;

          if (other && other.connected) {
            other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
            session.guest = null;
            session.profiles.guest = null;
            io.to(sessionId).emit('profiles_updated', session.profiles);
          } else {
            delete sessions[sessionId];
          }
        }
      }
    }, 10000); // <--- prevents instant session-ending on Nothing OS
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
