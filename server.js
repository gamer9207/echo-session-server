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
      currentSongs: { host: null, guest: null },  // NEW: track current songs
      songSyncIntervals: {}  // NEW: store interval IDs for cleanup
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

    // NEW: Start the 3-second sync interval for this session
    _startSongSyncInterval(sessionId, io);

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

  // NEW: Track current song on host/guest
  socket.on('update_current_song', ({ sessionId, song, durationMs }) => {
    const session = sessions[sessionId];
    if (!session) return;

    if (session.host === socket.id) {
      session.currentSongs.host = { song, durationMs, updatedAt: Date.now() };
    } else if (session.guest === socket.id) {
      session.currentSongs.guest = { song, durationMs, updatedAt: Date.now() };
    }

    console.log(`[${sessionId}] Current song updated`);
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

    // NEW: Clear sync interval when leaving
    if (session.songSyncIntervals[sessionId]) {
      clearInterval(session.songSyncIntervals[sessionId]);
      delete session.songSyncIntervals[sessionId];
    }

    if (isHost) {
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

          // NEW: Clear sync interval on disconnect
          if (session.songSyncIntervals[sessionId]) {
            clearInterval(session.songSyncIntervals[sessionId]);
            delete session.songSyncIntervals[sessionId];
          }

          if (isHost) {
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

// NEW: Song sync interval function
function _startSongSyncInterval(sessionId, io) {
  const session = sessions[sessionId];
  if (!session) return;

  // Clear any existing interval
  if (session.songSyncIntervals[sessionId]) {
    clearInterval(session.songSyncIntervals[sessionId]);
  }

  // Start 3-second check interval
  session.songSyncIntervals[sessionId] = setInterval(() => {
    const hostSong = session.currentSongs.host;
    const guestSong = session.currentSongs.guest;

    // Only sync if both players have song data
    if (!hostSong || !guestSong) return;

    const hostVideoId = hostSong.song?.videoId;
    const guestVideoId = guestSong.song?.videoId;

    // If different songs, sync host's song to guest
    if (hostVideoId && guestVideoId && hostVideoId !== guestVideoId) {
      console.log(`[${sessionId}] Song mismatch detected. Host: ${hostVideoId}, Guest: ${guestVideoId}`);
      console.log(`[${sessionId}] Syncing host song to guest...`);

      // Send sync command to guest with host's song
      io.to(session.guest).emit('force_song_sync', {
        song: hostSong.song,
        durationMs: hostSong.durationMs,
        positionMs: 0  // Start from beginning
      });

      // Update tracked songs to avoid repeated syncs
      session.currentSongs.guest = {
        song: hostSong.song,
        durationMs: hostSong.durationMs,
        updatedAt: Date.now()
      };
    }
  }, 3000);  // Check every 3 seconds
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
