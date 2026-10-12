import sharp from 'sharp';

/**
 * Generates clearly illustrative product images for demo data (never stock photos of real items).
 * Each is a flat silhouette on a warm background with an "Illustrative" corner mark.
 */
const SHAPES: Record<string, string> = {
  shirt: 'M300 170 L380 140 Q400 180 420 140 L500 170 L560 260 L505 290 L490 255 L490 520 L310 520 L310 255 L295 290 L240 260 Z',
  dress: 'M350 140 L450 140 L470 230 L560 520 L240 520 L330 230 Z',
  trousers: 'M300 140 L500 140 L520 520 L430 520 L400 260 L370 520 L280 520 Z',
  jacket: 'M290 160 L370 140 L400 200 L430 140 L510 160 L570 300 L520 320 L510 290 L510 520 L410 520 L400 230 L390 520 L290 520 L290 290 L280 320 L230 300 Z',
  sneaker: 'M220 380 Q240 300 330 300 L420 330 Q470 340 520 360 Q580 375 580 420 L580 440 L220 440 Z',
  heel: 'M260 300 Q300 290 340 360 L520 400 Q560 410 560 430 L500 440 L470 520 L455 520 L470 440 L300 440 Q250 420 260 300 Z',
  bag: 'M260 260 L540 260 L570 520 L230 520 Z M330 260 Q330 170 400 170 Q470 170 470 260 L450 260 Q450 195 400 195 Q350 195 350 260 Z',
  hat: 'M220 420 Q400 470 580 420 Q560 450 400 460 Q240 450 220 420 Z M300 420 Q300 260 400 260 Q500 260 500 420 Z',
  belt: 'M200 330 L600 330 L600 390 L200 390 Z M380 320 L450 320 L450 400 L380 400 Z',
  scarf: 'M300 150 L500 150 L470 330 L520 520 L440 520 L400 360 L360 520 L280 520 L330 330 Z',
  watch: 'M370 160 L430 160 L430 280 L370 280 Z M370 400 L430 400 L430 520 L370 520 Z M400 260 A80 80 0 1 1 399.9 260 Z',
};

export type IllustrationShape = keyof typeof SHAPES;

export async function illustration(shape: IllustrationShape, colour: string, variant = 0): Promise<Buffer> {
  const bgs = ['#EBE4D6', '#E6DED0', '#EFE9DE', '#E2DACB'];
  const bg = bgs[variant % bgs.length];
  const flip = variant % 2 === 1 ? 'transform="translate(800,0) scale(-1,1)"' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 660" preserveAspectRatio="xMidYMid slice">
    <rect width="800" height="660" fill="${bg}"/>
    <ellipse cx="400" cy="560" rx="230" ry="18" fill="#000" opacity="0.06"/>
    <g ${flip}><path d="${SHAPES[shape]}" fill="${colour}" stroke="#202923" stroke-opacity="0.18" stroke-width="3" fill-rule="evenodd"/></g>
    ${variant >= 2 ? '<circle cx="455" cy="330" r="16" fill="#7a5a3a" opacity="0.45"/>' : ''}
    <rect x="150" y="18" width="150" height="30" rx="6" fill="#FFFFFF" opacity="0.85"/>
    <rect x="160" y="30" width="130" height="6" rx="3" fill="#A8442F" opacity="0.7"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
