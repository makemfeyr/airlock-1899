import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const MAX_WAIT_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();
const clients = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function safeName(value) {
  const name = String(value || 'Survivor').replace(/[<>&"'`]/g, '').trim().slice(0, 20);
  return name || 'Survivor';
}

function roomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    isPublic: room.isPublic,
    maxPlayers: room.maxPlayers,
    status: room.status,
    createdAt: room.createdAt,
    startsAt: room.startsAt,
    seed: room.seed || null,
    players: [...room.players.values()].map(({ id, name, ready }) => ({ id, name, ready })),
    spectators: [...room.spectators.values()].map(({ id, name }) => ({ id, name })),
    gameState: room.gameState
  };
}

function send(client, type, data = {}) {
  const socket = client?.socket || client;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...data }));
  }
}

function broadcast(room, type, data = {}) {
  const message = JSON.stringify({ type, ...data });
  [...room.players.keys(), ...room.spectators.keys()].forEach(id => {
    const client = clients.get(id);
    if (client?.readyState === WebSocket.OPEN) client.send(message);
  });
}

function broadcastRoom(room) {
  broadcast(room, 'room_updated', { room: roomSummary(room) });
}

function unlink(client) {
  const room = client.roomCode && rooms.get(client.roomCode);
  if (!room) {
    client.roomCode = null;
    client.role = null;
    return;
  }
  room.players.delete(client.id);
  room.spectators.delete(client.id);
  if (room.hostId === client.id && room.players.size) {
    room.hostId = room.players.keys().next().value;
  }
  client.roomCode = null;
  client.role = null;
  if (room.players.size === 0 && room.spectators.size === 0) {
    clearTimeout(room.startTimer);
    rooms.delete(room.code);
  } else {
    broadcastRoom(room);
  }
}

function startRoom(room, reason) {
  if (room.status !== 'WAITING' || room.players.size === 0) return false;
  room.status = 'PLAYING';
  clearTimeout(room.startTimer);
  room.startedAt = Date.now();
  room.seed = randomInt(1000, 10000);
  broadcast(room, 'room_started', {
    room: roomSummary(room),
    reason
  });
  broadcastRoom(room);
  return true;
}

function createRoom(client, message) {
  if (client.roomCode) throw new Error('Leave your current room before creating another.');
  const maxPlayers = Number(message.maxPlayers);
  if (![2, 3, 4, 5].includes(maxPlayers)) throw new Error('Choose a room size of 2, 3, 4, or 5 players.');
  const room = {
    code: makeCode(),
    hostId: client.id,
    maxPlayers,
    isPublic: message.isPublic !== false,
    status: 'WAITING',
    createdAt: Date.now(),
    startsAt: Date.now() + MAX_WAIT_MS,
    players: new Map(),
    spectators: new Map(),
    gameState: null,
    startTimer: null
  };
  room.players.set(client.id, { id: client.id, name: safeName(message.name), ready: false });
  client.roomCode = room.code;
  client.role = 'player';
  room.startTimer = setTimeout(() => startRoom(room, 'TIMEOUT'), MAX_WAIT_MS);
  room.startTimer.unref?.();
  rooms.set(room.code, room);
  send(client, 'room_joined', { room: roomSummary(room), role: 'player' });
  broadcastRoom(room);
}

function joinRoom(client, message, role) {
  if (client.roomCode) throw new Error('Leave your current room before joining another.');
  const code = String(message.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Room codes must contain exactly 6 letters or numbers.');
  const room = rooms.get(code);
  if (!room) throw new Error('That room code was not found.');
  const member = { id: client.id, name: safeName(message.name), ready: false };
  if (role === 'player') {
    if (room.status !== 'WAITING') throw new Error('This match has started. Join as a spectator instead.');
    if (room.players.size >= room.maxPlayers) throw new Error('This player roster is full.');
    room.players.set(client.id, member);
  } else {
    if (room.spectators.size >= 5) throw new Error('This room already has 5 spectators.');
    room.spectators.set(client.id, member);
  }
  client.roomCode = code;
  client.role = role;
  send(client, 'room_joined', { room: roomSummary(room), role });
  broadcastRoom(room);
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid message.');
  if (message.type === 'list_rooms') {
    send(client, 'room_list', {
      rooms: [...rooms.values()].filter(room => room.isPublic).map(roomSummary)
    });
    return;
  }
  if (message.type === 'create_room') return createRoom(client, message);
  if (message.type === 'join_room') return joinRoom(client, message, 'player');
  if (message.type === 'spectate_room') return joinRoom(client, message, 'spectator');

  const room = client.roomCode && rooms.get(client.roomCode);
  if (!room) throw new Error('Join a room before sending that command.');

  switch (message.type) {
    case 'ready': {
      if (client.role !== 'player' || room.status !== 'WAITING') throw new Error('Only waiting players can change readiness.');
      room.players.get(client.id).ready = Boolean(message.ready);
      broadcastRoom(room);
      break;
    }
    case 'start_game': {
      if (client.role !== 'player' || room.hostId !== client.id) throw new Error('Only the room creator can start the match.');
      if (room.status !== 'WAITING') throw new Error('This match has already started.');
      if ([...room.players.values()].some(player => !player.ready)) throw new Error('All connected players must be ready before starting.');
      if (!startRoom(room, 'HOST')) throw new Error('At least one player is required to start.');
      break;
    }
    case 'leave_room':
      unlink(client);
      send(client, 'room_left');
      break;
    case 'game_state': {
      if (client.role !== 'player' || client.id !== room.hostId || room.status !== 'PLAYING') {
        throw new Error('Only the host can publish match state.');
      }
      if (JSON.stringify(message.state || {}).length > MAX_MESSAGE_BYTES) throw new Error('Match state exceeds the size limit.');
      room.gameState = message.state || null;
      broadcast(room, 'game_state', { state: room.gameState });
      break;
    }
    case 'player_state': {
      if (client.role !== 'player' || room.status !== 'PLAYING') {
        throw new Error('Only active room players can publish player state.');
      }
      const state = message.state;
      if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.y) ||
          !Number.isInteger(state.floor) || state.floor < 0 || state.floor > 2) {
        throw new Error('Invalid player state.');
      }
      if (JSON.stringify(state).length > 1024) throw new Error('Player state exceeds the size limit.');
      broadcast(room, 'player_state', {
        playerId: client.id,
        name: room.players.get(client.id).name,
        state
      });
      break;
    }
    case 'world_action': {
      if (client.role !== 'player' || room.status !== 'PLAYING') {
        throw new Error('Only active room players can interact with the bunker.');
      }
      const { floor, objectIndex, action } = message;
      const allowedActions = [
        'collect_key',
        'drop_key',
        'activate_breaker',
        'unlock_progression',
        'toggle_door',
        'deploy_trap',
        'use_flare',
        'advance_stage'
      ];
      if (!Number.isInteger(floor) || floor < 0 || floor > 2 ||
          !Number.isInteger(objectIndex) || objectIndex < 0 ||
          !allowedActions.includes(action)) {
        throw new Error('Invalid shared-world action.');
      }
      if (action === 'drop_key' &&
          (!['VALVE_KEY', 'COPPER_FUSE', 'MASTER_KEY'].includes(message.itemId) ||
           !Number.isFinite(message.x) || !Number.isFinite(message.y))) {
        throw new Error('Invalid dropped objective key.');
      }
      broadcast(room, 'world_action', {
        playerId: client.id,
        floor,
        objectIndex,
        action,
        targetType: message.targetType,
        itemId: message.itemId,
        returnItem: message.returnItem,
        holderId: message.holderId,
        ...(Number.isFinite(message.x) && { x: message.x }),
        ...(Number.isFinite(message.y) && { y: message.y })
      });
      break;
    }
    case 'player_caught': {
      if (client.role !== 'player' || client.id !== room.hostId || room.status !== 'PLAYING') {
        throw new Error('Only the active room admin can report a caught player.');
      }
      const victim = room.players.get(String(message.playerId || ''));
      if (!victim) throw new Error('Caught player is not in this room.');
      if (!Number.isInteger(message.floor) || message.floor < 0 || message.floor > 2) {
        throw new Error('Invalid caught-player deck.');
      }
      broadcast(room, 'player_caught', {
        playerId: victim.id,
        floor: message.floor,
        reason: String(message.reason || 'CAUGHT BY A BUNKER ENTITY').slice(0, 120)
      });
      break;
    }
    case 'voice_signal': {
      if (client.role !== 'player') throw new Error('Spectators cannot use player voice chat.');
      const peer = room.players.get(String(message.to || ''));
      if (!peer || peer.id === client.id) throw new Error('Voice target is not a player in this room.');
      const signalSize = JSON.stringify(message.signal || {}).length;
      if (signalSize > 16 * 1024) throw new Error('Voice signaling message is too large.');
      send(clients.get(peer.id), 'voice_signal', {
        from: client.id,
        signal: message.signal
      });
      break;
    }
    case 'spectator_signal': {
      const peerId = String(message.to || '');
      const peer = room.spectators.get(peerId);
      const senderIsHost = client.role === 'player' && client.id === room.hostId;
      const senderIsSpectatorToHost = client.role === 'spectator' && peerId === room.hostId;
      if ((!senderIsHost || !peer) && !senderIsSpectatorToHost) {
        throw new Error('Spectator video signaling is limited to the room host.');
      }
      if (JSON.stringify(message.signal || {}).length > 16 * 1024) throw new Error('Video signaling message is too large.');
      send(clients.get(peerId), 'spectator_signal', {
        from: client.id,
        signal: message.signal
      });
      break;
    }
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/'))) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    response.writeHead(400);
    response.end('Invalid path');
    return;
  }
  const filePath = resolve(PROJECT_ROOT, `.${decodedPath}`);
  const indexPath = resolve(PROJECT_ROOT, 'index.html');
  const assetsPath = resolve(PROJECT_ROOT, 'assets');
  if (filePath !== indexPath && !filePath.startsWith(`${assetsPath}${sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.fnt': 'text/plain; charset=utf-8'
    };
    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });
wss.on('connection', socket => {
  const client = { id: randomUUID(), socket, roomCode: null, role: null };
  clients.set(client.id, socket);
  socket.send(JSON.stringify({ type: 'connected', clientId: client.id }));
  socket.on('message', raw => {
    try {
      handleMessage(client, JSON.parse(raw.toString()));
    } catch (error) {
      send(client, 'error', { message: error.message });
    }
  });
  socket.on('close', () => {
    unlink(client);
    clients.delete(client.id);
  });
  socket.on('error', error => console.error(`WebSocket error for ${client.id}:`, error.message));
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(PORT, () => {
    console.log(`Airlock 1899 room server listening on http://localhost:${PORT}`);
  });
}

export { clients, handleMessage, makeCode, roomSummary, rooms, server, startRoom };