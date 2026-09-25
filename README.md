# Campeonato de 67 — MVP

Multiplayer browser game for 2–4 players. Alternate left/right inputs, farm Aura, climb meme ranks, and survive three mistakes.

## Stack

- Frontend: Vite + TypeScript + PixiJS
- Hosting: Cloudflare Pages
- Multiplayer: Cloudflare Worker + Durable Objects + WebSocket Hibernation
- No database required for the MVP

## Gameplay implemented

- Create room and share `?room=ABCDE` link
- Up to 4 players
- Inputs: `A`, `D`, `←`, `→`, left mouse, right mouse, touch buttons
- Server-authoritative input validation
- Every completed LEFT → RIGHT pair = +1 Aura
- Wrong input = 1 mistake; 3 mistakes = eliminated
- Match ends when only one player remains or after 45 seconds
- Aura rank progression from NPC to PROTAGONIST
- 67 Aura = CHAD
- Countdown 3–2–1 → FARMAR! synchronized by the server
- Synthesized Web Audio sounds for countdown, left/right input, Aura, errors and rank-up
- Exaggerated hand animation with impact rings
- Visual combo counter with punch animation and combo-loss feedback
- Rank evolution changes body color, glow, aura rings, hand size and expression
- Screen shake, flashes, popups, FARMAR punch/flash and rank-up punch
- Rematch
- Reserved ad areas on both sides + bottom; mobile keeps bottom ad only

## Local development

Requires Node.js 20+.

```bash
npm install
```

Terminal 1:

```bash
npm run dev:worker
```

Terminal 2:

```bash
npm run dev:front
```

Open the Vite URL, create a room, then open the shared link in another browser/incognito window.

The frontend defaults to `ws://localhost:8787` during local development.

## Deploy Worker

```bash
cd worker
npx wrangler login
npm run deploy
```

Copy the resulting Worker URL and create `frontend/.env.production`:

```env
VITE_WS_URL=wss://campeonato-67-worker.YOUR_SUBDOMAIN.workers.dev
```

## Deploy frontend to Cloudflare Pages

Connect the repository in Cloudflare Pages and use:

- Root directory: `frontend`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_WS_URL=wss://...workers.dev`

Vite's production bundle is static and can be served directly by Pages.

## Important next passes

1. Replace temporary vector character with real sprite/animation set.
2. Add exact anti-cheat/rate heuristics after real playtesting; current 28ms floor only blocks obvious spam.
3. Add reconnect token so refreshing mid-match can reclaim a player slot.
4. Add analytics before ads so retention/replay behavior is measurable.
5. Add ad network only after gameplay layout and CLS are stable.
6. Add sound mute/volume controls and optional haptics for mobile.
