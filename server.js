const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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

    // If there was a pending deletion timer (host reconnect grace), clear it
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

    // If there's an active currentPlayback, try to align the joining client:
    // Use the same prepare/sync handshake so both sides buffer and then start together.
    if (session.currentPlayback && session.currentPlayback.song) {
      session.pendingSong = {
        song: session.currentPlayback.song,
        position: session.currentPlayback.position ?? 0,
      };
      // mark host as already "ready" because host is playing/prepared
      session.ready.host = true;
      session.ready.guest = false;

      // send prepare_song to both so host can acknowledge and guest can buffer
      if (session.host) session.host.emit('prepare_song', { data: session.pendingSong });
      if (session.guest) session.guest.emit('prepare_song', { data: session.pendingSong });
    }

    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  // Receive client profile (username, profileImagePath) and optional likes array
  socket.on('send_profile', ({ username, profileImagePath, likes }) => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket) {
        session.profiles.host = { username, profileImagePath };
        // store likes if provided
        if (Array.isArray(likes)) {
          session.likes.host = new Set(likes);
        }
        io.to(sessionId).emit('profiles_updated', session.profiles);
        // check for any both-liked intersections
        if (session.likes.host && session.likes.guest) {
          for (const vid of session.likes.host) {
            if (session.likes.guest.has(vid)) {
              io.to(sessionId).emit('both_liked', { videoId: vid });
            }
          }
        }
      } else if (session.guest === socket) {
        session.profiles.guest = { username, profileImagePath };
        if (Array.isArray(likes)) {
          session.likes.guest = new Set(likes);
        }
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

  // A user can also notify server when they LIKE a single song while in-session
  socket.on('like_song', ({ sessionId, videoId }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.host === socket) {
      session.likes.host.add(videoId);
    } else if (session.guest === socket) {
      session.likes.guest.add(videoId);
    }
    // If both have liked, notify both
    if (session.likes.host.has(videoId) && session.likes.guest.has(videoId)) {
      io.to(sessionId).emit('both_liked', { videoId });
    }
  });

  // playback_event: forward immediately and also update session.currentPlayback
  socket.on('playback_event', ({ sessionId, event, position, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const payload = { event, position, data, sentAt: Date.now() };

    // Keep a lightweight currentPlayback state to let joiners sync up
    if (event === 'play' || event === 'pause' || event === 'seek') {
      try {
        const song = (data && data.song) ? data.song : (session.currentPlayback ? session.currentPlayback.song : null);
        session.currentPlayback = {
          song,
          position: position ?? 0,
          isPlaying: event === 'play',
          lastUpdateAt: Date.now(),
        };
      } catch (_) {}
    }

    // forward to the other peer
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', payload);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', payload);
    }
  });

  // change_song: set pendingSong, reset ready flags and instruct both to prepare
  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.pendingSong = data; // expected to be { song, position, sentAt? }
    session.ready.host = false;
    session.ready.guest = false;

    if (session.host) session.host.emit('prepare_song', { data });
    if (session.guest) session.guest.emit('prepare_song', { data });
  });

  // ready_for_play: each client calls this after buffering; when both ready -> emit sync_play with startAt
  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) {
      session.ready.host = true;
    } else if (session.guest === socket) {
      session.ready.guest = true;
    }

    // When both ready, schedule a short future start and tell both clients the start time
    if (session.ready.host && session.ready.guest) {
      const now = Date.now();
      const startInMs = 600; // small buffer to ensure both have time to start
      const startAt = now + startInMs;

      const payload = {
        data: session.pendingSong,
        startAt,
        sentAt: now,
      };

      if (session.host) session.host.emit('sync_play', payload);
      if (session.guest) session.guest.emit('sync_play', payload);

      // update canonical currentPlayback to reflect the new playing song
      try {
        session.currentPlayback = {
          song: session.pendingSong.song,
          position: session.pendingSong.position ?? 0,
          isPlaying: true,
          lastUpdateAt: startAt,
        };
      } catch (_) {}

      // Clear pending and ready flags
      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  // playback_position relay (guest auto-sync helper)
  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_position', { position });
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_position', { position });
    }
  });

  // queue management and broadcast
  socket.on('add_to_queue', ({ sessionId, song }) => {
    console.log('Received add_to_queue', sessionId, song);
    const session = sessions[sessionId];
    if (!session) return;
    // Prevent duplicates by videoId
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

  socket.on('update_queue', ({ sessionId, queue }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = queue;
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('clear_queue', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = [];
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  // explicit leave
  socket.on('leave_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const isHost = session.host === socket;
    const other = isHost ? session.guest : session.host;
    if (other) {
      other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
    }
    if (isHost) {
      // remove immediately
      delete sessions[sessionId];
    } else {
      session.guest = null;
      session.profiles.guest = null;
      session.likes.guest = new Set();
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }
    socket.leave(sessionId);
  });

  // disconnect handling with a short grace window for host reconnects
  socket.on('disconnect', () => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket || session.guest === socket) {
        const isHost = session.host === socket;
        const other = isHost ? session.guest : session.host;
        if (other) {
          other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
        }

        if (isHost) {
          // Give host a grace period to reconnect (30s). If not reconnected, delete session.
          session.host = null;
          session.profiles.host = null;
          session.likes.host = new Set();
          // clear any previous timer
          clearDeletionTimer(session);
          session.deletionTimer = setTimeout(() => {
            // delete session after grace period
            if (sessions[sessionId]) {
              try { io.to(sessionId).emit('session_ended', { reason: 'host disconnected' }); } catch (_) {}
              delete sessions[sessionId];
              console.log(`Session ${sessionId} deleted after host disconnect grace`);
            }
          }, 30000); // 30 seconds
        } else {
          // guest left; clear guest info and persist session for host
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
