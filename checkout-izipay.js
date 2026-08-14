// Checkout con tarjeta (Izipay / Krypton). Requiere que la página ya defina
// `cart`, `cartSubtotal()` y el input #deliveryDate (ver index.html / tienda.html).
(function () {
  const KRYPTON_JS_URL = 'https://static.micuentaweb.pe/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js';
  const KRYPTON_CSS_URL = 'https://static.micuentaweb.pe/static/js/krypton-client/V4.0/ext/classic.css';
  const WHATSAPP_NUMBER = '51913897717';
  const CUSTOMER_STORAGE_KEY = 'santapatita_customer';

  let krLoadPromise = null;
  let submitHandlersAttached = false;
  let lastOrderId = null;
  let lastAmount = null;

  // ── Recordar datos del cliente (nombre/email/tel/dirección/distrito) ──
  function saveCustomerData(data) {
    try { localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreCustomerData() {
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

    const firstNameEl = document.getElementById('izipayFirstName');
    const lastNameEl = document.getElementById('izipayLastName');
    const emailEl = document.getElementById('izipayEmail');
    const phoneEl = document.getElementById('izipayPhone');
    if (firstNameEl && !firstNameEl.value && saved.firstName) firstNameEl.value = saved.firstName;
    if (lastNameEl && !lastNameEl.value && saved.lastName) lastNameEl.value = saved.lastName;
    if (emailEl && !emailEl.value && saved.email) emailEl.value = saved.email;
    if (phoneEl && !phoneEl.value && saved.phone) phoneEl.value = saved.phone;
  }

  function loadKrypton(publicKey) {
    if (krLoadPromise) return krLoadPromise;
    krLoadPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = KRYPTON_CSS_URL;
      document.head.appendChild(link);

      const script = document.createElement('script');
      script.src = KRYPTON_JS_URL;
      script.setAttribute('kr-public-key', publicKey);
      script.setAttribute('kr-language', 'es-PE');
      script.onload = () => resolve(window.KR);
      script.onerror = () => reject(new Error('No se pudo cargar el formulario de pago. Intenta de nuevo.'));
      document.body.appendChild(script);
    });
    return krLoadPromise;
  }

  function ensureModal() {
    if (document.getElementById('izipayModal')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'izipayModal';
    overlay.innerHTML = `
      <div class="modal-box izipay-modal-box">
        <button type="button" class="modal-close" id="izipayModalClose" aria-label="Cerrar">✕</button>
        <div class="izipay-modal-icon">💳</div>
        <h3 class="modal-title">Pagar con tarjeta</h3>
        <p class="izipay-lock-hint">🔒 Pago seguro procesado por Izipay</p>

        <div id="izipayStepForm">
          <div class="izipay-field"><label>Nombre</label><input type="text" id="izipayFirstName" placeholder="María"/></div>
          <div class="izipay-field"><label>Apellido</label><input type="text" id="izipayLastName" placeholder="Gómez"/></div>
          <div class="izipay-field"><label>Email</label><input type="email" id="izipayEmail" placeholder="maria@correo.com"/></div>
          <div class="izipay-field"><label>Teléfono</label><input type="tel" id="izipayPhone" placeholder="987654321"/></div>
          <div class="izipay-field"><label>DNI <span class="izipay-field__hint">(opcional, para tu boleta o factura)</span></label><input type="text" id="izipayDni" placeholder="12345678" maxlength="8"/></div>
          <p class="izipay-error" id="izipayError" style="display:none;"></p>
          <button type="button" class="btn btn--sky btn--full" id="izipayContinueBtn">Continuar al pago 🔒</button>
        </div>

        <div id="izipayStepPayment" style="display:none;">
          <div class="kr-embedded" id="izipayFormZone"></div>
        </div>

        <div id="izipayStepSuccess" style="display:none; text-align:center;">
          <p class="izipay-success-icon">🎉</p>
          <p class="izipay-success-text">¡Pago realizado con éxito! Confírmanos tu pedido por WhatsApp para coordinar la entrega.</p>
          <a class="btn btn--yellow btn--full" id="izipayWhatsappBtn" target="_blank">Confirmar por WhatsApp</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('izipayModalClose').addEventListener('click', closeIzipayModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeIzipayModal(); });
    document.getElementById('izipayContinueBtn').addEventListener('click', startPayment);

    restoreCustomerData();
  }

  function showError(msg) {
    const el = document.getElementById('izipayError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function resetModalSteps() {
    document.getElementById('izipayStepForm').style.display = 'block';
    document.getElementById('izipayStepPayment').style.display = 'none';
    document.getElementById('izipayStepSuccess').style.display = 'none';
    document.getElementById('izipayError').style.display = 'none';
  }

  window.openIzipayCheckout = function () {
    if (typeof cart === 'undefined' || cart.length === 0) { alert('🐾 ¡Agrega al menos un sabor a tu pedido!'); return; }
    const dateInput = document.getElementById('deliveryDate');
    if (!dateInput.value) { alert('🐾 ¡Elige la fecha de entrega!'); return; }
    if (typeof isDeliveryDateValid === 'function' && !isDeliveryDateValid(dateInput.value)) {
      alert('🐾 Necesitamos mínimo 3 días de anticipación. Elige otra fecha.');
      return;
    }

    const deliveryType = document.querySelector('input[name=delivery]:checked').value;
    if (deliveryType === 'delivery') {
      const district = document.getElementById('districtSelect').value;
      const address = document.getElementById('deliveryAddress').value.trim();
      if (!district) { alert('🐾 ¡Elige tu distrito de entrega!'); return; }
      if (!address)  { alert('🐾 ¡Escribe tu dirección exacta!'); return; }
    }

    if (typeof trackInitiateCheckout === 'function') {
      const value = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
      const numItems = cart.reduce((sum, i) => sum + i.qty, 0);
      const ids = cart.map((i) => fbSlug(i.flavor) + '-' + i.units + 'u');
      trackInitiateCheckout(value, numItems, ids);
    }

    ensureModal();
    resetModalSteps();
    document.getElementById('izipayModal').classList.add('open');
  };

  window.closeIzipayModal = function () {
    const modal = document.getElementById('izipayModal');
    if (modal) modal.classList.remove('open');
  };

  async function startPayment() {
    const firstName = document.getElementById('izipayFirstName').value.trim();
    const lastName = document.getElementById('izipayLastName').value.trim();
    const email = document.getElementById('izipayEmail').value.trim();
    const phone = document.getElementById('izipayPhone').value.trim();
    const dni = document.getElementById('izipayDni').value.trim();

    const deliveryType = document.querySelector('input[name=delivery]:checked').value;
    const district = deliveryType === 'delivery' ? document.getElementById('districtSelect').value : null;
    const address = deliveryType === 'delivery' ? document.getElementById('deliveryAddress').value.trim() : '';

    document.getElementById('izipayError').style.display = 'none';

    if (!firstName || !lastName || !email || !phone) {
      showError('🐾 Completa nombre, apellido, email y teléfono para continuar.');
      return;
    }

    const lat = document.getElementById('deliveryLat').value;
    const lng = document.getElementById('deliveryLng').value;

    saveCustomerData({ firstName, lastName, email, phone, address, district, lat: lat || null, lng: lng || null });

    const btn = document.getElementById('izipayContinueBtn');
    btn.disabled = true;
    btn.textContent = 'Procesando...';

    const payload = {
      cart: cart.map(item => ({ flavor: item.flavor, units: item.units, qty: item.qty })),
      customer: { firstName, lastName, email, phone, address, city: district || undefined, identityCode: dni || undefined },
      delivery: { type: deliveryType, district, date: document.getElementById('deliveryDate').value, lat: lat || null, lng: lng || null },
    };

    let data;
    try {
      const res = await fetch('/api/izipay/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo iniciar el pago.');
    } catch (err) {
      showError('⚠️ ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Continuar al pago 🔒';
      return;
    }

    lastOrderId = data.orderId;
    lastAmount = data.amount;

    try {
      const KR = await loadKrypton(data.publicKey);

      document.getElementById('izipayStepForm').style.display = 'none';
      document.getElementById('izipayStepPayment').style.display = 'block';

      await KR.setFormToken(data.formToken);

      if (!submitHandlersAttached) {
        KR.onSubmit(onPaymentSubmit);
        if (typeof KR.onError === 'function') KR.onError(onPaymentError);
        submitHandlersAttached = true;
      }
    } catch (err) {
      document.getElementById('izipayStepPayment').style.display = 'none';
      document.getElementById('izipayStepForm').style.display = 'block';
      showError('⚠️ ' + ((err && err.message) || 'No se pudo mostrar el formulario de pago.'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continuar al pago 🔒';
    }
  }

  function onPaymentSubmit(paymentData) {
    const status = paymentData && paymentData.clientAnswer && paymentData.clientAnswer.orderStatus;
    if (status === 'PAID') {
      document.getElementById('izipayStepPayment').style.display = 'none';
      document.getElementById('izipayStepSuccess').style.display = 'block';

      const deliveryType = document.querySelector('input[name=delivery]:checked').value;
      const district = document.getElementById('districtSelect').value;
      const address = document.getElementById('deliveryAddress').value.trim();

      let msg = `¡Hola Santa Patita! 🐾 Ya pagué mi pedido con tarjeta ✅\n\n`;
      msg += `🧾 *N° de orden:* ${lastOrderId}\n`;
      msg += `💰 *Total pagado:* S/ ${lastAmount}\n\n`;
      msg += `🍖 *Pedido:*\n`;
      cart.forEach(item => { msg += `- ${item.flavor} × ${item.units}u × ${item.qty} paquete(s)\n`; });
      msg += `🚚 *Tipo:* ${deliveryType === 'delivery' ? 'Delivery a domicilio' : 'Recojo en tienda'}\n`;
      if (deliveryType === 'delivery') {
        msg += `📍 *Distrito:* ${district}\n`;
        msg += `🏠 *Dirección:* ${address}\n`;
        const lat = document.getElementById('deliveryLat').value, lng = document.getElementById('deliveryLng').value;
        if (lat && lng) msg += `🗺️ *Ubicación:* https://www.google.com/maps?q=${lat},${lng}\n`;
      }
      msg += `\n¿Pueden confirmarme la entrega? ¡Gracias!`;

      document.getElementById('izipayWhatsappBtn').href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);

      if (typeof trackPurchase === 'function') {
        const numItems = cart.reduce((sum, i) => sum + i.qty, 0);
        const ids = cart.map((i) => fbSlug(i.flavor) + '-' + i.units + 'u');
        trackPurchase(lastOrderId, lastAmount, ids, numItems);
      }

      cart.length = 0;
      try { localStorage.removeItem('santapatita_cart'); } catch (e) {}
      if (typeof renderCart === 'function') renderCart();
      if (typeof updateSummary === 'function') updateSummary();
    } else {
      document.getElementById('izipayStepPayment').style.display = 'none';
      document.getElementById('izipayStepForm').style.display = 'block';
      showError('⚠️ El pago no se completó (estado: ' + status + '). Intenta con otra tarjeta.');
    }
    return false;
  }

  function onPaymentError(error) {
    document.getElementById('izipayStepPayment').style.display = 'none';
    document.getElementById('izipayStepForm').style.display = 'block';
    showError('⚠️ ' + (error && error.errorMessage ? error.errorMessage : 'Ocurrió un error con el pago.'));
  }

  restoreCustomerData();
})();
