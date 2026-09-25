import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { io } from 'socket.io-client';
import { readFileSync, writeFileSync } from 'fs';

const t = JSON.parse(readFileSync('/tmp/p2t.json','utf8'));

// 1) join matchmaking queue at the emulator default Quick Match stake (₦2,000)
const joinRes = await fetch('http://localhost:3000/api/v1/matchmaking/join', {
  method:'POST',
  headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+t.at },
  body: JSON.stringify({ stakeMinorUnits: 200000 })
});
console.log('join:', joinRes.status, (await joinRes.text()).slice(0,200));

// 2) socket: user room should get match_found / room events so P1 emulator gets a live match
const socket = io('http://localhost:3000', {
  path:'/app/socket.io',
  auth:{ token: t.at },
  transports:['websocket']
});
socket.on('connect', ()=>console.log('socket connected', socket.id));
socket.on('match_found', (d)=>console.log('MATCH_FOUND', JSON.stringify(d)));
socket.on('room_state', (d)=>console.log('room_state', typeof d==='string'?d:JSON.stringify(d).slice(0,200)));
socket.on('match_started', (d)=>{ console.log('MATCH_STARTED'); setTimeout(()=>socket.emit('player_ready',{}), 400); });
socket.on('move_played', (d)=>console.log('move_played', JSON.stringify(d).slice(0,120)));
socket.on('connect_error', e=>console.log('socket err', e.message));
setInterval(()=>{ /* keep alive */ }, 30000);
