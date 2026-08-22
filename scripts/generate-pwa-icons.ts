// Rasterizes the installable-app icon set from the frontend's favicon.
//
//   node scripts/generate-pwa-icons.ts
//
// The PNGs are committed, so nothing in the build or deploy path runs this; re-run it by hand after
// changing `packages/workshop-frontend/public/favicon.svg` and commit the result. Requires
// ImageMagick 7 with the librsvg delegate (`magick -list format | grep RSVG`) -- ImageMagick's own
// SVG renderer draws the mark's mitred stroke wrong.
//
// The mark is drawn at `scale` of each canvas and centred on an opaque background, because the
// manifest icons must be opaque: Android composites a legacy (non-maskable) icon onto white, and
// iOS fills transparency with black. `maskable` gets the smallest scale, keeping every corner of
// the hexagon inside the 80%-diameter circle Android may crop an adaptive icon to.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))),
    "packages", "workshop-frontend", "public");

// `--color-kumo-base` of the dark theme in `packages/workshop-frontend/src/styles.css`, matching
// the manifest's `background_color`. Not the accent: a deployment overrides that at runtime
// (`applyAccentColor`), while these icons are baked at build time.
const BACKGROUND = "#050509";

const ICONS = [
  { file: "icon-192.png", size: 192, scale: 0.9 },
  { file: "icon-512.png", size: 512, scale: 0.9 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.82 },
  { file: "apple-touch-icon.png", size: 180, scale: 0.86 },
];

for (const { file, size, scale } of ICONS) {
  const mark = Math.round(size * scale);
  execFileSync("magick", [
    "-background", "none", join(PUBLIC_DIR, "favicon.svg"),
    "-resize", `${mark}x${mark}`,
    "-background", BACKGROUND, "-gravity", "center", "-extent", `${size}x${size}`,
    "-flatten", "-strip", "-depth", "8",
    join(PUBLIC_DIR, file),
  ], { stdio: "inherit" });
  console.log(`Wrote public/${file} (${size}x${size})`);
}
