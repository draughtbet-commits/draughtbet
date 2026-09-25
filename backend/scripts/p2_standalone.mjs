import { io } from 'socket.io-client';
import { readFileSync, writeFileSync } from 'fs';
const t = JSON.parse(readFileSync('/tmp/p2t.json','utf8'));
const at = t.at;
const socket = io('http://localhost:3000', {
  path: '/socket.io',        // matches socket_service default
  auth: { token: at },
  transports: ['websocket'],
});
let ready = false;
socket.on('connect', () => { console.log('P2 socket connected', socket.id); });
socket.on('connect_error', e => console.log('connect_error', e.message));
socket.on('match_found', d => { console.log('P2 match_found', JSON.stringify(d)); });
socket.on('room_created', async (d) => {
  console.log('P2 room_created', JSON.stringify(d).slice(0,180));
});
socket.on('player_ready_request', async (d) => {
  // Auto-ready: P2 immediately asserts ready so the room starts quickly for P1.
  socket.emit('player_ready', {});
  console.log('P2 auto-ready');
});
socket.on('move_requested', async (d) => {
  // Auto-accept proposed terms / start.
  socket.emit('ready_accept', {});
  console.log('P2 ready_accept');
});
socket.on('opponent_joined', () => console.log('P2 opponent joined'));
socket.on('match_started', () => console.log('P2 match_started'));
socket.on('game_state', d => console.log('P2 game_state', JSON.stringify(d).slice(0,160)));
socket.on('move_applied', d => console.log('P2 move_applied', JSON.stringify(d).slice(0,160)));
socket.on('move_rejected', d => console.log('P2 move_rejected', JSON.stringify(d)));
socket.on('disconnect', r => console.log('P2 socket disconnected', r));
