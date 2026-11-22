import { Map, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import mapStyles from "maplibre-gl/dist/maplibre-gl.css?inline";

// Emit the worker and its imports as same-origin production assets.
setWorkerUrl(workerUrl);

let stylesInstalled = false;

/**
 * Renders a lazy-loaded MapLibre locator map for geotagged photographs.
 * Loaded only when the details panel is opened for a photograph with coordinates.
 */
export function mountLocationMap(
  container: HTMLElement,
  center: [number, number],
  locationUrl: string
): Map {
  if (!stylesInstalled) {
    const style = document.createElement("style");
    style.textContent = mapStyles;
    document.head.append(style);
    stylesInstalled = true;
  }
  const map = new Map({
    container,
    style: "https://tiles.openfreemap.org/styles/dark",
    center,
    zoom: 12,
    maxZoom: 19,
    attributionControl: {
      customAttribution: '<a href="https://github.com/openmaptiles/dark-matter-gl-style/blob/master/LICENSE.md" target="_blank" rel="noopener noreferrer">Map style</a>',
    },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), "top-left");
  map
    .getCanvas()
    .setAttribute(
      "aria-label",
      "Photo location map; use arrow keys to pan and plus or minus to zoom"
    );

  if (container.clientWidth < 360 || container.clientHeight < 160) {
    const attribution = container.querySelector<HTMLDetailsElement>(
      ".maplibregl-ctrl-attrib"
    );
    if (attribution) {
      attribution.open = false;
      attribution.classList.remove("maplibregl-compact-show");
    }
  }

  const pin = document.createElement("a");
  pin.className = "pv-map-pin";
  pin.href = locationUrl;
  pin.target = "_blank";
  pin.rel = "noopener noreferrer";
  pin.title = "Open this location in Google Maps";
  pin.setAttribute("aria-label", pin.title);
  new Marker({ element: pin }).setLngLat(center).addTo(map);

  return map;
}
