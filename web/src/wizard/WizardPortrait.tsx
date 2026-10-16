// The Bureaucramancer, flat. Used before the 3D scene loads, when it can't, and in Static quality.
// An original character: plum robe, crooked teal hat, hexagonal nose, inbox belt buckle, both hands up.
import type { Mood } from './derive.ts';

interface Props {
  mood: Mood;
  happiness: number;
  /** 0..1 decorative spell glow. Not progress. */
  energy: number;
  animate: boolean;
  compact?: boolean;
}

export function WizardPortrait({ mood, happiness, energy, animate, compact }: Props) {
  // Mouth: -6 (frown) to +6 (grin). Attention keeps it level-ish so a warning never looks like good news.
  const curve = Math.round(((happiness - 50) / 50) * (mood === 'attention' ? 2 : 6));
  // Brows tilt up with worry when something needs you.
  const brow = mood === 'attention' ? 7 : Math.round(((50 - happiness) / 50) * 3);
  return (
    <svg className={`wz-portrait${animate ? ' is-animated' : ''}${compact ? ' is-compact' : ''}`} viewBox="0 0 240 200" role="img" aria-label="The Bureaucramancer, a low-poly wizard with both hands raised">
      {/* Magic circle on the floor */}
      <ellipse cx="120" cy="182" rx="96" ry="14" className="wz-floor" />
      <polygon points="60,182 120,170 180,182 120,194" className="wz-rune-line" />
      <polygon points="120,170 150,190 90,190" className="wz-rune-line" />
      {/* Coffee cup on the plinth */}
      <g className="wz-cup">
        <rect x="196" y="150" width="26" height="14" className="wz-plinth" />
        <polygon points="200,132 216,132 214,150 202,150" className="wz-cup-body" />
        <rect x="199" y="129" width="18" height="4" className="wz-cup-lid" />
      </g>
      {/* The spell held between the hands: a blocky arc behind the hat. Its glow is decoration, not progress. */}
      <g className="wz-spell" style={{ opacity: 0.3 + energy * 0.7 }}>
        <polyline points="64,46 82,26 98,38 120,18 142,38 158,26 176,46" className="wz-spell-arc" />
        <polygon points="64,30 70,38 64,46 58,38" className="wz-spell-core" />
        <polygon points="176,30 182,38 176,46 170,38" className="wz-spell-core" />
      </g>
      <g className="wz-body">
        {/* Robe, two facets for that flat-shaded look */}
        <polygon points="120,92 78,180 120,180" className="wz-robe" />
        <polygon points="120,92 162,180 120,180" className="wz-robe-dark" />
        {/* Belt with an inbox buckle */}
        <polygon points="92,138 148,138 150,146 90,146" className="wz-belt" />
        <polygon points="112,136 128,136 130,148 110,148" className="wz-buckle" />
        <polyline points="113,141 117,141 119,144 121,144 123,141 127,141" className="wz-buckle-mark" />
        {/* Arms: mismatched sleeves, both raised above the shoulders */}
        <polygon points="104,100 92,104 62,74 70,66" className="wz-sleeve-a" />
        <polygon points="136,100 148,104 178,74 170,66" className="wz-sleeve-b" />
        {/* Angular palms and fingers */}
        <g className="wz-hand wz-hand-l">
          <polygon points="58,72 72,64 70,48 56,52" className="wz-skin" />
          <polygon points="56,52 59,36 62,37 61,51" className="wz-skin-dark" />
          <polygon points="61,51 64,33 67,34 65,50" className="wz-skin" />
          <polygon points="65,50 68,34 71,35 69,49" className="wz-skin-dark" />
          <polygon points="69,49 72,38 75,39 71,50" className="wz-skin" />
          <polygon points="72,62 80,56 79,60 72,66" className="wz-skin-dark" />
        </g>
        <g className="wz-hand wz-hand-r">
          <polygon points="182,72 168,64 170,48 184,52" className="wz-skin" />
          <polygon points="184,52 181,36 178,37 179,51" className="wz-skin-dark" />
          <polygon points="179,51 176,33 173,34 175,50" className="wz-skin" />
          <polygon points="175,50 172,34 169,35 171,49" className="wz-skin-dark" />
          <polygon points="171,49 168,38 165,39 169,50" className="wz-skin" />
          <polygon points="168,62 160,56 161,60 168,66" className="wz-skin-dark" />
        </g>
        {/* Head */}
        <polygon points="104,62 136,62 142,80 134,96 106,96 98,80" className="wz-skin" />
        {/* Square beard strips */}
        <rect x="104" y="88" width="8" height="26" className="wz-beard" />
        <rect x="113" y="90" width="7" height="32" className="wz-beard-light" />
        <rect x="121" y="90" width="7" height="30" className="wz-beard" />
        <rect x="129" y="88" width="7" height="22" className="wz-beard-light" />
        {/* Eyes: pale planes, small dark pupils */}
        <rect x="107" y="70" width="10" height="7" className="wz-eye" />
        <rect x="123" y="70" width="10" height="7" className="wz-eye" />
        <g className="wz-pupils">
          <rect x="111" y="72" width="3" height="4" className="wz-pupil" />
          <rect x="127" y="72" width="3" height="4" className="wz-pupil" />
        </g>
        {/* Brows */}
        <rect x="105" y="65" width="13" height="3" className="wz-brow" transform={`rotate(${-brow} 111 66)`} />
        <rect x="122" y="65" width="13" height="3" className="wz-brow" transform={`rotate(${brow} 129 66)`} />
        {/* The enormous hexagonal nose */}
        <polygon points="114,74 126,74 131,82 126,90 114,90 109,82" className="wz-nose" />
        <polygon points="120,74 126,74 131,82 126,90 120,90" className="wz-nose-dark" />
        {/* Mouth */}
        <polyline points={`110,${93 - curve / 2} 120,${93 + curve / 2} 130,${93 - curve / 2}`} className="wz-mouth" />
        {/* Crooked hat */}
        <polygon points="92,64 148,64 152,58 88,58" className="wz-hat-brim" />
        <polygon points="98,58 142,58 132,20 112,8" className="wz-hat" />
        <polygon points="120,58 142,58 132,20 112,8" className="wz-hat-dark" />
      </g>
    </svg>
  );
}
