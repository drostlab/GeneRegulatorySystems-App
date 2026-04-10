/**
 * Colour utilities (hex-based)
 */

/** Luminance threshold below which white text is used for contrast. */
const CONTRAST_LUMINANCE_THRESHOLD = 0.3

/**
 * Relative luminance of an sRGB colour (0 = black, 1 = white).
 * Uses the W3C formula from WCAG 2.0.
 */
function relativeLuminance(r: number, g: number, b: number): number {
    const [rs, gs, bs] = [r, g, b].map(c => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * rs! + 0.7152 * gs! + 0.0722 * bs!
}

/**
 * Return '#ffffff' or '#1a1a1a' depending on which provides better
 * contrast against the given background hex colour.
 */
export function contrastTextColour(bgHex: string): string {
    const { r, g, b } = parseHex(bgHex)
    return relativeLuminance(r, g, b) < CONTRAST_LUMINANCE_THRESHOLD
        ? '#ffffff'
        : '#1a1a1a'
}

/**
 * Parse a hex colour string to RGB components (0–255).
 */
export function parseHex(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '')
    return {
        r: parseInt(clean.substring(0, 2), 16),
        g: parseInt(clean.substring(2, 4), 16),
        b: parseInt(clean.substring(4, 6), 16)
    }
}

/**
 * Convert RGB (0–255) to hex.
 */
export function rgbToHex(r: number, g: number, b: number): string {
    const toHex = (val: number) => Math.round(val).toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Convert hex colour string to RGBA object for Monaco (0–1 scale).
 */
export function hexToRgba(hex: string): { red: number; green: number; blue: number; alpha: number } {
    const { r, g, b } = parseHex(hex)
    const alpha = hex.length > 7 ? parseInt(hex.substring(7, 9), 16) / 255 : 1
    return {
        red: r / 255,
        green: g / 255,
        blue: b / 255,
        alpha
    }
}

/**
 * Convert RGBA object (0–1 scale) to hex colour string.
 */
export function rgbaToHex(color: { red: number; green: number; blue: number; alpha?: number }): string {
    const r = Math.round(color.red * 255)
    const g = Math.round(color.green * 255)
    const b = Math.round(color.blue * 255)
    const hex = rgbToHex(r, g, b)
    return color.alpha !== undefined && color.alpha < 1 
        ? hex + Math.round(color.alpha * 255).toString(16).padStart(2, '0')
        : hex
}

/**
 * Convert RGB (0–255) to HSL (h: 0–360, s: 0–1, l: 0–1).
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255, gn = g / 255, bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const l = (max + min) / 2
    const d = max - min

    let h = 0
    let s = 0
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1))
        if      (max === rn) h = ((gn - bn) / d + 6) % 6
        else if (max === gn) h = (bn - rn) / d + 2
        else                 h = (rn - gn) / d + 4
        h = (h / 6) * 360
    }

    return { h, s, l }
}

/**
 * Convert HSL (h: 0–360, s: 0–1, l: 0–1) to RGB (0–255).
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    let r = 0, g = 0, b = 0
    const sector = Math.floor(h / 60)
    
    if      (sector === 0 || sector === 6) { r = c; g = x }
    else if (sector === 1) { r = x; g = c }
    else if (sector === 2) { g = c; b = x }
    else if (sector === 3) { g = x; b = c }
    else if (sector === 4) { r = x; b = c }
    else if (sector === 5) { r = c; b = x }
    
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    }
}

/**
 * Convert HSL (h: 0–360, s: 0–1, l: 0–1) to hex.
 */
function hslToHex(h: number, s: number, l: number): string {
    const { r, g, b } = hslToRgb(h, s, l)
    return rgbToHex(r, g, b)
}

/**
 * Extract HSL lightness (0–1) from a hex colour.
 */
function hexLightness(hex: string): number {
    const { r, g, b } = parseHex(hex)
    const { l } = rgbToHsl(r, g, b)
    return l
}

/**
 * Linear interpolation between two colours.
 */
export function lerpColor(color1: string, color2: string, t: number): string {
    const c1 = parseHex(color1)
    const c2 = parseHex(color2)
    
    return rgbToHex(
        c1.r + (c2.r - c1.r) * t,
        c1.g + (c2.g - c1.g) * t,
        c1.b + (c2.b - c1.b) * t
    )
}

/**
 * Lighten colour by mixing with white.
 */
export function lighten(hex: string, amount: number): string {
    return lerpColor(hex, '#FFFFFF', amount)
}

/**
 * Darken colour by mixing with black.
 */
export function darken(hex: string, factor: number = 0.7): string {
    return lerpColor(hex, '#000000', 1 - factor)
}

/**
 * Convert hex to rgba() string with opacity.
 */
export function withOpacity(hex: string, opacity: number): string {
    const { r, g, b } = parseHex(hex)
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

/**
 * Reduce saturation of a hex colour by `amount` (0–1) without changing lightness.
 * amount = 0 → no change, amount = 1 → fully greyscale.
 */
export function desaturate(hex: string, amount: number): string {
    const { r, g, b } = parseHex(hex)
    const { h, s, l } = rgbToHsl(r, g, b)
    const sNew = s * (1 - amount)
    return hslToHex(h, sNew, l)
}

/**
 * Build a stable mapping from channel names to distinct subtle hue colours.
 * Empty channel maps to the provided `baseColour`.
 * Non-empty channels are spread across hues from green (~120°) to purple (~280°),
 * using the same lightness as `baseColour` so they appear identical in brightness,
 * with very low saturation for a subtle tint effect.
 */
export function buildChannelColourMap(channels: string[], baseColour: string): Map<string, string> {
    const map = new Map<string, string>()
    map.set('', baseColour)

    const sorted = [...channels].filter(c => c !== '').sort()
    if (sorted.length === 0) return map

    const lightness = hexLightness(baseColour)
    const HUE_MIN = 120
    const HUE_MAX = 280
    const SATURATION = 0.25

    for (let i = 0; i < sorted.length; i++) {
        const t = sorted.length === 1 ? 0.5 : i / (sorted.length - 1)
        const hue = HUE_MIN + t * (HUE_MAX - HUE_MIN)
        map.set(sorted[i]!, hslToHex(hue, SATURATION, lightness))
    }
    return map
}

/**
 * Rotate hue of a hex colour by amount in degrees (-180 to 180).
 * amount = 0 → no change, amount = 120 → shift by 120°
 */
export function rotateHue(hex: string, degrees: number): string {
    const { r, g, b } = parseHex(hex)
    const { h, s, l } = rgbToHsl(r, g, b)
    const hNew = (h + degrees) % 360
    return hslToHex(hNew >= 0 ? hNew : hNew + 360, s, l)
}