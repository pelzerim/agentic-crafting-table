import { useEffect, useRef } from 'react';

const WIDTH = 13, HEIGHT = 16;
const NETHER = ['#3d1285', '#5b1fbf', '#7a35e6', '#9b5cff', '#c49bff', '#e6d2ff'];
const OVERWORLD = ['#2f5a3a', '#3f6b3c', '#5f8f5b', '#7fb87d', '#9cd29a', '#dff5d8'];
const OBSIDIAN = ['#0e0816', '#150c22', '#1f1330', '#2c1c45'];

/** Pixel-art portal: an obsidian frame around a core that swirls while hovered.
 * The core shows where it leads: purple to Undermap, green back to the map. */
export function PortalArt({ destination, animate }: { destination: 'below' | 'map'; animate: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const palette = destination === 'below' ? NETHER : OVERWORLD;
    const draw = (t: number) => {
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        const frame = x < 2 || x >= WIDTH - 2 || y < 2 || y >= HEIGHT - 2;
        if (frame) {
          const speck = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          context.fillStyle = (x === 1 || y === 1) && speck % 3 === 0 ? OBSIDIAN[3] : OBSIDIAN[speck % 3];
        } else {
          // Diagonal wavy streaks drifting upward, brighter toward the center, with rare sparkles.
          const wave = Math.sin(x * .9 + y * .55 - t * 2.2 + Math.sin(y * .8 + t * 1.1) * 1.6) + .45 * Math.sin((x - y) * 1.3 + t * 3);
          const center = 1 - Math.hypot((x - WIDTH / 2 + .5) / (WIDTH / 2 - 2), (y - HEIGHT / 2 + .5) / (HEIGHT / 2 - 2));
          const sparkle = (((x * 7 + y * 13 + Math.floor(t * 4)) * 2654435761) >>> 0) % 29 === 0;
          const index = Math.floor((wave + 1.45) / 2.9 * (palette.length - 2) + Math.max(0, center) * 1.2);
          context.fillStyle = sparkle ? palette[palette.length - 1] : palette[Math.max(0, Math.min(palette.length - 2, index))];
        }
        context.fillRect(x, y, 1, 1);
      }
    };
    // Still unless hovered or focused; reduced motion keeps it still.
    let t = 0; draw(t);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => { if (!document.hidden) draw(t += .12); }, 120);
    return () => clearInterval(timer);
  }, [destination, animate]);
  return <canvas ref={canvas} className="portal-art" width={WIDTH} height={HEIGHT} aria-hidden="true" />;
}
