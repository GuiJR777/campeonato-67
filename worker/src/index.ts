import { DurableObject } from 'cloudflare:workers';

type Hand = 'left' | 'right';
type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';
interface Env { ROOMS: DurableObjectNamespace<GameRoom>; }

type Attachment = {
  id: string;
  name: string;
  aura: number;
  mistakes: number;
  combo: number;
  expected: Hand;
  joinedAt: number;
  host: boolean;
  status: RoomStatus;
  startedAt: number | null;
  winnerId: string | null;
  lastInputAt: number;
  roomId: string;
};

const COUNTDOWN_MS = 3000;
const DURATION_MS = 45_000;
const MAX_PLAYERS = 4;
const MIN_INPUT_GAP_MS = 28;
const RANKS = [
  [0, 'NPC'], [5, 'NOOB'], [12, 'BETINHA'], [20, 'BETA'], [30, 'ALPHA'], [42, 'SIGMA'], [55, 'OMEGA'], [67, 'CHAD'],
  [85, 'MEGA CHAD'], [105, 'GIGA CHAD'], [130, 'KILO CHAD'], [160, 'TERA CHAD'], [195, 'ULTIMATE CHAD'], [235, 'JUST CHAD'], [280, 'C'], [333, 'PROTAGONIST']
] as const;

function rankFor(aura: number) { let rank = 'NPC'; for (const [needed, name] of RANKS) if (aura >= needed) rank = name; return rank; }
function id() { return crypto.randomUUID().slice(0, 8); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{2,32})$/);
    if (!match) return cors(Response.json({ ok: true, service: 'campeonato-67-worker' }));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return cors(new Response('Expected WebSocket', { status: 426 }));
    const roomId = match[1].toUpperCase();
    const objectId = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(objectId).fetch(request);
  }
} satisfies ExportedHandler<Env>;

function cors(response: Response) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', '*'); h.set('Access-Control-Allow-Headers', '*'); h.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

export class GameRoom extends DurableObject<Env> {
  private roomId = 'ROOM';
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.roomId = url.pathname.split('/').pop()?.toUpperCase() || 'ROOM';
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response('Room full', { status: 403 });
    const name = (url.searchParams.get('name') || 'Player').trim().slice(0, 18);
    const sockets = new WebSocketPair();
    const client = sockets[0], server = sockets[1];
    const current = this.players();
    const first = current.length === 0;
    const baseStatus = current[0]?.status ?? 'lobby';
    if (baseStatus !== 'lobby') return new Response('Match already started', { status: 409 });
    const attachment: Attachment = { id: id(), name, aura: 0, mistakes: 0, combo: 0, expected: 'left', joinedAt: Date.now(), host: first, status: 'lobby', startedAt: null, winnerId: null, lastInputAt: 0, roomId: this.roomId };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'welcome', playerId: attachment.id }));
    this.sendState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any; try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const me = ws.deserializeAttachment() as Attachment | null; if (!me) return;
    if (msg.type === 'start') return this.start(me.id);
    if (msg.type === 'rematch') return this.rematch();
    if (msg.type === 'input' && (msg.hand === 'left' || msg.hand === 'right')) return this.input(ws, me, msg.hand);
  }

  webSocketClose(ws: WebSocket) {
    const gone = ws.deserializeAttachment() as Attachment | null;
    try { ws.close(1000, 'bye'); } catch { }
    if (gone?.host) this.electHost();
    this.sendState();
  }

  webSocketError(ws: WebSocket) {
    try { ws.close(1011, 'error'); } catch { }
    this.electHost();
    this.sendState();
  }

  private async start(requesterId: string) {
    const players = this.players();
    const requester = players.find(p => p.id === requesterId);
    if (!requester?.host) return this.errorTo(requesterId, 'Só o host pode iniciar');
    if (players.length < 2) return this.errorTo(requesterId, 'Precisa de pelo menos 2 jogadores');
    const countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.updateAll(p => ({ ...p, status: 'countdown' as const, startedAt: countdownEndsAt, winnerId: null, aura: 0, mistakes: 0, combo: 0, expected: 'left' as const, lastInputAt: 0 }));
    await this.ctx.storage.setAlarm(countdownEndsAt);
    this.sendState();
  }

  private async rematch() {
    const players = this.players();
    if (!players.length) return;
    this.updateAll(p => ({ ...p, status: 'lobby' as const, startedAt: null, winnerId: null, aura: 0, mistakes: 0, combo: 0, expected: 'left' as const, lastInputAt: 0 }));
    await this.ctx.storage.deleteAlarm();
    this.electHost();
    this.sendState();
  }

  private input(ws: WebSocket, me: Attachment, hand: Hand) {
    if (me.status !== 'playing') return;
    const now = Date.now();
    if (me.startedAt && now - me.startedAt >= DURATION_MS) { this.finish(); return; }
    if (now - me.lastInputAt < MIN_INPUT_GAP_MS) return;
    const beforeRank = rankFor(me.aura);
    const correct = hand === me.expected;
    let auraGained = false;
    if (correct) {
      if (me.expected === 'right') { me.aura += 1; me.combo += 1; auraGained = true; }
      me.expected = me.expected === 'left' ? 'right' : 'left';
    } else {
      me.mistakes += 1;
      me.combo = 0;
      me.expected = 'left';
    }
    me.lastInputAt = now;
    ws.serializeAttachment(me);
    const afterRank = rankFor(me.aura);
    this.broadcast({ type: 'impact', playerId: me.id, hand, correct, auraGained, rankUp: afterRank !== beforeRank ? afterRank : undefined });
    this.sendState();
  }

  async alarm() {
    const players = this.players();
    const status = players[0]?.status;
    if (status === 'countdown') {
      const matchStart = Date.now();
      this.updateAll(p => ({ ...p, status: 'playing' as const, startedAt: matchStart, winnerId: null }));
      await this.ctx.storage.setAlarm(matchStart + DURATION_MS);
      this.sendState();
      return;
    }
    if (status === 'playing') this.finish();
  }

  private finish() {
    const players = this.players();
    const winner = [...players].sort((a, b) => b.aura - a.aura || a.mistakes - b.mistakes || b.combo - a.combo)[0];
    this.updateAll(p => ({ ...p, status: 'finished' as const, winnerId: winner?.id ?? null }));
    this.sendState();
  }

  private players(): Attachment[] { return this.ctx.getWebSockets().map(ws => ws.deserializeAttachment() as Attachment).filter(Boolean).sort((a, b) => a.joinedAt - b.joinedAt); }
  private updateAll(fn: (p: Attachment) => Attachment) { for (const ws of this.ctx.getWebSockets()) { const p = ws.deserializeAttachment() as Attachment | null; if (p) ws.serializeAttachment(fn(p)); } }
  private electHost() {
    const sockets = this.ctx.getWebSockets();
    const players = sockets.map(ws => ({ ws, p: ws.deserializeAttachment() as Attachment })).filter(x => x.p).sort((a, b) => a.p.joinedAt - b.p.joinedAt);
    players.forEach((x, i) => { x.p.host = i === 0; x.ws.serializeAttachment(x.p); });
  }
  private state() {
    const players = this.players();
    const first = players[0];
    return { type: 'state' as const, roomId: first?.roomId ?? this.roomId, status: first?.status ?? 'lobby', players: players.map(p => ({ id: p.id, name: p.name, aura: p.aura, mistakes: p.mistakes, combo: p.combo, expected: p.expected, joinedAt: p.joinedAt, host: p.host, rank: rankFor(p.aura) })), startedAt: first?.startedAt ?? null, durationMs: DURATION_MS, winnerId: first?.winnerId ?? null };
  }
  private sendState() { this.broadcast(this.state()); }
  private broadcast(payload: unknown) { const s = JSON.stringify(payload); for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch { } }
  private errorTo(playerId: string, message: string) { for (const ws of this.ctx.getWebSockets()) { const p = ws.deserializeAttachment() as Attachment | null; if (p?.id === playerId) { ws.send(JSON.stringify({ type: 'error', message })); break; } } }
}
