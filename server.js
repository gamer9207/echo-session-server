const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// sessions[sessionId] = { host, guest, ready, pendingSong, queue, profiles: {host, guest} }
const sessions = {}; // sessionId -> session object

// When both clients are ready we'll give them this many ms to start after sync_play
const START_AFTER_READY_MS = 350;

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
    };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by socket ${socket.id}`);
  });

  socket.on('join_session', (payload) => {
    let sessionId = null;
    if (!payload) {
      socket.emit('invalid_session', { message: 'Missing sessionId.' });
      return;
    }
    sessionId = typeof payload === 'string' ? payload : payload.sessionId;
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

  socket.on('send_profile', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { username, profileImagePath } = payload;
    for (const sid in sessions) {
      const session = sessions[sid];
      if (session.host === socket) {
        session.profiles.host = { username, profileImagePath };
        io.to(sid).emit('profiles_updated', session.profiles);
        break;
      } else if (session.guest === socket) {
        session.profiles.guest = { username, profileImagePath };
        io.to(sid).emit('profiles_updated', session.profiles);
        break;
      }
    }
  });

  // Forward playback_event (play/pause/seek) immediately; include serverTime will be added by server-side if client needs it
  socket.on('playback_event', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const session = sessions[sessionId];
    if (!session) return;
    // attach serverTime for receivers
    const augmented = Object.assign({}, payload, { serverTime: Date.now() });

    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', augmented);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', augmented);
    }
  });

  // change_song: schedule a coordinated start. We DO NOT allow selector to play immediately.
  // Steps:
  // 1) store pendingSong (song + position + selector)
  // 2) reset ready flags
  // 3) emit 'stop' to both to immediately halt current playback
  // 4) emit 'prepare_song' to both so they load & buffer
  socket.on('change_song', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const data = payload.data;
    if (!sessionId || !data) return;
    const session = sessions[sessionId];
    if (!session) return;

    // Detect duplicate same-song change by same selector and ignore
    try {
      const selector = session.host === socket ? 'host' : (session.guest === socket ? 'guest' : null);
      const incomingVid = data?.song?.videoId;
      if (session.pendingSong && session.pendingSong.song && incomingVid) {
        const prevVid = session.pendingSong.song.videoId;
        const prevSelector = session.pendingSong.selector;
        if (prevVid === incomingVid && prevSelector === selector) {
          console.log(`Ignoring duplicate change_song for ${incomingVid} by ${selector}`);
          return;
        }
      }
    } catch (_) {}

    // record pending song and selector
    const selectorLabel = session.host === socket ? 'host' : (session.guest === socket ? 'guest' : null);
    session.pendingSong = {
      song: data.song,
      position: data.position ?? 0,
      selector: selectorLabel,
      // note: start timing will be computed on ready_for_play when both are ready
    };

    session.ready = { host: false, guest: false };

    // stop both peers immediately so the other peer doesn't keep playing the old track
    try { if (session.host) session.host.emit('stop'); } catch (_) {}
    try { if (session.guest) session.guest.emit('stop'); } catch (_) {}

    // instruct both peers to prepare (load + buffer) the new song
    try { if (session.host) session.host.emit('prepare_song', { data }); } catch (_) {}
    try { if (session.guest) session.guest.emit('prepare_song', { data }); } catch (_) {}

    console.log(`change_song stored for session ${sessionId} selector=${selectorLabel} videoId=${data.song?.videoId}`);
  });

  // ready_for_play: when both ready, compute a fresh start delay (relative) and emit sync_play with that delay
  socket.on('ready_for_play', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) session.ready.host = true;
    else if (session.guest === socket) session.ready.guest = true;

    if (session.ready.host && session.ready.guest) {
      // compute small start delay relative to now so both clients can schedule locally
      const startInMs = START_AFTER_READY_MS;

      const syncPayload = {
        data: {
          song: session.pendingSong.song,
          position: session.pendingSong.position,
          selector: session.pendingSong.selector,
          startInMs: startInMs,
        }
      };

      try { if (session.host) session.host.emit('sync_play', syncPayload); } catch (_) {}
      try { if (session.guest) session.guest.emit('sync_play', syncPayload); } catch (_) {}

      // clear pending
      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
      console.log(`sync_play emitted to session ${sessionId} with startInMs=${startInMs}`);
    }
  });

  // playback_position relay (host -> guest)
  socket.on('playback_position', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const session = sessions[sessionId];
    if (!session) return;
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_position', payload);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_position', payload);
    }
  });

  // queue ops
  socket.on('add_to_queue', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const song = payload.song;
    const session = sessions[sessionId];
    if (!session) return;
    if (!session.queue.some(s => s.videoId === song.videoId)) {
      session.queue.push(song);
    }
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('remove_from_queue', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const videoId = payload.videoId;
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = session.queue.filter(s => s.videoId !== videoId);
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('move_in_queue', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const oldIndex = payload.oldIndex;
    const newIndex = payload.newIndex;
    const session = sessions[sessionId];
    if (!session) return;
    const queue = session.queue;
    if (oldIndex < 0 || oldIndex >= queue.length || newIndex < 0 || newIndex > queue.length) return;
    const [song] = queue.splice(oldIndex, 1);
    queue.splice(newIndex, 0, song);
    session.queue = queue;
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('update_queue', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const queue = payload.queue;
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = queue;
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  socket.on('clear_queue', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const session = sessions[sessionId];
    if (!session) return;
    session.queue = [];
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  // leaving
  socket.on('leave_session', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = payload.sessionId;
    const session = sessions[sessionId];
    if (!session) return;
    const isHost = session.host === socket;
    const other = isHost ? session.guest : session.host;
    if (other) other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
    if (isHost) delete sessions[sessionId];
    else {
      session.guest = null;
      session.profiles.guest = null;
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }
    socket.leave(sessionId);
  });

  socket.on('disconnect', () => {
    for (const sid in sessions) {
      const session = sessions[sid];
      if (session.host === socket || session.guest === socket) {
        const isHost = session.host === socket;
        const other = isHost ? session.guest : session.host;
        if (other) other.emit('partner_left', { by: isHost ? 'host' : 'guest' });
        if (isHost) delete sessions[sid];
        else {
          session.guest = null;
          session.profiles.guest = null;
          io.to(sid).emit('profiles_updated', session.profiles);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});
