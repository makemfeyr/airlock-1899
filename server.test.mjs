import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clients, handleMessage, rooms } from './server.mjs';

const fakeClients = [];

function fakeClient(id) {
  const messages = [];
  const socket = {
    readyState: 1,
    send(data) {
      messages.push(JSON.parse(data));
    }
  };
  clients.set(id, socket);
  const client = { id, socket, roomCode: null, role: null, readyState: 1, send: socket.send.bind(socket), messages };
  fakeClients.push(client);
  return client;
}

afterEach(() => {
  rooms.forEach(room => clearTimeout(room.startTimer));
  rooms.clear();
  fakeClients.forEach(client => clients.delete(client.id));
  fakeClients.length = 0;
});

test('creates rooms for up to five players and starts once present players are ready', () => {
  const host = fakeClient('host');
  const guest = fakeClient('guest');

  handleMessage(host, { type: 'create_room', name: 'Host', maxPlayers: 5 });
  const joined = host.messages.find(message => message.type === 'room_joined');
  assert.match(joined.room.code, /^[A-Z0-9]{6}$/);
  assert.equal(joined.room.players.length, 1);
  assert.equal(joined.room.maxPlayers, 5);
  assert.throws(() => handleMessage(fakeClient('invalid-size'), {
    type: 'create_room',
    name: 'Invalid',
    maxPlayers: 6
  }), /2, 3, 4, or 5 players/i);

  handleMessage(guest, { type: 'join_room', code: joined.room.code, name: 'Guest' });
  handleMessage(host, { type: 'ready', ready: true });
  assert.throws(() => handleMessage(host, { type: 'start_game' }), /all connected players must be ready/i);
  handleMessage(guest, { type: 'ready', ready: true });
  handleMessage(host, { type: 'start_game' });
  assert.equal(rooms.get(joined.room.code).status, 'PLAYING');
  assert.equal(rooms.get(joined.room.code).players.size, 2);
  assert.equal(host.messages.at(-1).type, 'room_updated');
  assert.ok(host.messages.some(message => message.type === 'room_started'));
  assert.ok(guest.messages.some(message => message.type === 'room_started'));
});

test('rejects a sixth player in a five-player room', () => {
  const host = fakeClient('capacity-host');
  handleMessage(host, { type: 'create_room', name: 'Host', maxPlayers: 5 });
  const code = host.messages.find(message => message.type === 'room_joined').room.code;
  for (let index = 1; index < 5; index++) {
    handleMessage(fakeClient(`capacity-player-${index}`), {
      type: 'join_room',
      code,
      name: `Player ${index}`
    });
  }
  assert.equal(rooms.get(code).players.size, 5);
  assert.throws(() => handleMessage(fakeClient('capacity-sixth'), {
    type: 'join_room',
    code,
    name: 'Sixth Player'
  }), /roster is full/i);
});

test('only lists public rooms while private rooms remain joinable by code', () => {
  const publicHost = fakeClient('public-host');
  const privateHost = fakeClient('private-host');
  const directoryClient = fakeClient('directory-client');
  handleMessage(publicHost, { type: 'create_room', name: 'Public', maxPlayers: 2, isPublic: true });
  handleMessage(privateHost, { type: 'create_room', name: 'Private', maxPlayers: 2, isPublic: false });
  const publicRoom = publicHost.messages.find(message => message.type === 'room_joined').room;
  const privateRoom = privateHost.messages.find(message => message.type === 'room_joined').room;

  handleMessage(directoryClient, { type: 'list_rooms' });
  const directory = directoryClient.messages.find(message => message.type === 'room_list');
  assert.deepEqual(directory.rooms.map(room => room.code), [publicRoom.code]);
  assert.equal(privateRoom.isPublic, false);

  const privateGuest = fakeClient('private-guest');
  handleMessage(privateGuest, { type: 'join_room', code: privateRoom.code, name: 'Guest' });
  assert.equal(rooms.get(privateRoom.code).players.size, 2);
});

test('allows five spectators and rejects a sixth or spectator voice signaling', () => {
  const host = fakeClient('owner');
  handleMessage(host, { type: 'create_room', name: 'Owner', maxPlayers: 4 });
  const code = host.messages.find(message => message.type === 'room_joined').room.code;
  const spectators = Array.from({ length: 6 }, (_, index) => fakeClient(`watcher-${index}`));
  spectators.slice(0, 5).forEach(client => handleMessage(client, {
    type: 'spectate_room',
    code,
    name: client.id
  }));
  assert.equal(rooms.get(code).spectators.size, 5);
  assert.throws(() => handleMessage(spectators[5], { type: 'spectate_room', code, name: 'Extra' }), /5 spectators/i);
  assert.throws(() => handleMessage(spectators[0], {
    type: 'voice_signal',
    to: host.id,
    signal: { description: 'blocked' }
  }), /spectators cannot use player voice chat/i);
});

test('relays live state and player-only WebRTC signaling to room members', () => {
  const host = fakeClient('host-live');
  const player = fakeClient('player-live');
  const spectator = fakeClient('spectator-live');
  handleMessage(host, { type: 'create_room', name: 'Host', maxPlayers: 2 });
  const code = host.messages.find(message => message.type === 'room_joined').room.code;
  handleMessage(player, { type: 'join_room', code, name: 'Player' });
  handleMessage(spectator, { type: 'spectate_room', code, name: 'Viewer' });
  handleMessage(host, { type: 'ready', ready: true });
  handleMessage(player, { type: 'ready', ready: true });
  handleMessage(host, { type: 'start_game' });
  handleMessage(host, { type: 'game_state', state: { stage: 1, floor: 0, fuel: 80, monsters: 3 } });
  assert.equal(spectator.messages.at(-1).type, 'game_state');
  handleMessage(player, { type: 'player_state', state: { x: 30, y: 40, floor: 1 } });
  assert.ok(host.messages.some(message => message.type === 'player_state' && message.playerId === player.id));
  handleMessage(player, { type: 'voice_signal', to: host.id, signal: { description: 'offer' } });
  assert.equal(host.messages.at(-1).type, 'voice_signal');
  assert.equal(host.messages.at(-1).from, player.id);
  handleMessage(host, {
    type: 'world_action',
    floor: 1,
    objectIndex: 0,
    action: 'drop_key',
    itemId: 'COPPER_FUSE',
    holderId: player.id,
    x: 321,
    y: 654
  });
  assert.ok(spectator.messages.some(message =>
    message.type === 'world_action' && message.action === 'drop_key' &&
    message.x === 321 && message.y === 654 && message.holderId === player.id
  ));
  for (const action of ['toggle_door', 'deploy_trap', 'use_flare']) {
    handleMessage(player, {
      type: 'world_action',
      floor: 1,
      objectIndex: 0,
      action,
      x: 321,
      y: 654
    });
    assert.ok(spectator.messages.some(message =>
      message.type === 'world_action' && message.action === action &&
      message.playerId === player.id
    ));
  }
  assert.throws(() => handleMessage(player, {
    type: 'world_action',
    floor: 1,
    objectIndex: 0,
    action: 'deploy_trap',
    x: Number.NaN,
    y: 654
  }), /position/i);
  assert.throws(() => handleMessage(player, {
    type: 'player_caught',
    playerId: host.id,
    floor: 1
  }), /room admin/i);
  handleMessage(host, {
    type: 'player_caught',
    playerId: player.id,
    floor: 1,
    reason: 'CAPTURED'
  });
  assert.ok(player.messages.some(message =>
    message.type === 'player_caught' && message.playerId === player.id
  ));
});
