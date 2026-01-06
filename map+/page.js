"use strict";

/* global grist, L, DOMPurify */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';

let mapSource =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
let mapCopyright =
  'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ';

const Name = "Name";
const Longitude = "Longitude";
const Latitude = "Latitude";
const Color = "Color";

let lastRecord;
let lastRecords;

/* =========================================================
   ExtraMarkers – fabrique d’icônes
   ========================================================= */

function createMarkerIcon(color, selected) {
  return L.ExtraMarkers.icon({
    markerColor: color || 'blue',     // accepte 'red' ou '#ff5733'
    shape: selected ? 'star' : 'circle',
    icon: selected ? 'fa-check' : 'fa-circle',
    prefix: 'fa'
  });
}

/* =========================================================
   Utils
   ========================================================= */

function parseValue(v) {
  if (typeof v === 'object' && v !== null && v.value && v.value.startsWith('V(')) {
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
  document.getElementById('map').innerHTML =
    `<div class="error">${txt}</div>`;
}

/* =========================================================
   Carte
   ========================================================= */

let clearMarkers = () => {};

function updateMap(data) {
  data = data || selectedRecords;
  selectedRecords = data;

  if (!data || data.length === 0) {
    showProblem("No data found");
    return;
  }

  if (!(Longitude in data[0] && Latitude in data[0] && Name in data[0])) {
    showProblem(
      "Table must contain Name, Latitude and Longitude columns."
    );
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

  for (const rec of data) {
    const { id, name, lng, lat, color } = getInfo(rec);

    if (!lat || !lng || Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
      continue;
    }

    const isSelected = id === selectedRowId;
    const pt = [lat, lng];
    points.push(pt);

    const marker = L.marker(pt, {
      id,
      title: name,
      pane: isSelected ? 'selectedMarker' : 'otherMarkers',
      icon: createMarkerIcon(color, isSelected)
    });

    // stocker la couleur pour les mises à jour
    marker.options.color = color;

    marker.bindPopup(name);
    marker.on('click', () => selectMarker(id));

    marker.addTo(map);
    popups[id] = marker;
  }

  clearMarkers = () => {
    Object.values(popups).forEach(m => map.removeLayer(m));
    popups = {};
  };

  if (points.length) {
    map.fitBounds(points, { maxZoom: 15 });
  }

  amap = map;

  if (selectedRowId && popups[selectedRowId]) {
    popups[selectedRowId].openPopup();
  }
}

/* =========================================================
   Sélection
   ========================================================= */

function selectMarker(id) {
  if (selectedRowId === id) return;

  // ancien marker
  if (selectedRowId && popups[selectedRowId]) {
    const old = popups[selectedRowId];
    old.setIcon(createMarkerIcon(old.options.color, false));
    old.options.pane = 'otherMarkers';
  }

  selectedRowId = id;

  const marker = popups[id];
  if (!marker) return;

  marker.setIcon(createMarkerIcon(marker.options.color, true));
  marker.options.pane = 'selectedMarker';
  marker.openPopup();

  grist.setCursorPos?.({ rowId: id }).catch(() => {});
}

/* =========================================================
   Grist bindings
   ========================================================= */

function selectOnMap(rec) {
  if (selectedRowId === rec.id) return;
  selectedRowId = rec.id;
  updateMap();
}

grist.onRecord((record) => {
  lastRecord = grist.mapColumnNames(record) || record;
  selectOnMap(lastRecord);
});

grist.onRecords((data) => {
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
    { name: "Color", type: "Text", optional: true }
  ],
  allowSelectBy: true
});

grist.onOptions((options) => {
  mapSource = options?.mapSource ?? mapSource;
  mapCopyright = options?.mapCopyright ?? mapCopyright;
});
