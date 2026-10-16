// The Bureaucramancer in 3D. Plain Three.js, no React inside: one scene, one clock, one loop.
// Everything is built from primitives at load time. No model files, no texture downloads.
// Motion is decoration. It is driven by local timers and the task facts the view passes in, never by guesses.
import * as THREE from 'three';
import type { Mood, SpellKind } from './derive.ts';
import { seed } from './derive.ts';

export type SceneTier = 'normal' | 'low' | 'static';

export interface SceneGlyph {
  id: string;
  kind: SpellKind;
}

export interface SceneState {
  glyphs: SceneGlyph[];
  selectedId: string | null;
  mood: Mood;
  stale: boolean;
  happiness: number;
  caffeine: number;
  clutter: number;
  /** 0..1 decorative spell glow. Not progress. */
  energy: number;
  tier: SceneTier;
  animate: boolean;
  followCursor: boolean;
  /** Fine pointer and motion allowed: hovering tilts the stage a few degrees. */
  hoverTilt: boolean;
}

interface Callbacks {
  onFail: (why: string) => void;
  onSlow: () => void;
  /** True while the stage is turned away from home, so the view can offer Reset view. */
  onTurned: (turned: boolean) => void;
}

/** How far the stage may turn. Drag is bounded so the wizard always stays framed. */
const TURN = { yaw: 35 * (Math.PI / 180), pitch: 10 * (Math.PI / 180), tiltYaw: 6 * (Math.PI / 180), tiltPitch: 3 * (Math.PI / 180), radPerPx: 0.003, homeAfter: 3 };

const TIERS = {
  normal: { fps: 30, ratio: 1.25, maxW: 960, maxH: 600, particles: 48, budgetMs: 25 },
  low: { fps: 20, ratio: 1, maxW: 480, maxH: 320, particles: 12, budgetMs: 40 },
  static: { fps: 0, ratio: 1, maxW: 960, maxH: 600, particles: 0, budgetMs: Infinity },
} as const;

const C = {
  plum: 0x5b2a6e,
  plumDark: 0x3e1c4c,
  teal: 0x2f7d73,
  tealDark: 0x1f5a52,
  sleeveB: 0x7a3b2e,
  skin: 0xe2b48c,
  skinDark: 0xc28f68,
  beard: 0xd9d2c0,
  beardDark: 0xb4ab95,
  parchment: 0xefe2bf,
  amber: 0xf2a33a,
  brick: 0xa8442f,
  brass: 0xc99a3a,
  ink: 0x1a1420,
  floor: 0x2b2238,
  plinth: 0x6b6458,
};

const DEG = Math.PI / 180;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A crunchy 64px noise texture, nearest-filtered, so surfaces look badly textured on purpose. */
function noiseTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 64; y += 4)
    for (let x = 0; x < 64; x += 4) {
      const v = 200 + Math.floor(rnd() * 55);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, 4, 4);
    }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The magic circle on the floor: concentric rings, a hexagram and tick marks, drawn once at 256px. */
function circleTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2238';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#f2a33a';
  g.lineWidth = 4;
  const ring = (r: number) => (g.beginPath(), g.arc(128, 128, r, 0, Math.PI * 2), g.stroke());
  ring(118);
  ring(96);
  g.lineWidth = 3;
  const star = (rot: number) => {
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = rot + (i * 2 * Math.PI) / 3;
      g[i ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * 94, 128 + Math.sin(a) * 94);
    }
    g.closePath();
    g.stroke();
  };
  star(-Math.PI / 2);
  star(Math.PI / 2);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.fillStyle = '#2f7d73';
    g.fillRect(128 + Math.cos(a) * 107 - 3, 128 + Math.sin(a) * 107 - 3, 6, 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  wrist: THREE.Group;
  side: 1 | -1;
}

interface GlyphMesh {
  group: THREE.Group;
  kind: SpellKind;
  seed: number;
}

export class WizardEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 40);
  private container: HTMLElement;
  private cb: Callbacks;
  private state: SceneState | null = null;
  private resources: { dispose(): void }[] = [];
  private raf = 0;
  private lastFrame = 0;
  private lastTick = 0;
  private clock = 0;
  private ro: ResizeObserver;
  private disposed = false;

  // Everything that turns with a drag. Lights and camera stay put.
  private stage = new THREE.Group();
  private turn = { yaw: 0, pitch: 0, dragYaw: 0, dragPitch: 0, tiltYaw: 0, tiltPitch: 0, releasedAt: -1, turned: false };
  private drag: { id: number; x: number; y: number; yaw: number; pitch: number } | null = null;

  // Rig
  private body = new THREE.Group();
  private head = new THREE.Group();
  private robe!: THREE.Mesh;
  private arms: Arm[] = [];
  private pupils: THREE.Mesh[] = [];
  private eyes: THREE.Group[] = [];
  private brows: THREE.Mesh[] = [];
  private mouth: THREE.Mesh[] = [];
  private cup = new THREE.Group();
  private arc: THREE.Mesh[] = [];
  private arcMat!: THREE.MeshLambertMaterial;
  private palmOrbs: THREE.Mesh[] = [];
  private particles!: THREE.Points;
  private particleSeeds: Float32Array;
  private stampMesh!: THREE.Mesh;
  private archive = new THREE.Group();
  private halo!: THREE.Mesh;

  // Glyphs
  private glyphRoot = new THREE.Group();
  private glyphs = new Map<string, GlyphMesh>();
  private glyphGeo!: Record<SpellKind, THREE.BufferGeometry>;
  private glyphMat!: Record<SpellKind, THREE.MeshLambertMaterial>;

  // Eased values
  private gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  private glanceUntil = 0;
  private pose = { steady: 0, brow: 0, smile: 0, energy: 0.2, proud: 0 };
  private stampStart = -1;
  private nextBlink = 3;
  private blinkUntil = 0;
  private slowSince = -1;
  private slowReported = false;
  private workAvg = 0;

  constructor(container: HTMLElement, cb: Callbacks) {
    this.container = container;
    this.cb = cb;
    // Throws when WebGL isn't available. The caller shows the portrait instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.className = 'wz-canvas-el';
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    container.append(canvas);

    this.particleSeeds = new Float32Array(TIERS.normal.particles);
    for (let i = 0; i < this.particleSeeds.length; i++) this.particleSeeds[i] = seed(`p${i}`);
    this.build();

    container.addEventListener('pointermove', this.onPointer);
    container.addEventListener('pointerleave', this.onLeave);
    container.addEventListener('pointerdown', this.onDown);
    container.addEventListener('pointerup', this.onUp);
    container.addEventListener('pointercancel', this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
  }

  // ─── Construction ───

  private mat(color: number, opts: THREE.MeshLambertMaterialParameters = {}) {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
    this.resources.push(m);
    return m;
  }
  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.resources.push(g);
    return g;
  }
  private mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    const me = new THREE.Mesh(g, m);
    me.position.set(x, y, z);
    parent.add(me);
    return me;
  }

  private build() {
    const s = this.scene;
    // Always a dark game stage, in light and dark themes alike.
    s.background = new THREE.Color(0x1c1626);
    s.fog = new THREE.Fog(0x1c1626, 7, 15);
    s.add(new THREE.AmbientLight(0xbfb0d6, 1.1));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
    key.position.set(3, 5, 4);
    s.add(key);
    const rim = new THREE.DirectionalLight(0x6fd0c0, 0.8);
    rim.position.set(-4, 3, -3);
    s.add(rim);

    const st = this.stage;
    s.add(st);
    this.camera.position.set(2.3, 2.1, 6.1);
    this.camera.lookAt(0, 1.45, 0);

    const noise = noiseTexture();
    const ring = circleTexture();
    this.resources.push(noise, ring);
    const tex = (color: number) => this.mat(color, { map: noise });

    // Floor, magic circle and a baked-looking shadow.
    const floor = this.mesh(this.geo(new THREE.CircleGeometry(2.4, 12)), this.mat(0xffffff, { map: ring }), st);
    floor.rotation.x = -Math.PI / 2;
    const shadow = this.mesh(this.geo(new THREE.CircleGeometry(0.85, 8)), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }), st, 0, 0.01, 0);
    this.resources.push(shadow.material as THREE.Material);
    shadow.rotation.x = -Math.PI / 2;

    st.add(this.body);
    // Robe: a 7-sided cone, faceted, with a darker hem.
    this.robe = this.mesh(this.geo(new THREE.ConeGeometry(0.78, 1.62, 7)), tex(C.plum), this.body, 0, 0.81, 0);
    this.mesh(this.geo(new THREE.CylinderGeometry(0.8, 0.82, 0.12, 7)), this.mat(C.plumDark), this.body, 0, 0.06, 0);
    // Belt with an inbox-shaped buckle.
    this.mesh(this.geo(new THREE.CylinderGeometry(0.43, 0.46, 0.1, 7)), this.mat(C.ink), this.body, 0, 1.0, 0);
    this.mesh(this.geo(new THREE.BoxGeometry(0.2, 0.15, 0.05)), this.mat(C.brass), this.body, 0, 1.0, 0.44);
    this.mesh(this.geo(new THREE.BoxGeometry(0.12, 0.05, 0.03)), this.mat(C.ink), this.body, 0, 1.02, 0.47);

    // Head, up top.
    this.head.position.set(0, 1.86, 0);
    this.body.add(this.head);
    this.mesh(this.geo(new THREE.IcosahedronGeometry(0.31, 0)), tex(C.skin), this.head);
    // The enormous hexagonal nose.
    const nose = this.mesh(this.geo(new THREE.CylinderGeometry(0.1, 0.14, 0.3, 6)), this.mat(C.skinDark), this.head, 0, -0.05, 0.33);
    nose.rotation.x = Math.PI / 2;
    // Eyes: pale planes with small dark pupils, just under the brim.
    const eyeGeo = this.geo(new THREE.PlaneGeometry(0.12, 0.085));
    const pupilGeo = this.geo(new THREE.PlaneGeometry(0.04, 0.05));
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xf6f1e4 });
    const pupilMat = new THREE.MeshBasicMaterial({ color: C.ink });
    this.resources.push(eyeMat, pupilMat);
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.12, 0.06, 0.285);
      eye.rotation.y = side * 0.25;
      this.head.add(eye);
      this.mesh(eyeGeo, eyeMat, eye);
      this.pupils.push(this.mesh(pupilGeo, pupilMat, eye, 0, 0, 0.005));
      this.eyes.push(eye);
      const brow = this.mesh(this.geo(new THREE.BoxGeometry(0.15, 0.035, 0.03)), this.mat(C.beardDark), this.head, side * 0.12, 0.15, 0.27);
      this.brows.push(brow);
      // Mouth halves tilt for a smile or frown.
      const half = this.mesh(this.geo(new THREE.BoxGeometry(0.085, 0.025, 0.02)), this.mat(C.ink), this.head, side * 0.042, -0.19, 0.27);
      this.mouth.push(half);
    }
    // Square beard strips.
    [0.42, 0.52, 0.48, 0.36].forEach((len, i) => {
      const b = this.mesh(this.geo(new THREE.BoxGeometry(0.075, len, 0.04)), this.mat(i % 2 ? C.beard : C.beardDark), this.head, -0.12 + i * 0.08, -0.2 - len / 2, 0.24 - Math.abs(i - 1.5) * 0.03);
      b.rotation.x = -0.12;
    });
    // Crooked teal hat.
    const hat = new THREE.Group();
    hat.position.set(0, 0.22, 0);
    hat.rotation.z = 0.14;
    this.head.add(hat);
    this.mesh(this.geo(new THREE.CylinderGeometry(0.52, 0.55, 0.05, 8)), this.mat(C.tealDark), hat);
    const cone = this.mesh(this.geo(new THREE.ConeGeometry(0.33, 0.95, 6)), tex(C.teal), hat, 0.05, 0.47, 0);
    cone.rotation.z = 0.22;

    // Arms: shoulder → elbow → wrist. Mismatched sleeves. Both hands end up above the head.
    const sleeves = [this.mat(C.plum, { map: noise }), this.mat(C.sleeveB, { map: noise })];
    const upperGeo = this.geo(new THREE.CylinderGeometry(0.11, 0.14, 0.5, 6).translate(0, -0.25, 0));
    const foreGeo = this.geo(new THREE.CylinderGeometry(0.09, 0.12, 0.45, 6).translate(0, -0.225, 0));
    const palmGeo = this.geo(new THREE.BoxGeometry(0.22, 0.24, 0.07).translate(0, -0.12, 0));
    const fingerGeo = this.geo(new THREE.CylinderGeometry(0.018, 0.03, 0.17, 4).translate(0, -0.085, 0));
    const skin = this.mat(C.skin);
    const skinDark = this.mat(C.skinDark);
    for (const side of [-1, 1] as const) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.36, 1.5, 0);
      this.body.add(shoulder);
      this.mesh(upperGeo, sleeves[side < 0 ? 0 : 1], shoulder);
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.5, 0);
      shoulder.add(elbow);
      this.mesh(foreGeo, sleeves[side < 0 ? 0 : 1], elbow);
      const wrist = new THREE.Group();
      wrist.position.set(0, -0.45, 0);
      elbow.add(wrist);
      this.mesh(palmGeo, skin, wrist);
      for (let i = 0; i < 4; i++) {
        const f = this.mesh(fingerGeo, i % 2 ? skin : skinDark, wrist, -0.08 + i * 0.053, -0.235, 0);
        f.rotation.z = (i - 1.5) * 0.08;
      }
      const thumb = this.mesh(fingerGeo, skinDark, wrist, side * -0.12, -0.06, 0.02);
      thumb.rotation.z = side * -1.0;
      this.arms.push({ shoulder, elbow, wrist, side });
    }

    // The spell: a blocky arc between the palms, plus a small orb in each.
    this.arcMat = this.mat(C.amber, { emissive: C.amber, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 });
    const seg = this.geo(new THREE.BoxGeometry(0.09, 0.09, 0.09));
    for (let i = 0; i <= 10; i++) {
      const k = i / 10;
      const x = lerp(-0.8, 0.8, k);
      const y = 2.42 + Math.sin(k * Math.PI) * 0.42;
      const z = 0.25 + Math.sin(k * Math.PI) * 0.3;
      const m = this.mesh(seg, this.arcMat, st, x, y, z);
      m.rotation.set(k * 3, k * 5, 0);
      this.arc.push(m);
    }
    const orbGeo = this.geo(new THREE.OctahedronGeometry(0.1, 0));
    for (const side of [-1, 1]) this.palmOrbs.push(this.mesh(orbGeo, this.arcMat, st, side * 0.82, 2.42, 0.12));

    // A cheap cardboard coffee cup on a plinth.
    this.cup.position.set(1.55, 0, 0.55);
    st.add(this.cup);
    this.mesh(this.geo(new THREE.BoxGeometry(0.42, 0.55, 0.42)), tex(C.plinth), this.cup, 0, 0.275, 0);
    const cupBody = new THREE.Group();
    cupBody.position.y = 0.55;
    this.cup.add(cupBody);
    this.mesh(this.geo(new THREE.CylinderGeometry(0.1, 0.075, 0.24, 8)), tex(C.parchment), cupBody, 0, 0.12, 0);
    this.mesh(this.geo(new THREE.CylinderGeometry(0.105, 0.105, 0.03, 8)), this.mat(C.ink), cupBody, 0, 0.255, 0);
    this.mesh(this.geo(new THREE.CylinderGeometry(0.102, 0.098, 0.06, 8)), this.mat(C.brick), cupBody, 0, 0.12, 0);

    // Stamped archive: where confirmed completions land.
    this.archive.position.set(-1.6, 0, 0.5);
    st.add(this.archive);
    this.mesh(this.geo(new THREE.BoxGeometry(0.5, 0.18, 0.4)), tex(C.parchment), this.archive, 0, 0.09, 0);
    this.stampMesh = this.mesh(this.geo(new THREE.CylinderGeometry(0.14, 0.16, 0.12, 8)), this.mat(C.brick), this.archive, 0, 2, 0);
    this.stampMesh.visible = false;

    // Racks: queued papers stand back left, untriaged papers sit in a tray back right.
    this.mesh(this.geo(new THREE.BoxGeometry(0.7, 0.06, 0.3)), this.mat(C.plinth), st, -1.1, 0.03, -1.4);
    this.mesh(this.geo(new THREE.BoxGeometry(0.6, 0.1, 0.4)), this.mat(C.plinth), st, 1.15, 0.05, -1.35);

    // Glyphs: each state has its own shape, not just its own color.
    this.glyphGeo = {
      working: this.geo(new THREE.OctahedronGeometry(0.14, 0)),
      needsYou: this.geo(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 8).rotateX(Math.PI / 2)),
      waiting: this.geo(new THREE.TetrahedronGeometry(0.15, 0)),
      queued: this.geo(new THREE.BoxGeometry(0.17, 0.24, 0.015)),
      untriaged: this.geo(new THREE.BoxGeometry(0.2, 0.015, 0.26)),
      done: this.geo(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 8)),
    };
    this.glyphMat = {
      working: this.mat(C.teal, { emissive: C.teal, emissiveIntensity: 0.5 }),
      needsYou: this.mat(C.amber, { emissive: C.amber, emissiveIntensity: 0.7 }),
      waiting: this.mat(0x8a86a0),
      queued: this.mat(C.parchment),
      untriaged: this.mat(0xd8cba6),
      done: this.mat(C.brick),
    };
    st.add(this.glyphRoot);
    // The selected ticket gets a halo ring, so selection never depends on color alone.
    this.halo = this.mesh(this.geo(new THREE.TorusGeometry(0.36, 0.035, 4, 12)), new THREE.MeshBasicMaterial({ color: 0xffffff }), st);
    this.resources.push(this.halo.material as THREE.Material);
    this.halo.visible = false;

    // Decorative sparkles. Count follows Spell clutter, capped by tier.
    const pos = new Float32Array(TIERS.normal.particles * 3);
    const pg = this.geo(new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pm = new THREE.PointsMaterial({ color: C.amber, size: 0.06, transparent: true, opacity: 0.85 });
    this.resources.push(pm);
    this.particles = new THREE.Points(pg, pm);
    st.add(this.particles);
  }

  // ─── Updates from the view ───

  update(next: SceneState) {
    const prev = this.state;
    this.state = next;
    if (!prev || prev.tier !== next.tier) this.resize();
    if (!next.hoverTilt) this.turn.tiltYaw = this.turn.tiltPitch = 0;
    this.syncGlyphs(next);
    if (next.selectedId && next.selectedId !== prev?.selectedId) this.glanceUntil = this.clock + 1.2;
    if (!next.followCursor) this.gaze.tx = this.gaze.ty = 0;
    this.schedule();
  }

  /** Back to the home view. */
  resetView() {
    this.turn.dragYaw = this.turn.dragPitch = 0;
    this.turn.releasedAt = -1;
    this.schedule();
  }

  /** One stamp, once, for confirmed completions. Bursts arrive as one call. */
  celebrate() {
    this.stampStart = this.clock;
    this.schedule();
    if (!this.looping()) this.settleStamp();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.container.removeEventListener('pointermove', this.onPointer);
    this.container.removeEventListener('pointerleave', this.onLeave);
    this.container.removeEventListener('pointerdown', this.onDown);
    this.container.removeEventListener('pointerup', this.onUp);
    this.container.removeEventListener('pointercancel', this.onUp);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    for (const r of this.resources) r.dispose();
    this.resources = [];
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private syncGlyphs(st: SceneState) {
    const want = new Set(st.glyphs.map((g) => g.id));
    for (const [id, g] of this.glyphs) {
      if (!want.has(id) || g.kind !== st.glyphs.find((x) => x.id === id)!.kind) {
        this.glyphRoot.remove(g.group);
        this.glyphs.delete(id);
      }
    }
    for (const g of st.glyphs) {
      if (this.glyphs.has(g.id)) continue;
      const group = new THREE.Group();
      group.add(new THREE.Mesh(this.glyphGeo[g.kind], this.glyphMat[g.kind]));
      if (g.kind === 'waiting') {
        // Tethered: a rope post beside it.
        const rope = new THREE.Mesh(this.glyphGeo.queued, this.glyphMat.waiting);
        rope.scale.set(0.15, 2.2, 1);
        rope.position.set(0.2, -0.1, 0);
        group.add(rope);
      }
      this.glyphRoot.add(group);
      this.glyphs.set(g.id, { group, kind: g.kind, seed: seed(g.id) });
    }
    // Index per kind gives each glyph a stable slot in its rack or ring.
    const slot = new Map<SpellKind, number>();
    const ringCount = st.glyphs.filter((g) => g.kind === 'working' || g.kind === 'needsYou').length;
    let ringIdx = 0;
    for (const g of st.glyphs) {
      const m = this.glyphs.get(g.id)!;
      const i = slot.get(g.kind) ?? 0;
      slot.set(g.kind, i + 1);
      const ud = m.group.userData as { slot: number; ring: number; ringCount: number };
      ud.slot = i;
      ud.ring = g.kind === 'working' || g.kind === 'needsYou' ? ringIdx++ : -1;
      ud.ringCount = ringCount;
    }
  }

  // ─── Loop ───

  private looping() {
    return !!this.state && this.state.animate && this.state.tier !== 'static' && !this.disposed;
  }

  private schedule() {
    if (this.disposed) return;
    cancelAnimationFrame(this.raf);
    if (this.looping()) {
      this.lastTick = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    } else {
      // Static, paused or hidden: draw once for this change and stop.
      this.step(0);
      this.render();
    }
  }

  private frame = (now: number) => {
    if (!this.looping()) return;
    this.raf = requestAnimationFrame(this.frame);
    const tier = TIERS[this.state!.tier];
    if (now - this.lastFrame < 1000 / tier.fps - 2) return;
    this.lastFrame = now;
    // Cap the step so a long pause doesn't fast-forward or burst.
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const t0 = performance.now();
    this.step(dt);
    this.render();
    this.watchBudget(performance.now() - t0, tier.budgetMs);
  };

  /** Drops to Low after five seconds of missing the frame budget. Never climbs back on its own. */
  private watchBudget(ms: number, budget: number) {
    if (this.slowReported || this.state?.tier !== 'normal') return;
    this.workAvg = this.workAvg * 0.9 + ms * 0.1;
    if (this.workAvg > budget) {
      if (this.slowSince < 0) this.slowSince = this.clock;
      else if (this.clock - this.slowSince > 5) {
        this.slowReported = true;
        this.cb.onSlow();
      }
    } else this.slowSince = -1;
  }

  private step(dt: number) {
    const st = this.state;
    if (!st) return;
    const speed = 0.7 + (st.caffeine / 100) * 0.7;
    this.clock += dt * speed;
    const t = this.clock;
    const ease = (tau: number) => (dt === 0 ? 1 : 1 - Math.exp(-dt / tau));
    const k = ease(0.12);

    // Pose targets from the mood. Attention holds the hands steadier and lifts the brows.
    const p = this.pose;
    p.steady = lerp(p.steady, st.mood === 'attention' ? 1 : 0, k);
    p.brow = lerp(p.brow, st.mood === 'attention' ? 1 : (50 - st.happiness) / 100, k);
    p.smile = lerp(p.smile, ((st.happiness - 50) / 50) * (st.mood === 'attention' ? 0.3 : 1), k);
    p.energy = lerp(p.energy, st.stale ? 0.08 : st.energy, ease(0.3));
    const stampAge = this.stampStart >= 0 ? t - this.stampStart : -1;
    p.proud = lerp(p.proud, stampAge >= 0 && stampAge < 1.4 ? 1 : 0, k);

    // Ambient casting breath: robe ±1 cm, wrists ±3°. It runs with no work at all, by design.
    const breath = Math.sin(t * 1.6);
    this.robe.scale.y = 1 + breath * 0.006;
    this.body.position.y = breath * 0.01;
    const sway = 1 - p.steady * 0.7;
    for (const a of this.arms) {
      const s = a.side;
      a.shoulder.rotation.z = s * 2.0 + Math.sin(t * 1.1 + s) * 0.02 * sway;
      a.elbow.rotation.z = s * (Math.PI - 2.0) - s * 0.05 + Math.sin(t * 1.3 + s) * 0.02 * sway;
      a.wrist.rotation.z = Math.sin(t * 1.7 + s * 2) * 3 * DEG * sway;
      a.wrist.rotation.x = -0.15;
    }

    // Face.
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      this.brows[i].rotation.z = side * (p.brow * 0.35 - p.proud * 0.2);
      this.brows[i].position.y = 0.15 + p.brow * 0.02 + p.proud * 0.02;
      this.mouth[i].rotation.z = side * p.smile * 0.35;
    }
    if (dt > 0 && t > this.nextBlink) {
      this.blinkUntil = t + 0.12;
      this.nextBlink = t + 5 + ((t * 7.31) % 3);
    }
    for (const e of this.eyes) e.scale.y = t < this.blinkUntil ? 0.1 : 1;

    // Gaze: pupils ±12°/±8° equivalent, head ±5°. The camera and body never chase the pointer.
    const g = this.gaze;
    let tx = st.followCursor ? g.tx : 0;
    let ty = st.followCursor ? g.ty : 0;
    if (t < this.glanceUntil) {
      const sel = st.selectedId ? this.glyphs.get(st.selectedId) : undefined;
      if (sel) {
        const v = sel.group.getWorldPosition(new THREE.Vector3()).project(this.camera);
        tx = clamp(v.x, -1, 1);
        ty = clamp(v.y * 0.6, -1, 1);
      }
    }
    const gk = ease(0.15);
    g.x = lerp(g.x, tx, gk);
    g.y = lerp(g.y, ty, gk);
    for (const pu of this.pupils) pu.position.set(g.x * 0.03, g.y * 0.018, 0.005);
    this.head.rotation.y = g.x * 5 * DEG;
    this.head.rotation.x = -g.y * 3 * DEG;

    // Spell: glow and bob follow decorative energy only.
    const glow = 0.25 + p.energy * 0.9;
    this.arcMat.emissiveIntensity = glow * (0.85 + Math.sin(t * 3) * 0.15);
    this.arcMat.opacity = 0.35 + p.energy * 0.6;
    this.arc.forEach((m, i) => (m.position.y += (2.42 + Math.sin((i / 10) * Math.PI) * 0.42 + Math.sin(t * 2 + i * 0.6) * 0.03 - m.position.y) * 0.5));
    this.palmOrbs.forEach((o, i) => (o.rotation.y = t * (1.2 + i * 0.3)));

    // Coffee cup wobble, bounded.
    const wob = (st.caffeine / 100) * 0.08;
    this.cup.children[1].rotation.z = Math.sin(t * 9) * wob;

    this.stepTurn(dt);

    this.placeGlyphs(st, t);
    this.placeParticles(st, t);
    this.placeStamp(stampAge);
  }

  private placeGlyphs(st: SceneState, t: number) {
    let selPos: THREE.Vector3 | null = null;
    for (const [id, g] of this.glyphs) {
      const ud = g.group.userData as { slot: number; ring: number; ringCount: number };
      const pos = g.group.position;
      if (ud.ring >= 0) {
        // Casting ring around the wizard. Needs-you seals hold still; working runes drift slowly.
        const base = (ud.ring / Math.max(1, ud.ringCount)) * Math.PI * 2 + g.seed * 0.5;
        const a = base + (g.kind === 'working' ? t * 0.25 : 0);
        pos.set(Math.cos(a) * 1.95, 0.6 + Math.sin(t * 1.4 + g.seed * 6) * (g.kind === 'working' ? 0.06 : 0.01), Math.sin(a) * 1.1 + 0.2);
        g.group.rotation.y = g.kind === 'working' ? t * 0.8 + g.seed * 6 : -a + Math.PI / 2;
      } else if (g.kind === 'waiting') {
        pos.set(1.9 - ud.slot * 0.35, 0.18, -0.6 - (ud.slot % 2) * 0.3);
        g.group.rotation.y = g.seed * 2;
      } else if (g.kind === 'queued') {
        pos.set(-1.35 + (ud.slot % 4) * 0.17, 0.2 + Math.floor(ud.slot / 4) * 0.02, -1.4);
        g.group.rotation.set(0, 0.1, (g.seed - 0.5) * 0.15);
      } else {
        pos.set(1.0 + (ud.slot % 3) * 0.12, 0.12 + ud.slot * 0.018, -1.35 + (g.seed - 0.5) * 0.12);
        g.group.rotation.y = (g.seed - 0.5) * 0.8;
      }
      const sel = id === st.selectedId;
      g.group.scale.setScalar(sel ? 2.1 : 1.5);
      if (sel) selPos = pos;
    }
    this.halo.visible = !!selPos;
    if (selPos) {
      this.halo.position.set(selPos.x, selPos.y, selPos.z);
      this.halo.rotation.set(Math.PI / 2, 0, t);
    }
  }

  private placeParticles(st: SceneState, t: number) {
    const cap = TIERS[st.tier].particles;
    const n = st.stale ? 0 : Math.round((st.clutter / 100) * cap);
    const arr = (this.particles.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < n; i++) {
      const s = this.particleSeeds[i];
      const a = s * Math.PI * 2 + t * (0.2 + s * 0.3);
      const r = 1.2 + s * 1.0;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = ((t * (0.25 + s * 0.3) + s * 3) % 3) + 0.1;
      arr[i * 3 + 2] = Math.sin(a) * r * 0.8;
    }
    this.particles.geometry.setDrawRange(0, n);
    this.particles.geometry.getAttribute('position').needsUpdate = true;
  }

  /** 700 ms stamp drop onto the archive, then rest. */
  private placeStamp(age: number) {
    if (age < 0) return;
    const m = this.stampMesh;
    m.visible = age < 2.2;
    const k = clamp(age / 0.7, 0, 1);
    m.position.y = lerp(1.6, 0.24, k * k);
    m.rotation.y = k * 0.6;
    if (age >= 2.2) this.stampStart = -1;
  }

  private settleStamp() {
    // Without motion the stamp just appears in place for the caption's duration.
    this.stampMesh.visible = true;
    this.stampMesh.position.y = 0.24;
    this.render();
    setTimeout(() => {
      if (this.disposed) return;
      this.stampMesh.visible = false;
      this.stampStart = -1;
      this.render();
    }, 2200);
  }

  private render() {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const tier = TIERS[this.state?.tier ?? 'normal'];
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    // Internal size capped per tier. The canvas is stretched with nearest-neighbour for the chunky look.
    const ratio = Math.min(window.devicePixelRatio || 1, tier.ratio, tier.maxW / w, tier.maxH / h);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Narrow stages pull back so both hands stay in frame.
    const aspect = w / h;
    this.camera.fov = aspect < 1.2 ? 44 : aspect < 1.5 ? 39 : 34;
    // Tall screens (a phone in full screen) pull the camera back so both hands stay in frame.
    const back = aspect < 1 ? Math.min(1.8, 0.8 / aspect) : 1;
    this.camera.position.set(2.3 * back, 1.45 + 0.65 * back, 6.1 * back);
    this.camera.lookAt(0, 1.45, 0);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = 7 * back;
      this.scene.fog.far = 15 * back;
    }
    this.camera.updateProjectionMatrix();
    if (!this.looping()) this.render();
  }

  /** Eases the stage toward the drag plus hover tilt, and home a few seconds after a drag ends. */
  private stepTurn(dt: number) {
    const u = this.turn;
    if (!this.drag && u.releasedAt >= 0 && performance.now() / 1000 - u.releasedAt > TURN.homeAfter) {
      u.dragYaw = u.dragPitch = 0;
      u.releasedAt = -1;
    }
    const ty = clamp(u.dragYaw + u.tiltYaw, -TURN.yaw, TURN.yaw);
    const tp = clamp(u.dragPitch + u.tiltPitch, -TURN.pitch, TURN.pitch);
    // While dragging, follow the hand closely; otherwise drift. Without motion, jump.
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt / (this.drag ? 0.05 : 0.35));
    u.yaw = lerp(u.yaw, ty, k);
    u.pitch = lerp(u.pitch, tp, k);
    this.stage.rotation.set(u.pitch, u.yaw, 0);
    const turned = Math.abs(u.dragYaw) > 0.01 || Math.abs(u.dragPitch) > 0.01;
    if (turned !== u.turned) {
      u.turned = turned;
      this.cb.onTurned(turned);
    }
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.container.getBoundingClientRect();
    const nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    const ny = clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1, 1);
    if (this.drag && e.pointerId === this.drag.id) {
      const u = this.turn;
      u.dragYaw = clamp(this.drag.yaw + (e.clientX - this.drag.x) * TURN.radPerPx, -TURN.yaw, TURN.yaw);
      u.dragPitch = clamp(this.drag.pitch + (e.clientY - this.drag.y) * TURN.radPerPx * 0.5, -TURN.pitch, TURN.pitch);
      if (!this.looping()) this.schedule();
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (this.state?.hoverTilt) {
      this.turn.tiltYaw = nx * TURN.tiltYaw;
      this.turn.tiltPitch = -ny * TURN.tiltPitch;
    }
    if (this.state?.followCursor) {
      this.gaze.tx = nx;
      this.gaze.ty = ny;
    }
  };
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.turn.dragYaw, pitch: this.turn.dragPitch };
    try {
      this.container.setPointerCapture(e.pointerId);
    } catch {
      // Some pointers can't be captured; the drag still works while over the stage.
    }
    this.container.classList.add('is-dragging');
  };
  private onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.turn.releasedAt = performance.now() / 1000;
    this.container.classList.remove('is-dragging');
    // Static or paused: there is no loop to bring it home, so a timer does, once.
    if (!this.looping()) setTimeout(() => !this.disposed && !this.drag && (this.resetView(), undefined), TURN.homeAfter * 1000 + 50);
  };
  private onLeave = () => {
    this.gaze.tx = this.gaze.ty = 0;
    this.turn.tiltYaw = this.turn.tiltPitch = 0;
  };
  private onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.disposed = true;
    this.cb.onFail('the graphics context was lost');
  };
}
