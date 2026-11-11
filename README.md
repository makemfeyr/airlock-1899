# Airlock 1899

## Run the game and room service

Install dependencies and start the HTTP/WebSocket server:

```powershell
npm install
npm start
```

Open `http://localhost:3000`. The room service creates six-character channels, supports 2–5 players and up to 5 spectators, starts waiting rooms after five minutes, and lets the creator start sooner after every connected player is ready. `npm run test:rooms` runs the room protocol tests.

Each stage contains three decks. Survivors move between decks independently through the lifts; AI companions must reach and use each lift before appearing on the next deck. Player, bot, and enemy movement is reduced by 50%. Stages begin with six enemies and add one per stage, distributed among the decks, up to 18; enemy movement speed increases by 3.5% per stage. Workshop upgrades can each be purchased up to five times, with each purchase increasing that upgrade's scrap price by 50%. Cleared-stage counts are carried between stages and shown when the survivor is defeated.

Online room creators are room admins and choose public or private visibility. Only public rooms appear in the server directory; private rooms can be joined using their six-character code. The admin sees and can copy that code in the lobby. Maps are approximately 20% larger in width and height, with additional maze-like bulkheads. Each deck's single required key is stored in a distant objective crate; if its carrier is caught, the key drops at the capture position. Interacting with a lift grants temporary safety while the player remains nearby. Ambience-light flicker runs at half its former rate.

For two devices to connect, host the server on a reachable machine and allow inbound TCP on its port (default `3000`). The client uses the current host and port when deployed with the room service; VS Code Live Server on port `5500` connects to port `3000` by default. For a separately hosted client, set `window.AIRLOCK_ROOM_URL` to the room service's WebSocket URL before the inline app script runs. For public deployment, terminate HTTPS/WSS at a trusted reverse proxy.

Online doors, traps, flares, keys, and progression actions are relayed through the room service. The host simulates monsters on any deck occupied by a survivor, and each online stage derives its map seed from the room seed so clients generate matching layouts.

## Voice and spectator transport

Player microphone audio is peer-to-peer WebRTC; the room server relays signaling only between players. The host's game canvas is streamed to spectators over WebRTC video. Spectators do not receive a microphone control or access to player voice signaling. The default STUN server helps peers discover direct routes, but public deployments should configure `window.AIRLOCK_ICE_SERVERS` with the deployment's STUN/TURN service. TURN is needed for some NAT/firewall combinations; use authenticated, short-lived TURN credentials rather than embedding permanent credentials in this page.

The room service keeps rooms in memory. Restarting it closes all rooms. This is a prototype transport and does not provide accounts, matchmaking persistence, encrypted application-level room authorization, or server-authoritative game simulation.
