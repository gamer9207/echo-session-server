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
      currentPlaylistId: null, // Track current playlist context
      playlistSongIds: [], // Track which songs came from current playlist
      profiles: { host: null, guest: null },
      playbackState: { playing: false, positionMs: 0, currentSongId: null }
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
  socket.on('change_song', ({ sessionId, data, playlistId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.pendingSong = data;
    session.ready.host = false;
    session.ready.guest = false;
    session.playbackState.positionMs = 0;
    session.playbackState.currentSongId = data?.song?.videoId || null;

    // If playing from a playlist, update playlist context
    if (playlistId) {
      session.currentPlaylistId = playlistId;
    } else {
      // If playing a single song (not from playlist), clear playlist context and remove playlist songs
      if (session.currentPlaylistId !== null) {
        console.log(`[${sessionId}] Cleared playlist context, removing ${session.playlistSongIds.length} playlist songs`);
        session.queue = session.queue.filter(s => !session.playlistSongIds.includes(s.videoId));
        session.currentPlaylistId = null;
        session.playlistSongIds = [];
      }
    }

    console.log(`[${sessionId}] Song change requested from playlist: ${playlistId || 'NONE'}`);

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

  // UPDATE PLAYLIST CONTEXT - when songs from playlist are added
  socket.on('update_playlist_context', ({ sessionId, playlistId, playlistSongs }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.currentPlaylistId = playlistId;
    const newPlaylistSongIds = playlistSongs.map(s => s.videoId);
    
    // Add playlist songs to queue
    for (const song of playlistSongs) {
      if (!session.queue.some(s => s.videoId === song.videoId)) {
        session.queue.push(song);
      }
    }
    
    session.playlistSongIds = newPlaylistSongIds;
    console.log(`[${sessionId}] Updated playlist context: ${playlistId}, added ${newPlaylistSongIds.length} songs`);
    
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
  });

  // QUEUE OPERATIONS
  socket.on('add_to_queue', ({ sessionId, song }) => {
    const session = sessions[sessionId];
    if (!session) return;

    // Don't add if already in queue
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
    session.playlistSongIds = session.playlistSongIds.filter(id => id !== videoId);
    
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
    session.playlistSongIds = [];
    session.currentPlaylistId = null;
    io.to(sessionId).emit('queue_updated', { queue: [] });
  });

  // SONG COMPLETED - remove from queue
  socket.on('song_completed', ({ sessionId, videoId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    session.queue = session.queue.filter(s => s.videoId !== videoId);
    session.playlistSongIds = session.playlistSongIds.filter(id => id !== videoId);
    session.playbackState.currentSongId = null;
    
    io.to(sessionId).emit('queue_updated', { queue: session.queue });
    console.log(`[${sessionId}] Removed completed song from queue: ${videoId}`);
  });

  // LEAVE SESSION
  socket.on('leave_session', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const isHost = session.host === socket.id;
    const otherSocketId = isHost ? session.guest : session.host;

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
