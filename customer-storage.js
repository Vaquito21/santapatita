// Recordar los datos del cliente (nombre/email/tel/dirección/distrito/pin del
// mapa) entre visitas y entre los distintos modales de pago (tarjeta, Yape/Plin)
// — todos leen y escriben la misma clave, así que vive en un solo lugar.
(function () {
  const CUSTOMER_STORAGE_KEY = 'santapatita_customer';

  function saveCustomerData(data) {
    try { localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  // ids: { firstName, lastName, email, phone } -> ids de los <input> a rellenar.
  function restoreCustomerData(ids) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(CUSTOMER_STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return;

    const addressEl = document.getElementById('deliveryAddress');
    const districtEl = document.getElementById('districtSelect');
    if (addressEl && !addressEl.value && saved.address) {
      addressEl.value = saved.address;
      // La dirección guardada viaja junto con el pin que el cliente confirmó la
      // última vez — sin esto, el campo se rellena pero el mapa queda "vacío"
      // (sin lat/lng) y el cliente tiene que volver a ubicar el pin de cero.
      const latEl = document.getElementById('deliveryLat');
      const lngEl = document.getElementById('deliveryLng');
      if (latEl && saved.lat) latEl.value = saved.lat;
      if (lngEl && saved.lng) lngEl.value = saved.lng;
    }
    if (districtEl && !districtEl.value && saved.district) districtEl.value = saved.district;

    Object.keys(ids || {}).forEach((key) => {
      const el = document.getElementById(ids[key]);
      if (el && !el.value && saved[key]) el.value = saved[key];
    });
  }

  window.SantaPatitaCustomer = { save: saveCustomerData, restore: restoreCustomerData };
})();
