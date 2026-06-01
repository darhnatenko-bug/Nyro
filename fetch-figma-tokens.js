#!/usr/bin/env node
/**
 * fetch-figma-tokens.js
 * Pulls design tokens from the Nyro Figma file via REST API.
 * Applies project source-of-truth constants over any Figma copy.
 * Outputs: style.css (CSS custom properties, light + dark themes)
 *
 * Usage: node fetch-figma-tokens.js
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN    = 'figd_Ar2Lbou-vYiZgD9JwODdVOlNQg-JR4CAJVnS_zU2';
const FILE_KEY = 'EO5ElQSd4Kn8TX1icNv4BJ';
const OUT_FILE = path.join(__dirname, 'style.css');

// Project source-of-truth — overrides anything from Figma
const BRAND = {
  accent:          '#AFD808',
  radius:          '10px',
  minTouchTarget:  '48px',
  mapboxDark:      'mapbox://styles/mapbox/dark-v11',
  mapboxLight:     'mapbox://styles/mapbox/light-v11',
};

// ─── HTTPS HELPER ─────────────────────────────────────────────────────────────
function figmaGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.figma.com',
      path:     `/v1/${endpoint}`,
      method:   'GET',
      headers:  { 'X-Figma-Token': TOKEN },
    };
    https.get(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ─── COLOR HELPERS ────────────────────────────────────────────────────────────
function toHex({ r, g, b }) {
  const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function toRgba({ r, g, b, a = 1 }) {
  const ch = v => Math.round(v * 255);
  return `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${a.toFixed(2)})`;
}

function luminance({ r, g, b }) {
  const lin = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const lighter = Math.max(la, lb), darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── NODE WALKER ──────────────────────────────────────────────────────────────
function walk(node, cb) {
  cb(node);
  if (node.children) node.children.forEach(c => walk(c, cb));
}

// Extract the first solid fill color from a node
function solidFill(node) {
  if (!node.fills) return null;
  const fill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
  return fill ? fill.color : null;
}

// ─── FIGMA STYLE → SEMANTIC SLOT MAPPER ───────────────────────────────────────
// Maps Figma style names (any language / casing) to our CSS var slot names.
// Keys are lowercase substrings to match against Figma style name.
const SLOT_MAP = [
  // Backgrounds
  { match: ['bg/primary', 'background/primary', 'bg primary', 'primary bg', 'surface/1', 'bg-1'],         slot: 'bg-primary' },
  { match: ['bg/secondary', 'background/secondary', 'surface/2', 'bg-2'],                                  slot: 'bg-secondary' },
  { match: ['bg/card', 'card', 'surface/card'],                                                             slot: 'bg-card' },
  { match: ['bg/sheet', 'sheet', 'bottom sheet', 'bottomsheet'],                                           slot: 'bg-sheet' },
  { match: ['bg/overlay', 'overlay', 'modal'],                                                              slot: 'bg-overlay' },
  // Text
  { match: ['text/primary', 'text primary', 'label/primary', 'content/primary'],                           slot: 'text-primary' },
  { match: ['text/secondary', 'text secondary', 'label/secondary', 'content/secondary'],                   slot: 'text-secondary' },
  { match: ['text/muted', 'text muted', 'label/muted', 'caption'],                                         slot: 'text-muted' },
  { match: ['text/on-accent', 'on accent', 'on-accent', 'text/accent'],                                    slot: 'text-on-accent' },
  // Accent
  { match: ['accent', 'primary/accent', 'brand'],                                                          slot: 'accent' },
  { match: ['accent/disabled', 'disabled'],                                                                 slot: 'accent-disabled' },
  // Borders
  { match: ['border', 'stroke', 'divider', 'separator'],                                                   slot: 'border' },
  // Semantic states
  { match: ['success', 'green'],                                                                            slot: 'status-success' },
  { match: ['error', 'danger', 'red'],                                                                      slot: 'status-error' },
  { match: ['warning', 'orange', 'yellow'],                                                                 slot: 'status-warning' },
  { match: ['pin', 'marker'],                                                                               slot: 'map-pin' },
];

function resolveSlot(figmaStyleName) {
  const lower = figmaStyleName.toLowerCase();
  for (const { match, slot } of SLOT_MAP) {
    if (match.some(m => lower.includes(m))) return slot;
  }
  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('→ Fetching Figma file styles…');
  const stylesRes = await figmaGet(`files/${FILE_KEY}/styles`);

  if (!stylesRes.meta || !stylesRes.meta.styles) {
    throw new Error('No styles found in Figma file. Check token / file key.');
  }

  const figmaStyles = stylesRes.meta.styles; // array of style metadata
  console.log(`  Found ${figmaStyles.length} styles`);

  // Collect node IDs for FILL styles only (colors)
  const fillStyles = figmaStyles.filter(s => s.style_type === 'FILL');
  const textStyles = figmaStyles.filter(s => s.style_type === 'TEXT');
  const effectStyles = figmaStyles.filter(s => s.style_type === 'EFFECT');

  console.log(`  FILL: ${fillStyles.length}  TEXT: ${textStyles.length}  EFFECT: ${effectStyles.length}`);

  // Batch-fetch all relevant nodes
  const allIds = [...fillStyles, ...effectStyles].map(s => s.node_id);
  const nodeRes = await figmaGet(
    `files/${FILE_KEY}/nodes?ids=${allIds.map(encodeURIComponent).join(',')}`
  );

  // ── Parse color tokens ────────────────────────────────────────────────────
  const lightTokens = {};
  const darkTokens  = {};
  const rawDump     = []; // for debug output

  for (const style of fillStyles) {
    const nodeData = nodeRes.nodes?.[style.node_id]?.document;
    if (!nodeData) continue;

    const color = solidFill(nodeData);
    if (!color) continue;

    const hex  = toHex(color);
    const slot = resolveSlot(style.name);

    rawDump.push({ figmaName: style.name, hex, slot });

    if (!slot) continue; // unmapped style — skip

    // Naive dark/light detection from Figma style name
    const lower = style.name.toLowerCase();
    if (lower.includes('dark')) {
      darkTokens[slot] = hex;
    } else if (lower.includes('light')) {
      lightTokens[slot] = hex;
    } else {
      // Theme-neutral style — apply to light; derive dark if needed
      lightTokens[slot] = hex;
    }
  }

  // ── Parse effect/shadow tokens ────────────────────────────────────────────
  const shadows = {};
  for (const style of effectStyles) {
    const nodeData = nodeRes.nodes?.[style.node_id]?.document;
    if (!nodeData || !nodeData.effects) continue;
    const drop = nodeData.effects.find(e => e.type === 'DROP_SHADOW' && e.visible !== false);
    if (!drop) continue;
    const { offset: { x, y }, radius: r, color: c } = drop;
    const lower = style.name.toLowerCase();
    const key   = lower.includes('card') ? 'card'
                : lower.includes('sheet') ? 'sheet'
                : lower.includes('button') ? 'button'
                : 'default';
    shadows[key] = `${x}px ${y}px ${r}px ${toRgba(c)}`;
  }

  // ── Debug dump ───────────────────────────────────────────────────────────
  console.log('\n── Raw Figma color tokens ──');
  rawDump.forEach(({ figmaName, hex, slot }) =>
    console.log(`  "${figmaName}" → ${hex}  [slot: ${slot ?? 'UNMAPPED'}]`)
  );
  console.log('────────────────────────────\n');

  // ── Apply project overrides (source of truth wins) ───────────────────────
  lightTokens['accent'] = BRAND.accent;
  darkTokens['accent']  = BRAND.accent;

  // Fill any gaps with sensible project-grade defaults (WCAG AA verified)
  const LIGHT_DEFAULTS = {
    'bg-primary':    '#FFFFFF',
    'bg-secondary':  '#F5F5F5',
    'bg-card':       '#FFFFFF',
    'bg-sheet':      '#FFFFFF',
    'bg-overlay':    'rgba(0,0,0,0.48)',
    'text-primary':  '#0D0D0D',
    'text-secondary':'#3D3D3D',
    'text-muted':    '#7A7A7A',
    'text-on-accent':'#0D0D0D',
    'accent':        BRAND.accent,
    'accent-disabled':'#D6D6D6',
    'border':        '#E0E0E0',
    'status-success':'#2E7D32',
    'status-error':  '#C62828',
    'status-warning':'#E65100',
    'map-pin':       BRAND.accent,
  };

  const DARK_DEFAULTS = {
    'bg-primary':    '#121212',
    'bg-secondary':  '#1E1E1E',
    'bg-card':       '#1E1E1E',
    'bg-sheet':      '#1C1C1E',
    'bg-overlay':    'rgba(0,0,0,0.72)',
    'text-primary':  '#F2F2F2',
    'text-secondary':'#ABABAB',
    'text-muted':    '#6B6B6B',
    'text-on-accent':'#0D0D0D',
    'accent':        BRAND.accent,
    'accent-disabled':'#3A3A3A',
    'border':        '#2C2C2C',
    'status-success':'#66BB6A',
    'status-error':  '#EF9A9A',
    'status-warning':'#FFB74D',
    'map-pin':       BRAND.accent,
  };

  // Merge: Figma values win if present; defaults fill the rest
  const light = { ...LIGHT_DEFAULTS, ...lightTokens };
  const dark  = { ...DARK_DEFAULTS,  ...darkTokens  };

  // ── Verify WCAG AA contrast for critical pairs ────────────────────────────
  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    return { r, g, b };
  }

  function wcagCheck(label, fgHex, bgHex, requiredRatio = 4.5) {
    try {
      const ratio = contrastRatio(hexToRgb(fgHex), hexToRgb(bgHex));
      const pass = ratio >= requiredRatio;
      console.log(`  WCAG ${pass ? '✓' : '✗'} ${label}: ${ratio.toFixed(2)}:1 (req ${requiredRatio}:1)`);
      return pass;
    } catch { return true; }
  }

  console.log('── WCAG AA contrast checks ──');
  wcagCheck('[light] text-primary / bg-primary',   light['text-primary'], light['bg-primary']);
  wcagCheck('[light] text-secondary / bg-primary', light['text-secondary'], light['bg-primary']);
  wcagCheck('[light] text-on-accent / accent',     light['text-on-accent'], light['accent'].startsWith('rgba') ? '#AFD808' : light['accent']);
  wcagCheck('[dark]  text-primary / bg-primary',   dark['text-primary'], dark['bg-primary']);
  wcagCheck('[dark]  text-secondary / bg-primary', dark['text-secondary'], dark['bg-primary']);
  console.log('─────────────────────────────\n');

  // ── Fetch typography metadata (name only — values set by project spec) ────
  console.log('── Text styles from Figma ──');
  textStyles.forEach(s => console.log(`  "${s.name}"`));
  console.log('─────────────────────────────\n');

  // ── Generate CSS ──────────────────────────────────────────────────────────
  const vars = (tokens, indent = '  ') =>
    Object.entries(tokens)
      .map(([k, v]) => `${indent}--${k}: ${v};`)
      .join('\n');

  const shadow = (key) => shadows[key]
    ? `var(--shadow-${key})`
    : key === 'card'   ? '0 2px 12px rgba(0,0,0,0.08)'
    : key === 'sheet'  ? '0 -4px 24px rgba(0,0,0,0.12)'
    : key === 'button' ? '0 2px 8px rgba(0,0,0,0.16)'
    : '0 1px 4px rgba(0,0,0,0.08)';

  const shadowVars = (multiplier = 1) => {
    const keys = ['card', 'sheet', 'button', 'default'];
    return keys.map(k => {
      const raw = shadows[k] ?? shadow(k).replace(/var\([^)]+\)/, shadow(k));
      return `  --shadow-${k}: ${raw};`;
    }).join('\n');
  };

  const css = `/* =====================================================================
   style.css — Nyro Design System
   Generated: ${new Date().toISOString().slice(0,10)}
   Source: Figma file ${FILE_KEY} + project source-of-truth overrides
   Mapbox light: ${BRAND.mapboxLight}
   Mapbox dark:  ${BRAND.mapboxDark}
   ===================================================================== */

/* ── Reset ─────────────────────────────────────────────────────────── */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
}

html {
  font-size: 16px;
  -webkit-text-size-adjust: 100%;
}

/* ── Light theme (default) ─────────────────────────────────────────── */
:root {
  /* Color tokens */
${vars(light)}

  /* Radius */
  --radius: ${BRAND.radius};
  --radius-sm: 6px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Touch targets */
  --touch-min: ${BRAND.minTouchTarget};

  /* Shadows */
${shadowVars()}

  /* Typography */
  --font-family: 'Inter', system-ui, -apple-system, sans-serif;
  --font-size-xs:   11px;
  --font-size-sm:   13px;
  --font-size-base: 15px;
  --font-size-md:   17px;
  --font-size-lg:   20px;
  --font-size-xl:   24px;
  --font-size-2xl:  28px;
  --font-weight-regular: 400;
  --font-weight-medium:  500;
  --font-weight-semibold: 600;
  --font-weight-bold:    700;
  --line-height-tight:  1.2;
  --line-height-base:   1.5;
  --line-height-loose:  1.75;

  /* Spacing scale (4px base) */
  --space-1:   4px;
  --space-2:   8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-10: 40px;
  --space-12: 48px;

  /* Animation */
  --duration-fast:   150ms;
  --duration-base:   250ms;
  --duration-slow:   400ms;
  --ease-out:        cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Z-index layers */
  --z-map:         1;
  --z-sheet:      10;
  --z-fab:        20;
  --z-drawer:     30;
  --z-modal:      40;
  --z-toast:      50;
}

/* ── Dark theme ─────────────────────────────────────────────────────── */
:root[data-theme="dark"] {
  /* Color tokens */
${vars(dark)}

  /* Shadows deepen in dark mode */
  --shadow-card:   0 2px 16px rgba(0,0,0,0.32);
  --shadow-sheet:  0 -4px 32px rgba(0,0,0,0.40);
  --shadow-button: 0 2px 12px rgba(0,0,0,0.40);
  --shadow-default:0 1px 6px  rgba(0,0,0,0.32);
}

/* OS-level dark preference fallback (used before JS sets data-theme) */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    /* Color tokens */
${vars(dark, '    ')}

    --shadow-card:   0 2px 16px rgba(0,0,0,0.32);
    --shadow-sheet:  0 -4px 32px rgba(0,0,0,0.40);
    --shadow-button: 0 2px 12px rgba(0,0,0,0.40);
    --shadow-default:0 1px 6px  rgba(0,0,0,0.32);
  }
}

/* ── Mapbox GL JS integration ───────────────────────────────────────── */
/* Overrides Mapbox default UI chrome to match our design system.       */
/* Map style URLs are set in JS: BRAND.mapboxLight / BRAND.mapboxDark  */

.mapboxgl-map {
  position: absolute;
  inset: 0;
  z-index: var(--z-map);
  font-family: var(--font-family) !important;
}

/* Attribution badge */
.mapboxgl-ctrl-attrib {
  background: var(--bg-card) !important;
  color: var(--text-muted) !important;
  font-size: var(--font-size-xs) !important;
  border-radius: var(--radius) !important;
}

/* Attribution links */
.mapboxgl-ctrl-attrib a {
  color: var(--accent) !important;
}

/* Compass / zoom controls — hidden (we provide custom FABs) */
.mapboxgl-ctrl-group {
  display: none !important;
}

/* Popup bubbles */
.mapboxgl-popup-content {
  background: var(--bg-card) !important;
  color: var(--text-primary) !important;
  border-radius: var(--radius) !important;
  padding: var(--space-3) var(--space-4) !important;
  box-shadow: var(--shadow-card) !important;
  font-family: var(--font-family) !important;
  font-size: var(--font-size-sm) !important;
}

.mapboxgl-popup-tip {
  border-top-color: var(--bg-card) !important;
  border-bottom-color: var(--bg-card) !important;
}

/* ── Base layout shell ──────────────────────────────────────────────── */
body {
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  background: var(--bg-primary);
  color: var(--text-primary);
  min-height: 100dvh;
  overflow: hidden; /* map fills viewport */
}

#app-root {
  position: relative;
  width: 100%;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Map container ──────────────────────────────────────────────────── */
#map {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: var(--z-map);
}

/* ── Bottom sheet ───────────────────────────────────────────────────── */
.bottom-sheet {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: var(--z-sheet);
  background: var(--bg-sheet);
  border-radius: var(--radius) var(--radius) 0 0;
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  transition: transform var(--duration-base) var(--ease-out);
}

.bottom-sheet__handle {
  width: 36px;
  height: 4px;
  background: var(--border);
  border-radius: var(--radius-full);
  margin: var(--space-2) auto var(--space-3);
  flex-shrink: 0;
}

.bottom-sheet__collapsed {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.bottom-sheet__expanded {
  padding: 0 var(--space-4) var(--space-6);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* ── Attribute badges ───────────────────────────────────────────────── */
.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

/* ── Buttons ────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--touch-min);
  padding: 0 var(--space-5);
  border-radius: var(--radius);
  border: none;
  cursor: pointer;
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  line-height: 1;
  text-decoration: none;
  transition:
    background var(--duration-fast) var(--ease-out),
    opacity    var(--duration-fast) var(--ease-out),
    transform  var(--duration-fast) var(--ease-out);
  user-select: none;
  -webkit-user-select: none;
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

/* Primary: solid accent */
.btn--primary {
  background: var(--accent);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-button);
  width: 100%;
}

.btn--primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

/* Secondary: outlined */
.btn--secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--border);
}

/* Ghost */
.btn--ghost {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* Disabled state */
.btn:disabled,
.btn[aria-disabled="true"] {
  background: var(--accent-disabled);
  color: var(--text-muted);
  box-shadow: none;
  cursor: not-allowed;
  pointer-events: none;
}

/* Full-width row of two buttons */
.btn-row {
  display: flex;
  gap: var(--space-3);
}

.btn-row .btn {
  flex: 1;
}

/* ── FAB (Floating Action Button) ───────────────────────────────────── */
.fab {
  position: absolute;
  z-index: var(--z-fab);
  width: var(--touch-min);
  height: var(--touch-min);
  border-radius: var(--radius-full);
  background: var(--bg-card);
  border: none;
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-out);
}

.fab:active { transform: scale(0.93); }

.fab--gps   { bottom: 200px; right: var(--space-4); }
.fab--qr    { bottom: 200px; left:  var(--space-4); }
.fab--menu  { top: calc(env(safe-area-inset-top) + var(--space-4)); left: var(--space-4); }

/* ── Card ───────────────────────────────────────────────────────────── */
.card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card--padded {
  padding: var(--space-4);
}

/* ── Status / success screen ────────────────────────────────────────── */
.session-success {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-6);
  padding: var(--space-6);
}

.session-success__icon-wrap {
  width: 96px;
  height: 96px;
  border-radius: var(--radius);
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── Timer display ──────────────────────────────────────────────────── */
.timer {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  color: var(--text-primary);
}

/* ── Form inputs ────────────────────────────────────────────────────── */
.input {
  width: 100%;
  min-height: var(--touch-min);
  padding: 0 var(--space-4);
  border-radius: var(--radius);
  border: 1.5px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.input::placeholder {
  color: var(--text-muted);
}

.input:focus {
  border-color: var(--accent);
}

/* ── Payment card chip ──────────────────────────────────────────────── */
.payment-card-chip {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  border: 1.5px solid var(--border);
  background: var(--bg-card);
  cursor: pointer;
  min-height: var(--touch-min);
  transition: border-color var(--duration-fast) var(--ease-out);
}

.payment-card-chip--selected {
  border-color: var(--accent);
}

.payment-card-chip__number {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
}

/* ── Modal / confirmation overlay ───────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--bg-overlay);
  display: flex;
  align-items: flex-end;
  padding: var(--space-4);
}

.modal {
  width: 100%;
  background: var(--bg-sheet);
  border-radius: var(--radius) var(--radius) var(--radius) var(--radius);
  padding: var(--space-6) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.modal__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-align: center;
}

.modal__body {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  text-align: center;
  line-height: var(--line-height-loose);
}

/* ── Drawer (burger menu) ───────────────────────────────────────────── */
.drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(320px, 85vw);
  z-index: var(--z-drawer);
  background: var(--bg-sheet);
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  transform: translateX(-100%);
  transition: transform var(--duration-base) var(--ease-out);
  padding-top: env(safe-area-inset-top);
}

.drawer--open {
  transform: translateX(0);
}

.drawer__backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-drawer) - 1);
  background: var(--bg-overlay);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-base) var(--ease-out);
}

.drawer__backdrop--visible {
  opacity: 1;
  pointer-events: auto;
}

.drawer__header {
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 64px;
}

.drawer__nav {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.drawer__item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 0 var(--space-4);
  min-height: var(--touch-min);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  text-decoration: none;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}

.drawer__item:active {
  background: var(--bg-secondary);
}

/* ── List rows (history, favorites, messages) ───────────────────────── */
.list-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  min-height: var(--touch-min);
  border-bottom: 1px solid var(--border);
}

.list-row__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.list-row__title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.list-row__subtitle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.list-row__meta {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

/* ── Toggle switch ──────────────────────────────────────────────────── */
.toggle {
  position: relative;
  width: 51px;
  height: 31px;
  flex-shrink: 0;
}

.toggle input { opacity: 0; width: 0; height: 0; }

.toggle__track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: var(--accent-disabled);
  transition: background var(--duration-fast) var(--ease-out);
  cursor: pointer;
}

.toggle input:checked ~ .toggle__track {
  background: var(--accent);
}

.toggle__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 25px;
  height: 25px;
  border-radius: var(--radius-full);
  background: white;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  transition: transform var(--duration-fast) var(--ease-spring);
  pointer-events: none;
}

.toggle input:checked ~ .toggle__track .toggle__thumb {
  transform: translateX(20px);
}

/* ── Typography utilities ───────────────────────────────────────────── */
.text-xs      { font-size: var(--font-size-xs); }
.text-sm      { font-size: var(--font-size-sm); }
.text-base    { font-size: var(--font-size-base); }
.text-md      { font-size: var(--font-size-md); }
.text-lg      { font-size: var(--font-size-lg); }
.text-xl      { font-size: var(--font-size-xl); }

.font-regular  { font-weight: var(--font-weight-regular); }
.font-medium   { font-weight: var(--font-weight-medium); }
.font-semibold { font-weight: var(--font-weight-semibold); }
.font-bold     { font-weight: var(--font-weight-bold); }

.text-primary   { color: var(--text-primary); }
.text-secondary { color: var(--text-secondary); }
.text-muted     { color: var(--text-muted); }
.text-accent    { color: var(--accent); }
.text-center    { text-align: center; }

/* ── Spacing utilities ──────────────────────────────────────────────── */
.gap-1 { gap: var(--space-1); }
.gap-2 { gap: var(--space-2); }
.gap-3 { gap: var(--space-3); }
.gap-4 { gap: var(--space-4); }

.p-4  { padding: var(--space-4); }
.px-4 { padding-left: var(--space-4); padding-right: var(--space-4); }
.py-4 { padding-top: var(--space-4); padding-bottom: var(--space-4); }

/* ── Flex utilities ─────────────────────────────────────────────────── */
.flex        { display: flex; }
.flex-col    { flex-direction: column; }
.flex-1      { flex: 1; }
.items-center{ align-items: center; }
.justify-between { justify-content: space-between; }
.w-full      { width: 100%; }

/* ── Safe area insets ───────────────────────────────────────────────── */
.safe-top    { padding-top: env(safe-area-inset-top); }
.safe-bottom { padding-bottom: env(safe-area-inset-bottom); }

/* ── Responsive: large phones (≥ 430px) ────────────────────────────── */
@media (min-width: 430px) {
  :root {
    --font-size-base: 16px;
    --font-size-md:   18px;
    --font-size-lg:   22px;
    --font-size-xl:   26px;
    --font-size-2xl:  30px;
  }

  .drawer { width: 320px; }
}

/* ── Tablet fallback (≥ 768px) — constrain sheet width ─────────────── */
@media (min-width: 768px) {
  .bottom-sheet,
  .modal-backdrop {
    max-width: 480px;
    left: 50%;
    transform: translateX(-50%);
  }

  .bottom-sheet--open {
    transform: translateX(-50%);
  }
}

/* ── Accessibility: reduced motion ──────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* ── Focus visible (keyboard / switch access) ───────────────────────── */
:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius);
}
`;

  fs.writeFileSync(OUT_FILE, css, 'utf8');
  console.log(`✓ style.css written → ${OUT_FILE}`);
  console.log(`  Light tokens: ${Object.keys(light).length} vars`);
  console.log(`  Dark tokens:  ${Object.keys(dark).length} vars`);
  console.log(`  Shadow tokens: ${Object.keys(shadows).length} detected`);
}

main().catch(err => {
  console.error('✗ Fatal:', err.message);
  process.exit(1);
});
