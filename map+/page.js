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
   Geocoding
   ========================================================= */

let geocoder = L.Control.Geocoder && L.Control.Geocoder.nominatim();

async function geocode(address) {
  const results = await geocoder.geocode(address);
  return results[0]?.center || null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scan(tableId, records, mappings) {
  if (!writeAccess || !geocoder) return;
  for (const record of records) {
    if (!record[Geocode]) continue;
    const address = record[Address];
    if (!address) continue;
    if (record[GeocodedAddress] === address) continue;

    const result = await geocode(address);
    if (!result) continue;

    await grist.docApi.applyUserActions([
      ['UpdateRecord', tableId, record.id, {
        [mappings[Longitude]]: result.lng,
        [mappings[Latitude]]: result.lat,
        ...(GeocodedAddress in mappings ? { [mappings[GeocodedAddress]]: address } : {})
      }]
    ]);
    await delay(1000);
  }
}

function scanOnNeed(mappings) {
  if (!scanning && selectedTableId && selectedRecords) {
    scanning = scan(selectedTableId, selectedRecords, mappings).finally(() => scanning = null);
  }
}

/* =========================================================
   Map rendering with MarkerCluster + Spiderfy
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

  // --- MarkerCluster Group ---
  const clusterGroup = L.markerClusterGroup({
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    maxClusterRadius: 1 // permet de spiderfy même pour points identiques
  });

  // --- Création des markers ---
  for (const rec of data) {
    const { id, name, lng, lat, color } = getInfo(rec);
    if (lat == null || lng == null) continue;

    points.push([lat, lng]);

    const marker = L.marker([lat, lng], {
      icon: createSvgMarker(color, id === selectedRowId),
      title: name,
      id
    });

    marker.bindPopup(name);
    marker.on('click', () => selectMarker(id));

    clusterGroup.addLayer(marker);
    popups[id] = marker;
  }

  map.addLayer(clusterGroup);

  clearMarkers = () => {
    clusterGroup.clearLayers();
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
  scanOnNeed(mappings);
});

grist.onRecords((data, mappings) => {
  lastRecords = grist.mapColumnNames(data) || data;
  updateMap(lastRecords);
  scanOnNeed(mappings);
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
