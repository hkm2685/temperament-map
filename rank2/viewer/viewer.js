// http://localhost:8000/viewer/
// python -m http.server 8000 --directory rank2

"use strict";

const MAPS_DIR = "../temperament_maps";
const XENWIKI_BASE_URL = "https://en.xen.wiki/w/";
const CATALOG_URL = `${MAPS_DIR}/maps_index.json`;
const GROUP_KEY_TOLERANCE = 1e-4;
const FEATURED_PERIOD_MAPS = [
  { key: 1, label: "octave" },
  { key: 0.5, label: "half-octave" },
  { key: 1 / 3, label: "third-octave" },
  { key: Math.log2(3), label: "tritave" },
];

function groupKeyMatches(groupKey, targetKey) {
  return Math.abs(groupKey - targetKey) < GROUP_KEY_TOLERANCE;
}

function featuredPeriodLabel(groupKey) {
  const period = FEATURED_PERIOD_MAPS.find((entry) => groupKeyMatches(groupKey, entry.key));
  return period ? period.label : null;
}

function featuredCatalogMaps(maps) {
  return FEATURED_PERIOD_MAPS.map((period) =>
    maps.find((entry) => groupKeyMatches(entry.group_key, period.key))
  ).filter(Boolean);
}

const mapSelect = document.getElementById("map-select");
const mapHint = document.getElementById("map-hint");
const mapHost = document.getElementById("map-host");
const scrollTrack = document.getElementById("scroll-track");
const scrollport = document.getElementById("scrollport");
const zoomInButton = document.getElementById("zoom-in");
const zoomOutButton = document.getElementById("zoom-out");
const zoomResetButton = document.getElementById("zoom-reset");
const zoomLevelLabel = document.getElementById("zoom-level");

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.15;
const SVG_NS = "http://www.w3.org/2000/svg";
const HINT_REFERENCE_WIDTH = 699;
const MAP_HINT_FONT_SIZE = 8;
const MAP_HINT_LINE_HEIGHT = 8;
const MAP_HINT_PADDING_TOP = 8;
const MAP_HINT_PADDING_BOTTOM = 0;
const MAP_HINT_BLOCK_WIDTH_RATIO = 0.88;
const MAP_HINT_TEXT =
  "The left half of this graphic displays the ratios you reach from stacking a generator (where y-position corresponds to generator size) some number of times "
  + "(increasing left to right). For example, the leftmost column marks the ratios corresponding to the generator, the next column from the left marks the ratios corresponding to a stack of two generators, etc. The right half of the graphic marks temperaments at each generator (with reduced mapping and badness). "
  + "Hover over a temperament to highlight its mapping. Click one to go to the Xen Wiki technical page. "
  + "Click the left region to see MOS scale sizes, which can be clicked for Scale Workshop links.";

let manifest = null;
let cachedMapSize = null;
let cachedHintLayout = null;
let zoom = 1;
let pendingZoomWheel = null;
let zoomWheelFrame = null;
let hoveredTemperament = null;
let pointerCrosshairCents = null;
let mosAnchorSvgY = null;
let crosshairLayer = null;
let crosshairLineEl = null;
let countHitArea = null;
let suppressCountHitAreaLeave = false;
let crosshairRaf = null;
let pointerFrameRaf = null;
let mosDismissRaf = null;
let pendingPointerClient = null;
let pendingMosPointer = null;
let viewportFrame = null;

const CROSSHAIR_COLOR = "#cc0000";
const CROSSHAIR_LABEL_PAD_X = 2;
const CROSSHAIR_LABEL_PAD_Y = 1.5;
const MOS_CIRCLE_RADIUS = 5;
const MOS_Y_CLEAR_THRESHOLD_PX = 24;
const TICK_LABEL_OFFSET_X = 9;
const TICK_HASH_WIDTH = 6;
const TICK_LABEL_BASELINE_OFFSET_Y = 2.5;
const TICK_LABEL_FONT_SIZE = 7;
const TEMPERAMENT_NORMAL_FONT_SIZE = 8;
const HIGHLIGHT_STROKE = "#000000";
const HIGHLIGHT_STROKE_WIDTH = 1.2;

function sy(manifestData, cents) {
  const { top, plot_height } = manifestData.layout;
  const yMax = manifestData.y_max;
  if (yMax <= 0) {
    return top + plot_height;
  }
  return top + ((yMax - cents) / yMax) * plot_height;
}

function sxCount(manifestData, count) {
  const { count_start_x, count_step } = manifestData.layout;
  return count_start_x + (count - 1) * count_step;
}

function axisX(manifestData) {
  return manifestData.layout.axis_x ?? manifestData.layout.count_start_x - manifestData.layout.count_step;
}

function tickLabelX(manifestData) {
  const offset = manifestData.layout.tick_label_offset_x ?? TICK_LABEL_OFFSET_X;
  return axisX(manifestData) - offset;
}

function tickHashLeft(manifestData) {
  const hashWidth = manifestData.layout.tick_hash_width ?? TICK_HASH_WIDTH;
  return axisX(manifestData) - hashWidth;
}

function tickLabelBaselineOffset(manifestData) {
  return manifestData.layout.tick_label_baseline_offset_y ?? TICK_LABEL_BASELINE_OFFSET_Y;
}

function tickLabelFontSize(manifestData) {
  return manifestData.layout.tick_label_font_size ?? TICK_LABEL_FONT_SIZE;
}

function countRegionLeft(manifestData) {
  return manifestData.layout.count_start_x - manifestData.layout.count_step / 2;
}

function countRegionRight(manifestData) {
  return (
    manifestData.layout.count_start_x
    + (manifestData.max_count - 1) * manifestData.layout.count_step
    + manifestData.layout.count_step / 2
  );
}

function roundCentsToTwoDecimals(value) {
  return Math.round(value * 100) / 100;
}

function formatCents(value) {
  return roundCentsToTwoDecimals(value).toFixed(2);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getSvgDimensions(svg) {
  return {
    width: Number(svg.getAttribute("width")) || svg.viewBox.baseVal.width,
    height: Number(svg.getAttribute("height")) || svg.viewBox.baseVal.height,
  };
}

function updateZoomLabel() {
  zoomLevelLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function hintOffset() {
  return mapHint?.offsetHeight ?? 0;
}

function hintTextBlock() {
  const blockWidth = HINT_REFERENCE_WIDTH * MAP_HINT_BLOCK_WIDTH_RATIO;
  const textX = (HINT_REFERENCE_WIDTH - blockWidth) / 2;
  return { textX, blockWidth };
}

function computeHintLayout() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${MAP_HINT_FONT_SIZE}px Arial, sans-serif`;

  const { textX, blockWidth } = hintTextBlock();
  const words = MAP_HINT_TEXT.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > blockWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }

  const height = MAP_HINT_PADDING_TOP + MAP_HINT_PADDING_BOTTOM + lines.length * MAP_HINT_LINE_HEIGHT;
  return { textX, lines, height };
}

function renderMapHint() {
  if (cachedHintLayout && mapHint.querySelector("svg")) {
    return cachedHintLayout.height;
  }

  cachedHintLayout = computeHintLayout();
  const { textX, lines, height } = cachedHintLayout;
  mapHint.replaceChildren();

  const hintSvg = document.createElementNS(SVG_NS, "svg");
  hintSvg.setAttribute("class", "map-hint-svg");

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = "text { font-family: Arial, sans-serif; }";
  hintSvg.appendChild(style);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(textX));
  text.setAttribute("y", String(MAP_HINT_PADDING_TOP));
  text.setAttribute("text-anchor", "start");
  text.setAttribute("dominant-baseline", "hanging");
  text.setAttribute("font-size", String(MAP_HINT_FONT_SIZE));
  text.setAttribute("fill", "#000000");

  for (const [index, line] of lines.entries()) {
    const tspan = document.createElementNS(SVG_NS, "tspan");
    tspan.setAttribute("x", String(textX));
    if (index > 0) {
      tspan.setAttribute("dy", String(MAP_HINT_LINE_HEIGHT));
    }
    tspan.textContent = line;
    text.appendChild(tspan);
  }

  hintSvg.appendChild(text);
  mapHint.appendChild(hintSvg);
  return height;
}

function horizontalCenteringMetrics(displayW) {
  const lastCountPx = sxCount(manifest, manifest.max_count) * zoom;
  const hintDisplayW = HINT_REFERENCE_WIDTH * zoom;
  const viewportCenter = scrollport.clientWidth / 2;

  let mapMarginLeft = Math.max(0, viewportCenter - lastCountPx);
  let scrollLeft = Math.max(0, lastCountPx - viewportCenter);
  let hintMarginLeft = scrollLeft + viewportCenter - hintDisplayW / 2;

  const minLeft = Math.min(mapMarginLeft, hintMarginLeft);
  if (minLeft < 0) {
    const pad = -minLeft;
    mapMarginLeft += pad;
    hintMarginLeft += pad;
    scrollLeft += pad;
  }

  const trackWidth = Math.max(
    scrollport.clientWidth,
    mapMarginLeft + displayW,
    hintMarginLeft + hintDisplayW
  );
  return { mapMarginLeft, hintMarginLeft, scrollLeft, trackWidth };
}

function updateHintLayout(hintMarginLeft) {
  const height = renderMapHint();
  const hintSvg = mapHint.querySelector("svg");
  const hintDisplayW = HINT_REFERENCE_WIDTH * zoom;
  const hintDisplayH = height * zoom;
  hintSvg.setAttribute("width", String(hintDisplayW));
  hintSvg.setAttribute("height", String(hintDisplayH));
  hintSvg.setAttribute("viewBox", `0 0 ${HINT_REFERENCE_WIDTH} ${height}`);
  mapHint.style.width = `${hintDisplayW}px`;
  mapHint.style.marginLeft = `${hintMarginLeft}px`;
  mapHint.style.marginRight = "0";
}

function viewMetrics() {
  const { width, height } = cachedMapSize;
  return {
    width,
    height,
    displayW: width * zoom,
    displayH: height * zoom,
  };
}

function mapScales() {
  const { width, height, displayW, displayH } = viewMetrics();
  return {
    scaleX: displayW / width,
    scaleY: displayH / height,
  };
}

function captureViewportFrame(svg) {
  viewportFrame = {
    rect: svg.getBoundingClientRect(),
  };
  return viewportFrame;
}

function svgPointFromClient(clientX, clientY) {
  const { width, height } = cachedMapSize;
  const { rect } = viewportFrame;
  return {
    x: ((clientX - rect.left) / rect.width) * width,
    y: ((clientY - rect.top) / rect.height) * height,
  };
}

function applyZoomLayout() {
  const svg = mapHost.querySelector("svg");
  if (!svg || !cachedMapSize) {
    return;
  }

  const { width, height, displayW, displayH } = viewMetrics();
  const { mapMarginLeft, hintMarginLeft, scrollLeft, trackWidth } =
    horizontalCenteringMetrics(displayW);
  updateHintLayout(hintMarginLeft);
  scrollTrack.style.width = `${trackWidth}px`;
  scrollTrack.style.height = `${hintOffset() + displayH}px`;
  mapHost.style.width = `${displayW}px`;
  mapHost.style.height = `${displayH}px`;
  mapHost.style.marginLeft = `${mapMarginLeft}px`;
  mapHost.style.marginRight = "0";
  svg.setAttribute("width", String(displayW));
  svg.setAttribute("height", String(displayH));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  scrollport.scrollLeft = scrollLeft;
  viewportFrame = null;
  updateOverlayLayout();
  updateZoomLabel();
  if (pointerCrosshairCents != null || hoveredTemperament) {
    scheduleCrosshairUpdate();
  }
}

function zoomAt(clientX, clientY, nextZoom) {
  const svg = mapHost.querySelector("svg");
  if (!svg || !cachedMapSize) {
    return;
  }

  const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
  if (clampedZoom === zoom) {
    return;
  }

  captureViewportFrame(svg);
  const anchor = svgPointFromClient(clientX, clientY);
  const scrollportRect = scrollport.getBoundingClientRect();

  zoom = clampedZoom;
  applyZoomLayout();
  scrollport.scrollTop = hintOffset() + anchor.y * zoom - (clientY - scrollportRect.top);
}

function resetZoom() {
  zoom = 1;
  scrollport.scrollTop = 0;
  applyZoomLayout();
}

function handleZoomWheel(event) {
  if (!event.ctrlKey || !cachedMapSize) {
    return;
  }

  event.preventDefault();
  const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const currentTarget = pendingZoomWheel?.targetZoom ?? zoom;
  pendingZoomWheel = {
    clientX: event.clientX,
    clientY: event.clientY,
    targetZoom: clamp(currentTarget * factor, ZOOM_MIN, ZOOM_MAX),
  };

  if (zoomWheelFrame) {
    return;
  }

  zoomWheelFrame = requestAnimationFrame(() => {
    zoomWheelFrame = null;
    const pending = pendingZoomWheel;
    pendingZoomWheel = null;
    if (pending) {
      zoomAt(pending.clientX, pending.clientY, pending.targetZoom);
    }
  });
}

function svgPointFromEvent(svg, event) {
  const svgPoint = svg.createSVGPoint();
  svgPoint.x = event.clientX;
  svgPoint.y = event.clientY;
  return svgPoint.matrixTransform(svg.getScreenCTM().inverse());
}

function centsFromSvgY(manifestData, svgY) {
  const { top, plot_height } = manifestData.layout;
  const yMax = manifestData.y_max;
  if (plot_height <= 0) {
    return 0;
  }
  const clamped = Math.min(Math.max(svgY, top), top + plot_height);
  return yMax * (1 - (clamped - top) / plot_height);
}

function findClosestByYCents(nodes, sourceY) {
  let closest = null;
  let closestDistance = Infinity;
  for (const node of nodes) {
    const markerY = Number(node.getAttribute("data-y-cents"));
    if (!Number.isFinite(markerY)) {
      continue;
    }
    const distance = Math.abs(markerY - sourceY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = node;
    }
  }
  return closest;
}

function findClosestMarkerPolygon(svg, count, sourceY, { prime = null, interval = null } = {}) {
  const selector =
    prime != null
      ? `polygon.marker[data-count="${count}"][data-prime="${prime}"]`
      : `polygon.marker[data-count="${count}"][data-label="${interval}"]`;
  return findClosestByYCents(svg.querySelectorAll(selector), sourceY);
}

function ensureHighlightOverlay(svg) {
  let overlay = svg.querySelector("#highlight-overlay");
  if (!overlay) {
    overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
    overlay.setAttribute("id", "highlight-overlay");
    overlay.setAttribute("pointer-events", "none");
    svg.appendChild(overlay);
  }
  return overlay;
}

function clearSyntheticHighlights(svg) {
  const overlay = svg.querySelector("#highlight-overlay");
  if (overlay) {
    overlay.replaceChildren();
  }
}

function ratioLabelToCents(label) {
  const ratio = label.includes("/")
    ? Number(label.split("/", 2)[0]) / Number(label.split("/", 2)[1])
    : Number(label);
  return 1200 * Math.log2(ratio);
}

function solutionsForInterval(count, intervalCents, gCents) {
  const yMax = gCents / 2;
  const kMin = Math.ceil(-intervalCents / gCents - 1e-12);
  const kMax = Math.floor((count * yMax - intervalCents) / gCents + 1e-12);
  const solutions = [];
  for (let k = kMin; k <= kMax; k += 1) {
    const y = (intervalCents + k * gCents) / count;
    if (y >= -1e-9 && y <= yMax + 1e-9) {
      solutions.push(Math.min(Math.max(y, 0), yMax));
    }
  }
  return solutions;
}

function closestIntervalYCents(count, intervalLabel, sourceY, gCents) {
  const solutions = solutionsForInterval(count, ratioLabelToCents(intervalLabel), gCents);
  if (!solutions.length) {
    return sourceY;
  }
  let closest = solutions[0];
  let closestDistance = Math.abs(closest - sourceY);
  for (const y of solutions.slice(1)) {
    const distance = Math.abs(y - sourceY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = y;
    }
  }
  return closest;
}

function intervalLabelFromMappingTarget(mappingTarget) {
  if (mappingTarget.interval) {
    return mappingTarget.interval;
  }
  return String(mappingTarget.prime);
}

function syntheticRatioTrianglePoints(count, yCents) {
  const x = sxCount(manifest, count);
  const countStep = manifest.layout.count_step;
  const halfCents = manifest.triangle_cent_half_width / count;
  const yTop = sy(manifest, yCents + halfCents);
  const yCenter = sy(manifest, yCents);
  const yBottom = sy(manifest, yCents - halfCents);
  const tipX = x + countStep / 2;
  return `${x.toFixed(3)},${yTop.toFixed(3)} ${tipX.toFixed(3)},${yCenter.toFixed(3)} ${x.toFixed(3)},${yBottom.toFixed(3)}`;
}

function parsePolygonPoints(pointsAttr) {
  return pointsAttr.trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x, y };
  });
}

function formatPolygonPoints(vertices) {
  return vertices.map((vertex) => `${vertex.x.toFixed(3)},${vertex.y.toFixed(3)}`).join(" ");
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function outsetPolygonVertex(previous, current, next, distance) {
  const edgeIn = normalizeVector({ x: current.x - previous.x, y: current.y - previous.y });
  const edgeOut = normalizeVector({ x: next.x - current.x, y: next.y - current.y });
  const normalIn = { x: edgeIn.y, y: -edgeIn.x };
  const normalOut = { x: edgeOut.y, y: -edgeOut.x };
  const bisector = normalizeVector({ x: normalIn.x + normalOut.x, y: normalIn.y + normalOut.y });
  const alignment = bisector.x * normalIn.x + bisector.y * normalIn.y;
  const offset = alignment === 0 ? distance : distance / alignment;
  return {
    x: current.x + bisector.x * offset,
    y: current.y + bisector.y * offset,
  };
}

function outsetPolygon(vertices, distance) {
  const count = vertices.length;
  return vertices.map((current, index) => {
    const previous = vertices[(index - 1 + count) % count];
    const next = vertices[(index + 1) % count];
    return outsetPolygonVertex(previous, current, next, distance);
  });
}

function addTriangleOutlineHighlight(svg, pointsAttr) {
  const outlineVertices = outsetPolygon(parsePolygonPoints(pointsAttr), HIGHLIGHT_STROKE_WIDTH / 2);
  const polygon = document.createElementNS(SVG_NS, "polygon");
  polygon.setAttribute("class", "marker-highlight-outline");
  polygon.setAttribute("points", formatPolygonPoints(outlineVertices));
  polygon.setAttribute("fill", "none");
  polygon.setAttribute("stroke", HIGHLIGHT_STROKE);
  polygon.setAttribute("stroke-width", String(HIGHLIGHT_STROKE_WIDTH));
  ensureHighlightOverlay(svg).appendChild(polygon);
}

function clearMarkerHighlights(svg) {
  svg.querySelectorAll(".marker.highlight").forEach((node) => node.classList.remove("highlight"));
  clearSyntheticHighlights(svg);
}

function highlightClosestMappingMarker(svg, count, sourceY, mappingTarget) {
  const domMarker = findClosestMarkerPolygon(svg, count, sourceY, mappingTarget);
  const points = domMarker
    ? domMarker.getAttribute("points")
    : syntheticRatioTrianglePoints(
        count,
        closestIntervalYCents(
          count,
          intervalLabelFromMappingTarget(mappingTarget),
          sourceY,
          manifest.g_cents
        )
      );
  addTriangleOutlineHighlight(svg, points);
  return true;
}

function isHighlightableMappingEntry(entry) {
  return Math.abs(entry.count) <= manifest.max_count;
}

function reciprocalIntervalLabel(label) {
  if (label.includes("/")) {
    const [numerator, denominator] = label.split("/", 2);
    return `${denominator}/${numerator}`;
  }
  return `1/${label}`;
}

function mappingHighlightTarget(entry) {
  if (entry.prime != null) {
    return entry.count < 0
      ? { interval: reciprocalIntervalLabel(String(entry.prime)) }
      : { prime: entry.prime };
  }

  if (!entry.interval) {
    return null;
  }

  return entry.count < 0
    ? { interval: reciprocalIntervalLabel(entry.interval) }
    : { interval: entry.interval };
}

function countUnhighlightableMappings(temp) {
  return temp.mapping.filter((entry) => !isHighlightableMappingEntry(entry)).length;
}

function applyTemperamentHighlights(svg, temp) {
  for (const entry of temp.mapping) {
    if (!isHighlightableMappingEntry(entry)) {
      continue;
    }

    const mappingTarget = mappingHighlightTarget(entry);
    if (!mappingTarget) {
      continue;
    }

    highlightClosestMappingMarker(svg, Math.abs(entry.count), temp.source_y, mappingTarget);
  }
}

function ensureHtmlCrosshair() {
  if (crosshairLayer) {
    return;
  }

  crosshairLayer = document.createElement("div");
  crosshairLayer.id = "crosshair-layer";
  crosshairLineEl = document.createElement("div");
  crosshairLineEl.className = "crosshair-line-html";
  crosshairLayer.appendChild(crosshairLineEl);
  mapHost.appendChild(crosshairLayer);
}

function clearCrosshairSvg(svg) {
  const overlay = svg?.querySelector("#crosshair-overlay");
  if (overlay) {
    overlay.replaceChildren();
  }
}

function renderCrosshairSvgLabel(svg, cents, svgY) {
  const overlay = svg.querySelector("#crosshair-overlay");
  if (!overlay) {
    return;
  }

  overlay.replaceChildren();

  const labelX = tickLabelX(manifest);
  const labelBaselineY = svgY + tickLabelBaselineOffset(manifest);
  const fontSize = tickLabelFontSize(manifest);
  const padX = manifest.layout.crosshair_label_pad_x ?? CROSSHAIR_LABEL_PAD_X;
  const padY = manifest.layout.crosshair_label_pad_y ?? CROSSHAIR_LABEL_PAD_Y;

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("class", "crosshair-label-bg");
  background.setAttribute("x", "0");
  background.setAttribute("y", String(labelBaselineY - fontSize + padY));
  background.setAttribute("width", String(labelX + padX));
  background.setAttribute("height", String(fontSize + padY));
  background.setAttribute("fill", "#ffffff");

  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("class", "crosshair-label");
  label.setAttribute("x", String(labelX));
  label.setAttribute("y", String(labelBaselineY));
  label.setAttribute("text-anchor", "end");
  label.setAttribute("font-size", String(fontSize));
  label.setAttribute("fill", CROSSHAIR_COLOR);
  label.textContent = formatCents(cents);

  overlay.appendChild(background);
  overlay.appendChild(label);
}

function resetViewportChrome() {
  crosshairLayer = null;
  crosshairLineEl = null;
  countHitArea = null;
  viewportFrame = null;
}

function clearCrosshair() {
  if (crosshairLayer) {
    crosshairLayer.style.display = "none";
  }
  clearCrosshairSvg(mapHost.querySelector("svg"));
}

function ensureCountHitArea() {
  if (countHitArea) {
    return;
  }

  countHitArea = document.createElement("div");
  countHitArea.id = "count-hit-area";
  countHitArea.addEventListener("mousemove", handleCountHitAreaMove);
  countHitArea.addEventListener("mouseleave", handleCountHitAreaLeave);
  countHitArea.addEventListener("click", handleCountHitAreaClick);
  mapHost.appendChild(countHitArea);
}

function mosCircleAtClient(clientX, clientY) {
  if (!countHitArea) {
    return null;
  }

  suppressCountHitAreaLeave = true;
  countHitArea.style.pointerEvents = "none";
  const target = document.elementFromPoint(clientX, clientY);
  countHitArea.style.pointerEvents = "auto";
  suppressCountHitAreaLeave = false;
  return target?.closest?.(".mos-circle") ?? null;
}

function updateOverlayLayout() {
  const { scaleX } = mapScales();
  ensureCountHitArea();
  countHitArea.style.left = `${countRegionLeft(manifest) * scaleX}px`;
  countHitArea.style.width = `${(countRegionRight(manifest) - countRegionLeft(manifest)) * scaleX}px`;
  ensureHtmlCrosshair();
}

function handleCountHitAreaMove(event) {
  schedulePointerFrame(event.clientX, event.clientY);
}

function handleCountHitAreaLeave() {
  if (suppressCountHitAreaLeave) {
    return;
  }

  pointerCrosshairCents = null;
  scheduleCrosshairUpdate();
  const svg = mapHost.querySelector("svg");
  if (svg && mosAnchorSvgY != null) {
    dismissMosOverlay(svg);
  }
}

function handleCountHitAreaClick(event) {
  event.stopPropagation();
  const svg = mapHost.querySelector("svg");
  if (!svg) {
    return;
  }
  if (!viewportFrame) {
    captureViewportFrame(svg);
  }

  const mosCircle = mosCircleAtClient(event.clientX, event.clientY);
  if (mosCircle) {
    window.open(mosCircle.getAttribute("href"), "_blank", "noopener");
    return;
  }

  const generatorCents = centsFromSvgY(manifest, svgPointFromClient(event.clientX, event.clientY).y);
  pointerCrosshairCents = generatorCents;
  clearHighlights(svg);
  scheduleCrosshairUpdate();
  renderMosOverlay(svg, generatorCents);
}

function schedulePointerFrame(clientX, clientY) {
  pendingPointerClient = { x: clientX, y: clientY };
  if (pointerFrameRaf) {
    return;
  }

  pointerFrameRaf = requestAnimationFrame(() => {
    pointerFrameRaf = null;
    const svg = mapHost.querySelector("svg");
    const pointer = pendingPointerClient;
    pendingPointerClient = null;
    if (!svg || !pointer) {
      return;
    }

    captureViewportFrame(svg);
    const mapped = svgPointFromClient(pointer.x, pointer.y);
    pointerCrosshairCents = centsFromSvgY(manifest, mapped.y);
    updateCrosshair(svg);
    if (mosAnchorSvgY != null) {
      updateMosDismissalFast(svg, pointer.x, pointer.y);
    }
  });
}

function showCrosshair(svg, cents) {
  ensureHtmlCrosshair();
  const { scaleX, scaleY } = mapScales();
  const svgY = sy(manifest, cents);
  const lineLeft = tickHashLeft(manifest);
  const top = svgY * scaleY;
  const left = lineLeft * scaleX;
  const width = (countRegionRight(manifest) - lineLeft) * scaleX;

  crosshairLayer.style.display = "block";
  crosshairLineEl.style.top = `${top}px`;
  crosshairLineEl.style.left = `${left}px`;
  crosshairLineEl.style.width = `${width}px`;
  renderCrosshairSvgLabel(svg, cents, svgY);
}

function updateCrosshair(svg) {
  if (hoveredTemperament) {
    showCrosshair(svg, hoveredTemperament.source_y);
    return;
  }
  if (pointerCrosshairCents != null) {
    showCrosshair(svg, pointerCrosshairCents);
    return;
  }
  clearCrosshair();
}

function scheduleCrosshairUpdate() {
  if (crosshairRaf) {
    return;
  }

  crosshairRaf = requestAnimationFrame(() => {
    crosshairRaf = null;
    const svg = mapHost.querySelector("svg");
    if (svg) {
      updateCrosshair(svg);
    }
  });
}

function parseLeaderLinePoints(polyline) {
  return polyline
    .getAttribute("points")
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
}

function ensureLeaderHighlightOverlay(svg) {
  let overlay = svg.querySelector("#leader-highlight-overlay");
  if (!overlay) {
    overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
    overlay.setAttribute("id", "leader-highlight-overlay");
    overlay.setAttribute("pointer-events", "none");
    svg.appendChild(overlay);
  }
  return overlay;
}

function clearLeaderLineHighlight(svg) {
  const overlay = svg.querySelector("#leader-highlight-overlay");
  if (overlay) {
    overlay.replaceChildren();
  }
  svg.querySelectorAll(".leader-line.hover").forEach((line) => line.classList.remove("hover"));
}

function appendUnmappedLeaderIndicator(overlay, p0, p1, unmappedCount) {
  const leftRegionEnd = p0.x + ((p1.x - p0.x) * 2) / 3;
  const centerX = (p0.x + leftRegionEnd) / 2;
  const centerY = p0.y;
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "leader-unmapped-indicator");

  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", (centerX - 8).toFixed(3));
  text.setAttribute("y", centerY.toFixed(3));
  text.setAttribute("font-size", String(TEMPERAMENT_NORMAL_FONT_SIZE));
  text.setAttribute("font-weight", "bold");
  text.setAttribute("fill", "#000000");
  text.setAttribute("text-anchor", "end");
  text.setAttribute("dominant-baseline", "middle");
  text.textContent = `+${unmappedCount}`;

  const triangleWidth = 5;
  const triangleHeight = 12;
  const triangleBaseX = centerX - 3;
  const triangle = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  triangle.setAttribute(
    "points",
    `${triangleBaseX.toFixed(3)},${(centerY - triangleHeight / 2).toFixed(3)} `
      + `${(triangleBaseX + triangleWidth).toFixed(3)},${centerY.toFixed(3)} `
      + `${triangleBaseX.toFixed(3)},${(centerY + triangleHeight / 2).toFixed(3)}`
  );
  triangle.setAttribute("fill", "#dddddd");
  triangle.setAttribute("stroke", HIGHLIGHT_STROKE);
  triangle.setAttribute("stroke-width", String(HIGHLIGHT_STROKE_WIDTH));

  group.appendChild(text);
  group.appendChild(triangle);
  overlay.appendChild(group);
}

function setLeaderLineHighlight(svg, temperamentId, temp) {
  clearLeaderLineHighlight(svg);
  if (!temp) {
    return;
  }

  const polyline = svg.querySelector(
    `.leader-line[data-temperament-id="${CSS.escape(temperamentId)}"]`
  );
  if (!polyline) {
    return;
  }

  const [p0, p1, p2] = parseLeaderLinePoints(polyline);
  const unmappedCount = countUnhighlightableMappings(temp);
  if (unmappedCount === 0) {
    polyline.classList.add("hover");
    return;
  }

  const overlay = ensureLeaderHighlightOverlay(svg);
  const splitX = p0.x + ((p1.x - p0.x) * 2) / 3;
  const highlightedLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  highlightedLine.setAttribute(
    "points",
    `${splitX.toFixed(3)},${p0.y.toFixed(3)} ${p1.x.toFixed(3)},${p1.y.toFixed(3)} ${p2.x.toFixed(3)},${p2.y.toFixed(3)}`
  );
  highlightedLine.setAttribute("fill", "none");
  highlightedLine.setAttribute("stroke", "#000");
  highlightedLine.setAttribute("stroke-width", "0.8");
  highlightedLine.setAttribute("opacity", "1");
  overlay.appendChild(highlightedLine);
  appendUnmappedLeaderIndicator(overlay, p0, p1, unmappedCount);
}

function clearHighlights(svg) {
  if (hoveredTemperament) {
    setLeaderLineHighlight(svg, hoveredTemperament.id, null);
  }
  hoveredTemperament = null;
  clearMarkerHighlights(svg);
  svg.querySelectorAll(".temperament.hover").forEach((node) => node.classList.remove("hover"));
  updateCrosshair(svg);
}

function highlightTemperament(svg, temp) {
  if (hoveredTemperament) {
    setLeaderLineHighlight(svg, hoveredTemperament.id, null);
  }
  hoveredTemperament = temp;
  clearMarkerHighlights(svg);
  svg.querySelectorAll(".temperament.hover").forEach((node) => node.classList.remove("hover"));

  applyTemperamentHighlights(svg, temp);
  for (const textNode of svg.querySelectorAll(`[data-temperament-id="${CSS.escape(temp.id)}"]`)) {
    textNode.classList.add("hover");
  }
  setLeaderLineHighlight(svg, temp.id, temp);
  updateCrosshair(svg);
}

function isMos(scaleSize, generatorCents, periodCents) {
  if (scaleSize < 3 || periodCents <= 0) {
    return false;
  }
  const pitches = [...new Set(Array.from({ length: scaleSize }, (_, index) => (index * generatorCents) % periodCents))].sort(
    (left, right) => left - right
  );
  if (pitches.length < 2) {
    return false;
  }
  const steps = [];
  for (let index = 0; index < pitches.length - 1; index += 1) {
    steps.push(pitches[index + 1] - pitches[index]);
  }
  steps.push(periodCents - pitches[pitches.length - 1] + pitches[0]);
  const rounded = new Set(steps.map((step) => Math.round(step * 10000) / 10000));
  return rounded.size <= 2;
}

function mosSizes(generatorCents, periodCents, maxSize) {
  const sizes = [];
  for (let size = 3; size <= maxSize; size += 1) {
    if (isMos(size, generatorCents, periodCents)) {
      sizes.push(size);
    }
  }
  return sizes;
}

function mosScaleCents(scaleSize, generatorCents, periodCents) {
  return Array.from({ length: scaleSize }, (_, index) => (index * generatorCents) % periodCents).sort(
    (left, right) => left - right
  );
}

function formatScaleWorkshopCentsLine(cents) {
  const rounded = roundCentsToTwoDecimals(cents);
  return Number.isInteger(rounded) ? `${rounded}.` : String(rounded);
}

function formatGeneratorCentsForTitle(cents) {
  return String(roundCentsToTwoDecimals(cents));
}

function mosScaleWorkshopPeriodSuffix(groupKey) {
  const label = featuredPeriodLabel(groupKey);
  if (!label) {
    return "";
  }
  if (label === "octave") {
    return "";
  }
  if (label === "tritave") {
    return " with tritave period";
  }
  return ` with ${label} period`;
}

function mosScaleWorkshopName(scaleSize, generatorCents, groupKey) {
  let name = `${scaleSize}-note MOS generated by ${formatGeneratorCentsForTitle(generatorCents)}c`;
  name += mosScaleWorkshopPeriodSuffix(groupKey);
  return name;
}

function mosScaleWorkshopData(scaleSize, generatorCents, periodCents) {
  const pitchLines = mosScaleCents(scaleSize, generatorCents, periodCents)
    .filter((value) => value > 1e-9)
    .map((value) => formatScaleWorkshopCentsLine(value));
  pitchLines.push(formatScaleWorkshopCentsLine(periodCents));
  return pitchLines.join("\n");
}

const SCALE_WORKSHOP_BASE_URL = "https://scaleworkshop.plainsound.org/";
const SCALE_WORKSHOP_BASE_MIDI = 60;
const SCALE_WORKSHOP_BASE_FREQUENCY = 261.6256;

function scaleWorkshopUrl(scaleSize, generatorCents, periodCents, groupKey) {
  const roundedGeneratorCents = roundCentsToTwoDecimals(generatorCents);
  const params = new URLSearchParams({
    name: mosScaleWorkshopName(scaleSize, roundedGeneratorCents, groupKey),
    data: mosScaleWorkshopData(scaleSize, roundedGeneratorCents, periodCents),
    freq: String(SCALE_WORKSHOP_BASE_FREQUENCY),
    midi: String(SCALE_WORKSHOP_BASE_MIDI),
  });
  return `${SCALE_WORKSHOP_BASE_URL}?${params.toString()}`;
}

function clearMosOverlay(svg) {
  const overlay = svg.querySelector("#mos-overlay");
  if (overlay) {
    overlay.replaceChildren();
    overlay.setAttribute("pointer-events", "none");
  }
}

function dismissMosOverlay(svg) {
  if (mosAnchorSvgY == null) {
    return;
  }
  clearMosOverlay(svg);
  mosAnchorSvgY = null;
}

function updateMosDismissalFast(svg, clientX, clientY) {
  if (mosAnchorSvgY == null) {
    return;
  }

  if (!viewportFrame) {
    captureViewportFrame(svg);
  }

  const mapped = svgPointFromClient(clientX, clientY);
  const { top, plot_height } = manifest.layout;
  const inCount =
    mapped.x >= countRegionLeft(manifest)
    && mapped.x <= countRegionRight(manifest)
    && mapped.y >= top
    && mapped.y <= top + plot_height;
  if (!inCount || Math.abs(mapped.y - mosAnchorSvgY) > MOS_Y_CLEAR_THRESHOLD_PX) {
    dismissMosOverlay(svg);
  }
}

function renderMosOverlay(svg, generatorCents) {
  generatorCents = roundCentsToTwoDecimals(generatorCents);
  clearMosOverlay(svg);
  const overlay = svg.querySelector("#mos-overlay");
  if (!overlay) {
    return;
  }

  const sizes = mosSizes(generatorCents, manifest.g_cents, manifest.max_count);
  if (!sizes.length) {
    return;
  }

  const centerY = sy(manifest, generatorCents);

  for (const size of sizes) {
    const circleX = sxCount(manifest, size);
    const url = scaleWorkshopUrl(size, generatorCents, manifest.g_cents, manifest.group_key);

    const group = document.createElementNS("http://www.w3.org/2000/svg", "a");
    group.setAttribute("class", "mos-circle");
    group.setAttribute("href", url);
    group.setAttribute("target", "_blank");
    group.setAttribute("rel", "noopener");
    group.setAttribute("data-mos-size", String(size));
    group.setAttribute("data-mos-count", String(size));

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "mos-fill");
    circle.setAttribute("cx", circleX.toFixed(3));
    circle.setAttribute("cy", centerY.toFixed(3));
    circle.setAttribute("r", String(MOS_CIRCLE_RADIUS));
    circle.setAttribute("fill", "rgba(0, 68, 136, 0.18)");
    circle.setAttribute("stroke", "#004488");
    circle.setAttribute("stroke-width", "0.8");

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "mos-label");
    label.setAttribute("x", circleX.toFixed(3));
    label.setAttribute("y", centerY.toFixed(3));
    label.textContent = String(size);

    group.appendChild(circle);
    group.appendChild(label);
    overlay.appendChild(group);
  }

  overlay.setAttribute("pointer-events", "all");
  mosAnchorSvgY = centerY;
}

function scheduleMosDismissal(clientX, clientY) {
  pendingMosPointer = { x: clientX, y: clientY };
  if (mosDismissRaf) {
    return;
  }

  mosDismissRaf = requestAnimationFrame(() => {
    mosDismissRaf = null;
    const svg = mapHost.querySelector("svg");
    const pointer = pendingMosPointer;
    if (!svg || !pointer || mosAnchorSvgY == null) {
      return;
    }
    captureViewportFrame(svg);
    updateMosDismissalFast(svg, pointer.x, pointer.y);
  });
}

function handleScrollportMouseMove(event) {
  if (mosAnchorSvgY == null) {
    return;
  }
  scheduleMosDismissal(event.clientX, event.clientY);
}

function xenwikiTemperamentUrl(pageTitle, temperamentName) {
  const pageSlug = pageTitle.replace(/ /g, "_");
  const anchor = temperamentName.replace(/ /g, "_");
  return `${XENWIKI_BASE_URL}${encodeURIComponent(pageSlug)}#${encodeURIComponent(anchor)}`;
}

function temperamentWikiUrl(temp) {
  if (temp.xw_url?.includes("#")) {
    return temp.xw_url;
  }
  return xenwikiTemperamentUrl(temp.page_title, temp.wiki_anchor ?? temp.display_name);
}

function applyTemperamentLinks(svg) {
  const urlsById = new Map(
    manifest.temperaments.map((temp) => [temp.id, temperamentWikiUrl(temp)])
  );
  for (const textNode of svg.querySelectorAll(".temperament[data-temperament-id]")) {
    const url = urlsById.get(textNode.getAttribute("data-temperament-id"));
    const link = textNode.closest("a.temperament-link");
    if (!url || !link) {
      continue;
    }
    link.setAttribute("href", url);
    link.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
  }
}

function attachInteractions(svg) {
  applyTemperamentLinks(svg);
  for (const temp of manifest.temperaments) {
    for (const textNode of svg.querySelectorAll(`[data-temperament-id="${CSS.escape(temp.id)}"]`)) {
      textNode.addEventListener("mouseenter", () => highlightTemperament(svg, temp));
      textNode.addEventListener("mouseleave", () => clearHighlights(svg));
    }
  }

  svg.addEventListener("click", (event) => {
    if (event.target.closest(".mos-circle") || event.target.closest(".temperament-link")) {
      return;
    }
    dismissMosOverlay(svg);
    pointerCrosshairCents = null;
    clearHighlights(svg);
  });
}

async function loadMap(mapEntry) {
  cachedMapSize = null;
  cachedHintLayout = null;
  resetViewportChrome();
  mapHint.innerHTML = "";
  mapHost.textContent = "Loading…";
  const [svgText, manifestText] = await Promise.all([
    fetch(`${MAPS_DIR}/${mapEntry.svg}`).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load ${mapEntry.svg}`);
      }
      return response.text();
    }),
    fetch(`${MAPS_DIR}/${mapEntry.json}`).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load ${mapEntry.json}`);
      }
      return response.text();
    }),
  ]);

  manifest = JSON.parse(manifestText);
  mapHost.innerHTML = svgText;
  const svg = mapHost.querySelector("svg");
  if (!svg) {
    throw new Error("Map SVG missing root element");
  }

  hoveredTemperament = null;
  pointerCrosshairCents = null;
  mosAnchorSvgY = null;
  cachedMapSize = getSvgDimensions(svg);
  attachInteractions(svg);
  resetZoom();
}

async function init() {
  scrollport.addEventListener("mousemove", handleScrollportMouseMove);
  scrollport.addEventListener("wheel", handleZoomWheel, { passive: false });
  window.addEventListener("resize", () => {
    if (cachedMapSize) {
      applyZoomLayout();
    }
  });
  zoomInButton.addEventListener("click", () => {
    const viewport = scrollport.getBoundingClientRect();
    zoomAt(
      viewport.left + viewport.width / 2,
      viewport.top + viewport.height / 2,
      zoom * ZOOM_STEP
    );
  });
  zoomOutButton.addEventListener("click", () => {
    const viewport = scrollport.getBoundingClientRect();
    zoomAt(
      viewport.left + viewport.width / 2,
      viewport.top + viewport.height / 2,
      zoom / ZOOM_STEP
    );
  });
  zoomResetButton.addEventListener("click", resetZoom);

  try {
    const catalog = await fetch(CATALOG_URL).then((response) => {
      if (!response.ok) {
        throw new Error("Failed to load maps_index.json");
      }
      return response.json();
    });

    const maps = featuredCatalogMaps(catalog.maps);
    for (const entry of maps) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = featuredPeriodLabel(entry.group_key);
      option._entry = entry;
      mapSelect.appendChild(option);
    }

    mapSelect.addEventListener("change", () => {
      const selected = mapSelect.selectedOptions[0]._entry;
      loadMap(selected).catch((error) => {
        mapHost.textContent = String(error);
      });
    });

    if (maps.length) {
      mapSelect.selectedIndex = 0;
      await loadMap(maps[0]);
    }
  } catch (error) {
    mapHost.innerHTML = `<p style="padding:1rem">Could not load maps. Serve this folder over HTTP, for example:<br><code>cd rank2 && python -m http.server 8000</code><br>then open <code>http://localhost:8000/viewer/</code></p><p>${error}</p>`;
  }
}

init();
