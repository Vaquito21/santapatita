// Mapa de confirmación de dirección (Google Maps + Places Autocomplete).
// Requiere #deliveryAddress, #deliveryMap, #deliveryMapHint, #deliveryLat, #deliveryLng en la página.
(function () {
  const GOOGLE_MAPS_API_KEY = 'AIzaSyC6w85nKZjZ6lYVl_8J3KOqcOU0sT5ABLc';
  const LIMA_CENTER = { lat: -12.0464, lng: -77.0428 };
  const LIMA_BOUNDS = { south: -12.20, west: -77.20, north: -11.90, east: -76.85 };

  let mapsLoadPromise = null;
  let map = null;
  let marker = null;

  function loadGoogleMaps() {
    if (mapsLoadPromise) return mapsLoadPromise;
    mapsLoadPromise = new Promise((resolve, reject) => {
      if (window.google && window.google.maps) { resolve(window.google); return; }
      window.__onGoogleMapsLoaded = () => resolve(window.google);
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=__onGoogleMapsLoaded`;
      script.async = true;
      script.onerror = () => reject(new Error('No se pudo cargar el mapa.'));
      document.head.appendChild(script);
    });
    return mapsLoadPromise;
  }

  function setLatLng(lat, lng) {
    document.getElementById('deliveryLat').value = lat;
    document.getElementById('deliveryLng').value = lng;
    const hint = document.getElementById('deliveryMapHint');
    if (hint) hint.textContent = '📍 Ubicación confirmada — arrastra el pin si no quedó exacta.';
  }

  window.initDeliveryMap = async function () {
    const mapDiv = document.getElementById('deliveryMap');
    const addressInput = document.getElementById('deliveryAddress');
    if (!mapDiv || !addressInput || map) return;

    let google;
    try {
      google = await loadGoogleMaps();
    } catch (err) {
      const hint = document.getElementById('deliveryMapHint');
      if (hint) hint.textContent = '⚠️ No se pudo cargar el mapa. Escribe tu dirección igual, la confirmamos por WhatsApp.';
      return;
    }

    mapDiv.style.display = 'block';
    map = new google.maps.Map(mapDiv, {
      center: LIMA_CENTER, zoom: 12, streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
    });
    marker = new google.maps.Marker({ map, position: LIMA_CENTER, draggable: true });

    const geocoder = new google.maps.Geocoder();

    marker.addListener('dragend', () => {
      const pos = marker.getPosition();
      setLatLng(pos.lat(), pos.lng());
      geocoder.geocode({ location: pos }, (results, status) => {
        if (status === 'OK' && results[0]) addressInput.value = results[0].formatted_address;
      });
    });

    const autocomplete = new google.maps.places.Autocomplete(addressInput, {
      componentRestrictions: { country: 'pe' },
      bounds: LIMA_BOUNDS,
      fields: ['formatted_address', 'geometry'],
    });

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;
      const loc = place.geometry.location;
      map.setCenter(loc);
      map.setZoom(17);
      marker.setPosition(loc);
      setLatLng(loc.lat(), loc.lng());
      if (place.formatted_address) addressInput.value = place.formatted_address;
    });
  };
})();
