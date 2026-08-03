import { share } from "../lib/metrics.js";

// Générateurs SVG purs (§12.2) — aucune librairie de charting, aucune ressource
// externe (pas de police distante, pas d'image liée, pas d'appel réseau).
// Chaque fonction est pure et testable : mêmes entrées => même SVG.
//
// Les couleurs référencent des variables CSS `var(--chart-*)` définies une
// seule fois par report/html.js (thème clair/sombre). La palette et les
// spécifications de tracé (épaisseurs, arrondis, espaceurs, contraste) suivent
// la skill `dataviz` : catégorielle à 8 teintes validées CVD, rampe
// séquentielle bleue pour l'entonnoir (ordinale, steps 250→600 — reste
// lisible sur fond clair ET sombre), couleurs de statut (bon/attention/
// critique) réservées au sens de la variation, jamais réutilisées comme
// identité de série.

/** Échappe le texte injecté dans le SVG (labels/valeurs proviennent des données collectées). */
export function escapeXml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function truncate(str, maxLen) {
  const s = String(str ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

// Correction lisibilité (§12.2) : Node n'a pas accès à la mesure réelle d'un
// texte (pas de DOM/Canvas). Cette approximation — largeur moyenne d'un
// caractère à 55% de la taille de police — suffit pour décider si un libellé
// tient dans une barre ou doit en sortir ; aucune dépendance externe.
const TEXT_WIDTH_CHAR_RATIO = 0.55;

/** Estimation grossière (mais suffisante) de la largeur d'un texte en pixels. */
export function estimateTextWidth(str, fontSize = 11) {
  return String(str ?? "").length * fontSize * TEXT_WIDTH_CHAR_RATIO;
}

const numberFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
/** Formatage français par défaut (séparateur de milliers = espace insécable) — utilisé pour les labels de graphique. */
export function formatChartNumber(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return numberFormatter.format(n);
}

// Pas de `xmlns` : ces SVG sont toujours intégrés en ligne dans une page HTML5
// (jamais servis comme fichier .svg autonome), où le parseur reconnaît la
// balise <svg> nativement — l'attribut xmlns n'est pas nécessaire, et son
// URI (`http://www.w3.org/2000/svg`) ressemble sinon à une ressource externe
// alors qu'aucune requête réseau n'est jamais faite dessus.
function svgWrap(width, height, inner, title) {
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" preserveAspectRatio="xMinYMid meet" ` +
    `role="img" class="chart-svg">` +
    (title ? `<title>${escapeXml(title)}</title>` : "") +
    inner +
    `</svg>`
  );
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const n = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Choisit blanc ou encre sombre pour un texte posé À L'INTÉRIEUR d'un aplat coloré, selon la luminance de l'aplat. */
function textColorOnFill(hex) {
  return relativeLuminance(hex) > 0.4 ? "#0b0b0b" : "#ffffff";
}

function buildLinePath(points) {
  let d = "";
  let started = false;
  for (const p of points) {
    if (!p) {
      started = false;
      continue;
    }
    d += `${started ? " L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    started = true;
  }
  return d.trim();
}

/**
 * Sparkline quotidienne (§12.2). `values` : tableau de nombres (ou `null`
 * pour un jour manquant — la ligne se coupe plutôt que d'interpoler un faux
 * chiffre, cf. §14 « jamais de zéro implicite »). Trait 2px, marqueur ≥8px
 * sur le dernier point connu, cerné d'un anneau de la couleur de surface.
 */
export function sparkline(values, { width = 240, height = 48, color = "var(--chart-series-1)" } = {}) {
  const clean = (values || []).map((v) => (Number.isFinite(v) ? v : null));
  const defined = clean.filter((v) => v != null);
  if (!defined.length) {
    return svgWrap(
      width,
      height,
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-muted">Pas de données</text>`,
      "Tendance quotidienne — pas de données"
    );
  }
  const max = Math.max(...defined);
  const min = Math.min(...defined);
  const range = max - min || 1;
  const padY = 6;
  const stepX = clean.length > 1 ? width / (clean.length - 1) : 0;
  const points = clean.map((v, i) => {
    if (v == null) return null;
    const x = i * stepX;
    const y = height - padY - ((v - min) / range) * (height - padY * 2);
    return [x, y];
  });
  const path = buildLinePath(points);
  const lastIndex = [...points].reverse().findIndex((p) => p != null);
  const last = lastIndex === -1 ? null : points[points.length - 1 - lastIndex];
  const marker = last
    ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="${color}" stroke="var(--chart-surface)" stroke-width="2" />`
    : "";
  const inner =
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` + marker;
  return svgWrap(width, height, inner, "Tendance quotidienne du mois");
}

/**
 * Barres horizontales (§12.2) : canaux, pages… `rows` = [{ label, value, color? }],
 * déjà triées par l'appelant. Barre ≤24px d'épaisseur, extrémité arrondie
 * 4px, piste neutre en fond, valeur en clair à droite de la barre (jamais
 * dans la couleur de la série — cf. anatomy « le texte ne porte jamais la
 * couleur de la donnée »).
 */
export function horizontalBars(rows, { width = 480, barThickness = 18, gap = 10, maxBars = 8, labelWidth = 150, valueWidth = 70 } = {}) {
  const data = (rows || []).slice(0, maxBars);
  if (!data.length) {
    return svgWrap(width, 40, `<text x="8" y="24" class="chart-muted">Pas de données</text>`, "Barres horizontales — pas de données");
  }
  const max = Math.max(1, ...data.map((r) => Number(r.value) || 0));
  const valueLabels = data.map((row) => row.valueLabel || formatChartNumber(Number(row.value) || 0));
  // Anti-débordement (même principe que funnel()) : si la valeur formatée est
  // plus large que l'espace réservé, on élargit plutôt que de laisser le
  // viewBox rogner le texte — le label, lui, reste hors barre depuis
  // toujours (troncature déjà calibrée sur labelWidth), donc pas concerné.
  const widestValue = Math.max(0, ...valueLabels.map((v) => estimateTextWidth(v)));
  const effectiveValueWidth = Math.max(valueWidth, widestValue + 16);
  const plotWidth = Math.max(20, width - labelWidth - effectiveValueWidth);
  const totalWidth = labelWidth + plotWidth + effectiveValueWidth;
  const rowHeight = barThickness + gap;
  const height = data.length * rowHeight;
  const rows_ = data
    .map((row, i) => {
      const y = i * rowHeight;
      const value = Number(row.value) || 0;
      const barWidth = Math.max(3, (value / max) * plotWidth);
      const color = row.color || `var(--chart-series-${(i % 8) + 1})`;
      const label = escapeXml(truncate(row.label, 24));
      const valueLabel = escapeXml(valueLabels[i]);
      return (
        `<g>` +
        `<title>${escapeXml(row.label)} : ${escapeXml(valueLabels[i])}</title>` +
        `<text x="0" y="${(y + barThickness / 2 + 4).toFixed(1)}" class="chart-label">${label}</text>` +
        `<rect x="${labelWidth}" y="${y}" width="${plotWidth}" height="${barThickness}" rx="4" class="chart-track" />` +
        `<rect x="${labelWidth}" y="${y}" width="${barWidth.toFixed(1)}" height="${barThickness}" rx="4" fill="${color}" />` +
        `<text x="${(labelWidth + plotWidth + 8).toFixed(1)}" y="${(y + barThickness / 2 + 4).toFixed(1)}" class="chart-value">${valueLabel}</text>` +
        `</g>`
      );
    })
    .join("");
  return svgWrap(totalWidth, height, rows_, "Barres horizontales");
}

const FUNNEL_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#184f95"]; // rampe ordinale bleue (steps 250/350/450/600, valide clair+sombre)

const FUNNEL_INNER_PADDING = 16; // marge intérieure (≈8px de chaque côté) pour juger qu'un libellé "tient" dans sa barre
const FUNNEL_BELOW_LINE_HEIGHT = 16; // ligne supplémentaire réservée quand le libellé sort de la barre

/**
 * Entonnoir d'achat (§12.2). `stages` = [{ label, value }] déjà dans l'ordre
 * (vue produit → panier → paiement → achat). Chaque barre affiche sa valeur
 * et le taux de passage depuis le stade précédent (déjà calculé par
 * `metrics.funnel`, ré-affiché ici pour lecture directe sur le graphique).
 *
 * Lisibilité (correction dédiée) : sur les stades bas de l'entonnoir, la
 * barre est trop étroite pour contenir son propre libellé — le texte
 * débordait alors du remplissage et n'était lisible qu'au survol. On estime
 * ici la largeur du texte (`estimateTextWidth`) ; s'il ne tient pas dans la
 * barre (avec marge), il est sorti et rendu **sous** la barre, en
 * `currentColor` (couleur de texte de la page, jamais dépendante du thème ni
 * du survol). La hauteur totale du SVG s'ajuste en conséquence pour qu'aucune
 * ligne ne chevauche ni ne soit rognée.
 */
export function funnel(stages, { width = 480, stageHeight = 40, gap = 6 } = {}) {
  const data = (stages || []).filter((s) => s && s.value != null);
  if (!data.length) {
    return svgWrap(width, 40, `<text x="8" y="24" class="chart-muted">Pas de données</text>`, "Entonnoir d'achat — pas de données");
  }
  const max = Math.max(1, ...data.map((s) => Number(s.value) || 0));

  const layout = data.map((stage, i) => {
    const value = Number(stage.value) || 0;
    const w = Math.max(6, (value / max) * width);
    const prev = data[i - 1];
    const pct = prev && prev.value ? share(value, prev.value) : null;
    const shortPctLabel = pct != null ? ` (${pct.toFixed(0)} %)` : "";
    const tooltipPctLabel = pct != null ? ` (${pct.toFixed(0)} % du stade précédent)` : "";
    const label = `${stage.label} — ${formatChartNumber(value)}${shortPctLabel}`;
    const fits = estimateTextWidth(label) <= w - FUNNEL_INNER_PADDING;
    return { stage, value, w, tooltipPctLabel, label, fits };
  });

  const height = layout.reduce((sum, s) => sum + stageHeight + (s.fits ? 0 : FUNNEL_BELOW_LINE_HEIGHT), 0) + (data.length - 1) * gap;

  let y = 0;
  const parts = layout.map(({ stage, value, w, tooltipPctLabel, label, fits }, i) => {
    const x = (width - w) / 2;
    const color = FUNNEL_RAMP[Math.min(i, FUNNEL_RAMP.length - 1)];
    const textColor = textColorOnFill(color);
    const insideText = fits
      ? `<text x="${(width / 2).toFixed(1)}" y="${(y + stageHeight / 2 + 4).toFixed(1)}" text-anchor="middle" fill="${textColor}" class="chart-value-on-fill">${escapeXml(label)}</text>`
      : "";
    const belowText = fits
      ? ""
      : `<text x="${(width / 2).toFixed(1)}" y="${(y + stageHeight + FUNNEL_BELOW_LINE_HEIGHT - 4).toFixed(1)}" text-anchor="middle" fill="currentColor" class="chart-value-below">${escapeXml(label)}</text>`;
    const g =
      `<g><title>${escapeXml(stage.label)} : ${escapeXml(formatChartNumber(value))}${escapeXml(tooltipPctLabel)}</title>` +
      `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${stageHeight}" rx="4" fill="${color}" />` +
      insideText +
      belowText +
      `</g>`;
    y += stageHeight + (fits ? 0 : FUNNEL_BELOW_LINE_HEIGHT) + gap;
    return g;
  });
  return svgWrap(width, height, parts.join(""), "Entonnoir d'achat");
}

/**
 * Jauge KPI (§12.2) : barre de progression colorée selon la position de
 * `deltaPct` par rapport aux seuils `green`/`warn` de config/kpi-targets.json
 * (§ colorisation des tuiles). `direction` = "up" (une hausse est positive) ou
 * "down" (une baisse est positive, ex. bounceRate). `deltaPct === null` →
 * jauge neutre « n/d » (garde-fou de significativité, §9).
 */
export function kpiGauge(deltaPct, { direction = "up", green = 0, warn = -10, width = 120, height = 10 } = {}) {
  if (deltaPct == null) {
    return svgWrap(
      width,
      height + 4,
      `<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" class="chart-track" />` +
        `<text x="${width / 2}" y="${height + 12}" text-anchor="middle" class="chart-muted" font-size="9">n/d</text>`,
      "Variation — volume insuffisant pour conclure"
    );
  }
  const normalized = direction === "down" ? -deltaPct : deltaPct;
  const normGreen = direction === "down" ? -green : green;
  const normWarn = direction === "down" ? -warn : warn;
  const zone = normalized >= normGreen ? "good" : normalized >= normWarn ? "warn" : "critical";
  const color = zone === "good" ? "var(--chart-good)" : zone === "warn" ? "var(--chart-warn-fill)" : "var(--chart-critical)";
  // Échelle bornée entre (warn - un tiers d'écart) et (green + un tiers d'écart au-delà) pour donner une lecture visuelle relative, sans prétendre à une échelle absolue.
  const spread = Math.max(Math.abs(normGreen - normWarn), 1) * 1.5;
  const lo = normWarn - spread / 3;
  const hi = normGreen + spread;
  const clamped = Math.min(hi, Math.max(lo, normalized));
  const fillRatio = Math.min(1, Math.max(0, (clamped - lo) / (hi - lo)));
  const fillWidth = Math.max(2, fillRatio * width);
  const inner =
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" class="chart-track" />` +
    `<rect x="0" y="0" width="${fillWidth.toFixed(1)}" height="${height}" rx="${height / 2}" fill="${color}" />`;
  return svgWrap(width, height, inner, `Variation ${deltaPct >= 0 ? "+" : ""}${decimalFormatter.format(deltaPct)}%`);
}
