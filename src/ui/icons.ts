/** Pixel-art inline SVG icons — 8×8 grid, uses currentColor */

function pxSvg(rects: string, size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 8 8" fill="currentColor" style="vertical-align:middle">${rects}</svg>`
}

function pxSvgBox(rects: string, width: number, height: number, viewW: number, viewH: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewW} ${viewH}" fill="currentColor" style="vertical-align:middle">${rects}</svg>`
}

export const iconFastForward = (size?: number) => pxSvg(
  `<rect x="1" y="1" width="1" height="1"/><rect x="5" y="1" width="1" height="1"/>` +
  `<rect x="1" y="2" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/>` +
  `<rect x="1" y="3" width="1" height="1"/><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/>` +
  `<rect x="1" y="4" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/>` +
  `<rect x="1" y="5" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/>`,
  size,
)

export const iconArrowRightLong = (width = 40, height = 16) => pxSvgBox(
  // 16×8: clean pixel arrow with thicker shaft
  `<rect x="0" y="3" width="10" height="2"/>` +
  `<rect x="8" y="1" width="2" height="1"/>` +
  `<rect x="9" y="2" width="2" height="1"/>` +
  `<rect x="10" y="3" width="2" height="2"/>` +
  `<rect x="9" y="5" width="2" height="1"/>` +
  `<rect x="8" y="6" width="2" height="1"/>`,
  width,
  height,
  16,
  8,
)

export const iconX = (size?: number) => pxSvg(
  `<rect x="1" y="1" width="1" height="1"/><rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="2" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/>` +
  `<rect x="3" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/>` +
  `<rect x="3" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/>` +
  `<rect x="2" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>
`,
  size,
)

export const iconCoin = (size?: number) => pxSvg(
  // Thick pixelated "$" — cheapest indicator
  `<rect x="3" y="0" width="2" height="1"/>` +
  `<rect x="2" y="1" width="4" height="1"/>` +
  `<rect x="1" y="2" width="3" height="1"/>` +
  `<rect x="2" y="3" width="4" height="1"/>` +
  `<rect x="4" y="4" width="3" height="1"/>` +
  `<rect x="2" y="5" width="4" height="1"/>` +
  `<rect x="3" y="6" width="2" height="1"/>`,
  size,
)

export const iconCrown = (size?: number) => pxSvg(
  // Infinity symbol ∞ — best route
  `<rect x="1" y="1" width="2" height="1"/><rect x="5" y="1" width="2" height="1"/>` +
  `<rect x="0" y="2" width="1" height="1"/><rect x="3" y="2" width="2" height="1"/><rect x="7" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="3" y="3" width="2" height="1"/><rect x="7" y="3" width="1" height="1"/>` +
  `<rect x="1" y="4" width="2" height="1"/><rect x="5" y="4" width="2" height="1"/>`,
  size,
)

export const iconExternalLink = (size?: number) => pxSvg(
  // Box bottom-left with arrow exiting top-right
  `<rect x="4" y="0" width="3" height="1"/>` +
  `<rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="0" y="2" width="4" height="1"/><rect x="5" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/>` +
  `<rect x="0" y="4" width="1" height="1"/>` +
  `<rect x="0" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/>` +
  `<rect x="0" y="6" width="7" height="1"/>`,
  size,
)

export const iconRefresh = (size?: number) => pxSvg(
  // Two counter-rotating arcs with arrowheads forming a refresh cycle
  `<rect x="2" y="0" width="4" height="1"/>` +
  `<rect x="1" y="1" width="1" height="1"/><rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="0" y="2" width="1" height="1"/><rect x="4" y="2" width="3" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/>` +
  `<rect x="7" y="4" width="1" height="1"/>` +
  `<rect x="1" y="5" width="3" height="1"/><rect x="7" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>` +
  `<rect x="2" y="7" width="4" height="1"/>`,
  size,
)

export const iconTrash = (size?: number) => pxSvg(
  // Pixel trash basket (open top)
  `<rect x="1" y="1" width="6" height="1"/>` +
  `<rect x="0" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/>` +
  `<rect x="1" y="2" width="6" height="1"/>` +
  `<rect x="1" y="3" width="1" height="4"/><rect x="6" y="3" width="1" height="4"/>` +
  `<rect x="2" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/>` +
  `<rect x="3" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/>` +
  `<rect x="2" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/>` +
  `<rect x="3" y="6" width="1" height="1"/><rect x="5" y="6" width="1" height="1"/>` +
  `<rect x="2" y="7" width="4" height="1"/>`,
  size,
)

export const iconInfo = (size = 14) => pxSvgBox(
  // Circled question mark on 10×10 grid for better readability
  `<rect x="3" y="0" width="4" height="1"/>` +
  `<rect x="2" y="1" width="1" height="1"/><rect x="7" y="1" width="1" height="1"/>` +
  `<rect x="1" y="2" width="1" height="1"/><rect x="5" y="2" width="2" height="1"/><rect x="8" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="9" y="3" width="1" height="1"/>` +
  `<rect x="0" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/>` +
  `<rect x="0" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/>` +
  `<rect x="0" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/>` +
  `<rect x="1" y="7" width="1" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="8" y="7" width="1" height="1"/>` +
  `<rect x="2" y="8" width="1" height="1"/><rect x="7" y="8" width="1" height="1"/>` +
  `<rect x="3" y="9" width="4" height="1"/>`,
  size, size, 10, 10,
)

export const iconWarnPixel = (size = 14) => pxSvg(
  // Pixel exclamation for bad quote warning
  `<rect x="3" y="0" width="2" height="5"/>` +
  `<rect x="3" y="7" width="2" height="1"/>`,
  size,
)

export const iconCheck = (size?: number) => pxSvg(
  // Checkmark — short left tail (3px) + long right leg (6px), vertex left-biased
  `<rect x="7" y="0" width="1" height="1"/>` +
  `<rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="5" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/>` +
  `<rect x="1" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/>` +
  `<rect x="2" y="5" width="1" height="1"/>`,
  size,
)

export const iconCross = (size?: number) => pxSvg(
  // Cross/fail mark — same as iconX but smaller
  `<rect x="1" y="1" width="1" height="1"/><rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="2" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/>` +
  `<rect x="3" y="3" width="2" height="1"/>` +
  `<rect x="3" y="4" width="2" height="1"/>` +
  `<rect x="2" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>`,
  size,
)

export const iconCircle = (size?: number) => pxSvg(
  // Empty circle (pending state)
  `<rect x="2" y="0" width="4" height="1"/>` +
  `<rect x="1" y="1" width="1" height="1"/><rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="0" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/>` +
  `<rect x="0" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/>` +
  `<rect x="0" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>` +
  `<rect x="2" y="7" width="4" height="1"/>`,
  size,
)

export const iconCircleDot = (size?: number) => pxSvg(
  // Circle with dot inside (active/spinner state)
  `<rect x="2" y="0" width="4" height="1"/>` +
  `<rect x="1" y="1" width="1" height="1"/><rect x="6" y="1" width="1" height="1"/>` +
  `<rect x="0" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/>` +
  `<rect x="0" y="3" width="1" height="1"/><rect x="3" y="3" width="2" height="1"/><rect x="7" y="3" width="1" height="1"/>` +
  `<rect x="0" y="4" width="1" height="1"/><rect x="3" y="4" width="2" height="1"/><rect x="7" y="4" width="1" height="1"/>` +
  `<rect x="0" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/>` +
  `<rect x="1" y="6" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>` +
  `<rect x="2" y="7" width="4" height="1"/>`,
  size,
)

export const iconDot = (size?: number) => pxSvg(
  // Middle dot (·)
  `<rect x="3" y="3" width="2" height="2"/>`,
  size,
)

export const iconClaim = (size?: number) => pxSvg(
  // Pixel down-arrow-into-tray — claim/receive icon, uses accent green
  `<rect x="3" y="0" width="2" height="1" fill="#11a477"/>` +
  `<rect x="3" y="1" width="2" height="1" fill="#11a477"/>` +
  `<rect x="3" y="2" width="2" height="1" fill="#11a477"/>` +
  `<rect x="1" y="3" width="2" height="1" fill="#11a477"/><rect x="3" y="3" width="2" height="1" fill="#11a477"/><rect x="5" y="3" width="2" height="1" fill="#11a477"/>` +
  `<rect x="2" y="4" width="1" height="1" fill="#11a477"/><rect x="3" y="4" width="2" height="1" fill="#11a477"/><rect x="5" y="4" width="1" height="1" fill="#11a477"/>` +
  `<rect x="3" y="5" width="2" height="1" fill="#11a477"/>` +
  `<rect x="0" y="6" width="8" height="1" fill="#11a477"/>` +
  `<rect x="0" y="7" width="1" height="1" fill="#11a477"/><rect x="7" y="7" width="1" height="1" fill="#11a477"/>`,
  size,
)
