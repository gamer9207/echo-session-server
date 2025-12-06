const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);

// NOTHING DEVICE FIX + RENDER FREE PLAN FIX
const io = new Server(server, {
  cors: { origin: "*" },

  // --- Critical Nothing OS Fix ---
  transports: ["polling", "websocket"],
  allowEIO3: true,

  // --- Prevent random disconnects ---
  pingInterval: 25000,
  pingTimeout: 60000
});

// sessions[sessionId] = {
//   host, guest,
//   ready: { host: false, guest: false },
//   pendingSong: null,
//   queue: [],
//   profiles: { host: null, guest: null },
//   likes: { host: new Set(), guest: new Set() },
//   currentPlayback: { song, position, isPlaying, lastUpdateAt },
//   deletionTimer: null
// }
const sessions = {};

app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Helper to clear deletion timer
  function clearDeletionTimer(session) {
    if (!session) return;
    if (session.deletionTimer) {
      clearTimeout(session.deletionTimer);
      session.deletionTimer = null;
    }
  }

  socket.on('create_session', () => {
    const sessionId = nanoid(10);
    sessions[sessionId] = {
      host: socket,
      guest: null,
      ready: { host: false, guest: false },
      pendingSong: null,
      queue: [],
      profiles: { host: null, guest: null },
      likes: { host: new Set(), guest: new Set() },
      currentPlayback: null,
      deletionTimer: null,
      createdAt: Date.now(),
    };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by socket ${socket.id}`);
  });

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

    // Clear deletion timer if reconnecting
    clearDeletionTimer(session);

    session.guest = socket;
    socket.join(sessionId);

    // Notify host and guest
    if (session.host) session.host.emit('guest_joined', {});
    socket.emit('session_joined', { sessionId });

    // Send current queue
    socket.emit('queue_updated', { queue: session.queue });

    // Send profiles if available
    if (session.profiles.host || session.profiles.guest) {
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    // Joining guest should sync to current playback if exists
    if (session.currentPlayback && session.currentPlayback.song) {
      session.pendingSong = {
        song: session.currentPlayback.song,
        position: session.currentPlayback.position ?? 0,
      };
      session.ready.host = true;
      session.ready.guest = false;

      if (session.host) session.host.emit('prepare_song', { data: session.pendingSong });
      if (session.guest) session.guest.emit('prepare_song', { data: session.pendingSong });
    }

    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  socket.on('send_profile', ({ username, profileImagePath, likes }) => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket) {
        session.profiles.host = { username, profileImagePath };
        if (Array.isArray(likes)) session.likes.host = new Set(likes);

        io.to(sessionId).emit('profiles_updated', session.profiles);

        if (session.likes.host && session.likes.guest) {
          for (const vid of session.likes.host) {
            if (session.likes.guest.has(vid)) {
              io.to(sessionId).emit('both_liked', { videoId: vid });
            }
          }
        }
      } else if (session.guest === socket) {
        session.profiles.guest = { username, profileImagePath };
        if (Array.isArray(likes)) session.likes.guest = new Set(likes);

        io.to(sessionId).emit('profiles_updated', session.profiles);

        if (session.likes.host && session.likes.guest) {
          for (const vid of session.likes.guest) {
            if (session.likes.host.has(vid)) {
              io.to(sessionId).emit('both_liked', { videoId: vid });
            }
          }
        }
      }
    }
  });

  socket.on('like_song', ({ sessionId, videoId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (session.host === socket) session.likes.host.add(videoId);
    else if (session.guest === socket) session.likes.guest.add(videoId);

    if (session.likes.host.has(videoId) && session.likes.guest.has(videoId)) {
      io.to(sessionId).emit('both_liked', { videoId });
    }
  });

  socket.on('playback_event', ({ sessionId, event, position, data }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const payload = { event, position, data, sentAt: Date.now() };

    if (event === 'play' || event === 'pause' || event === 'seek') {
      const song = (data && data.song)
        ? data.song
        : (session.currentPlayback ? session.currentPlayback.song : null);

      session.currentPlayback = {
        song,
        position: position ?? 0,
        isPlaying: event === 'play',
        lastUpdateAt: Date.now(),
      };
    }

    if (session.host === socket && session.guest)
      session.guest.emit('playback_event', payload);
    else if (session.guest === socket && session.host)
      session.host.emit('playback_event', payload);
  });

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
      const now = Date.now();
      const startAt = now + 600;

      const payload = {
        data: session.pendingSong,
        startAt,
        sentAt: now,
      };

      if (session.host) session.host.emit('sync_play', payload);
      if (session.guest) session.guest.emit('sync_play', payload);

      session.currentPlayback = {
        song: session.pendingSong.song,
        position: session.pendingSong.position ?? 0,
        isPlaying: true,
        lastUpdateAt: startAt,
      };

      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (session.host === socket && session.guest)
      session.guest.emit('playback_position', { position });
    else if (session.guest === socket && session.host)
      session.host.emit('playback_position', { position });
  });

  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (!session.queue.some(s => s.videoId === song.videoId))
      session.queue.push(song);

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
    if (
      oldIndex < 0 || oldIndex >= q.length ||
      newIndex < 0 || newIndex > q.length
    ) return;

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

  socket.on('leave_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const isHost = session.host === socket;
    const other = isHost ? session.guest : session.host;

    if (other) other.emit('partner_left', { by: isHost ? 'host' : 'guest' });

    if (isHost) {
      delete sessions[sessionId];
    } else {
      session.guest = null;
      session.profiles.guest = null;
      session.likes.guest = new Set();
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    socket.leave(sessionId);
  });

  // --- NOTHING DEVICE DISCONNECT FIX ---
  // Use reconnect-grace instead of instant delete
  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (!session) continue;

      if (session.host === socket || session.guest === socket) {
        const isHost = session.host === socket;
        const other = isHost ? session.guest : session.host;

        if (other)
          other.emit('partner_left', { by: isHost ? 'host' : 'guest' });

        if (isHost) {
          session.host = null;
          session.profiles.host = null;
          session.likes.host = new Set();

          clearDeletionTimer(session);

          // 30 seconds host reconnect grace
          session.deletionTimer = setTimeout(() => {
            if (sessions[sessionId]) {
              io.to(sessionId).emit('session_ended', { reason: 'host disconnected' });
              delete sessions[sessionId];
            }
          }, 30000);

        } else {
          session.guest = null;
          session.profiles.guest = null;
          session.likes.guest = new Set();
          io.to(sessionId).emit('profiles_updated', session.profiles);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});
