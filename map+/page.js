"use strict";

/* global grist, L, DOMPurify */

/* =========================================================
   State
   ========================================================= */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let lastRecord = null;
let lastRecords = null;

let writeAccess = true;
let scanning = null;
let mode = 'multi';

/* =========================================================
   Map configuration
   ========================================================= */

let mapSource =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
let mapCopyright =
  'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ';

/* =========================================================
   Column names
   ========================================================= */

const Name = "Name";
const Longitude = "Longitude";
const Latitude = "Latitude";
const Address = "Address";
const Geocode = "Geocode";
const GeocodedAddress = "GeocodedAddress";
const Color = "Color";

/* =========================================================
   Utils
   ========================================================= */

function parseValue(v) {
  if (typeof v === 'object' && v !== null && v.value?.startsWith('V(')) {
    const payload = JSON.parse(v.value.slice(2, -1));
    return payload.remote || payload.local || payload.parent || payload;
  }
  return v;
}

function getInfo(rec) {
  return {
    id: rec.id,
    name: parseValue(rec[Name]),
    lng: parseValue(rec[Longitude]),
    lat: parseValue(rec[Latitude]),
    color: parseValue(rec[Color])
  };
}

function showProblem(txt) {
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.innerHTML = `<div class="error">${txt}</div>`;
}

/* =========================================================
   Marker SVG factory
   ========================================================= */

function sanitizeColor(color) {
  if (!color) return '#3388ff';
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  if (/^#[0-9a-fA-F]{3}$/.test(color)) return color;
  if (/^[a-zA-Z]+$/.test(color)) return color;
  return '#3388ff';
}

function darkenColor(hex, amount = 30) {
  if (!hex.startsWith('#')) return '#333';
  let num = parseInt(hex.slice(1), 16);
  let r = Math.max(0, (num >> 16) - amount);
  let g = Math.max(0, ((num >> 8) & 0x00FF) - amount);
  let b = Math.max(0, (num & 0x0000FF) - amount);
  return `rgb(${r},${g},${b})`;
}

function createSvgMarker(color, selected = false) {
  const fill = sanitizeColor(color);
  const stroke = selected ? fill : darkenColor(fill, 30);
  const size = selected ? 40 : 36;

  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size + 6],
    html: `
      <svg xmlns="http://www.w3.org/2000/svg"
           width="${size}" height="${size}"
           viewBox="0 0 24 24">
        <path
          d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"
          fill="${fill}"
          stroke="${stroke}"
          stroke-width="1.4"
        />
        <circle cx="12" cy="9" r="3" fill="white"/>
      </svg>
    `
  });
}

/* =========================================================
   Offset circulaire pour points superposés
   ========================================================= */

function offsetLatLng(lat, lng, index, total) {
  const radius = 0.00005; // ~5 mètres
  const angle = (index / total) * Math.PI * 2;
  return [
    lat + Math.sin(angle) * radius,
    lng + Math.cos(angle) * radius
  ];
}

/* =========================================================
   Map rendering
   ========================================================= */

let clearMarkers = () => {};

function updateMap(data) {
  data = data || selectedRecords;
  selectedRecords = data;

  if (!data || !data.length) {
    showProblem("No data found");
    return;
  }
  if (!(Longitude in data[0] && Latitude in data[0])) {
    showProblem("Missing Latitude/Longitude");
    return;
  }

  const tiles = L.tileLayer(mapSource, {
    attribution: DOMPurify.sanitize(mapCopyright, { FORCE_BODY: true })
  });

  if (amap) {
    amap.off();
    amap.remove();
  }

  const map = L.map('map', {
    layers: [tiles],
    wheelPxPerZoomLevel: 90
  });

  map.createPane('selectedMarker').style.zIndex = 620;
  map.createPane('otherMarkers').style.zIndex = 600;

  popups = {};
  const points = [];
  const groups = {};

  /* --- Regroupement par coordonnées exactes --- */
  for (const rec of data) {
    const info = getInfo(rec);
    if (info.lat == null || info.lng == null) continue;

    const key = `${info.lat},${info.lng}`;
    groups[key] ??= [];
    groups[key].push(info);
  }

  /* --- Création des markers avec offset si nécessaire --- */
  Object.values(groups).forEach(group => {
    group.forEach((info, index) => {
      const [lat, lng] =
        group.length > 1
          ? offsetLatLng(info.lat, info.lng, index, group.length)
          : [info.lat, info.lng];

      points.push([lat, lng]);

      const marker = L.marker([lat, lng], {
        icon: createSvgMarker(info.color, info.id === selectedRowId),
        title: info.name,
        id: info.id,
        pane: info.id === selectedRowId ? 'selectedMarker' : 'otherMarkers'
      });

      marker.bindPopup(info.name);
      marker.on('click', () => selectMarker(info.id));

      map.addLayer(marker);
      popups[info.id] = marker;
    });
  });

  clearMarkers = () => {
    Object.values(popups).forEach(m => map.removeLayer(m));
    popups = {};
  };

  if (points.length) map.fitBounds(points, { maxZoom: 15 });

  amap = map;

  if (selectedRowId && popups[selectedRowId]) {
    popups[selectedRowId].openPopup();
  }
}

/* =========================================================
   Selection
   ========================================================= */

function selectMarker(id) {
  if (selectedRowId === id) return;

  if (selectedRowId && popups[selectedRowId]) {
    const oldRec = lastRecords?.find(r => r.id === selectedRowId) || lastRecord;
    popups[selectedRowId].setIcon(
      createSvgMarker(parseValue(oldRec?.Color), false)
    );
  }

  selectedRowId = id;

  const rec = lastRecords?.find(r => r.id === id) || lastRecord;
  const marker = popups[id];
  if (!marker) return;

  marker.setIcon(createSvgMarker(parseValue(rec?.Color), true));
  marker.openPopup();

  grist.setCursorPos?.({ rowId: id }).catch(() => {});
}

/* =========================================================
   Grist bindings
   ========================================================= */

grist.on('message', e => {
  if (e.tableId) selectedTableId = e.tableId;
});

grist.onRecord((record, mappings) => {
  lastRecord = grist.mapColumnNames(record) || record;
  selectMarker(lastRecord.id);
});

grist.onRecords((data, mappings) => {
  lastRecords = grist.mapColumnNames(data) || data;
  updateMap(lastRecords);
});

grist.onNewRecord(() => {
  clearMarkers();
  selectedRowId = null;
});

/* =========================================================
   Widget setup
   ========================================================= */

grist.ready({
  columns: [
    "Name",
    { name: "Longitude", type: "Numeric" },
    { name: "Latitude", type: "Numeric" },
    { name: "Address", type: "Text", optional: true },
    { name: "Geocode", type: "Bool", optional: true },
    { name: "GeocodedAddress", type: "Text", optional: true },
    { name: "Color", type: "Text", optional: true }
  ],
  allowSelectBy: true
});
