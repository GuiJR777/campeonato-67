import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import './style.css';

type Hand = 'left' | 'right';
type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';

type Player = {
  id: string;
  name: string;
  aura: number;
  mistakes: number;
  combo: number;
  expected: Hand;
  joinedAt: number;
  host: boolean;
  rank: string;
};

type RoomState = {
  type: 'state';
  roomId: string;
  status: RoomStatus;
  players: Player[];
  startedAt: number | null;
  durationMs: number;
  winnerId: string | null;
};

type ImpactEvent = { type: 'impact'; playerId: string; hand: Hand; correct: boolean; auraGained: boolean; rankUp?: string };
type ServerEvent = RoomState | { type: 'welcome'; playerId: string } | { type: 'error'; message: string } | ImpactEvent;

type VisualPlayer = {
  root: Container;
  body: Graphics;
  glow: Graphics;
  auraRing: Graphics;
  auraText: Text;
  rankText: Text;
  comboText: Text;
  bar: Graphics;
  name: Text;
  leftHand: Text;
  rightHand: Text;
  leftBaseY: number;
  rightBaseY: number;
  handBaseScale: number;
  bodyBaseScale: number;
  rankIndex: number;
  lastCombo: number;
};

const RANKS: ReadonlyArray<readonly [number, string]> = [
  [0, 'NPC'], [5, 'NOOB'], [12, 'BETINHA'], [20, 'BETA'], [30, 'ALPHA'], [42, 'SIGMA'], [55, 'OMEGA'], [67, 'CHAD'],
  [85, 'MEGA CHAD'], [105, 'GIGA CHAD'], [130, 'KILO CHAD'], [160, 'TERA CHAD'], [195, 'ULTIMATE CHAD'],
  [235, 'JUST CHAD'], [280, 'C'], [333, 'PROTAGONIST']
];
const RANK_COLORS = [
  0x69677f, 0x77728f, 0x8d6d9e, 0x6178ad, 0x3d8fb0, 0x6550bd, 0x9a49b9, 0xffd84a,
  0xffa63d, 0xff7043, 0xf04673, 0xc14cff, 0x6a66ff, 0x38bdf8, 0x2de2a6, 0xffffff
] as const;

const appEl = document.querySelector<HTMLDivElement>('#app')!;
let socket: WebSocket | null = null;
let myId = '';
let state: RoomState | null = null;
let pixi: Application | null = null;
let scene: Container | null = null;
let uiLoop = 0;
let playingIntroShown = false;
let farmarTimeout = 0;
let lastCountdownSecond = 0;
let audioCtx: AudioContext | null = null;
const visualPlayers = new Map<string, VisualPlayer>();
const handAnimTokens = new WeakMap<Text, number>();
let resizeBound = false;

function isTouchLike() { return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0; }
function isMobileLayout() { return window.innerWidth <= 900; }
function shouldShowMobileControls() { return isTouchLike() || isMobileLayout(); }
function applyResponsiveClasses() {
  document.body.classList.toggle('mobile-device', shouldShowMobileControls());
  document.body.classList.toggle('mobile-layout', isMobileLayout());
}

function playerLayoutPosition(index: number, count: number, width: number, height: number) {
  const mobile = isMobileLayout();
  const presets: Record<number, { x: number; y: number; scale: number }[]> = mobile ? {
    1: [{ x: .5, y: .54, scale: .95 }],
    2: [{ x: .32, y: .56, scale: .84 }, { x: .68, y: .56, scale: .84 }],
    3: [{ x: .28, y: .40, scale: .72 }, { x: .72, y: .40, scale: .72 }, { x: .5, y: .72, scale: .78 }],
    4: [{ x: .28, y: .39, scale: .68 }, { x: .72, y: .39, scale: .68 }, { x: .28, y: .72, scale: .68 }, { x: .72, y: .72, scale: .68 }]
  } : {
    1: [{ x: .5, y: .58, scale: 1 }],
    2: [{ x: .33, y: .58, scale: .98 }, { x: .67, y: .58, scale: .98 }],
    3: [{ x: .24, y: .58, scale: .84 }, { x: .5, y: .46, scale: .84 }, { x: .76, y: .58, scale: .84 }],
    4: [{ x: .24, y: .42, scale: .76 }, { x: .76, y: .42, scale: .76 }, { x: .24, y: .76, scale: .76 }, { x: .76, y: .76, scale: .76 }]
  };
  const fallback = { x: (index + 1) / (count + 1), y: mobile ? .6 : .58, scale: .8 };
  const pos = presets[count]?.[index] ?? fallback;
  return { x: width * pos.x, y: height * pos.y, scale: pos.scale };
}

function randomRoom() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }
function wsBase() {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return 'ws://localhost:8787';
}
function roomFromUrl() { return new URLSearchParams(location.search).get('room')?.toUpperCase() ?? ''; }
function nameFromStorage() { return localStorage.getItem('67-name') ?? ''; }
function rankProgress(aura: number) {
  let current = RANKS[0], next = RANKS[1];
  for (let i = 0; i < RANKS.length; i++) {
    if (aura >= RANKS[i][0]) current = RANKS[i];
    if (aura < RANKS[i][0]) { next = RANKS[i]; break; }
    next = RANKS[Math.min(i + 1, RANKS.length - 1)];
  }
  if (current[1] === 'PROTAGONIST') return { current: current[1], next: current[1], progress: 1 };
  return { current: current[1], next: next[1], progress: Math.max(0, Math.min(1, (aura - current[0]) / (next[0] - current[0]))) };
}

function rankIndexFor(aura: number) {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (aura >= RANKS[i][0]) index = i;
  return index;
}

function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function tone(freq: number, duration = .06, type: OscillatorType = 'sine', volume = .025, delay = 0) {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(.0002, volume), start + .006);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + .02);
}

function playCountdownSound(n: number) {
  const freq = n === 3 ? 440 : n === 2 ? 540 : 680;
  tone(freq, .11, 'square', .035);
  tone(freq * 2, .07, 'sine', .012, .01);
}
function playFarmarSound() {
  tone(440, .16, 'sawtooth', .035);
  tone(660, .18, 'square', .025, .035);
  tone(880, .22, 'sine', .032, .07);
}
function playInputSound(hand: Hand, auraGained: boolean) {
  tone(hand === 'left' ? 185 : 245, .038, 'square', .018);
  if (auraGained) tone(620, .055, 'sine', .024, .012);
}
function playErrorSound() {
  tone(120, .13, 'sawtooth', .045);
  tone(72, .18, 'square', .025, .035);
}
function playRankSound() {
  tone(520, .09, 'sine', .025);
  tone(780, .11, 'sine', .024, .07);
  tone(1040, .15, 'sine', .03, .14);
}

function layout(children: string) {
  appEl.innerHTML = `<main class="shell"><aside class="ad side">ADVERTISEMENT</aside><section class="game-column">${children}</section><aside class="ad side">ADVERTISEMENT</aside><aside class="ad bottom">ADVERTISEMENT</aside></main><div id="toast" class="toast"></div>`;
}

function showHome() {
  destroyPixi();
  layout(`<section class="panel home"><div class="kicker">FARME AURA. NÃO VACILE.</div><div class="logo67">67</div><h1>CAMPEONATO DE 67</h1><p class="subtitle">Desafie até 3 amigos. Alterne esquerda e direita o mais rápido possível e farme o máximo de Aura antes do tempo acabar.</p><form id="join-form" class="form"><input id="nickname" maxlength="18" placeholder="Seu nome" value="${escapeHtml(nameFromStorage())}" autocomplete="nickname"><button class="primary" type="submit">CRIAR CAMPEONATO</button>${roomFromUrl() ? `<button id="join-room" class="secondary" type="button">ENTRAR NA SALA ${roomFromUrl()}</button>` : ''}</form><div class="help">Teclado ou mouse<div class="arrows"><span class="key">A / ←</span><span class="key">D / →</span></div></div></section>`);
  const form = document.querySelector<HTMLFormElement>('#join-form')!;
  const input = document.querySelector<HTMLInputElement>('#nickname')!;
  form.addEventListener('submit', e => { e.preventDefault(); ensureAudio(); connect(randomRoom(), input.value); });
  document.querySelector('#join-room')?.addEventListener('click', () => { ensureAudio(); connect(roomFromUrl(), input.value); });
}

async function connect(roomId: string, rawName: string) {
  const name = rawName.trim().slice(0, 18);
  if (!name) return toast('Coloque um nome primeiro');
  localStorage.setItem('67-name', name);
  history.replaceState({}, '', `?room=${roomId}`);
  const url = `${wsBase()}/room/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name)}`;
  socket?.close();
  socket = new WebSocket(url);
  socket.addEventListener('open', () => showRoom(roomId));
  socket.addEventListener('message', ev => {
    const message = JSON.parse(String(ev.data)) as ServerEvent;
    if (message.type === 'welcome') { myId = message.playerId; return; }
    if (message.type === 'error') return toast(message.message);
    if (message.type === 'impact') return impact(message);
    state = message;
    renderState();
  });
  socket.addEventListener('close', () => { if (state?.status !== 'finished') toast('Conexão encerrada'); });
}

function showRoom(roomId: string) {
  applyResponsiveClasses();
  if (!resizeBound) {
    window.addEventListener('resize', applyResponsiveClasses);
    resizeBound = true;
  }
  layout(`<section class="panel room"><header class="topbar"><div class="roomcode"><small>SALA</small>${roomId}</div><div class="actions"><button id="copy" class="secondary">COPIAR LINK</button></div></header><div class="players-list" id="players"></div><div class="stage-wrap" id="stage"><div class="hud"><div class="status-pill" id="status">AGUARDANDO JOGADORES</div><div class="controls-hint">A / ← / clique esquerdo &nbsp;•&nbsp; D / → / clique direito</div></div><div id="center-action" class="center-action"></div><div id="countdown-overlay" class="countdown-overlay hidden"></div></div><div class="touch-controls"><button class="touch" data-hand="left"><span class="touch-emoji">🫲</span><span class="touch-label">ESQUERDA</span></button><button class="touch" data-hand="right"><span class="touch-emoji">🫱</span><span class="touch-label">DIREITA</span></button></div></section>`);
  document.querySelector('#copy')?.addEventListener('click', async () => { await navigator.clipboard.writeText(location.href); toast('Link copiado'); });
  document.querySelectorAll<HTMLElement>('[data-hand]').forEach(b => {
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (e.pointerType === 'touch' && navigator.vibrate) navigator.vibrate(8);
      b.classList.add('pressed');
      window.setTimeout(() => b.classList.remove('pressed'), 90);
      sendInput(b.dataset.hand as Hand);
    });
  });
  const stage = document.querySelector<HTMLElement>('#stage')!;
  stage.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 0) sendInput('left');
    if (e.button === 2) sendInput('right');
  });
  window.addEventListener('keydown', keyboardInput);
  initPixi(stage as HTMLElement);
}

function keyboardInput(e: KeyboardEvent) {
  if (e.repeat) return;
  if (['a', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); sendInput('left'); }
  if (['d', 'ArrowRight'].includes(e.key)) { e.preventDefault(); sendInput('right'); }
}
function sendInput(hand: Hand) {
  ensureAudio();
  if (state?.status === 'playing') send({ type: 'input', hand, at: Date.now() });
}
function send(data: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }

async function initPixi(host: HTMLElement) {
  pixi = new Application();
  await pixi.init({ resizeTo: host, antialias: true, backgroundAlpha: 0 });
  pixi.canvas.id = 'game-canvas';
  host.prepend(pixi.canvas);
  scene = new Container();
  pixi.stage.addChild(scene);
  pixi.ticker.add(() => animateAmbient());
}
function destroyPixi() {
  window.removeEventListener('keydown', keyboardInput);
  cancelAnimationFrame(uiLoop);
  clearTimeout(farmarTimeout);
  playingIntroShown = false;
  lastCountdownSecond = 0;
  if (pixi) {
    pixi.destroy(true);
    pixi = null;
    scene = null;
  }
  visualPlayers.clear();
}

function renderState() {
  if (!state || !scene || !pixi) return;
  const me = state.players.find(p => p.id === myId) ?? state.players.find(p => p.name === nameFromStorage());
  if (me) myId = me.id;
  const list = document.querySelector('#players');
  if (list) list.innerHTML = state.players.map(p => `<div class="player-chip ${p.id === myId ? 'me' : ''}"><div class="name">${escapeHtml(p.name)} ${p.host ? '👑' : ''}</div><div class="meta">${p.rank} · ${p.aura} AURA</div></div>`).join('') + Array.from({ length: Math.max(0, 4 - state.players.length) }, () => `<div class="player-chip"><div class="name">Aguardando...</div><div class="meta">compartilhe o link</div></div>`).join('');
  const stageWrap = document.querySelector<HTMLElement>('#stage');
  if (stageWrap) {
    stageWrap.classList.toggle('stage-four', state.players.length === 4);
    stageWrap.classList.toggle('stage-three-plus', state.players.length >= 3);
  }
  syncCharacters();
  updateCenterAction(me ?? null);
  updateStatus();
  if (state.status === 'finished') showResults(); else document.querySelector('#results-overlay')?.remove();
}

function updateCenterAction(me: Player | null) {
  const mount = document.querySelector<HTMLDivElement>('#center-action');
  if (!mount || !state) return;
  if (state.status !== 'lobby') {
    mount.innerHTML = '';
    mount.classList.add('hidden');
    return;
  }
  mount.classList.remove('hidden');
  if (me?.host) {
    const disabled = state.players.length < 2 ? 'disabled' : '';
    mount.innerHTML = `<div class="start-stack"><button id="start-center-btn" class="primary big-start" ${disabled}>INICIAR GAME</button><div class="center-sub">${state.players.length < 2 ? 'Precisa de pelo menos 2 jogadores' : '3... 2... 1... FARMAR!'}</div></div>`;
    document.querySelector('#start-center-btn')?.addEventListener('click', () => { ensureAudio(); send({ type: 'start' }); });
  } else {
    const host = state.players.find(p => p.host)?.name ?? 'host';
    mount.innerHTML = `<div class="waiting-card"><strong>Aguardando ${escapeHtml(host)}</strong><span>O host vai iniciar quando todo mundo estiver pronto.</span></div>`;
  }
}

function syncCharacters() {
  if (!state || !scene || !pixi) return;
  const currentState = state;
  for (const id of [...visualPlayers.keys()]) {
    if (!currentState.players.some(p => p.id === id)) {
      visualPlayers.get(id)?.root.destroy({ children: true });
      visualPlayers.delete(id);
    }
  }
  currentState.players.forEach((p, index) => {
    let v = visualPlayers.get(p.id);
    if (!v) {
      v = makeCharacter(p);
      visualPlayers.set(p.id, v);
      scene!.addChild(v.root);
    }
    const pos = playerLayoutPosition(index, currentState.players.length, pixi!.screen.width, pixi!.screen.height);
    v.root.x = pos.x;
    v.root.y = pos.y;
    v.root.scale.set(pos.scale);
    v.auraText.text = `${p.aura}`;
    v.rankText.text = p.rank;
    v.name.text = p.name + (p.id === myId ? ' • VOCÊ' : '');
    v.comboText.text = p.combo >= 2 ? `COMBO x${p.combo}` : '';
    v.comboText.alpha = p.combo >= 2 ? Math.min(1, .55 + p.combo * .025) : 0;
    if (p.combo > v.lastCombo && p.combo >= 2) punchCombo(v.comboText, p.combo);
    v.lastCombo = p.combo;
    applyRankVisuals(v, p);
    drawBar(v.bar, rankProgress(p.aura).progress, p.aura >= 67);
  });
}

function makeCharacter(p: Player): VisualPlayer {
  const root = new Container();
  const glow = new Graphics();
  root.addChild(glow);

  const auraRing = new Graphics();
  root.addChild(auraRing);

  const leftHand = new Text({
    text: '🫲',
    style: { fontFamily: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif', fontSize: 38 }
  });
  leftHand.anchor.set(.5);
  leftHand.x = -96;
  leftHand.y = 8;
  root.addChild(leftHand);

  const rightHand = new Text({
    text: '🫱',
    style: { fontFamily: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif', fontSize: 38 }
  });
  rightHand.anchor.set(.5);
  rightHand.x = 96;
  rightHand.y = 8;
  root.addChild(rightHand);

  const body = new Graphics();
  root.addChild(body);

  const auraStyle = new TextStyle({ fontFamily: 'Arial', fill: 0xffffff, fontSize: 28, fontWeight: '900', stroke: { color: 0x000000, width: 5 } });
  const auraText = new Text({ text: '0', style: auraStyle });
  auraText.anchor.set(.5);
  auraText.y = -142;
  root.addChild(auraText);

  const rankText = new Text({ text: 'NPC', style: auraStyle });
  rankText.anchor.set(.5);
  rankText.scale.set(.72);
  rankText.y = -102;
  root.addChild(rankText);

  const comboText = new Text({ text: '', style: { fontFamily: 'Arial', fill: 0xffd84a, fontSize: 15, fontWeight: '900', stroke: { color: 0x000000, width: 4 } } });
  comboText.anchor.set(.5);
  comboText.y = -72;
  comboText.alpha = 0;
  root.addChild(comboText);

  const name = new Text({ text: 'Player', style: auraStyle });
  name.anchor.set(.5);
  name.scale.set(.65);
  name.y = 82;
  root.addChild(name);

  const bar = new Graphics();
  bar.y = 112;
  root.addChild(bar);
  drawBar(bar, 0, false);

  const visual: VisualPlayer = {
    root, body, glow, auraRing, auraText, rankText, comboText, bar, name, leftHand, rightHand,
    leftBaseY: leftHand.y, rightBaseY: rightHand.y, handBaseScale: 1, bodyBaseScale: 1, rankIndex: -1, lastCombo: 0
  };
  applyRankVisuals(visual, p);
  return visual;
}

function drawCharacterBody(body: Graphics, rankIndex: number) {
  const color = RANK_COLORS[Math.min(rankIndex, RANK_COLORS.length - 1)];
  body.clear();
  body.roundRect(-42, -46, 84, 92, 25).fill({ color }).stroke({ color: 0xffffff, alpha: .12 + rankIndex * .012, width: 2 + Math.min(2, rankIndex * .12) });
  body.circle(-14, -10, 5 + Math.min(2, rankIndex * .12)).fill(0xffffff);
  body.circle(14, -10, 5 + Math.min(2, rankIndex * .12)).fill(0xffffff);
  if (rankIndex >= 7) {
    body.moveTo(-18, 18).quadraticCurveTo(0, 29, 18, 18).stroke({ color: 0xffffff, alpha: .82, width: 3 });
  } else {
    body.moveTo(-16, 18).lineTo(16, 18).stroke({ color: 0xffffff, alpha: .6, width: 3 });
  }
  if (rankIndex >= 5) {
    body.moveTo(-24, -22).lineTo(-8, -17).stroke({ color: 0xffffff, alpha: .45, width: 3 });
    body.moveTo(24, -22).lineTo(8, -17).stroke({ color: 0xffffff, alpha: .45, width: 3 });
  }
}

function applyRankVisuals(v: VisualPlayer, p: Player) {
  const index = rankIndexFor(p.aura);
  if (index === v.rankIndex) return;
  v.rankIndex = index;
  const color = RANK_COLORS[Math.min(index, RANK_COLORS.length - 1)];
  v.handBaseScale = 1 + Math.min(.34, index * .022);
  v.bodyBaseScale = 1 + Math.min(.22, index * .014);

  drawCharacterBody(v.body, index);
  v.body.scale.set(v.bodyBaseScale);
  v.leftHand.scale.set(v.handBaseScale);
  v.rightHand.scale.set(v.handBaseScale);

  v.glow.clear();
  v.glow.circle(0, 0, 70 + index * 4).fill({ color, alpha: Math.min(.22, .025 + index * .012) });

  v.auraRing.clear();
  if (index >= 3) v.auraRing.circle(0, 0, 58 + index * 2.5).stroke({ color, alpha: Math.min(.58, .14 + index * .025), width: 2 + Math.min(4, index * .18) });
  if (index >= 7) v.auraRing.circle(0, 0, 76 + index * 2.2).stroke({ color: 0xffffff, alpha: Math.min(.3, .08 + index * .012), width: 1.5 });

  v.rankText.style.fill = color;
  v.rankText.scale.set(.72 + Math.min(.18, index * .012));
  v.auraText.style.fill = index >= 7 ? 0xffd84a : 0xffffff;
}

function drawBar(g: Graphics, progress: number, hot: boolean) {
  g.clear();
  g.roundRect(-56, 0, 112, 8, 4).fill({ color: 0xffffff, alpha: 0.09 });
  g.roundRect(-56, 0, 112 * progress, 8, 4).fill({ color: hot ? 0xffd84a : 0xb79cff, alpha: 1 });
}

function impact(ev: ImpactEvent) {
  const v = visualPlayers.get(ev.playerId);
  if (!v) return;
  const dir = ev.hand === 'left' ? -1 : 1;
  pulseHand(v, ev.hand, ev.correct);
  v.body.x = dir * 9;
  v.body.rotation = dir * .055;
  v.body.scale.set(v.bodyBaseScale * 1.08, v.bodyBaseScale * .93);
  setTimeout(() => {
    if (!v.root.destroyed) {
      v.body.x = 0;
      v.body.rotation = 0;
      v.body.scale.set(v.bodyBaseScale);
    }
  }, 70);

  if (ev.playerId === myId) {
    if (!ev.correct) playErrorSound();
    else playInputSound(ev.hand, ev.auraGained);
  }

  if (!ev.correct) {
    shake(10);
    flash(0xff355d, .2);
    popText(v.root.x, v.root.y - 154, 'ERRO!', 0xff4f70, 24);
    if (v.lastCombo >= 2) popText(v.root.x, v.root.y - 188, `COMBO x${v.lastCombo} PERDIDO`, 0xff4f70, 14);
  } else if (ev.auraGained) {
    shake(3);
    popText(v.root.x, v.root.y - 162, '+1 AURA', 0xffd84a);
  }
  if (ev.rankUp) {
    playRankSound();
    shake(14);
    flash(0xffffff, .24);
    popText((pixi?.screen.width ?? 500) / 2, 120, ev.rankUp, 0xffffff, 40);
  }
}

function pulseHand(v: VisualPlayer, hand: Hand, correct: boolean) {
  const target = hand === 'left' ? v.leftHand : v.rightHand;
  const baseY = hand === 'left' ? v.leftBaseY : v.rightBaseY;
  const baseX = hand === 'left' ? -96 : 96;
  const dir = hand === 'left' ? -1 : 1;
  const token = (handAnimTokens.get(target) ?? 0) + 1;
  handAnimTokens.set(target, token);
  const start = performance.now();
  const duration = correct ? 165 : 210;
  handBurst(v, hand, correct);

  const tick = (now: number) => {
    if (target.destroyed || handAnimTokens.get(target) !== token) return;
    const t = Math.min(1, (now - start) / duration);
    const arc = Math.sin(Math.PI * t);
    if (correct) {
      target.y = baseY - arc * 52;
      target.x = baseX + dir * arc * 20;
      target.rotation = dir * arc * .5;
      target.scale.set(v.handBaseScale * (1 + arc * .62));
    } else {
      target.y = baseY - arc * 18;
      target.x = baseX + Math.sin(t * Math.PI * 8) * 14;
      target.rotation = Math.sin(t * Math.PI * 7) * .35;
      target.scale.set(v.handBaseScale * (1 + arc * .22));
    }
    if (t < 1) requestAnimationFrame(tick);
    else {
      target.y = baseY;
      target.x = baseX;
      target.rotation = 0;
      target.scale.set(v.handBaseScale);
    }
  };
  requestAnimationFrame(tick);
}

function handBurst(v: VisualPlayer, hand: Hand, correct: boolean) {
  const ring = new Graphics();
  const x = hand === 'left' ? -96 : 96;
  ring.x = x;
  ring.y = hand === 'left' ? v.leftBaseY : v.rightBaseY;
  ring.circle(0, 0, 18).stroke({ color: correct ? 0xffd84a : 0xff4f70, alpha: .85, width: 4 });
  v.root.addChild(ring);
  let frame = 0;
  const tick = () => {
    if (ring.destroyed) return;
    frame++;
    ring.scale.set(1 + frame * .07);
    ring.alpha = 1 - frame / 16;
    if (frame >= 16) ring.destroy(); else requestAnimationFrame(tick);
  };
  tick();
}

function punchCombo(text: Text, combo: number) {
  const start = performance.now();
  const strength = Math.min(.75, .25 + combo * .018);
  const tick = (now: number) => {
    if (text.destroyed) return;
    const t = Math.min(1, (now - start) / 150);
    const pulse = Math.sin(Math.PI * t);
    text.scale.set(1 + pulse * strength);
    text.rotation = Math.sin(t * Math.PI * 2) * .035;
    if (t < 1) requestAnimationFrame(tick);
    else { text.scale.set(1); text.rotation = 0; }
  };
  requestAnimationFrame(tick);
}

function shake(power: number) {
  if (!scene) return;
  const ox = scene.x, oy = scene.y;
  let n = 5;
  const t = setInterval(() => {
    if (!scene || --n <= 0) {
      clearInterval(t);
      if (scene) { scene.x = ox; scene.y = oy; }
      return;
    }
    scene.x = ox + (Math.random() - .5) * power;
    scene.y = oy + (Math.random() - .5) * power;
  }, 18);
}

function flash(color: number, alpha: number) {
  if (!pixi) return;
  const f = new Graphics().rect(0, 0, pixi.screen.width, pixi.screen.height).fill({ color, alpha });
  pixi.stage.addChild(f);
  setTimeout(() => f.destroy(), 60);
}

function popText(x: number, y: number, text: string, color: number, size = 18) {
  if (!scene) return;
  const t = new Text({ text, style: { fontFamily: 'Arial', fontSize: size, fontWeight: '900', fill: color, stroke: { color: 0x000000, width: 5 } } });
  t.anchor.set(.5);
  t.x = x;
  t.y = y;
  scene.addChild(t);
  let life = 0;
  const tick = () => {
    if (t.destroyed) return;
    life++;
    t.y -= 1.7;
    t.alpha = 1 - life / 38;
    t.scale.set(1 + life * .008);
    if (life >= 38) t.destroy(); else requestAnimationFrame(tick);
  };
  tick();
}

function animateAmbient() {
  if (!state) return;
  const now = performance.now();
  visualPlayers.forEach((v, id) => {
    const p = state!.players.find(x => x.id === id);
    if (!p) return;
    const intensity = Math.min(.05, p.aura / 6000);
    v.root.rotation = Math.sin(now / 130 + p.joinedAt) * intensity;
    if (v.rankIndex >= 3) {
      const pulse = 1 + Math.sin(now / (260 - Math.min(120, v.rankIndex * 5)) + p.joinedAt) * (.015 + v.rankIndex * .0025);
      v.auraRing.scale.set(pulse);
      v.glow.scale.set(1 + (pulse - 1) * 2.2);
    }
  });
}

function restartOverlayAnimation(overlay: HTMLElement, className: string) {
  overlay.classList.remove(className);
  void overlay.offsetWidth;
  overlay.classList.add(className);
}

function updateStatus() {
  if (!state) return;
  const pill = document.querySelector<HTMLElement>('#status');
  const overlay = document.querySelector<HTMLElement>('#countdown-overlay');
  if (!pill || !overlay) return;
  cancelAnimationFrame(uiLoop);

  const clearOverlay = () => {
    overlay.textContent = '';
    overlay.classList.add('hidden');
    overlay.classList.remove('farmar', 'farmar-punch', 'count-pop');
  };

  if (state.status === 'lobby') {
    clearTimeout(farmarTimeout);
    playingIntroShown = false;
    lastCountdownSecond = 0;
    pill.textContent = `AGUARDANDO • ${state.players.length}/4`;
    clearOverlay();
    return;
  }

  if (state.status === 'countdown') {
    clearTimeout(farmarTimeout);
    playingIntroShown = false;
    const loop = () => {
      if (!state || state.status !== 'countdown') return;
      const diff = (state.startedAt ?? Date.now()) - Date.now();
      const seconds = Math.max(1, Math.ceil(diff / 1000));
      pill.textContent = `COMEÇA EM ${seconds}`;
      overlay.classList.remove('hidden', 'farmar', 'farmar-punch');
      overlay.textContent = `${seconds}`;
      if (seconds !== lastCountdownSecond) {
        lastCountdownSecond = seconds;
        restartOverlayAnimation(overlay, 'count-pop');
        playCountdownSound(seconds);
        flash(0xffffff, .045);
      }
      uiLoop = requestAnimationFrame(loop);
    };
    loop();
    return;
  }

  if (state.status === 'playing') {
    if (!playingIntroShown) {
      playingIntroShown = true;
      lastCountdownSecond = 0;
      overlay.classList.remove('hidden', 'count-pop');
      overlay.classList.add('farmar');
      overlay.textContent = 'FARMAR!';
      restartOverlayAnimation(overlay, 'farmar-punch');
      playFarmarSound();
      flash(0xffd84a, .28);
      shake(16);
      clearTimeout(farmarTimeout);
      farmarTimeout = window.setTimeout(() => {
        if (state?.status === 'playing') clearOverlay();
      }, 850);
    }
    const loop = () => {
      if (!state || state.status !== 'playing') return;
      const left = Math.max(0, state.durationMs - (Date.now() - (state.startedAt ?? Date.now())));
      pill.textContent = `${(left / 1000).toFixed(1)}s`;
      uiLoop = requestAnimationFrame(loop);
    };
    loop();
    return;
  }

  clearTimeout(farmarTimeout);
  playingIntroShown = false;
  lastCountdownSecond = 0;
  clearOverlay();
  pill.textContent = 'FIM DE JOGO';
}

function showResults() {
  if (!state || document.querySelector('#results-overlay')) return;
  const stage = document.querySelector('#stage');
  if (!stage) return;
  const sorted = [...state.players].sort((a, b) => b.aura - a.aura || a.mistakes - b.mistakes);
  stage.insertAdjacentHTML('beforeend', `<div class="overlay" id="results-overlay"><div class="overlay-card"><div class="kicker">RESULTADO</div><h2>${sorted[0]?.id === myId ? 'VOCÊ LEVOU' : 'ACABOU'}</h2><p>${sorted[0]?.rank ?? ''} • ${sorted[0]?.aura ?? 0} AURA</p><div class="results">${sorted.map((p, i) => `<div class="result-row"><span>${i + 1}. ${escapeHtml(p.name)}</span><strong>${p.aura} ⚡ · ${p.mistakes} erro${p.mistakes === 1 ? '' : 's'}</strong></div>`).join('')}</div><button id="rematch" class="primary">REVANCHE</button></div></div>`);
  document.querySelector('#rematch')?.addEventListener('click', () => send({ type: 'rematch' }));
}

function toast(message: string) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

function escapeHtml(s: string) { return s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!)); }

showHome();
