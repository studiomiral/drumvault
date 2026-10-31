# Menu and top-bar artwork

- `menu-flat/*.svg`: current menu artwork. Ten flat vector icons at 24 × 24 pixels, with consistent strokes, solid colors and restrained secondary tones. No surrounding tiles, gradients, shadows, or raster textures. Grid uses a waveform over beat markers; Chord Stabs uses three aligned MIDI notes; Disco Hits uses a disco ball and glint.
- `app/artwork/menu-3d/`: previous full-resolution 3D icons and their built-in image generation prompts, retained as source history; no longer used by the menu.
- `menu-3d/*.png`: previous 128px exports, retained but no longer used.
- `menu/*.svg`: previous vector tile icons, retained as source history; no longer used by the menu.
- `topbar-waves.png`: original background generated with the built-in image generation tool (2172 × 724).
- `topbar-waves-smooth.png`: current lossless background, regenerated without the fine contour lines that aliased in the thin top bar. CSS softly filters only the decorative image layer, preserving sharp text and controls.
- `topbar-waves.jpg`: previous compressed version, no longer used.

## Background generation prompt

Use case: stylized-concept

Asset type: very wide panoramic abstract background image for the 56px high top bar of Drumvault, a dark charcoal desktop music production application.

Primary request: a refined, cool, modern, subtle abstract panorama, extremely wide horizontal format, ideally 3072 by 384 pixels (8:1). Smooth sculptural flowing ribbons and finely layered wave contours suggesting sound and rhythm, matte graphite black background (#1c1d20). Desaturated petrol teal, soft lavender, and restrained champagne gold light grazing the ribbon edges. The shapes travel horizontally across the image, readable even when cropped into a thin horizontal strip. Keep the middle horizontal band interesting, with large simple forms, generous dark negative space especially on the left for a white title. Premium abstract editorial art, satin surfaces, soft diffuse studio lighting, almost monochrome dark image with a few subdued colored edges, delicate texture. Restrained and elegant. It must work behind white text and controls.

Constraints: a single finished background image, no interface mockup, no icons, no lettering, no logos, no watermark, no bright white highlights, no busy noise, no neon, no stars, no hard geometric grid.
