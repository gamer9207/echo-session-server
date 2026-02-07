const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["polling", "websocket"],
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 60000
});

const sessions = {}; 
const hostSyncIntervals = {}; // Track sync intervals per session

app.get('/', (req, res) => {
  res.send('Echo Session Server is running!');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // CREATE SESSION
  socket.on('create_session', () => {
    const sessionId = nanoid(10);

    sessions[sessionId] = {
      host: socket.id,
      guest: null,
      ready: { host: false, guest: false },
      pendingSong: null,
      queue: [],
      profiles: { host: null, guest: null },
      playbackState: { playing: false, positionMs: 0 },
      hostCurrentSong: null, // Track what host is currently playing
      guestCurrentSong: null // Track what guest is currently playing
    };

    socket.join(sessionId);
    socket.emit('session_created', { sessionId });
    console.log(`[${sessionId}] Session created by ${socket.id}`);
  });

  // JOIN SESSION
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

    session.guest = socket.id;
    socket.join(sessionId);

    io.to(sessionId).emit('guest_joined');
    socket.emit('session_joined', { sessionId });
    socket.emit('queue_updated', { queue: session.queue });

    if (session.profiles.host || session.profiles.guest) {
      io.to(sessionId).emit('profiles_updated', session.profiles);
    }

    // Start 3-second sync interval when guest joins
    _startHostSyncInterval(sessionId);

    console.log(`[${sessionId}] Socket ${socket.id} joined as guest`);
  });

  // PROFILE SYNC
  socket.on('send_profile', ({ username, profileImagePath }) => {
    for (const sessionId in sessions) {
      const session = sessions[sessionId];

      if (session.host === socket.id) {
        session.profiles.host = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);
      } else if (session.guest === socket.id) {
        session.profiles.guest = { username, profileImagePath };
        io.to(sessionId).emit('profiles_updated', session.profiles);
      }
    }
  });

  // TRACK HOST'S CURRENT SONG
  socket.on('host_current_song', ({ sessionId, videoId, title, position, duration }) => {
    const session = sessions[sessionId];
    if (!session || session.host !== socket.id) return;

    session.hostCurrentSong = {
      videoId,
      title,
      position,
      duration,
      timestamp: Date.now()
    };

    console.log(`[${sessionId}] Host now playing: ${videoId} (${title})`);
  });

  // TRACK GUEST'S CURRENT SONG
  socket.on('guest_current_song', ({ sessionId, videoId, title, position, duration }) => {
    const session = sessions[sessionId];
    if (!session || session.guest !== socket.id) return;

    session.guestCurrentSong = {
      videoId,
      title,
      position,
      duration,
      timestamp: Date.now()
    };

    console.log(`[${sessionId}] Guest now playing: ${videoId} (${title})`);
  });

  // PLAYBACK EVENTS - BROADCAST TO BOTH PEERS
  socket.on('playback_event', ({ sessionId, event, data, position }) => {
    const session = sessions[sessionId];
    if (!session) {
      console.log(`[${sessionId}] Session not found for playback event`);
      return;
    }

    // Update server state
    session.playbackState.playing = (event === 'play');
    session.playbackState.positionMs = position || 0;

    const payload = { event, position: position || 0, data };

    console.log(`[${sessionId}] Playback event: ${event} at ${position}ms`);

    // CRITICAL: Broadcast to BOTH peers (including originator for sync)
    io.to(sessionId).emit('playback_event', payload);
  });

  // SONG CHANGE SYNC
  socket.on('change_song', ({ sessionId, data }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;
    session.playbackState.positionMs = 0;

    console.log(`[${sessionId}] Song change requested`);

    // Send to both - let them prepare
    io.to(sessionId).emit('prepare_song', { data });
  });

  // READY FOR PLAY
  socket.on('ready_for_play', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session || !session.pendingSong) {
      console.log(`[${sessionId}] Ready received but no pending song`);
      return;
    }

    // Mark who is ready
    if (session.host === socket.id) {
      session.ready.host = true;
    } else if (session.guest === socket.id) {
      session.ready.guest = true;
    }

    console.log(`[${sessionId}] Ready state: host=${session.ready.host}, guest=${session.ready.guest}`);

    // When BOTH are ready, sync play
    if (session.ready.host && session.ready.guest) {
      console.log(`[${sessionId}] Both ready - syncing play`);
      
      const startAt = Date.now() + 500; // 500ms delay for both to start
      const payload = {
        data: session.pendingSong,
        startAt: startAt
      };

      // Send sync play to both peers
      io.to(sessionId).emit('sync_play', payload);

      session.playbackState.playing = true;
      session.pendingSong = null;
      session.ready.host = false;
      session.ready.guest = false;
    }
  });

  // POSITION SYNC (guest -> host for keepalive)
  socket.on('playback_position', ({ sessionId, position }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.playbackState.positionMs = position;
  });

  // QUEUE OPERATIONS
  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (!session.queue.some(s => s.videoId === song.videoId)) {
      session.queue.push(song);
    }

    io.to(sessionId).emit('queue_updated', { queue: session.queue });
    console.log(`[${sessionId}] Added to queue: ${song.title || song.videoId}`);
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

  // LEAVE SESSION
  socket.on('leave_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const isHost = session.host === socket.id;
    const otherSocketId = isHost ? session.guest : session.host;

    if (isHost) {
      // Clear sync interval when host leaves
      if (hostSyncIntervals[sessionId]) {
        clearInterval(hostSyncIntervals[sessionId]);
        delete hostSyncIntervals[sessionId];
      }
      delete sessions[sessionId];
      if (session.guest) {
        io.to(sessionId).emit('partner_left', { by: 'host' });
      }
    } else {
      session.guest = null;
      session.profiles.guest = null;
      io.to(sessionId).emit('profiles_updated', session.profiles);
      io.to(sessionId).emit('partner_left', { by: 'guest' });
    }

    socket.leave(sessionId);
    console.log(`[${sessionId}] ${socket.id} left session`);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log("Socket disconnected:", socket.id);

    setTimeout(() => {
      for (const sessionId in sessions) {
        const session = sessions[sessionId];

        if (session.host === socket.id || session.guest === socket.id) {
          const isHost = session.host === socket.id;
          const otherSocketId = isHost ? session.guest : session.host;

          if (isHost) {
            // Clear sync interval when host disconnects
            if (hostSyncIntervals[sessionId]) {
              clearInterval(hostSyncIntervals[sessionId]);
              delete hostSyncIntervals[sessionId];
            }
            delete sessions[sessionId];
          } else if (otherSocketId) {
            const otherSocket = io.sockets.sockets.get(otherSocketId);
            if (otherSocket) {
              otherSocket.emit('partner_left', { by: 'guest' });
              otherSocket.leave(sessionId);
            }
            delete sessions[sessionId];
          }
        }
      }
    }, 5000);
  });
});

// Function to start 3-second sync interval for host
function _startHostSyncInterval(sessionId) {
  // Clear any existing interval
  if (hostSyncIntervals[sessionId]) {
    clearInterval(hostSyncIntervals[sessionId]);
  }

  hostSyncIntervals[sessionId] = setInterval(() => {
    const session = sessions[sessionId];
    
    // Clear interval if session no longer exists
    if (!session) {
      if (hostSyncIntervals[sessionId]) {
        clearInterval(hostSyncIntervals[sessionId]);
        delete hostSyncIntervals[sessionId];
      }
      return;
    }

    // Only proceed if both host and guest are connected
    if (!session.host || !session.guest || !session.hostCurrentSong) {
      return;
    }

    const hostSong = session.hostCurrentSong;
    const guestSong = session.guestCurrentSong;

    // Compare videoIds to detect song mismatch
    const hostVideoId = hostSong.videoId?.toString();
    const guestVideoId = guestSong?.videoId?.toString();

    if (!hostVideoId) return;

    // If different songs or guest has no song, force sync
    if (hostVideoId !== guestVideoId) {
      console.log(`[${sessionId}] SYNC DETECTED: Host playing ${hostVideoId}, Guest playing ${guestVideoId} - forcing guest to sync`);

      // Send force_sync event to guest with host's current song
      io.to(sessionId).emit('force_sync_song', {
        videoId: hostSong.videoId,
        title: hostSong.title,
        position: hostSong.position,
        duration: hostSong.duration,
        timestamp: Date.now()
      });
    }
  }, 3000); // Check every 3 seconds
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
