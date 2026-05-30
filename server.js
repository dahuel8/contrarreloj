const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── HTTP server (serve index.html + static files) ──────────────
const server = http.createServer((req, res) => {
  const safePath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', safePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── WebSocket server ────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// rooms: { roomCode: { hostId, state, players: Map<ws, {name,teamIdx,isHost}> } }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? genCode() : c;
}

function broadcast(room, msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  for (const [ws] of room.players) {
    if (ws !== exceptWs && ws.readyState === 1) ws.send(data);
  }
}

function broadcastAll(room, msg) { broadcast(room, msg, null); }

function roomSummary(room) {
  return {
    type: 'room_update',
    state: room.state,
    players: [...room.players.values()].map(p => ({
      name: p.name, teamIdx: p.teamIdx, isHost: p.isHost
    }))
  };
}

wss.on('connection', ws => {
  let myRoom = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ROOM ──
    if (msg.type === 'create_room') {
      const code = genCode();
      const state = { screen: 'lobby', teams: msg.teams, currentTeamIdx: 0,
                      cardIndex: 0, deck: msg.deck, currentCardColor: 'default',
                      teamScores: msg.teams.map(() => 0), roundScores: [],
                      roundsPlayed: 0, powersUnlocked: false, powersUsed: [],
                      powerUsedThisTurn: false, roundsSinceAllUsed: null };
      const room = { code, state, players: new Map() };
      rooms.set(code, room);
      myRoom = room;
      room.players.set(ws, { name: msg.playerName || 'Host', teamIdx: -1, isHost: true });
      ws.send(JSON.stringify({ type: 'created', code }));
      broadcastAll(room, roomSummary(room));
      return;
    }

    // ── JOIN ROOM ──
    if (msg.type === 'join_room') {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      myRoom = room;
      // assign team sequentially: count non-host players already in room
      const nonHostCount = [...room.players.values()].filter(p => !p.isHost).length;
      const teamCount = room.state.teams ? room.state.teams.length : 1;
      const assignedTeamIdx = nonHostCount % teamCount;
      room.players.set(ws, { name: msg.playerName || 'Jugador', teamIdx: assignedTeamIdx, isHost: false });
      // send joined with assigned team index AND full player list
      const playerList = [...room.players.values()].map(p => ({
        name: p.name, teamIdx: p.teamIdx, isHost: p.isHost
      }));
      ws.send(JSON.stringify({
        type: 'joined',
        code: room.code,
        state: room.state,
        myTeamIdx: assignedTeamIdx,
        players: playerList
      }));
      broadcastAll(room, roomSummary(room));
      return;
    }

    if (!myRoom) return;

    // ── HOST ACTIONS (all game state changes) ──
    if (msg.type === 'game_action') {
      const { action, payload } = msg;
      const s = myRoom.state;

      if (action === 'start_game') {
        s.screen = 'card_choice';
        s.currentTeamIdx = 0;
      }
      if (action === 'pick_color') {
        s.currentCardColor = payload.color;
        s.screen = 'playing';
      }
      if (action === 'next_card') {
        s.roundScores.push(payload.score);
        s.teamScores[s.currentTeamIdx] = (s.teamScores[s.currentTeamIdx] || 0) + payload.score;
        s.cardIndex++;
        s.powerUsedThisTurn = false;
        if (s.cardIndex >= s.deck.length) { s.screen = 'result'; }
        else { s.screen = 'playing'; }
      }
      if (action === 'finish_round') {
        s.roundScores.push(payload.score);
        s.teamScores[s.currentTeamIdx] = (s.teamScores[s.currentTeamIdx] || 0) + payload.score;
        s.roundsPlayed = (s.roundsPlayed || 0) + 1;
        s.powerUsedThisTurn = false;
        s.currentTeamIdx = (s.currentTeamIdx + 1) % s.teams.length;
        s.currentCardColor = 'default';
        s.cardIndex++;
        const windowSize = s.teams.length * 2;
        if (!s.powersUnlocked && s.roundsPlayed >= windowSize && s.roundsSinceAllUsed === null) {
          s.powersUnlocked = true;
        }
        if (s.roundsSinceAllUsed !== null) {
          s.roundsSinceAllUsed++;
          if (s.roundsSinceAllUsed >= windowSize) {
            s.powersUnlocked = true; s.powersUsed = []; s.roundsSinceAllUsed = null;
          }
        }
        if (s.cardIndex >= s.deck.length) { s.screen = 'result'; }
        else { s.screen = 'handoff'; }
      }
      if (action === 'handoff_done') {
        s.screen = 'card_choice';
      }
      if (action === 'restart_round') {
        // go back to card choice with next card
        s.cardIndex++;
        if (s.cardIndex >= s.deck.length) s.cardIndex = 0;
        s.currentCardColor = 'default';
        s.screen = 'card_choice';
      }
      if (action === 'emergency') {
        s.emergencyActive = true;
      }
      if (action === 'clear_emergency') {
        s.emergencyActive = false;
      }
      if (action === 'use_power') {
        if (!s.powersUnlocked || s.powersUsed.includes(payload.power) || s.powerUsedThisTurn) {
          return;
        }
        s.powerUsedThisTurn = true;
        s.powersUsed.push(payload.power);
        if (s.powersUsed.length >= 4) {
          s.powersUnlocked = false; s.roundsSinceAllUsed = 0;
        }
      }
      if (action === 'new_game') {
        s.cardIndex = 0; s.currentTeamIdx = 0;
        s.teamScores = s.teams.map(() => 0);
        s.roundScores = []; s.currentCardColor = 'default';
        s.roundsPlayed = 0; s.powersUnlocked = false; s.powersUsed = [];
        s.powerUsedThisTurn = false; s.roundsSinceAllUsed = null;
        s.deck = payload.deck;
        s.screen = 'card_choice';
      }
      if (action === 'go_home') {
        s.screen = 'home';
      }

      // relay full state to everyone
      broadcastAll(myRoom, { type: 'state_update', state: s, action, payload });
      return;
    }

    // ── PING (keep-alive) ──
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    const player = myRoom.players.get(ws);
    myRoom.players.delete(ws);
    if (myRoom.players.size === 0) {
      rooms.delete(myRoom.code);
    } else {
      // if host left, assign new host
      if (player?.isHost) {
        const [newWs, newPlayer] = myRoom.players.entries().next().value;
        newPlayer.isHost = true;
        newWs.send(JSON.stringify({ type: 'you_are_host' }));
      }
      broadcastAll(myRoom, roomSummary(myRoom));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Contrarreloj server running on port ${PORT}`));
