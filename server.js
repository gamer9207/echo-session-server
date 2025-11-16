const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
// allow CORS from any origin for now (you can restrict in production)
const io = new Server(server, { cors: { origin: "*" } });

// sessions[sessionId] = {
//   host, guest,
//   ready: { host: bool, guest: bool },
//   pendingSong, queue, profiles: { host: {...}, guest: {...} },
//   lastSelector: 'host'|'guest'|null
// }
const sessions = {}; // sessionId -> session object

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
      queue: [],
      profiles: { host: null, guest: null },
      lastSelector: null,
    };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by socket ${socket.id}`);
  });

  // Accept either an object { sessionId } or a plain string (legacy)
  socket.on('join_session', (payload) => {
    let sessionId = null;
    if (!payload) {
      socket.emit('invalid_session', { message: 'Missing sessionId.' });
      return;
    }
    if (typeof payload === 'string') sessionId = payload;
    else sessionId = payload.sessionId;

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
    try { session.host.emit('guest_joined', {}); } catch (_) {}
    socket.emit('session_joined', { sessionId });
    socket.emit('queue_updated', { queue: session.queue });

    if (session.profiles.host || session.profiles.guest) {
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }
    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

  // Receive client profile and update session
  // payload: { username, profileImagePath }
  socket.on('send_profile', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const username = payload.username;
    const profileImagePath = payload.profileImagePath;

    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.host === socket) {
        session.profiles.host = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);
        break;
      } else if (session.guest === socket) {
        session.profiles.guest = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);
        break;
      }
    }
  });

  // Playback events: forward entire payload so sentAt etc. preserved
  socket.on('playback_event', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const session = sessions[sessionId];
      if (!session) return;

      if (session.host === socket && session.guest) {
        session.guest.emit('playback_event', payload);
      } else if (session.guest === socket && session.host) {
        session.host.emit('playback_event', payload);
      }
    } catch (e) {
      console.error('playback_event handler error:', e);
    }
  });

  // Change song event sync: selector initiates song change.
  // We will record who selected and notify only the other peer to prepare.
  // payload: { sessionId, data: { song, position } }
  socket.on('change_song', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const data = payload.data;
      if (!sessionId || !data) return;
      const session = sessions[sessionId];
      if (!session) return;

      // store pendingSong and reset ready flags
      session.pendingSong = data;
      session.ready = { host: false, guest: false };

      // record who selected: 'host' or 'guest'
      if (session.host === socket) session.lastSelector = 'host';
      else if (session.guest === socket) session.lastSelector = 'guest';
      else session.lastSelector = null;

      // Notify only the other client to prepare (not the selector)
      if (session.host === socket && session.guest) {
        // host selected -> tell guest only
        session.guest.emit('prepare_song', { data });
      } else if (session.guest === socket && session.host) {
        // guest selected -> tell host only
        session.host.emit('prepare_song', { data });
      } else {
        // No paired peer yet: nothing to notify right now
      }

      // Note: selector is expected to locally start playing immediately and emit ready_for_play,
      // which the server will record. When both ready flags true, server will tell the non-selector to sync_play.
      console.log(`change_song from ${session.lastSelector} in session ${sessionId}`);
    } catch (e) {
      console.error('change_song handler error:', e);
    }
  });

  // Each client signals ready after buffering
  // payload: { sessionId }
  socket.on('ready_for_play', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const session = sessions[sessionId];
      if (!session || !session.pendingSong) return;

      if (session.host === socket) {
        session.ready.host = true;
      } else if (session.guest === socket) {
        session.ready.guest = true;
      }

      // When both are ready, instruct only the non-selector to start playing (selector already started)
      if (session.ready.host && session.ready.guest) {
        const selector = session.lastSelector; // 'host' or 'guest'
        if (selector === 'host') {
          // host selected -> tell guest to sync_play
          if (session.guest) session.guest.emit('sync_play', { data: session.pendingSong });
        } else if (selector === 'guest') {
          // guest selected -> tell host to sync_play
          if (session.host) session.host.emit('sync_play', { data: session.pendingSong });
        } else {
          // fallback: if unknown, emit to both
          if (session.host) session.host.emit('sync_play', { data: session.pendingSong });
          if (session.guest) session.guest.emit('sync_play', { data: session.pendingSong });
        }

        // Clear pending state
        session.pendingSong = null;
        session.ready.host = false;
        session.ready.guest = false;
        session.lastSelector = null;
      }
    } catch (e) {
      console.error('ready_for_play handler error:', e);
    }
  });

  // Auto-sync: forward playback_position (full payload preserved)
  socket.on('playback_position', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const session = sessions[sessionId];
      if (!session) return;

      if (session.host === socket && session.guest) {
        session.guest.emit('playback_position', payload);
      } else if (session.guest === socket && session.host) {
        session.host.emit('playback_position', payload);
      }
    } catch (e) {
      console.error('playback_position handler error:', e);
    }
  });

  // --- Queue sync handlers (payload objects expected) ---
  socket.on('add_to_queue', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const song = payload.song;
      if (!sessionId || !song) return;
      console.log('Received add_to_queue', sessionId, song);
      const session = sessions[sessionId];
      if (!session) return;
      if (!session.queue.some(s => s.videoId === song.videoId)) {
        session.queue.push(song);
      }
      io.to(sessionId).emit('queue_updated', { queue: session.queue });
    } catch (e) {
      console.error('add_to_queue handler error:', e);
    }
  });

  socket.on('remove_from_queue', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const videoId = payload.videoId;
      if (!sessionId || !videoId) return;
      const session = sessions[sessionId];
      if (!session) return;
      session.queue = session.queue.filter(s => s.videoId !== videoId);
      io.to(sessionId).emit('queue_updated', { queue: session.queue });
    } catch (e) {
      console.error('remove_from_queue handler error:', e);
    }
  });

  socket.on('move_in_queue', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const oldIndex = payload.oldIndex;
      const newIndex = payload.newIndex;
      if (typeof oldIndex !== 'number' || typeof newIndex !== 'number') return;
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
    } catch (e) {
      console.error('move_in_queue handler error:', e);
    }
  });

  socket.on('update_queue', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      const queue = payload.queue;
      if (!sessionId || !Array.isArray(queue)) return;
      const session = sessions[sessionId];
      if (!session) return;
      session.queue = queue;
      io.to(sessionId).emit('queue_updated', { queue: session.queue });
    } catch (e) {
      console.error('update_queue handler error:', e);
    }
  });

  socket.on('clear_queue', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const session = sessions[sessionId];
      if (!session) return;
      session.queue = [];
      io.to(sessionId).emit('queue_updated', { queue: session.queue });
    } catch (e) {
      console.error('clear_queue handler error:', e);
    }
  });

  // Explicit leave event
  socket.on('leave_session', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const session = sessions[sessionId];
      if (!session) return;
      const isHost = session.host === socket;
      const other = isHost ? session.guest : session.host;
      if (other) {
        other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
      }
      if (isHost) {
        delete sessions[sessionId];
      } else {
        session.guest = null;
        session.profiles.guest = null;
        io.to(sessionId).emit('profiles_updated', session.profiles);
      }
      socket.leave(sessionId);
    } catch (e) {
      console.error('leave_session handler error:', e);
    }
  });

  // Disconnect handling similar to leave
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
          delete sessions[sessionId];
        } else {
          session.guest = null;
          session.profiles.guest = null;
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
