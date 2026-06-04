'use strict';

// ── Map init ─────────────────────────────────────────────────────────
mapboxgl.accessToken = 'pk.eyJ1IjoiZGFyaG5hdGVua28iLCJhIjoiY21wZWg2Mnc1MDNoYjJwcjJ2amI2NnM0bSJ9.D0o5D21Zal4fb1vi-teB3w';

const STYLE_DARK  = 'mapbox://styles/mapbox/dark-v11';
const STYLE_LIGHT = 'mapbox://styles/mapbox/light-v11';

const html = document.documentElement;
let isDark = html.getAttribute('data-theme') !== 'light';

const map = new mapboxgl.Map({
  container: 'map',
  style:     isDark ? STYLE_DARK : STYLE_LIGHT,
  center:    [24.0272, 49.8375], // Stefanyka St, Lviv
  zoom:      15,
  language:  'uk',
});

// ── User location dot ─────────────────────────────────────────────────
let _locationMarker = null;
let _lastKnownPos   = null;
let _headingEl      = null;

function initGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    pos => {
      const lngLat = [pos.coords.longitude, pos.coords.latitude];
      _lastKnownPos = lngLat;
      if (!_locationMarker) {
        const el = document.createElement('div');
        el.className = 'location-dot';
        el.innerHTML =
          `<svg class="location-dot__svg" width="74" height="74" viewBox="0 0 74 74" xmlns="http://www.w3.org/2000/svg">
            <g class="location-dot__heading">
              <path d="M37 37 L20 2 L54 2 Z" fill="#AFEE00" fill-opacity="0.47"/>
            </g>
            <circle cx="37" cy="37" r="22.75" stroke="#AFEE00" stroke-width="2.5" fill="none"/>
            <circle cx="37" cy="37" r="13" fill="#AFEE00"/>
          </svg>`;
        _headingEl = el.querySelector('.location-dot__heading');
        _locationMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat(lngLat)
          .addTo(map);
        map.flyTo({ center: lngLat, zoom: 15, duration: 1000 });
      } else {
        _locationMarker.setLngLat(lngLat);
      }
      _updateParkBtnState();
    },
    err => console.warn('Geolocation:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

function initHeading() {
  let _lastHeadingSource = null;
  function onOrientation(e) {
    if (!_headingEl) return;
    // Prefer absolute source over relative; ignore relative if absolute already firing
    if (_lastHeadingSource === 'absolute' && !e.absolute) return;
    let heading = null;
    if (e.webkitCompassHeading != null) {
      heading = e.webkitCompassHeading;                 // iOS
      _lastHeadingSource = 'absolute';
    } else if (e.absolute && e.alpha != null) {
      heading = (360 - e.alpha) % 360;                  // Android absolute
      _lastHeadingSource = 'absolute';
    } else if (e.alpha != null) {
      heading = (360 - e.alpha) % 360;                  // Android relative fallback
    }
    if (heading === null) return;
    _headingEl.setAttribute('transform', `rotate(${heading}, 37, 37)`);
  }

  if (typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ — request permission on first user gesture, then listen to both events
    document.addEventListener('click', () => {
      DeviceOrientationEvent.requestPermission()
        .then(s => {
          if (s === 'granted') {
            window.addEventListener('deviceorientation', onOrientation, true);
            window.addEventListener('deviceorientationabsolute', onOrientation, true);
          }
        })
        .catch(() => {});
    }, { once: true });
  } else {
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
  }
}

// Rate used by the drum price calculator — updated per lot on card populate
let _drumRate = 40;

// ── Proximity check for park button ──────────────────────────────────
const _MAX_PARK_DIST_M = 5;

function _updateParkBtnState() {
  const btn = $('btn-park');
  if (!btn) return;
  let canPark = !!_selectedPinLngLat;
  btn.disabled = !canPark;
  btn.setAttribute('aria-disabled', String(!canPark));
}

// ── Price parser ──────────────────────────────────────────────────────
function parsePriceFromDesc(desc) {
  const text = (typeof desc === 'object' && desc.value) ? desc.value : String(desc);
  const m = text.match(/(\d+)\s*грн\/год/);
  return m ? m[1] + ' грн' : '?';
}

// Returns the price label that is active right now for a given parking lot.
// Mirrors the tariff schedule in populateParkingCard.
function getCurrentPriceLabel(props) {
  const basePrice = parsePriceFromDesc(props.description);
  const iconColor = (props['icon-color'] || '').toLowerCase();
  const now = new Date();
  const day = now.getDay();           // 0=Sun…6=Sat
  const hour = now.getHours();
  const inBusiness = hour >= 8 && hour < 20;
  const isWeekday  = day >= 1 && day <= 5;

  switch (iconColor) {
    case '#e65100':                   // Zone 1 equipped — 24/7
      return basePrice;
    case '#0288d1':                   // Zone 1 designated
    case '#0f9d58':                   // Zone 2 — paid 08:00–20:00
      return inBusiness ? basePrice : '0 грн';
    case '#9c27b0':                   // Zone 3 — paid weekdays 08:00–20:00
      return (isWeekday && inBusiness) ? basePrice : '0 грн';
    default:
      return inBusiness ? basePrice : '0 грн';
  }
}

function parseParkingData(properties) {
  let raw;
  const desc = properties.description;
  if (typeof desc === 'object' && desc !== null) {
    raw = desc.value || '';
  } else if (typeof desc === 'string') {
    try { raw = JSON.parse(desc).value || desc; } catch { raw = desc; }
  } else {
    raw = String(desc ?? '');
  }
  const priceMatch = raw.match(/(\d+)\s*грн\/год/);
  const price = priceMatch ? priceMatch[1] + ' грн/год' : '';
  const name = properties.name || '';
  const parenIdx = name.indexOf('(');
  return {
    mainName:  parenIdx >= 0 ? name.slice(0, parenIdx).trim() : name,
    subName:   parenIdx >= 0 ? name.slice(parenIdx) : '',
    price,
    iconColor: (properties['icon-color'] || '').toLowerCase(),
  };
}

function populateParkingCard(properties) {
  const d = parseParkingData(properties);
  const strong  = document.querySelector('#sheet-neutral .sheet-address-text strong');
  const sub     = document.querySelector('#sheet-neutral .sheet-address-text .text-secondary');
  const tariffList = document.querySelector('#sheet-neutral .tariff-list');
  if (strong) strong.textContent = d.mainName;
  if (sub)    sub.textContent    = d.subName ? ` ${d.subName}` : '';

  // Price row: dual format for variable zones, single for Zone 1
  const now = new Date();
  const inBusiness = now.getHours() >= 8 && now.getHours() < 20;
  const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
  const isVariable = d.iconColor !== '#e65100';
  const priceEl  = $('neutral-price');
  const priceSep = $('neutral-price-sep');
  const priceNxt = $('neutral-price-next');
  const priceDot = $('neutral-price-dot');
  if (isVariable && priceEl) {
    const isPaid = d.iconColor === '#9c27b0'
      ? (isWeekday && inBusiness)
      : inBusiness;
    const currentRate = isPaid ? d.price : '0 грн/год';
    const otherRate   = isPaid ? '0 грн/год' : d.price;
    priceEl.textContent  = currentRate;
    priceNxt.textContent = otherRate;
    [priceSep, priceNxt].forEach(el => el && el.classList.remove('hidden'));
    if (priceDot) priceDot.classList.toggle('hidden', _secsUntilTariffChange() > 3600);
  } else {
    if (priceEl) priceEl.textContent = d.price;
    [priceSep, priceNxt, priceDot].forEach(el => el && el.classList.add('hidden'));
  }
  const badge = document.getElementById('time-badge-text');
  if (badge) badge.textContent = _lastKnownPos ? '…' : '—';
  const parkBtn = $('btn-park');
  if (parkBtn) parkBtn.textContent = 'Запаркуватись';
  _updateParkBtnState();
  // Update drum calculator rate and reset to button state
  const rateMatch = d.price.match(/(\d+)/);
  _drumRate = rateMatch ? parseInt(rateMatch[1]) : 40;
  resetDrumPicker();
  if (tariffList) {
    const now = new Date();
    const day  = now.getDay();   // 0=Sun … 6=Sat
    const hour = now.getHours();
    const isWeekday  = day >= 1 && day <= 5;
    const inBusiness = hour >= 8 && hour < 20;

    const row = (label, price, active) => {
      const cls = active ? '' : ' tariff-row--inactive';
      return `<div class="tariff-row${cls}">
        <span class="tariff-row__label">${label}</span>
        <span class="tariff-row__price">${price}</span>
      </div>`;
    };

    switch (d.iconColor) {
      case '#e65100':
        tariffList.innerHTML =
          row('Пн–Нд (цілодобово)', d.price, true);
        break;
      case '#0288d1':
      case '#0f9d58':
        tariffList.innerHTML =
          row('Пн–Нд (08:00–20:00)', d.price,       inBusiness) +
          row('Пн–Нд (20:00–08:00)', '0 грн/год',  !inBusiness);
        break;
      case '#9c27b0':
        tariffList.innerHTML =
          row('Пн–Пт (08:00–20:00)', d.price,             isWeekday && inBusiness) +
          row('Пн–Пт (20:00–08:00)', '0 грн/год',         isWeekday && !inBusiness) +
          row('Сб–Нд',               '0 грн/год',         !isWeekday);
        break;
      default:
        tariffList.innerHTML =
          row('Пн–Нд (08:00–20:00)', d.price,       inBusiness) +
          row('Пн–Нд (20:00–08:00)', '0 грн/год',  !inBusiness);
    }
  }
}

// Currently selected map pin element + its geographic coordinates
let _selectedPin        = null;
let _selectedPinLngLat  = null;
let _selectedPinKey     = null;   // exact key string used in individualMarkers
let _selectedParkingProps = null;

function selectPin(el) {
  if (_selectedPin) _selectedPin.classList.remove('is-selected');
  _selectedPin = el;
  if (el) el.classList.add('is-selected');
  if (!el) _selectedPinKey = null;
}

// ── Route ─────────────────────────────────────────────────────────────
function clearRoute() {
  ['route-line', 'route-casing'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource('route')) map.removeSource('route');
}

async function drawRoute(origin, dest) {
  clearRoute();
  if (!origin || !dest) return;
  const coords = `${origin[0]},${origin[1]};${dest[0]},${dest[1]}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;
  try {
    const data = await fetch(url).then(r => r.json());
    if (!data.routes?.length) return;
    const route = data.routes[0];
    const mins = Math.max(1, Math.round(route.duration / 60));
    const badge = document.getElementById('time-badge-text');
    if (badge) badge.textContent = `${mins} хв`;
    // anchor:'bottom' means the geo coord IS the tail tip — extend geometry to reach it exactly.
    route.geometry.coordinates.push([dest[0], dest[1]]);
    map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: route.geometry }
    });
    const before = map.getLayer('road-label') ? 'road-label' : undefined;
    map.addLayer({
      id: 'route-casing',
      type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-width': 10 }
    }, before);
    map.addLayer({
      id: 'route-line',
      type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#AFEE00', 'line-width': 6 }
    }, before);
  } catch (e) {
    console.warn('Route error:', e);
  }
}

// ── Parking clustering ────────────────────────────────────────────────
let geojsonData = null;
const featuresByCoord   = new Map(); // "lng,lat" → original properties
const clusterLabels     = new Map(); // cluster_id → mapboxgl.Marker (text overlay)
const individualMarkers = new Map(); // "lng,lat"  → mapboxgl.Marker

// Syncs HTML text labels over Mapbox cluster circles, and individual price pins.
// The 'clusters' circle layer forces tile loading so querySourceFeatures works.
function syncMarkers() {
  if (!map.getSource('parkings') || !map.isSourceLoaded('parkings')) return;

  // ── Cluster text overlays (Rubik, centered on the Mapbox circle) ──
  const rawClusters = map.querySourceFeatures('parkings', {
    filter: ['has', 'point_count'],
  });
  const visibleClusters = new Map();
  rawClusters.forEach(f => {
    const id = f.properties.cluster_id;
    if (!visibleClusters.has(id)) visibleClusters.set(id, f);
  });

  clusterLabels.forEach((m, id) => {
    if (!visibleClusters.has(id)) { m.remove(); clusterLabels.delete(id); }
  });

  visibleClusters.forEach((f, id) => {
    if (clusterLabels.has(id)) return;
    const coords = f.geometry.coordinates.slice();
    const count  = f.properties.point_count;

    const el = document.createElement('div');
    el.className = 'cluster-marker';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${count} паркінгів`);
    el.innerHTML = `<div class="cluster-marker__circle">${f.properties.point_count_abbreviated}</div>`;

    el.addEventListener('click', () => {
      map.getSource('parkings').getClusterExpansionZoom(id, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: coords, zoom, duration: 400 });
      });
    });

    clusterLabels.set(id,
      new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(coords)
        .addTo(map)
    );
  });

  // ── Individual price pins ─────────────────────────────────────────
  const rawPoints = map.querySourceFeatures('parkings', {
    filter: ['!', ['has', 'point_count']],
  });
  const visiblePoints = new Map();
  rawPoints.forEach(f => {
    const key = f.geometry.coordinates.slice(0, 2).join(',');
    if (!visiblePoints.has(key)) visiblePoints.set(key, f);
  });

  individualMarkers.forEach((m, key) => {
    if (!visiblePoints.has(key) && key !== _selectedPinKey) {
      m.remove();
      individualMarkers.delete(key);
    }
  });

  visiblePoints.forEach((f, key) => {
    if (individualMarkers.has(key)) {
      // Ensure the existing element still has is-selected (can be lost after style reload)
      if (key === _selectedPinKey) {
        const el = individualMarkers.get(key).getElement();
        if (!el.classList.contains('is-selected')) selectPin(el);
      }
      return;
    }
    const [lng, lat] = f.geometry.coordinates;
    const props = featuresByCoord.get(key) ?? f.properties;
    const price = getCurrentPriceLabel(props);

    const el = document.createElement('div');
    el.className = 'map-pin';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${props.name} · ${price}/год`);
    el.innerHTML =
      `<div class="price-pin__label">${price}</div>` +
      `<div class="price-pin__tail" aria-hidden="true"></div>`;

    // Restore selected state if this pin was previously chosen
    if (key === _selectedPinKey) selectPin(el);

    el.addEventListener('click', () => {
      selectPin(el);
      _selectedPinLngLat    = [lng, lat];
      _selectedPinKey       = key;
      _selectedParkingProps = props;
      populateParkingCard(props);
      addToRecentlyViewed();
      showSheet('sheet-neutral');
      drawRoute(_lastKnownPos, [lng, lat]);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        selectPin(el);
        _selectedPinLngLat    = [lng, lat];
        _selectedPinKey       = key;
        _selectedParkingProps = props;
        populateParkingCard(props);
        addToRecentlyViewed();
        showSheet('sheet-neutral');
        drawRoute(_lastKnownPos, [lng, lat]);
      }
    });

    individualMarkers.set(key,
      new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .addTo(map)
    );
  });
}

function addParkingLayers() {
  ['clusters', 'parkings-loader'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource('parkings')) map.removeSource('parkings');
  clusterLabels.forEach(m => m.remove());     clusterLabels.clear();
  individualMarkers.forEach(m => m.remove()); individualMarkers.clear();

  map.addSource('parkings', {
    type: 'geojson',
    data: geojsonData,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });

  // Invisible layer — required so querySourceFeatures returns cluster + point data
  map.addLayer({
    id: 'parkings-loader',
    type: 'circle',
    source: 'parkings',
    paint: { 'circle-radius': 0, 'circle-opacity': 0 },
  });
}

// ── Search result cards (dynamic, from GeoJSON) ───────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hasDisabledSpots(props) {
  const raw = typeof props.description === 'object'
    ? (props.description.value || '')
    : String(props.description || '');
  const m = raw.match(/Для осіб з інвалідністю - (\d+)/);
  return m ? parseInt(m[1]) > 0 : false;
}

function _cardPriceHtml(props) {
  const d = parseParkingData(props);
  const isVariable = d.iconColor !== '#e65100';
  if (!isVariable) return `<span class="src-price">${d.price}</span>`;
  const now = new Date();
  const inBusiness = now.getHours() >= 8 && now.getHours() < 20;
  const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
  const isPaid = d.iconColor === '#9c27b0' ? (isWeekday && inBusiness) : inBusiness;
  const cur   = isPaid ? d.price : '0 грн/год';
  const other = isPaid ? '0 грн/год' : d.price;
  const dot = _secsUntilTariffChange() <= 3600
    ? '<span class="src-price-dot">•</span>' : '';
  return `<span class="src-price">${cur}</span>` +
         `<span class="src-price-sep">–</span>` +
         `<span class="src-price-next">${other}</span>${dot}`;
}

const _SVG_P = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a2.5 2.5 0 0 1 0 5H9"/></svg>`;
const _SVG_WHEELCHAIR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.5105 17.4982C14.2504 18.6305 13.6993 19.6754 12.9117 20.5295C12.1241 21.3836 11.1273 22.0174 10.0197 22.3684C8.9122 22.7193 7.73225 22.7752 6.59649 22.5305C5.46074 22.2859 4.40848 21.7491 3.54368 20.9732C2.67889 20.1974 2.0315 19.2093 1.66548 18.1066C1.29946 17.004 1.22747 15.8249 1.45663 14.6859C1.6858 13.5469 2.20818 12.4874 2.97216 11.6121C3.73614 10.7368 4.71529 10.076 5.81284 9.69498" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="7.5" cy="3.5" r="3.5" fill="currentColor"/><path d="M7.5 4.5L9 15L18.5 14.5L19.5 20.5H21.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9L17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const _SVG_LIGHTNING = `<svg width="17" height="23" viewBox="0 0 17 23" fill="none" aria-hidden="true"><path d="M7.65083 7.28636L8.95133 1.9918C9.03423 1.6539 9.07573 1.48494 9.03423 1.35196C8.99783 1.23539 8.92003 1.13618 8.81553 1.07303C8.69633 1.00098 8.52233 1.00098 8.17433 1.00098H4.30173C4.08421 1.00098 3.97545 1.00098 3.88422 1.03843C3.80369 1.07148 3.73319 1.12498 3.67969 1.19363C3.61907 1.27142 3.5898 1.37617 3.53125 1.58566L1.47609 8.93971C1.09052 10.3194 0.897726 11.0093 1.05484 11.5546C1.19247 12.0324 1.50312 12.4418 1.92621 12.7029C2.40915 13.001 3.12544 13.001 4.55801 13.001H7.67283C7.98373 13.001 8.13913 13.001 8.25223 13.0637C8.35153 13.1187 8.42913 13.2059 8.47233 13.3109C8.52153 13.4305 8.50353 13.5849 8.46753 13.8936L7.83953 19.2802C7.71483 20.3497 7.65253 20.8844 7.79163 21.0497C7.91133 21.1919 8.10003 21.256 8.28153 21.2161C8.49263 21.1696 8.76873 20.7075 9.32093 19.7831L15.4716 9.48748C15.7083 9.09118 15.8267 8.89308 15.8113 8.73011C15.7978 8.588 15.7243 8.45841 15.6092 8.37399C15.4772 8.27718 15.2464 8.27718 14.7848 8.27718H8.42773C8.07983 8.27718 7.90583 8.27718 7.78663 8.20513C7.68213 8.14199 7.60433 8.04277 7.56793 7.9262C7.52633 7.79322 7.56783 7.62426 7.65083 7.28636Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const _SVG_BOOKMARK = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M0 10C0 4.47715 4.47715 0 10 0H30C35.5228 0 40 4.47715 40 10V30C40 35.5228 35.5228 40 30 40H10C4.47715 40 0 35.5228 0 30V10Z" fill="#E9E9E9"/><path d="M14 15.5333C14 13.9465 14 13.1531 14.2803 12.547C14.5268 12.0139 14.9202 11.5805 15.404 11.3088C15.9541 11 16.6742 11 18.1143 11H21.8857C23.3258 11 24.0459 11 24.596 11.3088C25.0798 11.5805 25.4732 12.0139 25.7197 12.547C26 13.1531 26 13.9465 26 15.5333V28L20 24.2222L14 28V15.5333Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const _SVG_ROUTE = `<svg width="19" height="20" viewBox="-1 -1 19 20" overflow="visible" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.192 0L17 4.702L12.192 9.403M15.242 4.702H6.8C3.044 4.702 0 7.679 0 11.351C0 15.023 3.044 18 6.8 18H7.367"/></svg>`;

function _makeSearchCard(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const props = feature.properties;
  const key   = `${lng},${lat}`;

  const refLat = _lastKnownPos ? _lastKnownPos[1] : 49.8375;
  const refLng = _lastKnownPos ? _lastKnownPos[0] : 24.0272;
  const distKm   = haversineKm(refLat, refLng, lat, lng);
  const distMins = Math.max(1, Math.round(distKm / 0.5));
  const distText = `${distMins} хв`;

  const d       = parseParkingData(props);
  const address = d.mainName + (d.subName ? ' ' + d.subName : '');
  const icons = _SVG_LIGHTNING + (hasDisabledSpots(props) ? _SVG_WHEELCHAIR : '');

  const card = document.createElement('div');
  card.className = 'search-result-card';
  card.tabIndex  = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', address);
  card.dataset.lat = lat;
  card.dataset.lng = lng;
  card.dataset.key = key;

  card.innerHTML =
    `<div class="src-content">` +
      `<div class="src-top">` +
        `<div class="src-price-group">${_cardPriceHtml(props)}</div>` +
        `<span class="src-dist">${distText}</span>` +
      `</div>` +
      `<p class="src-address">${address}</p>` +
    `</div>` +
    `<div class="src-bottom">` +
      `<div class="src-icons">${icons}</div>` +
      `<div class="src-actions">` +
        `<button class="search-result-card__btn search-result-card__btn--bookmark" aria-label="Зберегти в обране">${_SVG_BOOKMARK}</button>` +
        `<button class="search-result-card__btn search-result-card__btn--route" aria-label="Маршрут">${_SVG_ROUTE}</button>` +
      `</div>` +
    `</div>`;

  function openParking() {
    // Save search context before closing panel
    const ctxQuery = searchPanelInput ? searchPanelInput.value.trim() : '';
    const ctxLat   = _lastSearchLat;
    const ctxLng   = _lastSearchLng;
    closeSearchPanel(false); // keep context data alive
    if (ctxQuery && ctxLat !== null) _setSearchContext(ctxQuery, ctxLat, ctxLng);
    selectPin(null);
    _selectedPinKey       = key;
    _selectedPinLngLat    = [lng, lat];
    _selectedParkingProps = props;
    populateParkingCard(props);
    addToRecentlyViewed();
    showSheet('sheet-neutral');
    drawRoute(_lastKnownPos, [lng, lat]);
    map.flyTo({ center: [lng, lat], zoom: 16, duration: 500 });
  }

  card.addEventListener('click', e => {
    if (e.target.closest('.search-result-card__btn--bookmark')) return;
    if (e.target.closest('.search-result-card__btn--route')) return;
    openParking();
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openParking(); }
  });

  const bmBtn = card.querySelector('.search-result-card__btn--bookmark');
  bmBtn.addEventListener('click', e => {
    e.stopPropagation();
    const active = bmBtn.classList.toggle('bookmarked');
    bmBtn.setAttribute('aria-label', active ? 'Видалити з обраних' : 'Зберегти в обране');
  });

  const routeBtn = card.querySelector('.search-result-card__btn--route');
  routeBtn.addEventListener('click', e => {
    e.stopPropagation();
    _selectedPinLngLat = [lng, lat];
    openNavPicker();
  });

  return card;
}

// Recently viewed parkings — most recent first, max 10
const _recentlyViewed = [];

function addToRecentlyViewed() {
  if (!_selectedPinLngLat || !_selectedParkingProps) return;
  const [lng, lat] = _selectedPinLngLat;
  const idx = _recentlyViewed.findIndex(
    f => f.geometry.coordinates[0] === lng && f.geometry.coordinates[1] === lat
  );
  if (idx >= 0) _recentlyViewed.splice(idx, 1);
  _recentlyViewed.unshift({ geometry: { coordinates: [lng, lat] }, properties: _selectedParkingProps });
  if (_recentlyViewed.length > 10) _recentlyViewed.pop();
  populateSearchCards(_recentlyViewed);
}

function populateSearchCards(features) {
  const scroll = document.querySelector('.search-panel__scroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  features.slice(0, 10).forEach(f => scroll.appendChild(_makeSearchCard(f)));
}

// ── Load parking markers from GeoJSON ────────────────────────────────
function loadParkingMarkers() {
  fetch('./parkings.geojson')
    .then(r => r.json())
    .then(data => {
      geojsonData = data;
      // Cache original properties keyed by coordinate so click handlers
      // always get the full object even after tile serialisation flattens it
      data.features.forEach(({ geometry, properties }) => {
        const key = geometry.coordinates.slice(0, 2).join(',');
        featuresByCoord.set(key, properties);
      });
      addParkingLayers();
    })
    .catch(err => console.warn('parkings.geojson load failed:', err));
}

map.on('load', () => {
  initGeolocation();
  initHeading();
  loadParkingMarkers();
  _loadLvivStreets(); // start street index early so search is ready faster
  map.once('idle', syncMarkers);
});

// ── Marker sync event strategy ────────────────────────────────────────
// querySourceFeatures only returns correct cluster/point data after Mapbox has
// finished retiling at the new zoom level. 'zoomend'/'moveend' fire too early —
// the source may still be reclustering. The 'idle' event is the only reliable
// signal that animations AND source processing are both complete.

let _idlePending  = false;

function clearHtmlMarkers() {
  individualMarkers.forEach(m => m.remove()); individualMarkers.clear();
  clusterLabels.forEach(m => m.remove());     clusterLabels.clear();
}

function queueSyncOnIdle() {
  if (_idlePending) return;       // already waiting — one sync covers it
  _idlePending = true;
  map.once('idle', () => {
    _idlePending = false;
    syncMarkers();
  });
}

map.on('zoomend',  queueSyncOnIdle);
map.on('moveend',  queueSyncOnIdle);
map.on('pitchend', queueSyncOnIdle);


// ── Helpers ───────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

function openModal(el) {
  el.classList.remove('hidden');
}

function closeModal(el) {
  el.classList.add('hidden');
}

// ── Theme toggle ──────────────────────────────────────────────────────
// data-theme lives on <html> — matches CSS selector [data-theme="dark"]
on($('btn-theme'), 'click', () => {
  isDark = !isDark;
  html.setAttribute('data-theme', isDark ? 'dark' : 'light');
  map.setStyle(isDark ? STYLE_DARK : STYLE_LIGHT);
  clearRoute();
  map.once('style.load', () => {
    map.setLanguage('uk');
    addParkingLayers();
    if (_lastKnownPos && _locationMarker) _locationMarker.addTo(map);
  });
});

// ── Burger menu / Drawer ──────────────────────────────────────────────
const drawer         = $('drawer');
const drawerBackdrop = $('drawer-backdrop');

function openDrawer() {
  drawer.classList.add('drawer--open');
  drawer.setAttribute('aria-hidden', 'false');
  drawerBackdrop.classList.add('drawer__backdrop--visible');
}

function closeDrawer() {
  drawer.classList.remove('drawer--open');
  drawer.setAttribute('aria-hidden', 'true');
  drawerBackdrop.classList.remove('drawer__backdrop--visible');
}

on($('btn-menu'),      'click', openDrawer);
on(drawerBackdrop,     'click', closeDrawer);

// ── GPS FAB ───────────────────────────────────────────────────────────
function flyToUser() {
  if (_lastKnownPos) {
    map.flyTo({ center: _lastKnownPos, zoom: 15, duration: 800 });
  } else {
    initGeolocation();
  }
}

on($('btn-gps'), 'click', flyToUser);

// ── Pay-in-app prompt ─────────────────────────────────────────────────
function openPayPrompt() {
  $('pay-prompt').classList.add('is-open');
  $('pay-prompt-backdrop').classList.add('is-open');
}
function closePayPrompt() {
  $('pay-prompt').classList.remove('is-open');
  $('pay-prompt-backdrop').classList.remove('is-open');
}

on($('btn-pay-prompt-yes'), 'click', () => { closePayPrompt(); openPaymentPanel(); });
on($('btn-pay-prompt-no'),  'click', () => { closePayPrompt(); enterFreeSession(); });
on($('pay-prompt-backdrop'),'click', closePayPrompt);

// ── End session confirmation ────────────────────────────────────────────
let _pendingEndSessionCallback = null;

function openEndSessionPrompt() {
  $('end-session-prompt').classList.add('is-open');
  $('end-session-backdrop').classList.add('is-open');
}

function closeEndSessionPrompt() {
  $('end-session-prompt').classList.remove('is-open');
  $('end-session-backdrop').classList.remove('is-open');
  _pendingEndSessionCallback = null;
}

on($('btn-end-session-yes'), 'click', () => {
  const cb = _pendingEndSessionCallback;
  closeEndSessionPrompt();
  if (cb) cb();
});
on($('btn-end-session-no'), 'click', closeEndSessionPrompt);
on($('end-session-backdrop'), 'click', closeEndSessionPrompt);

// ── Park button → branch on zone ─────────────────────────────────────
on($('btn-park'), 'click', () => {
  if (_isCurrentlyChargeable()) openPayPrompt();
  else enterFreeSession();
});

on($('btn-end-parking'), 'click', () => {
  if ($('bottom-sheet').dataset.state === 'active-paid') {
    _pendingEndSessionCallback = exitPaidSession;
  } else {
    _pendingEndSessionCallback = exitParkedState;
  }
  openEndSessionPrompt();
});

on($('btn-pay-session'), 'click', () => {});

// ── Payment panel ─────────────────────────────────────────────────────
let _refreshPaymentDrum = null; // set by IIFE below

function openPaymentPanel() {
  // Populate address from selected parking data
  const addrEl = $('payment-address');
  if (addrEl && _selectedParkingProps) {
    const d = parseParkingData(_selectedParkingProps);
    addrEl.textContent = d.mainName + (d.subName ? ' ' + d.subName : '');
  }

  // Rebuild tariff rows directly from selected parking properties
  const dstTariff = $('payment-tariff-list');
  if (dstTariff && _selectedParkingProps) {
    const d = parseParkingData(_selectedParkingProps);
    const now = new Date();
    const day  = now.getDay();
    const hour = now.getHours();
    const isWeekday  = day >= 1 && day <= 5;
    const inBusiness = hour >= 8 && hour < 20;
    const row = (label, price, active) => {
      const cls = active ? '' : ' tariff-row--inactive';
      return `<div class="tariff-row${cls}">
        <span class="tariff-row__label">${label}</span>
        <span class="tariff-row__price">${price}</span>
      </div>`;
    };
    const color = d.iconColor;
    let html = '';
    if (color === '#e65100') {
      html = row('Пн–Нд (цілодобово)', d.price, true);
    } else if (color === '#0288d1' || color === '#0f9d58') {
      html = row('Пн–Нд (08:00–20:00)', d.price,      inBusiness) +
             row('Пн–Нд (20:00–08:00)', '0 грн/год', !inBusiness);
    } else if (color === '#9c27b0') {
      html = row('Пн–Пт (08:00–20:00)', d.price,          isWeekday && inBusiness) +
             row('Пн–Пт (20:00–08:00)', '0 грн/год',      isWeekday && !inBusiness) +
             row('Сб–Нд',               '0 грн/год',      !isWeekday);
    } else {
      html = row('Пн–Нд (08:00–20:00)', d.price,      inBusiness) +
             row('Пн–Нд (20:00–08:00)', '0 грн/год', !inBusiness);
    }
    dstTariff.innerHTML = html;
  }

  // Refresh drum total with current rate
  if (_refreshPaymentDrum) _refreshPaymentDrum();

  $('payment-panel').classList.add('is-open');
  $('payment-panel').setAttribute('aria-hidden', 'false');
}

function closePaymentPanel() {
  $('payment-panel').classList.remove('is-open');
  $('payment-panel').setAttribute('aria-hidden', 'true');
}

on($('btn-payment-back'), 'click', () => { _isExtending = false; closePaymentPanel(); });

// Method card radio selection
[$('pay-method-1'), $('pay-method-2')].forEach(card => {
  if (!card) return;
  card.addEventListener('click', () => {
    [$('pay-method-1'), $('pay-method-2')].forEach(c => {
      c.classList.remove('pay-method-card--checked');
      c.setAttribute('aria-checked', 'false');
      const r = c.querySelector('.pay-method-radio');
      if (r) r.classList.remove('pay-method-radio--checked');
    });
    card.classList.add('pay-method-card--checked');
    card.setAttribute('aria-checked', 'true');
    const r = card.querySelector('.pay-method-radio');
    if (r) r.classList.add('pay-method-radio--checked');
  });
});

let _isExtending = false;

// Confirm payment → close panel + start or extend session
function showSuccessPopup(title, sub) {
  const el = $('pay-success');
  el.querySelector('.pay-success__title').textContent = title;
  el.querySelector('.pay-success__sub').textContent   = sub;
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('is-visible');
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.setAttribute('aria-hidden', 'true'), 280);
  }, 2500);
}

function showPaySuccess() {
  showSuccessPopup('Оплата успішна', 'Ваша паркувальна сесія розпочата');
}

on($('btn-pay-confirm'), 'click', () => {
  closePaymentPanel();
  if (_isExtending) {
    _isExtending = false;
    const days  = parseInt(document.getElementById('pay-drum-day-val').textContent)  || 0;
    const hours = parseInt(document.getElementById('pay-drum-hour-val').textContent) || 0;
    const addSecs = Math.max(3600, (days * 24 + hours) * 3600);
    _paidSecondsLeft += addSecs;
    _paidSecondsPaid += addSecs;
    _updatePaidTimer();
  } else {
    enterPaidSession();
    showPaySuccess();
  }
});

// Payment drum picker (same logic as neutral card drum, separate elements)
(function initPaymentDrumPicker() {
  const colDays  = $('pay-drum-col-days');
  const colHours = $('pay-drum-col-hours');
  if (!colDays || !colHours) return;

  let days = 1, hours = 0;
  const MAX_DAYS = 7, MAX_HOURS = 23;

  function wrap(v, max) { return ((v % (max + 1)) + (max + 1)) % (max + 1); }

  function triggerAnim(el, dir) {
    const cls = dir > 0 ? 'drum-anim-up' : 'drum-anim-down';
    el.classList.remove('drum-anim-up', 'drum-anim-down');
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function render(dd, dh) {
    const dv = $('pay-drum-day-val'), hv = $('pay-drum-hour-val');
    if (dd) triggerAnim(dv, dd);
    if (dh) triggerAnim(hv, dh);
    dv.textContent = days;
    hv.textContent = hours;
    $('pay-drum-day-prev2').textContent  = wrap(days  - 2, MAX_DAYS);
    $('pay-drum-day-prev').textContent   = wrap(days  - 1, MAX_DAYS);
    $('pay-drum-day-next').textContent   = wrap(days  + 1, MAX_DAYS);
    $('pay-drum-day-next2').textContent  = wrap(days  + 2, MAX_DAYS);
    $('pay-drum-hour-prev2').textContent = wrap(hours - 2, MAX_HOURS);
    $('pay-drum-hour-prev').textContent  = wrap(hours - 1, MAX_HOURS);
    $('pay-drum-hour-next').textContent  = wrap(hours + 1, MAX_HOURS);
    $('pay-drum-hour-next2').textContent = wrap(hours + 2, MAX_HOURS);
    $('pay-drum-total').textContent = Math.round((days * 24 + hours) * _drumRate) + ' грн';
  }

  function makeDraggable(col, onChange) {
    let startY = 0, prevSteps = 0;
    col.style.cursor = 'ns-resize';
    col.style.userSelect = 'none';
    col.style.touchAction = 'none';
    col.addEventListener('pointerdown', e => { startY = e.clientY; prevSteps = 0; col.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    col.addEventListener('pointermove', e => {
      if (!col.hasPointerCapture(e.pointerId)) return;
      const steps = Math.floor(Math.abs(startY - e.clientY) / 24) * Math.sign(startY - e.clientY);
      const delta = steps - prevSteps;
      if (delta) { prevSteps = steps; onChange(delta, false); }
    });
    col.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); onChange(e.deltaY > 0 ? 1 : -1, true); }, { passive: false });
  }

  makeDraggable(colDays,  (d, a) => { days  = wrap(days  + d, MAX_DAYS);  render(a ? Math.sign(d) : 0, 0); });
  makeDraggable(colHours, (d, a) => { hours = wrap(hours + d, MAX_HOURS); render(0, a ? Math.sign(d) : 0); });

  $('pay-drum-day-prev2').addEventListener('click',  () => { days  = wrap(days  - 2, MAX_DAYS);  render(-1,  0); });
  $('pay-drum-day-prev').addEventListener('click',   () => { days  = wrap(days  - 1, MAX_DAYS);  render(-1,  0); });
  $('pay-drum-day-next').addEventListener('click',   () => { days  = wrap(days  + 1, MAX_DAYS);  render( 1,  0); });
  $('pay-drum-day-next2').addEventListener('click',  () => { days  = wrap(days  + 2, MAX_DAYS);  render( 1,  0); });
  $('pay-drum-hour-prev2').addEventListener('click', () => { hours = wrap(hours - 2, MAX_HOURS); render( 0, -1); });
  $('pay-drum-hour-prev').addEventListener('click',  () => { hours = wrap(hours - 1, MAX_HOURS); render( 0, -1); });
  $('pay-drum-hour-next').addEventListener('click',  () => { hours = wrap(hours + 1, MAX_HOURS); render( 0,  1); });
  $('pay-drum-hour-next2').addEventListener('click', () => { hours = wrap(hours + 2, MAX_HOURS); render( 0,  1); });

  _refreshPaymentDrum = () => render(0, 0);
  render(0, 0);
})();

// ── Session state ─────────────────────────────────────────────────────
let _paidSecondsLeft     = 0;
let _paidSecondsPaid     = 0;
let _paidSessionInterval = null;
let _isVariableZone      = false;

function _secsUntilTariffChange() {
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
  if (h >= 8 && h < 20) return (20 - h) * 3600 - m * 60 - s;
  if (h >= 20)           return (32 - h) * 3600 - m * 60 - s;
  return (8 - h) * 3600 - m * 60 - s;
}

function _isCurrentlyChargeable() {
  const c = (_selectedParkingProps?.['icon-color'] || '').toLowerCase();
  const now = new Date();
  const inBusiness = now.getHours() >= 8 && now.getHours() < 20;
  const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
  return c === '#e65100' ||
    ((c === '#0288d1' || c === '#0f9d58') && inBusiness) ||
    (c === '#9c27b0' && isWeekday && inBusiness);
}

function _showSessionTimer(show) {
  [$('paid-session-timer-divider'), $('paid-session-timer-section')]
    .forEach(el => el && el.classList.toggle('hidden', !show));
}

// mode: 'paid' shows Подовжити + hides Сплатити
//       'free' hides Подовжити + shows Сплатити disabled
//       'needs-payment' hides Подовжити + shows Сплатити enabled
function _setSessionButtons(mode) {
  const extend = $('btn-extend');
  const payNow = $('btn-pay-now');
  extend.classList.toggle('hidden', mode !== 'paid');
  if (mode === 'paid') {
    payNow.classList.add('hidden');
    payNow.disabled = false;
    payNow.removeAttribute('aria-disabled');
  } else if (mode === 'free') {
    payNow.classList.remove('hidden');
    payNow.disabled = true;
    payNow.setAttribute('aria-disabled', 'true');
  } else {
    payNow.classList.remove('hidden');
    payNow.disabled = false;
    payNow.removeAttribute('aria-disabled');
  }
}

function _updatePaidTimer() {
  const s = Math.max(0, _paidSecondsLeft);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  $('timer-display').textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function _populateSessionHeader(d) {
  const srcName = document.querySelector('#sheet-neutral .sheet-address-text strong');
  const srcSub  = document.querySelector('#sheet-neutral .sheet-address-text .text-secondary');
  if (srcName) $('paid-session-name').textContent = srcName.textContent;
  if (srcSub)  $('paid-session-sub').textContent  = srcSub.textContent;
  const sep = $('paid-session-price-sep'), next = $('paid-session-price-next'),
        dot = $('paid-session-price-dot');
  if (_isVariableZone && d) {
    const now = new Date();
    const inBusiness = now.getHours() >= 8 && now.getHours() < 20;
    const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
    const c = d.iconColor;
    const isPaid = c === '#9c27b0' ? (isWeekday && inBusiness) : inBusiness;
    $('paid-session-price').textContent = isPaid ? d.price : '0 грн/год';
    next.textContent = isPaid ? '0 грн/год' : d.price;
    [sep, next].forEach(el => el.classList.remove('hidden'));
    dot.classList.toggle('hidden', _secsUntilTariffChange() > 3600);
  } else {
    $('paid-session-price').textContent = d ? d.price : '—';
    [sep, next, dot].forEach(el => el.classList.add('hidden'));
  }
}

function _populateTariffList(d) {
  const list = $('paid-session-tariff-list');
  if (!list || !d) return;
  const now = new Date();
  const inBusiness = now.getHours() >= 8 && now.getHours() < 20;
  const isWeekday  = now.getDay() >= 1 && now.getDay() <= 5;
  const row = (label, price, active) =>
    `<div class="tariff-row${active ? '' : ' tariff-row--inactive'}">
      <span class="tariff-row__label">${label}</span>
      <span class="tariff-row__price">${price}</span>
    </div>`;
  const c = d.iconColor;
  if (c === '#e65100') {
    list.innerHTML = row('Пн–Нд (цілодобово)', d.price, true);
  } else if (c === '#0288d1' || c === '#0f9d58') {
    list.innerHTML = row('Пн–Нд (08:00–20:00)', d.price,      inBusiness) +
                     row('Пн–Нд (20:00–08:00)', '0 грн/год', !inBusiness);
  } else if (c === '#9c27b0') {
    list.innerHTML = row('Пн–Пт (08:00–20:00)', d.price,          isWeekday && inBusiness) +
                     row('Пн–Пт (20:00–08:00)', '0 грн/год',      isWeekday && !inBusiness) +
                     row('Сб–Нд',               '0 грн/год',      !isWeekday);
  } else {
    list.innerHTML = row('Пн–Нд (08:00–20:00)', d.price,      inBusiness) +
                     row('Пн–Нд (20:00–08:00)', '0 грн/год', !inBusiness);
  }
}

function _startCarMarker() {
  if (_selectedPinLngLat && !_carMarker) {
    const el = document.createElement('div');
    el.className = 'car-label';
    el.innerHTML = '<span class="car-label__bubble">Моє авто</span><div class="car-label__tail"></div>';
    _carMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(_selectedPinLngLat).addTo(map);
  }
}

function _liftFinishBtn() {
  const fin = $('btn-end-parking'), phone = $('phone-screen'), sheet = $('bottom-sheet');
  if (fin.parentElement !== phone) { phone.insertBefore(fin, sheet); fin.classList.add('finish--fixed'); }
}
function _lowerFinishBtn() {
  const fin = $('btn-end-parking'), sheet = $('bottom-sheet');
  if (fin.parentElement !== sheet) { sheet.insertBefore(fin, sheet.firstChild); fin.classList.remove('finish--fixed'); }
}

// ── Enter paid session (called after payment confirmed) ────────────────
function enterPaidSession() {
  const gps = $('btn-gps'), sheet = $('bottom-sheet');
  if (gps.parentElement !== sheet) { sheet.insertBefore(gps, sheet.firstChild); gps.classList.remove('gps--fixed'); }
  _liftFinishBtn();

  const d = _selectedParkingProps ? parseParkingData(_selectedParkingProps) : null;
  _isVariableZone = (d?.iconColor || '') !== '#e65100';
  _populateSessionHeader(d);
  _populateTariffList(d);

  const days  = parseInt(document.getElementById('pay-drum-day-val').textContent)  || 0;
  const hours = parseInt(document.getElementById('pay-drum-hour-val').textContent) || 0;
  _paidSecondsLeft = Math.max(3600, (days * 24 + hours) * 3600);
  _paidSecondsPaid = _paidSecondsLeft;

  $('paid-session-timer-label').textContent = 'Сплачено';
  _showSessionTimer(true);
  _setSessionButtons('paid');

  clearInterval(_paidSessionInterval);
  _updatePaidTimer();
  _paidSessionInterval = setInterval(() => {
    _paidSecondsLeft--;
    _updatePaidTimer();
    // Variable zone: tariff flipped to free mid-session
    if (_isVariableZone && !_isCurrentlyChargeable()) {
      clearInterval(_paidSessionInterval);
      _paidSessionInterval = null;
      _showSessionTimer(false);
      _setSessionButtons('free');
      return;
    }
    if (_paidSecondsLeft <= 0) exitPaidSession();
  }, 1000);

  showSheet('sheet-active-paid');
  _startCarMarker();
  $('phone-screen').classList.add('is-parked');
}

// ── Enter free session (no payment needed right now) ───────────────────
function enterFreeSession() {
  const gps = $('btn-gps'), sheet = $('bottom-sheet');
  if (gps.parentElement !== sheet) { sheet.insertBefore(gps, sheet.firstChild); gps.classList.remove('gps--fixed'); }
  _liftFinishBtn();

  const d = _selectedParkingProps ? parseParkingData(_selectedParkingProps) : null;
  _isVariableZone = true;
  _populateSessionHeader(d);
  _populateTariffList(d);

  _paidSecondsLeft = _secsUntilTariffChange();
  _paidSecondsPaid = 0;

  $('paid-session-timer-label').textContent = 'До зміни тарифу';
  _showSessionTimer(true);
  _setSessionButtons('free');

  clearInterval(_paidSessionInterval);
  _updatePaidTimer();
  _paidSessionInterval = setInterval(() => {
    _paidSecondsLeft--;
    _updatePaidTimer();
    if (_paidSecondsLeft <= 0) {
      // Tariff flipped to paid — prompt user to pay
      clearInterval(_paidSessionInterval);
      _paidSessionInterval = null;
      _showSessionTimer(false);
      _setSessionButtons('needs-payment');
    }
  }, 1000);

  showSheet('sheet-active-paid');
  _startCarMarker();
  $('phone-screen').classList.add('is-parked');
}

function exitPaidSession() {
  clearInterval(_paidSessionInterval);
  _paidSessionInterval = null;
  _lowerFinishBtn();

  const elapsed  = Math.max(0, _paidSecondsPaid - _paidSecondsLeft);
  const eh = Math.floor(elapsed / 3600), em = Math.floor((elapsed % 3600) / 60);
  const durText = eh > 0 ? `${eh} год ${String(em).padStart(2,'0')} хв`
                         : `${em} хв ${String(elapsed % 60).padStart(2,'0')} с`;
  const costGrn = ((elapsed / 3600) * _drumRate).toFixed(2).replace('.', ',');

  const durEl = $('receipt-duration'), addrEl = $('receipt-address'), totEl = $('receipt-total');
  if (durEl)  durEl.textContent  = durText;
  if (addrEl) addrEl.textContent = ($('paid-session-name').textContent || '') +
                                   ($('paid-session-sub').textContent  || '');
  if (totEl)  totEl.textContent  = costGrn + ' грн';

  if (_carMarker) { _carMarker.remove(); _carMarker = null; }
  $('phone-screen').classList.remove('is-parked');
  showSheet('sheet-discovery');
}

on($('btn-extend'),  'click', () => { _isExtending = true; openPaymentPanel(); });
on($('btn-pay-now'), 'click', () => { _isExtending = true; openPaymentPanel(); });

on($('btn-find-car'), 'click', () => {
  if (_selectedPinLngLat) {
    drawRoute(_lastKnownPos, _selectedPinLngLat);
    map.flyTo({ center: _selectedPinLngLat, zoom: 16, duration: 600 });
    openNavPicker();
  }
});

// ── Close session button → confirmation modal ─────────────────────────
const modalClose = $('modal-close');

on($('btn-close-session'), 'click', () => openModal(modalClose));
on($('close-no'),          'click', () => closeModal(modalClose));

on($('close-yes'), 'click', () => {
  closeModal(modalClose);
  showSessionSuccess();
});

// ── Session success screen ────────────────────────────────────────────
function showSessionSuccess() {
  // Hide active session sheet, restore neutral state
  $('sheet-active-paid').classList.add('hidden');
  $('sheet-neutral').classList.remove('hidden');
  showSheet('sheet-discovery');
}

// ── Price pin → sheet state transition ───────────────────────────────
function showSheet(stateId) {
  ['sheet-discovery', 'sheet-neutral', 'sheet-active-paid', 'sheet-parked'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== stateId);
  });
  if (stateId === 'sheet-discovery') { selectPin(null); clearRoute(); }
  setExpanded(false);
  $('bottom-sheet').dataset.state = stateId.replace(/^sheet-/, '');
  const actions = $('sheet-actions');
  if (actions) actions.classList.toggle('hidden', stateId !== 'sheet-neutral');
  const parkedActions = $('parked-actions');
  if (parkedActions) parkedActions.classList.toggle('hidden', stateId !== 'sheet-parked');
  const paidActions = $('paid-session-actions');
  if (paidActions) paidActions.classList.toggle('hidden', stateId !== 'sheet-active-paid');
}

let _carMarker = null;
let _expandedFromDiscovery = false;

function enterParkedState() {
  // If GPS was detached to phone-screen (expanded state), return it to sheet immediately
  // to avoid the 400ms setTimeout race in setExpanded(false)
  const gps = $('btn-gps');
  const sheet = $('bottom-sheet');
  if (gps.parentElement !== sheet) {
    sheet.insertBefore(gps, sheet.firstChild);
    gps.classList.remove('gps--fixed');
  }

  // Copy parking info from the regular card into the parked card
  const srcStrong = document.querySelector('#sheet-neutral .sheet-address-text strong');
  const srcSub    = document.querySelector('#sheet-neutral .sheet-address-text .text-secondary');
  const srcPrice  = document.querySelector('#sheet-neutral .price-time-row .sheet-price');
  const dstStrong = document.querySelector('#sheet-parked .sheet-address-text strong');
  const dstSub    = document.querySelector('#sheet-parked .sheet-address-text .text-secondary');
  const dstPrice  = document.querySelector('#sheet-parked .sheet-price');
  if (dstStrong && srcStrong) dstStrong.textContent = srcStrong.textContent;
  if (dstSub    && srcSub)    dstSub.textContent    = srcSub.textContent;
  if (dstPrice  && srcPrice)  dstPrice.textContent  = srcPrice.textContent;

  showSheet('sheet-parked');

  if (_selectedPinLngLat && !_carMarker) {
    const el = document.createElement('div');
    el.className = 'car-label';
    el.innerHTML = '<span class="car-label__bubble">Моє авто</span><div class="car-label__tail"></div>';
    _carMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(_selectedPinLngLat)
      .addTo(map);
  }

  $('phone-screen').classList.add('is-parked');
}

function exitParkedState() {
  // If expanded, return GPS to sheet first before showSheet resets state
  const sheet = $('bottom-sheet');
  if (sheet.classList.contains('is-expanded')) {
    sheet.classList.remove('is-expanded');
    sheet.insertBefore($('btn-gps'), sheet.firstChild);
    $('btn-gps').classList.remove('gps--fixed');
  }
  showSheet('sheet-discovery');
  if (_carMarker) { _carMarker.remove(); _carMarker = null; }
  $('phone-screen').classList.remove('is-parked');
}

// Pin tap → sheet handled in loadParkingMarkers() via Mapbox Marker elements

// ── Sheet expand / collapse ───────────────────────────────────────────
function setExpanded(expand) {
  const sheet = $('bottom-sheet');
  const gps   = $('btn-gps');
  const phone = $('phone-screen');

  sheet.classList.toggle('is-expanded', expand);
  sheet.dataset.state = expand ? 'expanded' : 'neutral';
  $('sheet-handle').setAttribute(
    'aria-label',
    expand ? 'Згорнути деталі' : 'Розгорнути деталі'
  );

  if (expand) {
    // Lift GPS out of the sheet into the phone-container so it stays fixed
    // while the card (z-25) slides up over it
    phone.insertBefore(gps, sheet);
    gps.classList.add('gps--fixed');
  } else {
    // Keep sheet above FABs (z=20) during the entire collapse animation,
    // then drop z-index after the transition completes.
    sheet.style.zIndex = '25';
    gps.style.opacity = '0';
    setTimeout(() => {
      if (!sheet.classList.contains('is-expanded')) {
        sheet.style.zIndex = '';
        if (gps.parentElement === phone) {
          sheet.insertBefore(gps, sheet.firstChild);
          gps.classList.remove('gps--fixed');
        }
        gps.style.opacity = '';
      }
    }, 430); // slightly after --duration-slow (420ms) so animation is fully done
  }
}

// Keyboard toggle on handle
on($('sheet-handle'), 'keydown', e => {
  if (e.key === 'Enter' || e.key === ' ')
    setExpanded(!$('bottom-sheet').classList.contains('is-expanded'));
});

// ── PointerEvents — whole card area (handle + head + buttons) ────────
(function initSheetPointer() {
  const sheet      = $('bottom-sheet');
  const scrollable = sheet.querySelector('.sheet-scrollable-content');
  let startY = 0, startTime = 0, active = false;

  sheet.addEventListener('pointerdown', e => {
    if (scrollable && scrollable.contains(e.target)) return;
    if (e.target.closest('button')) return;
    active    = true;
    startY    = e.clientY;
    startTime = Date.now();
    sheet.setPointerCapture(e.pointerId);
  });

  sheet.addEventListener('pointermove', e => {
    if (!active) return;
  });

  sheet.addEventListener('pointerup', e => {
    if (!active) return;
    active = false;

    const deltaY   = startY - e.clientY;                          // + = up
    const velocity = Math.abs(deltaY) / (Date.now() - startTime); // px/ms

    if (Math.abs(deltaY) < 10 && velocity < 0.2) return;          // tap — ignore
    if (Math.abs(deltaY) < 30 && velocity < 0.4) return;          // too small

    const isParked = ['parked', 'active-paid'].includes($('bottom-sheet').dataset.state);
    const isExpanded = $('bottom-sheet').classList.contains('is-expanded');

    if (isParked) {
      if (deltaY > 0 && !isExpanded) {
        // Expand parked card without changing dataset.state
        const sheet = $('bottom-sheet');
        sheet.classList.add('is-expanded');
        $('phone-screen').insertBefore($('btn-gps'), sheet);
        $('btn-gps').classList.add('gps--fixed');
      } else if (deltaY < 0 && isExpanded) {
        // Collapse parked card back to strip
        const sheet = $('bottom-sheet');
        $('btn-gps').style.opacity = '0';
        sheet.style.zIndex = '25'; // keep above FABs during collapse animation
        sheet.classList.remove('is-expanded');
        setTimeout(() => {
          if (!sheet.classList.contains('is-expanded')) {
            sheet.style.zIndex = '';
            sheet.insertBefore($('btn-gps'), sheet.firstChild);
            $('btn-gps').classList.remove('gps--fixed');
            $('btn-gps').style.opacity = '';
          }
        }, 430);
      }
      // swipe-down while collapsed: do nothing (can't dismiss parked card)
    } else {
      if (deltaY > 0) {
        const wasDiscovery = $('bottom-sheet').dataset.state === 'discovery';
        if (wasDiscovery) _expandedFromDiscovery = true;
        setExpanded(true);
        if (wasDiscovery) _populateDiscoveryCards();
      } else {
        if (isExpanded) {
          const fromDiscovery = _expandedFromDiscovery;
          _expandedFromDiscovery = false;
          setExpanded(false);
          if (fromDiscovery) $('bottom-sheet').dataset.state = 'discovery';
        } else {
          showSheet('sheet-discovery');
        }
      }
    }
  });

  sheet.addEventListener('pointercancel', () => { active = false; });
})();

// ── Navigator picker ──────────────────────────────────────────────────
function openNavPicker() {
  $('nav-picker').classList.add('is-open');
  $('nav-picker-backdrop').classList.add('is-open');
  $('nav-picker').setAttribute('aria-hidden', 'false');
}

function closeNavPicker() {
  $('nav-picker').classList.remove('is-open');
  $('nav-picker-backdrop').classList.remove('is-open');
  $('nav-picker').setAttribute('aria-hidden', 'true');
}

function openExternalNav(url) {
  closeNavPicker();
  window.open(url, '_blank');
}

// ── QR Scanner ────────────────────────────────────────────────────────
let _qrStream = null;
let _qrTrack  = null;
let _torchOn  = false;

async function openQRScanner() {
  $('qr-scanner').classList.add('is-open');
  $('qr-scanner').setAttribute('aria-hidden', 'false');
  try {
    _qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false
    });
    const video = $('qr-video');
    video.srcObject = _qrStream;
    _qrTrack = _qrStream.getVideoTracks()[0];
  } catch (err) {
    console.warn('Camera unavailable:', err);
  }
}

function closeQRScanner() {
  $('qr-scanner').classList.remove('is-open');
  $('qr-scanner').setAttribute('aria-hidden', 'true');
  if (_qrStream) {
    _qrStream.getTracks().forEach(t => t.stop());
    _qrStream = null;
    _qrTrack  = null;
  }
  _torchOn = false;
  $('btn-qr-flash').classList.remove('is-active');
}

on($('btn-qr'),       'click', openQRScanner);
on($('btn-qr-close'), 'click', closeQRScanner);

on($('btn-qr-flash'), 'click', async () => {
  if (!_qrTrack) return;
  _torchOn = !_torchOn;
  try {
    await _qrTrack.applyConstraints({ advanced: [{ torch: _torchOn }] });
    $('btn-qr-flash').classList.toggle('is-active', _torchOn);
  } catch (e) {
    console.warn('Torch not supported:', e);
  }
});

on($('btn-route'),          'click', openNavPicker);
on($('nav-picker-cancel'),  'click', closeNavPicker);
on($('nav-picker-backdrop'),'click', closeNavPicker);

on($('nav-google'), 'click', () => {
  const [lng, lat] = _selectedPinLngLat ?? [24.0272, 49.8375];
  openExternalNav(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`);
});

on($('nav-apple'), 'click', () => {
  const [lng, lat] = _selectedPinLngLat ?? [24.0272, 49.8375];
  openExternalNav(`http://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`);
});

on($('nav-waze'), 'click', () => {
  const [lng, lat] = _selectedPinLngLat ?? [24.0272, 49.8375];
  openExternalNav(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`);
});

// ── Bookmark toggle ───────────────────────────────────────────────────
let isBookmarked = false;
on($('btn-bookmark'), 'click', () => {
  isBookmarked = !isBookmarked;
  $('btn-bookmark').classList.toggle('bookmarked', isBookmarked);
  $('btn-bookmark').setAttribute('aria-pressed', String(isBookmarked));
  $('btn-bookmark').setAttribute(
    'aria-label',
    isBookmarked ? 'Видалити з обраних' : 'Зберегти в обране'
  );
});

// ── Search panel ──────────────────────────────────────────────────────
const searchPanel = $('search-panel');
const searchPanelInput = $('search-panel-input');
const searchClearBtn   = $('btn-search-clear');
const searchBarWrap    = $('search-bar-wrap');
const searchBarBack    = $('btn-search-bar-back');
const searchBarClear   = $('btn-search-bar-clear');
const mapSearchInput   = $('search-input');

// ── Search context — persists while user explores a searched street ───
let _searchContext = null; // { query, lat, lng }

function _setSearchContext(query, lat, lng) {
  _searchContext = { query, lat, lng };
  mapSearchInput.value = query;
  mapSearchInput.setAttribute('readonly', '');
  searchBarWrap.classList.add('has-context');
  searchBarBack.classList.remove('hidden');
  searchBarClear.classList.remove('hidden');
}

function _clearSearchContext() {
  _searchContext = null;
  mapSearchInput.value = '';
  mapSearchInput.setAttribute('readonly', '');
  searchBarWrap.classList.remove('has-context');
  searchBarBack.classList.add('hidden');
  searchBarClear.classList.add('hidden');
}

function openSearchPanel() {
  $('search-input').blur();
  searchPanel.classList.add('is-open');
  searchPanel.setAttribute('aria-hidden', 'false');
  const actions = $('sheet-actions');
  if (actions) actions.classList.add('hidden');
  _loadLvivStreets();
  if (searchPanelInput) {
    searchPanelInput.placeholder = 'Пошук парковки...';
    searchPanelInput.focus();
  }
}

function _openSearchPanelWithContext() {
  if (!_searchContext) { openSearchPanel(); return; }
  openSearchPanel();
  // Restore query and results
  if (searchPanelInput) {
    searchPanelInput.value = _searchContext.query;
    if (searchClearBtn) searchClearBtn.classList.remove('hidden');
  }
  _isShowingNearby = true;
  _lastSearchLat   = _searchContext.lat;
  _lastSearchLng   = _searchContext.lng;
  populateSearchCards(_getNearbyParkings(_searchContext.lat, _searchContext.lng).filter(_parkingPassesFilters));
  const hdr = document.querySelector('.search-panel__section-hdr');
  if (hdr) hdr.textContent = 'Парковки поруч';
}

function closeSearchPanel(clearCtx = true) {
  if (searchPanelInput) searchPanelInput.placeholder = '';
  searchPanel.classList.remove('is-open');
  searchPanel.setAttribute('aria-hidden', 'true');
  if (searchPanelInput) searchPanelInput.value = '';
  if (searchClearBtn) searchClearBtn.classList.add('hidden');
  const actions = $('sheet-actions');
  if (actions) actions.classList.remove('hidden');
  _hideSuggestions();
  if (clearCtx) {
    _clearSearchContext();
    _revertToRecentlyViewed();
  }
}

// Open when the map search bar receives focus / click
$('search-input').addEventListener('focus', e => {
  e.target.blur();
  if (_searchContext) _openSearchPanelWithContext();
  else openSearchPanel();
});
$('search-input').addEventListener('click', e => {
  if (_searchContext) { e.preventDefault(); _openSearchPanelWithContext(); }
});

// ← back button on map search bar → open search panel with context
on(searchBarBack, 'click', () => _openSearchPanelWithContext());

// × clear button on map search bar → clear context, reset to home
on(searchBarClear, 'click', () => {
  _clearSearchContext();
  _revertToRecentlyViewed();
});

// Filter chip toggle — re-applies filters immediately if nearby results are shown
function _updateSaveFiltersBtn() {
  const btn = $('btn-save-filters');
  const anySelected = document.querySelectorAll('.filter-chip[aria-pressed="true"]').length > 0;
  const isSaved = btn.dataset.saved === 'true';
  const enabled = anySelected || isSaved;
  btn.disabled = !enabled;
  btn.setAttribute('aria-disabled', String(!enabled));
}

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('pointerdown', e => e.preventDefault());
  chip.addEventListener('click', () => {
    const pressed = chip.getAttribute('aria-pressed') === 'true';
    chip.setAttribute('aria-pressed', String(!pressed));
    _updateSaveFiltersBtn();
    if (_isShowingNearby && _lastSearchLat !== null) {
      populateSearchCards(_getNearbyParkings(_lastSearchLat, _lastSearchLng).filter(_parkingPassesFilters));
    }
  });
});

on($('btn-save-filters'), 'click', () => {
  const btn = $('btn-save-filters');
  const isSaved = btn.dataset.saved === 'true';
  if (isSaved) {
    document.querySelectorAll('.filter-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    btn.textContent = 'Зберегти фільтри';
    btn.dataset.saved = 'false';
  } else {
    btn.textContent = 'Скинути фільтри';
    btn.dataset.saved = 'true';
  }
  _updateSaveFiltersBtn();
  if (_isShowingNearby && _lastSearchLat !== null) {
    populateSearchCards(_getNearbyParkings(_lastSearchLat, _lastSearchLng).filter(_parkingPassesFilters));
  }
});
$('btn-save-filters').addEventListener('pointerdown', e => e.preventDefault());

// Clear placeholder before back button causes blur (prevents flash during close transition)
$('btn-search-back').addEventListener('pointerdown', () => {
  if (searchPanelInput) searchPanelInput.placeholder = '';
});

// Close when focus leaves the panel — guarded against iOS button taps that don't move focus
let _panelPointerActive = false;
searchPanel.addEventListener('pointerdown', () => { _panelPointerActive = true; });
searchPanel.addEventListener('pointerup',   () => { setTimeout(() => { _panelPointerActive = false; }, 300); });

searchPanelInput && searchPanelInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (!_panelPointerActive && !searchPanel.contains(document.activeElement)) {
      closeSearchPanel(false); // keep context when closing via blur
    }
  }, 150);
});

// ← in search panel → always clear context and go home
on($('btn-search-back'), 'click', () => closeSearchPanel(true));

// Close via Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && searchPanel.classList.contains('is-open')) {
    closeSearchPanel();
  }
});

// ── Lviv street index (OpenStreetMap via Overpass, cached in localStorage) ──
// null = not yet requested, [] = loading/failed, [{name,lat,lng}] = ready
let _lvivStreets = null;
const _STREETS_CACHE_KEY = 'nyro_lviv_streets_v2';
const _STREETS_CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 days

function _loadLvivStreets() {
  if (_lvivStreets !== null) return;

  // Serve from localStorage cache when available
  try {
    const raw = localStorage.getItem(_STREETS_CACHE_KEY);
    if (raw) {
      const { data, ts } = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0 && Date.now() - ts < _STREETS_CACHE_TTL) {
        _lvivStreets = data;
        return;
      }
    }
  } catch (_) {}

  _lvivStreets = []; // mark as loading
  // Bounding box covers Lviv city area — simpler and more reliable than admin_level area query
  const oq = '[out:json][timeout:30];way["highway"]["name:uk"](49.77,23.85,49.92,24.25);out tags center;';
  fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(oq)
  })
  .then(r => r.json())
  .then(data => {
    const seen = new Set();
    _lvivStreets = [];
    for (const el of (data.elements || [])) {
      const name = el.tags && el.tags['name:uk'];
      if (name && !seen.has(name) && el.center) {
        seen.add(name);
        _lvivStreets.push({ name, lat: el.center.lat, lng: el.center.lon });
      }
    }
    try { localStorage.setItem(_STREETS_CACHE_KEY, JSON.stringify({ data: _lvivStreets, ts: Date.now() })); }
    catch (_) {}
  })
  .catch(() => {});
}

// ── Address search suggestions ────────────────────────────────────────
const _suggestionsEl = $('search-suggestions');
let _geoDebounce     = null;
let _isShowingNearby = false;

function _hideSuggestions() {
  if (_suggestionsEl) { _suggestionsEl.classList.remove('is-open'); _suggestionsEl.innerHTML = ''; }
}

function _populateDiscoveryCards() {
  const scroll = $('discovery-cards-scroll');
  if (!scroll || !geojsonData) return;
  const center  = map.getCenter();
  const refLat  = _lastKnownPos ? _lastKnownPos[1] : center.lat;
  const refLng  = _lastKnownPos ? _lastKnownPos[0] : center.lng;
  scroll.innerHTML = '';
  _getNearbyParkings(refLat, refLng).slice(0, 10)
    .forEach(f => scroll.appendChild(_makeSearchCard(f)));
}

function _revertToRecentlyViewed() {
  _isShowingNearby = false;
  const hdr = document.querySelector('.search-panel__section-hdr');
  if (hdr) hdr.textContent = 'Нещодавно переглянуті';
  populateSearchCards(_recentlyViewed);
}

function _getNearbyParkings(lat, lng) {
  if (!geojsonData) return [];
  return [...geojsonData.features]
    .sort((a, b) => {
      const [aLng, aLat] = a.geometry.coordinates;
      const [bLng, bLat] = b.geometry.coordinates;
      return haversineKm(lat, lng, aLat, aLng) - haversineKm(lat, lng, bLat, bLng);
    });
}

let _lastSearchLat = null, _lastSearchLng = null;

function _getActiveFilters() {
  return [...document.querySelectorAll('.filter-chip[aria-pressed="true"]')]
    .map(c => c.dataset.filter).filter(Boolean);
}

function _parkingPassesFilters(feature) {
  const active = _getActiveFilters();
  if (!active.length) return true;
  const props = feature.properties;
  for (const f of active) {
    if (f === 'disabled' && !hasDisabledSpots(props)) return false;
    // ev / cctv / security: no per-lot data yet — all pass
  }
  return true;
}

function _selectStreet(name, lat, lng) {
  _hideSuggestions();
  if (searchPanelInput) searchPanelInput.value = name;
  _isShowingNearby = true;
  _lastSearchLat = lat;
  _lastSearchLng = lng;
  const hdr = document.querySelector('.search-panel__section-hdr');
  if (hdr) hdr.textContent = '';
  populateSearchCards(_getNearbyParkings(lat, lng).filter(_parkingPassesFilters));
  map.flyTo({ center: [lng, lat], zoom: 16, duration: 600 });
}

function _renderSuggestions(items) {
  if (!items.length) { _hideSuggestions(); return; }
  _suggestionsEl.innerHTML = '';
  items.forEach(({ name, lat, lng }) => {
    const item = document.createElement('div');
    item.className = 'search-suggestion-item';
    item.setAttribute('role', 'option');
    item.textContent = name;
    // preventDefault on pointerdown keeps the input focused so the blur
    // handler doesn't fire closeSearchPanel() before the click registers
    item.addEventListener('pointerdown', e => e.preventDefault());
    item.addEventListener('click', () => _selectStreet(name, lat, lng));
    _suggestionsEl.appendChild(item);
  });
  _suggestionsEl.classList.add('is-open');
}

searchPanelInput && searchPanelInput.addEventListener('input', () => {
  const q = (searchPanelInput.value || '').trim();
  if (searchClearBtn) searchClearBtn.classList.toggle('hidden', !searchPanelInput.value.length);
  clearTimeout(_geoDebounce);
  if (!q) { _hideSuggestions(); if (_isShowingNearby) _revertToRecentlyViewed(); return; }

  const qLow = q.toLowerCase();
  const refLat = _lastKnownPos ? _lastKnownPos[1] : 49.8375;
  const refLng = _lastKnownPos ? _lastKnownPos[0] : 24.0272;

  // Primary: search GeoJSON parking names — always available after map load, no external requests
  if (geojsonData) {
    const seen = new Set();
    const matches = [];
    geojsonData.features
      .filter(f => {
        const n = parseParkingData(f.properties).mainName.toLowerCase();
        // Match if full name starts with query OR any significant word (4+ chars) starts with query
        return n.startsWith(qLow) ||
          n.split(/[\s.,]+/).some(w => w.length >= 4 && w.startsWith(qLow));
      })
      .sort((a, b) => {
        const [aLng, aLat] = a.geometry.coordinates;
        const [bLng, bLat] = b.geometry.coordinates;
        return haversineKm(refLat, refLng, aLat, aLng) - haversineKm(refLat, refLng, bLat, bLng);
      })
      .forEach(f => {
        const d = parseParkingData(f.properties);
        if (seen.has(d.mainName)) return;
        seen.add(d.mainName);
        const [lng, lat] = f.geometry.coordinates;
        matches.push({ name: d.mainName, lat, lng });
      });
    _renderSuggestions(matches.slice(0, 15));
    return;
  }

  // Fallback: Overpass local street index
  if (_lvivStreets && _lvivStreets.length > 0) {
    const matches = _lvivStreets
      .filter(s => s.name.toLowerCase().startsWith(qLow))
      .sort((a, b) => haversineKm(refLat, refLng, a.lat, a.lng) - haversineKm(refLat, refLng, b.lat, b.lng));
    _renderSuggestions(matches);
    return;
  }

  // Last resort: Mapbox geocoding
  _geoDebounce = setTimeout(() => {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`
      + `?proximity=24.0272,49.8375&types=address&language=uk&country=UA`
      + `&bbox=23.85,49.77,24.25,49.92&limit=10&access_token=${mapboxgl.accessToken}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const items = (data.features || [])
          .filter(f => f.text && f.text.toLowerCase().startsWith(qLow))
          .map(f => ({ name: f.text, lat: f.center[1], lng: f.center[0] }));
        _renderSuggestions(items);
      })
      .catch(() => _hideSuggestions());
  }, 300);
});

// Clear button: wipe input, hide suggestions, re-focus
searchClearBtn && searchClearBtn.addEventListener('click', () => {
  if (!searchPanelInput) return;
  searchPanelInput.value = '';
  searchClearBtn.classList.add('hidden');
  _hideSuggestions();
  searchPanelInput.focus();
});

// ── Calculate price drum picker ───────────────────────────────────────

function resetDrumPicker() {
  const morph = document.getElementById('price-morph');
  if (!morph) return;
  morph.classList.remove('is-open');
}

(function initDrumPicker() {
  const morph  = document.getElementById('price-morph');
  const header = document.getElementById('price-morph-header');
  if (!morph || !header) return;

  let days = 0, hours = 0;
  const MAX_DAYS = 7, MAX_HOURS = 23;

  function wrap(val, max) {
    return ((val % (max + 1)) + (max + 1)) % (max + 1);
  }

  // Animate the active value element — add class BEFORE updating text so the
  // new value appears while the element is still invisible (opacity:0 fill-mode).
  function triggerAnim(el, dir) {
    const cls = dir > 0 ? 'drum-anim-up' : 'drum-anim-down';
    el.classList.remove('drum-anim-up', 'drum-anim-down');
    void el.offsetWidth; // force reflow so removing+re-adding restarts animation
    el.classList.add(cls);
  }

  // dayDir / hourDir: +1 = scroll up (value increases), -1 = scroll down, 0 = no animation
  function render(dayDir, hourDir) {
    const dayValEl  = document.getElementById('drum-day-val');
    const hourValEl = document.getElementById('drum-hour-val');

    // Trigger slide animation before updating text (element is invisible during update)
    if (dayDir)  triggerAnim(dayValEl,  dayDir);
    if (hourDir) triggerAnim(hourValEl, hourDir);

    // Update all values
    dayValEl.textContent  = days;
    hourValEl.textContent = hours;
    document.getElementById('drum-day-prev2').textContent  = wrap(days  - 2, MAX_DAYS);
    document.getElementById('drum-day-prev').textContent   = wrap(days  - 1, MAX_DAYS);
    document.getElementById('drum-day-next').textContent   = wrap(days  + 1, MAX_DAYS);
    document.getElementById('drum-day-next2').textContent  = wrap(days  + 2, MAX_DAYS);
    document.getElementById('drum-hour-prev2').textContent = wrap(hours - 2, MAX_HOURS);
    document.getElementById('drum-hour-prev').textContent  = wrap(hours - 1, MAX_HOURS);
    document.getElementById('drum-hour-next').textContent  = wrap(hours + 1, MAX_HOURS);
    document.getElementById('drum-hour-next2').textContent = wrap(hours + 2, MAX_HOURS);

    const total = Math.round((days * 24 + hours) * _drumRate);
    document.getElementById('drum-price').textContent = total + ' грн';
  }

  // anim=true on scroll/click, false during drag (drag is its own visual feedback)
  function makeDraggable(colEl, onChange) {
    let startY = 0, prevSteps = 0;
    colEl.style.cursor = 'ns-resize';
    colEl.style.userSelect = 'none';
    colEl.style.touchAction = 'none';

    colEl.addEventListener('pointerdown', e => {
      startY = e.clientY;
      prevSteps = 0;
      colEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    colEl.addEventListener('pointermove', e => {
      if (!colEl.hasPointerCapture(e.pointerId)) return;
      const dy = startY - e.clientY;
      const steps = Math.floor(Math.abs(dy) / 24) * Math.sign(dy);
      const delta = steps - prevSteps;
      if (delta !== 0) { prevSteps = steps; onChange(delta, false); }
    });

    colEl.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      onChange(e.deltaY > 0 ? 1 : -1, true);
    }, { passive: false });
  }

  makeDraggable(
    document.getElementById('drum-col-days'),
    (delta, anim) => { days  = wrap(days  + delta, MAX_DAYS);  render(anim ? Math.sign(delta) : 0, 0); }
  );
  makeDraggable(
    document.getElementById('drum-col-hours'),
    (delta, anim) => { hours = wrap(hours + delta, MAX_HOURS); render(0, anim ? Math.sign(delta) : 0); }
  );

  // Tap ghost rows to step values — always animated
  document.getElementById('drum-day-prev2').addEventListener('click',  () => { days  = wrap(days  - 2, MAX_DAYS);  render(-1, 0); });
  document.getElementById('drum-day-prev').addEventListener('click',   () => { days  = wrap(days  - 1, MAX_DAYS);  render(-1, 0); });
  document.getElementById('drum-day-next').addEventListener('click',   () => { days  = wrap(days  + 1, MAX_DAYS);  render( 1, 0); });
  document.getElementById('drum-day-next2').addEventListener('click',  () => { days  = wrap(days  + 2, MAX_DAYS);  render( 1, 0); });
  document.getElementById('drum-hour-prev2').addEventListener('click', () => { hours = wrap(hours - 2, MAX_HOURS); render(0, -1); });
  document.getElementById('drum-hour-prev').addEventListener('click',  () => { hours = wrap(hours - 1, MAX_HOURS); render(0, -1); });
  document.getElementById('drum-hour-next').addEventListener('click',  () => { hours = wrap(hours + 1, MAX_HOURS); render(0,  1); });
  document.getElementById('drum-hour-next2').addEventListener('click', () => { hours = wrap(hours + 2, MAX_HOURS); render(0,  1); });

  function openPicker() {
    days = 0; hours = 0;
    render(0, 0);
    morph.classList.add('is-open');
  }

  function closePicker() {
    morph.classList.remove('is-open');
  }

  header.addEventListener('click', () => {
    morph.classList.contains('is-open') ? closePicker() : openPicker();
  });
})();

// ── Account flow ──────────────────────────────────────────────────────

const accountPanel      = $('account-panel');
const verifyMethodPanel = $('verify-method-panel');
const otpPanel          = $('otp-panel');
const changePwdPanel    = $('change-pwd-panel');
const cardsPanel        = $('cards-panel');
const addCardPanel      = $('add-card-panel');
const toastEl           = $('toast');

const notificationsPanel      = $('notifications-panel');
const notificationDetailPanel = $('notification-detail-panel');
const favoritesPanel          = $('favorites-panel');
const historyPanel            = $('history-panel');
const settingsPanel           = $('settings-panel');
const supportPanel            = $('support-panel');
const carsPanel               = $('cars-panel');
const addCarPanel             = $('add-car-panel');

const allAccountPanels = [accountPanel, verifyMethodPanel, otpPanel, changePwdPanel, cardsPanel, addCardPanel, notificationsPanel, notificationDetailPanel, favoritesPanel, historyPanel, settingsPanel, supportPanel, carsPanel, addCarPanel];

function openAccountPanel(panel) {
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeAccountPanel(panel) {
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
}

function closeAllAccountPanels() {
  allAccountPanels.forEach(closeAccountPanel);
}

// Toast
let _toastTimer = null;
function showToast(msg) {
  $('toast-text').textContent = msg;
  toastEl.classList.add('is-visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 3000);
}

// Drawer → Screen 1
on($('btn-nav-account'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(accountPanel);
});

// Drawer → Cards
on($('btn-nav-cards'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(cardsPanel);
});

on($('btn-settings-back'), 'click', () => closeAccountPanel(settingsPanel));

on($('btn-nav-settings'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(settingsPanel);
});

on($('btn-support-back'), 'click', () => closeAccountPanel(supportPanel));

on($('btn-nav-support'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(supportPanel);
});

// Settings: reminder toggle
const reminderToggle = $('toggle-reminder');
on(reminderToggle, 'click', () => reminderToggle.classList.toggle('is-off'));

// Settings: dark theme toggle (synced with main btn-theme)
const darkThemeToggle = $('toggle-dark-theme');
on(darkThemeToggle, 'click', () => {
  $('btn-theme').click();
  darkThemeToggle.classList.toggle('is-off');
});

// Settings: checkboxes
document.querySelectorAll('.settings-checkbox-item').forEach(item => {
  item.addEventListener('click', () => {
    item.querySelector('.settings-checkbox').classList.toggle('is-checked');
  });
});

on($('btn-history-back'), 'click', () => closeAccountPanel(historyPanel));

on($('btn-nav-history'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(historyPanel);
});

on($('btn-cars-back'),      'click', () => closeAccountPanel(carsPanel));

// Car selection — tap item to select, ignore taps on the delete button
document.querySelectorAll('.car-item').forEach(item => {
  item.addEventListener('click', e => {
    if (e.target.closest('.car-item__delete')) return;
    document.querySelectorAll('.car-item').forEach(c => {
      c.classList.remove('car-item--active');
      c.setAttribute('aria-checked', 'false');
    });
    item.classList.add('car-item--active');
    item.setAttribute('aria-checked', 'true');

    const plate = item.querySelector('.car-item__number').textContent.trim();
    document.querySelectorAll('.plate-widget__number').forEach(el => el.textContent = plate);
    document.querySelectorAll('.plate-widget').forEach(btn => {
      btn.setAttribute('aria-label', `Автомобіль: ${plate}`);
    });
  });
});
on($('btn-plate'),          'click', () => openAccountPanel(carsPanel));
on($('btn-plate-parked'),   'click', () => openAccountPanel(carsPanel));
on($('btn-plate-payment'),  'click', () => openAccountPanel(carsPanel));
on($('btn-plate-drawer'),   'click', () => { closeDrawer(); openAccountPanel(carsPanel); });

on($('btn-add-car-back'),   'click', () => closeAccountPanel(addCarPanel));
on($('btn-confirm-car'),    'click', () => {
  closeAccountPanel(addCarPanel);
  closeAccountPanel(carsPanel);
  showSuccessPopup('Автомобіль додано', 'Номер успішно збережено');
});

on($('toggle-std-plate'), 'click', () => {
  const t = $('toggle-std-plate');
  const isOn = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', String(isOn));
  $('add-car-form').classList.toggle('std-on', isOn);
});

document.querySelector('.cars-add-btn') &&
  document.querySelector('.cars-add-btn').addEventListener('click', () => openAccountPanel(addCarPanel));

on($('btn-favorites-back'), 'click', () => closeAccountPanel(favoritesPanel));

on($('btn-nav-favorites'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(favoritesPanel);
});

on($('btn-notifications-back'), 'click', () => closeAccountPanel(notificationsPanel));
on($('btn-notification-detail-back'), 'click', () => closeAccountPanel(notificationDetailPanel));

on($('notif-item-1'), 'click', () => openAccountPanel(notificationDetailPanel));
on($('notif-item-2'), 'click', () => openAccountPanel(notificationDetailPanel));

on($('btn-nav-notifications'), 'click', e => {
  e.preventDefault();
  closeDrawer();
  openAccountPanel(notificationsPanel);
});

on($('btn-cards-close'), 'click', closeAllAccountPanels);

// Delete card confirmation
const modalDeleteCard = $('modal-delete-card');
let cardToDelete = null;

document.querySelectorAll('.credit-card__delete').forEach(btn => {
  btn.addEventListener('click', () => {
    cardToDelete = btn.closest('.credit-card');
    $('card-delete-preview').innerHTML = cardToDelete.querySelector('.credit-card__top').innerHTML;
    modalDeleteCard.classList.remove('hidden');
  });
});

on($('btn-confirm-delete'), 'click', () => {
  if (cardToDelete) { cardToDelete.remove(); cardToDelete = null; }
  modalDeleteCard.classList.add('hidden');
});

on($('btn-cancel-delete'), 'click', () => {
  cardToDelete = null;
  modalDeleteCard.classList.add('hidden');
});

on($('btn-add-card'), 'click', () => openAccountPanel(addCardPanel));
on($('btn-add-card-back'), 'click', () => closeAccountPanel(addCardPanel));
on($('btn-confirm-card'), 'click', () => {
  closeAllAccountPanels();
  showSuccessPopup('Картку додано', 'Ваша картка успішно збережена');
});

// Screen 1: back / change-password / delete
on($('btn-account-close'), 'click', closeAllAccountPanels);

on($('btn-change-password'), 'click', () => {
  openAccountPanel(verifyMethodPanel);
});

on($('btn-delete-account'), 'click', () => {
  // Prototype: no-op
  console.log('→ delete account (not implemented)');
});

// Screen 2: method selection — tap card → go straight to OTP
let _selectedMethod = null;

document.querySelectorAll('.method-card').forEach(card => {
  card.addEventListener('click', () => {
    _selectedMethod = card.dataset.method;
    const dest = _selectedMethod === 'email'
      ? 'darianmildellis@gmail.com'
      : '+38 (099) 123 45 67';
    $('otp-info-dest').textContent = dest;
    $('otp-code-input').value = '';
    updateOtpConfirmBtn();
    startResendTimer();
    openAccountPanel(otpPanel);
  });
});

on($('btn-verify-method-back'), 'click', () => {
  closeAccountPanel(verifyMethodPanel);
  _selectedMethod = null;
});

// Screen 3: OTP
const otpInput = $('otp-code-input');

function updateOtpConfirmBtn() {
  const full = otpInput && otpInput.value.length >= 6;
  const btn = $('btn-confirm-otp');
  btn.disabled = !full;
  btn.toggleAttribute('aria-disabled', !full);
}

otpInput && otpInput.addEventListener('input', () => {
  otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
  updateOtpConfirmBtn();
});

on($('btn-otp-back'), 'click', () => {
  closeAccountPanel(otpPanel);
  clearResendTimer();
  if (otpInput) { otpInput.value = ''; updateOtpConfirmBtn(); }
});

on($('btn-confirm-otp'), 'click', () => {
  if (!otpInput || otpInput.value.length !== 6) return;
  clearResendTimer();
  $('new-password').value = '';
  $('confirm-password').value = '';
  $('pwd-error').textContent = '';
  openAccountPanel(changePwdPanel);
});

// Resend timer
let _resendInterval = null;

function startResendTimer() {
  let secs = 59;
  const btn = $('btn-resend');
  const timerText = $('otp-timer-text');
  btn.disabled = true;
  btn.setAttribute('aria-disabled', 'true');
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (timerText) { timerText.textContent = `Надіслати знову через ${fmt(secs)}`; timerText.classList.remove('hidden'); }
  clearInterval(_resendInterval);
  _resendInterval = setInterval(() => {
    secs--;
    if (secs > 0) {
      if (timerText) timerText.textContent = `Надіслати знову через ${fmt(secs)}`;
    } else {
      clearInterval(_resendInterval);
      btn.disabled = false;
      btn.removeAttribute('aria-disabled');
      if (timerText) timerText.classList.add('hidden');
    }
  }, 1000);
}

function clearResendTimer() {
  clearInterval(_resendInterval);
}

on($('btn-resend'), 'click', () => startResendTimer());

// Screen 4: Change password
function updateSaveBtn() {
  const ok = $('new-password').value.length >= 9;
  $('btn-save-password').disabled = !ok;
  $('btn-save-password').toggleAttribute('aria-disabled', !ok);
}

on($('new-password'),      'input', updateSaveBtn);
on($('confirm-password'),  'input', updateSaveBtn);

on($('btn-change-pwd-back'), 'click', () => closeAccountPanel(changePwdPanel));

const SVG_EYE_OPEN   = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_CLOSED = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function makeEyeToggle(toggleId, inputId) {
  const btn = $(toggleId);
  if (!btn) return;
  btn.innerHTML = SVG_EYE_OPEN;
  btn.addEventListener('click', () => {
    const input = $(inputId);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? SVG_EYE_OPEN : SVG_EYE_CLOSED;
    btn.setAttribute('aria-label', showing ? 'Показати пароль' : 'Приховати пароль');
  });
}

makeEyeToggle('toggle-new-pwd',     'new-password');
makeEyeToggle('toggle-confirm-pwd', 'confirm-password');

on($('btn-save-password'), 'click', () => {
  const newPwd  = $('new-password').value;
  const confirm = $('confirm-password').value;
  const errEl   = $('pwd-error');

  if (newPwd.length < 8 || newPwd !== confirm) {
    errEl.textContent = '*Паролі не співпадають';
    return;
  }

  closeAllAccountPanels();
  showToast('Пароль успішно оновлено!');
});

// ── Voice Search ──────────────────────────────────────────────────────

const voiceOverlay = $('voice-overlay');
const voiceStatus  = $('voice-status');
const voiceTranscript = $('voice-transcript');
let _recognition = null;
let _voiceActive = false;

// Strip street-type prefixes before fuzzy matching
function _extractStreetQuery(raw) {
  return raw
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\b(вулиця|вул|проспект|просп|бульвар|бул|площа|пл|провулок|пров|набережна|узвіз|алея|шосе|тупик)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _matchStreet(query) {
  if (!_lvivStreets || !_lvivStreets.length || !query) return null;
  const q = query.toLowerCase();
  // 1. Exact match
  let found = _lvivStreets.find(s => s.name.toLowerCase() === q);
  if (found) return found;
  // 2. Starts-with match (e.g. "стефаника" matches "вулиця Стефаника")
  found = _lvivStreets.find(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase().replace(/^.+\s/, '')));
  if (found) return found;
  // 3. Word overlap (last word of street name in query or vice versa)
  const qWords = q.split(/\s+/).filter(w => w.length > 2);
  found = _lvivStreets.find(s => {
    const sWords = s.name.toLowerCase().split(/\s+/);
    return qWords.some(qw => sWords.some(sw => sw.startsWith(qw) || qw.startsWith(sw)));
  });
  return found || null;
}

function openVoiceOverlay() {
  voiceOverlay.classList.add('is-open');
  voiceOverlay.setAttribute('aria-hidden', 'false');
  voiceStatus.textContent = 'Говоріть';
  voiceStatus.className = 'voice-overlay__status voice-overlay__status--listening';
  voiceTranscript.textContent = '';
  _startRecognition();
}

function closeVoiceOverlay() {
  voiceOverlay.classList.remove('is-open', 'is-listening');
  voiceOverlay.setAttribute('aria-hidden', 'true');
  _stopRecognition();
}

function _startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    voiceStatus.textContent = 'Голосовий пошук не підтримується';
    voiceStatus.className = 'voice-overlay__status voice-overlay__status--error';
    return;
  }
  _stopRecognition();
  _recognition = new SR();
  _recognition.lang = 'uk-UA';
  _recognition.interimResults = true;
  _recognition.maxAlternatives = 3;
  _voiceActive = true;
  voiceOverlay.classList.add('is-listening');

  _recognition.onresult = e => {
    const interim = [...e.results].map(r => r[0].transcript).join(' ');
    voiceTranscript.textContent = interim;
    if (e.results[e.results.length - 1].isFinal) {
      _processVoiceResult(e.results);
    }
  };

  _recognition.onerror = err => {
    voiceOverlay.classList.remove('is-listening');
    if (err.error === 'no-speech') {
      voiceStatus.textContent = 'Не почули. Спробуйте ще раз';
    } else if (err.error === 'not-allowed') {
      voiceStatus.textContent = 'Доступ до мікрофону заблоковано';
    } else {
      voiceStatus.textContent = 'Помилка. Спробуйте ще раз';
    }
    voiceStatus.className = 'voice-overlay__status voice-overlay__status--error';
  };

  _recognition.onend = () => {
    voiceOverlay.classList.remove('is-listening');
    _voiceActive = false;
  };

  _recognition.start();
}

function _stopRecognition() {
  if (_recognition) {
    try { _recognition.abort(); } catch(_) {}
    _recognition = null;
  }
  _voiceActive = false;
  voiceOverlay.classList.remove('is-listening');
}

async function _processVoiceResult(results) {
  // Wait for streets to load (max 6s)
  if (!_lvivStreets || _lvivStreets.length === 0) {
    voiceStatus.textContent = 'Завантаження...';
    voiceTranscript.textContent = '';
    _loadLvivStreets();
    await new Promise(res => {
      let attempts = 0;
      const id = setInterval(() => {
        if ((_lvivStreets && _lvivStreets.length > 0) || ++attempts > 30) {
          clearInterval(id); res();
        }
      }, 200);
    });
  }

  // Collect all alternatives
  const candidates = [];
  for (const result of results) {
    for (let i = 0; i < result.length; i++) {
      candidates.push(result[i].transcript);
    }
  }

  // Try each candidate until a street is found
  let match = null;
  for (const text of candidates) {
    const query = _extractStreetQuery(text);
    match = _matchStreet(query);
    if (match) break;
  }

  if (match) {
    voiceStatus.textContent = match.name;
    voiceStatus.className = 'voice-overlay__status voice-overlay__status--success';
    voiceTranscript.textContent = '';
    setTimeout(() => {
      closeVoiceOverlay();
      closeSearchPanel(false);
      map.flyTo({ center: [match.lng, match.lat], zoom: 15, duration: 600 });
      openSearchPanel();
      if (searchPanelInput) {
        searchPanelInput.value = match.name;
        if (searchClearBtn) searchClearBtn.classList.remove('hidden');
      }
      _isShowingNearby = true;
      _lastSearchLat   = match.lat;
      _lastSearchLng   = match.lng;
      const nearby = _getNearbyParkings(match.lat, match.lng);
      populateSearchCards(nearby.length ? nearby : _recentlyViewed);
      const hdr = document.querySelector('.search-panel__section-hdr');
      if (hdr && nearby.length) hdr.textContent = 'Парковки поруч';
      // Set context so map bar shows the address after user selects a parking
      _setSearchContext(match.name, match.lat, match.lng);
    }, 900);
  } else {
    voiceStatus.textContent = 'Вулицю не розпізнано. Спробувати ще раз?';
    voiceStatus.className = 'voice-overlay__status voice-overlay__status--error';
    voiceTranscript.textContent = '';
    // Offer retry via mic button
  }
}

// Bind mic buttons
on($('search-panel-mic'), 'click', openVoiceOverlay);
// Also bind the map search bar mic (opens search panel + voice)
document.querySelector('.search-bar-wrap .search-mic-btn')?.addEventListener('click', () => {
  openSearchPanel();
  setTimeout(openVoiceOverlay, 350);
});

on($('voice-close'),   'click', closeVoiceOverlay);
on($('voice-mic-btn'), 'click', () => {
  if (_voiceActive) {
    _stopRecognition();
  } else {
    voiceStatus.textContent = 'Говоріть';
    voiceStatus.className = 'voice-overlay__status voice-overlay__status--listening';
    voiceTranscript.textContent = '';
    _startRecognition();
  }
});
