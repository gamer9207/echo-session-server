const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 60000,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

const sessions = {};

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
      lastPlaybackEvent: null // FIX: Track last event
    };
    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`Session created: ${sessionId} by ${socket.id}`);
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

    session.guest = socket;
    socket.join(sessionId);

    session.host.emit('guest_joined');
    socket.emit('session_joined', { sessionId });
    socket.emit('queue_updated', { queue: session.queue });

    if (session.profiles.host || session.profiles.guest) {
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    // FIX: Sync last playback state to newly joined guest
    if (session.lastPlaybackEvent) {
      socket.emit('playback_event', session.lastPlaybackEvent);
    }

    console.log(`Socket ${socket.id} joined session ${sessionId}`);
  });

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

  // FIX: Store and broadcast playback events
  socket.on('playback_event', ({ sessionId, event, data, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const payload = { event, position, data };
    
    // Store last event for newly joining guests
    session.lastPlaybackEvent = payload;
    
    console.log(`[${sessionId}] Playback event: ${event} at ${position}ms`);

    // Broadcast to peer
    if (session.host === socket && session.guest) {
      session.guest.emit('playback_event', payload);
    } else if (session.guest === socket && session.host) {
      session.host.emit('playback_event', payload);
    }
  });

  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;

    if (session.host) session.host.emit('prepare_song', { data });
    if (session.guest) session.guest.emit('prepare_song', { data });
    
    console.log(`[${sessionId}] Song change requested`);
  });

  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) return;

    if (session.host === socket) session.ready.host = true;
    else if (session.guest === socket) session.ready.guest = true;

    console.log(`[${sessionId}] Ready state: host=${session.ready.host}, guest=${session.ready.guest}`);

    if (session.ready.host && session.ready.guest) {
      const syncPayload = { data: session.pendingSong };
      session.host?.emit('sync_play', syncPayload);
      session.guest?.emit('sync_play', syncPayload);

      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
      
      console.log(`[${sessionId}] Sync play initiated`);
    }
  });

  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (session.host === socket && session.guest) {
      session.guest.emit('playback_position', { position });
    }
  });

  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (!session.queue.some(s => s.videoId === song.videoId)) {
      session.queue.push(song);
    }

    io.to(sessionId).emit('queue_updated', { queue: session.queue });
    console.log(`[${sessionId}] Added to queue: ${song.title}`);
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

  socket.on('disconnect', () => {
    console.log("Socket disconnected:", socket.id);

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
    }, 10000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
