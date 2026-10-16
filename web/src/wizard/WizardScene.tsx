// React shell for the 3D engine. Loaded on demand, so Three.js never weighs on the board.
// React re-renders only when facts or settings change; the engine animates on its own.
import { useEffect, useRef } from 'react';
import { WizardEngine, type SceneState, type SceneTier } from './scene.ts';
import type { Mood, TaskSpell } from './derive.ts';

interface Props {
  glyphs: TaskSpell[];
  selectedId: string | null;
  mood: Mood;
  stale: boolean;
  happiness: number;
  caffeine: number;
  clutter: number;
  energy: number;
  tier: SceneTier;
  animate: boolean;
  followCursor: boolean;
  hoverTilt: boolean;
  /** Bump to send the stage back to its home view. */
  resetNonce: number;
  stamp: { ids: string[]; n: number } | null;
  onFail: (why: string) => void;
  onSlow: () => void;
  onTurned: (turned: boolean) => void;
}

export default function WizardScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<WizardEngine | null>(null);
  const cbs = useRef({ onFail: props.onFail, onSlow: props.onSlow, onTurned: props.onTurned });
  cbs.current = { onFail: props.onFail, onSlow: props.onSlow, onTurned: props.onTurned };

  useEffect(() => {
    try {
      engine.current = new WizardEngine(host.current!, { onFail: (w) => cbs.current.onFail(w), onSlow: () => cbs.current.onSlow(), onTurned: (t) => cbs.current.onTurned(t) });
    } catch {
      cbs.current.onFail('WebGL is not available');
    }
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);

  const glyphKey = props.glyphs.map((g) => `${g.task.id}:${g.kind}`).join(',');
  useEffect(() => {
    const state: SceneState = {
      glyphs: props.glyphs.map((g) => ({ id: g.task.id, kind: g.kind })),
      selectedId: props.selectedId,
      mood: props.mood,
      stale: props.stale,
      happiness: props.happiness,
      caffeine: props.caffeine,
      clutter: props.clutter,
      energy: props.energy,
      tier: props.tier,
      animate: props.animate,
      followCursor: props.followCursor,
      hoverTilt: props.hoverTilt,
    };
    engine.current?.update(state);
    // glyphKey stands in for the glyph list, which is a new array on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glyphKey, props.selectedId, props.mood, props.stale, props.happiness, props.caffeine, props.clutter, props.energy, props.tier, props.animate, props.followCursor, props.hoverTilt]);

  useEffect(() => {
    if (props.resetNonce) engine.current?.resetView();
  }, [props.resetNonce]);

  const stampN = props.stamp?.n;
  useEffect(() => {
    if (stampN) engine.current?.celebrate();
  }, [stampN]);

  return <div ref={host} className="wz-canvas" aria-hidden="true" />;
}
