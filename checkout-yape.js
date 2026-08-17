// Checkout con Yape/Plin (QR + comprobante). Pago sin pasarela: el cliente paga
// desde su app y sube captura o N° de operación; el pedido queda pendiente de
// verificación manual (ver api/yape/order.js). Requiere que la página ya defina
// `cart`, `cartSubtotal()`, `computeDeliveryFee()`, el input #deliveryDate y
// customer-storage.js (ver index.html / tienda.html).
(function () {
  // Yape y Plin usan números distintos — no son la misma cuenta.
  const YAPE_NUMBER = '913897717';
  const PLIN_NUMBER = '983845722';
  const YAPE_FIELD_IDS = { firstName: 'yapeFirstName', lastName: 'yapeLastName', email: 'yapeEmail', phone: 'yapePhone' };
  const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

  let lastOrderId = null;
  let lastAmount = null;
  let selectedProofType = 'image';

  function ensureYapeModal() {
    if (document.getElementById('yapeModal')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'yapeModal';
    overlay.innerHTML = `
      <div class="modal-box izipay-modal-box">
        <button type="button" class="modal-close" id="yapeModalClose" aria-label="Cerrar">✕</button>
        <div class="izipay-modal-icon">📱</div>
        <h3 class="modal-title">Pagar con Yape / Plin</h3>
        <p class="izipay-lock-hint">✅ Verificamos tu pago y te confirmamos por WhatsApp</p>

        <div id="yapeStepForm">
          <div class="izipay-field"><label>Nombre</label><input type="text" id="yapeFirstName" placeholder="María"/></div>
          <div class="izipay-field"><label>Apellido</label><input type="text" id="yapeLastName" placeholder="Gómez"/></div>
          <div class="izipay-field"><label>Email</label><input type="email" id="yapeEmail" placeholder="maria@correo.com"/></div>
          <div class="izipay-field"><label>Teléfono</label><input type="tel" id="yapePhone" placeholder="987654321"/></div>
          <p class="izipay-error" id="yapeFormError" style="display:none;"></p>
          <button type="button" class="btn btn--sky btn--full" id="yapeContinueBtn">Continuar 🔒</button>
        </div>

        <div id="yapeStepPay" style="display:none;">
          <div class="yape-qr-box">
            <div class="yape-account-row">
              <img src="yape-qr.png" alt="QR Yape" class="yape-qr-img" onerror="this.style.display='none'"/>
              <div class="yape-number-row">
                <span>🟣 Yape: <strong>913 897 717</strong></span>
                <button type="button" class="btn btn--secondary yape-copy-btn" data-number="${YAPE_NUMBER}" style="padding:6px 14px;font-size:.8rem;">Copiar</button>
              </div>
            </div>
            <div class="yape-account-row">
              <img src="plin-qr.png" alt="QR Plin" class="yape-qr-img" onerror="this.style.display='none'"/>
              <div class="yape-number-row">
                <span>🔵 Plin: <strong>983 845 722</strong></span>
                <button type="button" class="btn btn--secondary yape-copy-btn" data-number="${PLIN_NUMBER}" style="padding:6px 14px;font-size:.8rem;">Copiar</button>
              </div>
            </div>
            <div class="yape-amount">Monto a pagar: <strong id="yapeAmountText">S/ —</strong></div>
            <p class="date-hint">A nombre de Santa Patita</p>
          </div>

          <div class="izipay-field" style="margin-top:16px;">
            <label>¿Cómo confirmas tu pago?</label>
            <div class="yape-proof-toggle">
              <button type="button" class="btn btn--secondary yape-proof-btn is-active" id="yapeProofImageBtn">📷 Subir captura</button>
              <button type="button" class="btn btn--secondary yape-proof-btn" id="yapeProofOpBtn">🔢 N° de operación</button>
            </div>
          </div>

          <div id="yapeProofImageWrap" class="izipay-field">
            <input type="file" id="yapeProofImageInput" accept="image/png,image/jpeg,image/webp"/>
          </div>
          <div id="yapeProofOpWrap" class="izipay-field" style="display:none;">
            <input type="text" id="yapeProofOpInput" placeholder="Ej. 00123456" maxlength="40"/>
          </div>

          <p class="izipay-error" id="yapePayError" style="display:none;"></p>
          <button type="button" class="btn btn--yellow btn--full" id="yapeSubmitBtn">Ya pagué, enviar comprobante 🐾</button>
        </div>

        <div id="yapeStepSuccess" style="display:none; text-align:center;">
          <p class="izipay-success-icon">🕐</p>
          <p class="izipay-success-text">Recibimos tu pedido. Verificamos el pago y te confirmamos por WhatsApp.</p>
          <a class="btn btn--yellow btn--full" id="yapeWhatsappBtn" target="_blank">Escribir por WhatsApp</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('yapeModalClose').addEventListener('click', closeYapeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYapeModal(); });
    document.getElementById('yapeContinueBtn').addEventListener('click', goToPayStep);
    overlay.querySelectorAll('.yape-copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => copyNumber(btn.dataset.number, btn));
    });
    document.getElementById('yapeProofImageBtn').addEventListener('click', () => setProofType('image'));
    document.getElementById('yapeProofOpBtn').addEventListener('click', () => setProofType('operation'));
    document.getElementById('yapeSubmitBtn').addEventListener('click', submitYapeOrder);

    window.SantaPatitaCustomer.restore(YAPE_FIELD_IDS);
  }

  function setProofType(type) {
    selectedProofType = type;
    document.getElementById('yapeProofImageBtn').classList.toggle('is-active', type === 'image');
    document.getElementById('yapeProofOpBtn').classList.toggle('is-active', type === 'operation');
    document.getElementById('yapeProofImageWrap').style.display = type === 'image' ? 'block' : 'none';
    document.getElementById('yapeProofOpWrap').style.display = type === 'operation' ? 'block' : 'none';
  }

  function copyNumber(number, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(number).then(() => {
        const original = btn.textContent;
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = original; }, 1500);
      }).catch(() => {});
    }
  }

  function showFormError(msg) {
    const el = document.getElementById('yapeFormError');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function showPayError(msg) {
    const el = document.getElementById('yapePayError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function resetYapeSteps() {
    document.getElementById('yapeStepForm').style.display = 'block';
    document.getElementById('yapeStepPay').style.display = 'none';
    document.getElementById('yapeStepSuccess').style.display = 'none';
    document.getElementById('yapeFormError').style.display = 'none';
    document.getElementById('yapePayError').style.display = 'none';
    setProofType('image');
  }

  window.openYapeCheckout = function () {
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
      trackInitiateCheckout(value, numItems, ids, { content_category: 'yape_plin' });
    }

    ensureYapeModal();
    resetYapeSteps();
    document.getElementById('yapeModal').classList.add('open');
  };

  window.closeYapeModal = function () {
    const modal = document.getElementById('yapeModal');
    if (modal) modal.classList.remove('open');
  };

  function goToPayStep() {
    const firstName = document.getElementById('yapeFirstName').value.trim();
    const lastName = document.getElementById('yapeLastName').value.trim();
    const email = document.getElementById('yapeEmail').value.trim();
    const phone = document.getElementById('yapePhone').value.trim();

    document.getElementById('yapeFormError').style.display = 'none';
    if (!firstName || !lastName || !email || !phone) {
      showFormError('🐾 Completa nombre, apellido, email y teléfono para continuar.');
      return;
    }

    const deliveryType = document.querySelector('input[name=delivery]:checked').value;
    const district = deliveryType === 'delivery' ? document.getElementById('districtSelect').value : null;
    const address = deliveryType === 'delivery' ? document.getElementById('deliveryAddress').value.trim() : '';
    const lat = document.getElementById('deliveryLat').value;
    const lng = document.getElementById('deliveryLng').value;
    window.SantaPatitaCustomer.save({ firstName, lastName, email, phone, address, district, lat: lat || null, lng: lng || null });

    const subtotal = cartSubtotal();
    const deliveryFee = typeof computeDeliveryFee === 'function'
      ? computeDeliveryFee(deliveryType, district, document.getElementById('deliveryDate').value, subtotal)
      : 0;
    lastAmount = subtotal + deliveryFee;
    document.getElementById('yapeAmountText').textContent = 'S/ ' + lastAmount;

    document.getElementById('yapeStepForm').style.display = 'none';
    document.getElementById('yapeStepPay').style.display = 'block';
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(file);
    });
  }

  async function submitYapeOrder() {
    document.getElementById('yapePayError').style.display = 'none';

    const proof = { type: selectedProofType };
    if (selectedProofType === 'image') {
      const fileInput = document.getElementById('yapeProofImageInput');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { showPayError('🐾 Sube una captura de tu comprobante.'); return; }
      if (file.size > MAX_IMAGE_BYTES) { showPayError('⚠️ La imagen es muy pesada (máx. 3.5MB). Sube una captura más liviana.'); return; }
      try {
        proof.imageBase64 = await readFileAsDataUrl(file);
        proof.imageMimeType = file.type;
      } catch (err) {
        showPayError('⚠️ ' + err.message);
        return;
      }
    } else {
      const operationNumber = document.getElementById('yapeProofOpInput').value.trim();
      if (!operationNumber) { showPayError('🐾 Ingresa el N° de operación de tu pago.'); return; }
      proof.operationNumber = operationNumber;
    }

    const btn = document.getElementById('yapeSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    const deliveryType = document.querySelector('input[name=delivery]:checked').value;
    const district = deliveryType === 'delivery' ? document.getElementById('districtSelect').value : null;
    const lat = document.getElementById('deliveryLat').value;
    const lng = document.getElementById('deliveryLng').value;

    const payload = {
      cart: cart.map((item) => ({ flavor: item.flavor, units: item.units, qty: item.qty })),
      customer: {
        firstName: document.getElementById('yapeFirstName').value.trim(),
        lastName: document.getElementById('yapeLastName').value.trim(),
        email: document.getElementById('yapeEmail').value.trim(),
        phone: document.getElementById('yapePhone').value.trim(),
        address: deliveryType === 'delivery' ? document.getElementById('deliveryAddress').value.trim() : undefined,
      },
      delivery: { type: deliveryType, district, date: document.getElementById('deliveryDate').value, lat: lat || null, lng: lng || null },
      proof,
    };

    let data;
    try {
      const res = await fetch('/api/yape/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo registrar el pedido.');
    } catch (err) {
      showPayError('⚠️ ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Ya pagué, enviar comprobante 🐾';
      return;
    }

    lastOrderId = data.orderId;
    lastAmount = data.amount;

    document.getElementById('yapeStepPay').style.display = 'none';
    document.getElementById('yapeStepSuccess').style.display = 'block';

    let msg = `¡Hola Santa Patita! 🐾 Ya envié el comprobante de mi pago por Yape/Plin ✅\n\n`;
    msg += `🧾 *N° de orden:* ${lastOrderId}\n`;
    msg += `💰 *Total:* S/ ${lastAmount}\n`;
    msg += `\n¿Pueden confirmarme apenas verifiquen el pago? ¡Gracias!`;
    document.getElementById('yapeWhatsappBtn').href = 'https://wa.me/51913897717?text=' + encodeURIComponent(msg);

    if (typeof trackPurchase === 'function') {
      const numItems = cart.reduce((sum, i) => sum + i.qty, 0);
      const ids = cart.map((i) => fbSlug(i.flavor) + '-' + i.units + 'u');
      trackPurchase(lastOrderId, lastAmount, ids, numItems);
    }

    cart.length = 0;
    try { localStorage.removeItem('santapatita_cart'); } catch (e) {}
    if (typeof renderCart === 'function') renderCart();
    if (typeof updateSummary === 'function') updateSummary();

    btn.disabled = false;
    btn.textContent = 'Ya pagué, enviar comprobante 🐾';
  }
})();
