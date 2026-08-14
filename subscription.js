// Flujo de suscripción: peso → plan recomendado → mensual/trimestral → datos del perro → pago.
// Espejo en el cliente de la config y las reglas en lib/pricing.js — el servidor
// (api/izipay/create-payment.js) siempre recalcula el monto real, esto es solo para mostrar.
(function () {
  const KRYPTON_JS_URL = 'https://static.micuentaweb.pe/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js';
  const KRYPTON_CSS_URL = 'https://static.micuentaweb.pe/static/js/krypton-client/V4.0/ext/classic.css';
  const WHATSAPP_NUMBER = '51913897717';
  const CUSTOMER_STORAGE_KEY = 'santapatita_customer';

  const PLANS = {
    PATITA: { label: 'Patita', weightLabel: 'Perro hasta 10 kg', monthly: { gummies: 30, price: 27 }, quarterly: { gummies: 90, price: 70 } },
    PATA:   { label: 'Pata',   weightLabel: 'Perro de 10 a 25 kg', monthly: { gummies: 60, price: 50 }, quarterly: { gummies: 180, price: 135 } },
    PATAZA: { label: 'Pataza', weightLabel: '+25 kg o 2 perros',   monthly: { gummies: 90, price: 72 }, quarterly: { gummies: 270, price: 199 } },
  };

  const WEIGHT_TO_PLAN = { hasta10: 'PATITA', '10a25': 'PATA', mas25: 'PATAZA' };

  const DISTRICT_FEES = {
    'Pueblo Libre': 7, 'Breña': 7, 'Jesús María': 7, 'Magdalena': 7, 'San Miguel': 7,
    'Cercado de Lima': 10, 'San Isidro': 10, 'Lince': 10,
    'Miraflores': 12, 'Barranco': 12, 'San Borja': 12, 'Surquillo': 12, 'Surco': 12, 'La Molina': 12,
  };

  const BENEFITS_BASE = [
    'Precio congelado',
    'Cambio de sabor libre',
    'Pausa o cancela cuando quieras',
    'Club Santa Patita',
    'Regalo de cumpleaños de tu perro',
    'Refiere y ganan los dos un mes gratis',
  ];
  const BENEFITS_EXTRA = {
    PATITA: [],
    PATA: ['Dos sabores por entrega', 'Acceso anticipado a sabores nuevos', 'Bandana de bienvenida'],
    PATAZA: ['Entrega prioritaria', 'Kit de bienvenida', '15% en catálogo futuro', 'Perro del Mes en redes'],
  };

  const state = { weightRange: null, planCode: null, cadence: 'monthly', district: '' };

  let krLoadPromise = null;
  let submitHandlersAttached = false;
  let lastOrderId = null;
  let lastAmount = null;

  function money(n) { return `S/ ${n}`; }

  function computeShippingFee(planCode, cadence, district) {
    if (!district || DISTRICT_FEES[district] === undefined) return null;
    if (planCode !== 'PATITA' || cadence === 'quarterly') return 0;
    return DISTRICT_FEES[district];
  }

  function renderPlan() {
    const plan = PLANS[state.planCode];
    if (!plan) return;

    document.getElementById('planName').textContent = `${plan.label} 🐾`;
    document.getElementById('planWeightLabel').textContent = plan.weightLabel;
    document.getElementById('monthlyPrice').innerHTML = `${money(plan.monthly.price)} <span>/mes</span>`;
    document.getElementById('monthlyGummies').textContent = `${plan.monthly.gummies} gomitas/mes`;
    document.getElementById('quarterlyPrice').innerHTML = `${money(plan.quarterly.price)} <span>/3 meses</span>`;
    document.getElementById('quarterlyGummies').textContent = `${plan.quarterly.gummies} gomitas cada 3 meses`;

    const benefits = BENEFITS_BASE.concat(BENEFITS_EXTRA[state.planCode] || []);
    document.getElementById('planBenefits').innerHTML = benefits.map((b) => `<li>${b}</li>`).join('');

    document.getElementById('planResult').style.display = 'block';
    document.getElementById('subForm').style.display = 'block';

    document.querySelectorAll('.cadence-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.cadence === state.cadence);
    });
  }

  function updateSummary() {
    const plan = PLANS[state.planCode];
    const summaryEl = document.getElementById('subSummary');
    if (!plan || !state.district) {
      summaryEl.style.display = 'none';
      return;
    }

    const fee = computeShippingFee(state.planCode, state.cadence, state.district);
    if (fee === null) {
      summaryEl.style.display = 'none';
      return;
    }

    const tier = plan[state.cadence];
    const cadenceLabel = state.cadence === 'quarterly' ? 'Trimestral' : 'Mensual';

    document.getElementById('summaryPlanLine').textContent = `${plan.label} ${cadenceLabel} — ${tier.gummies} gomitas`;
    document.getElementById('summaryPlanPrice').textContent = money(tier.price);
    document.getElementById('summaryShipping').textContent = fee === 0 ? 'Gratis' : money(fee);
    document.getElementById('summaryTotal').textContent = money(tier.price + fee);
    summaryEl.style.display = 'block';

    const nudge = document.getElementById('lejanaNudge');
    if (state.planCode === 'PATITA' && state.cadence === 'monthly' && fee > 0) {
      nudge.style.display = 'block';
      nudge.innerHTML = `📦 En tu distrito, el plan Patita mensual tiene un envío de ${money(fee)}. Con el plan <strong>trimestral</strong> el envío es <strong>gratis</strong>. <button type="button" class="btn btn--yellow" style="padding:6px 16px;font-size:.8rem;margin-left:8px;" id="switchToQuarterlyBtn">Cambiar a trimestral</button>`;
      const switchBtn = document.getElementById('switchToQuarterlyBtn');
      if (switchBtn) switchBtn.addEventListener('click', () => setCadence('quarterly'));
    } else {
      nudge.style.display = 'none';
    }
  }

  function setWeight(range) {
    state.weightRange = range;
    state.planCode = WEIGHT_TO_PLAN[range];
    document.querySelectorAll('.weight-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.weight === range);
    });
    renderPlan();
    updateSummary();
  }

  function setCadence(cadence) {
    state.cadence = cadence;
    const radio = document.querySelector(`input[name=cadence][value=${cadence}]`);
    if (radio) radio.checked = true;
    renderPlan();
    updateSummary();
  }

  document.querySelectorAll('.weight-card').forEach((card) => {
    card.addEventListener('click', () => setWeight(card.dataset.weight));
  });
  document.querySelectorAll('.cadence-card').forEach((card) => {
    card.addEventListener('click', () => setCadence(card.dataset.cadence));
  });
  document.getElementById('districtSelect').addEventListener('change', (e) => {
    state.district = e.target.value;
    updateSummary();
  });

  // ── Recordar datos del cliente (mismo storage que el checkout de la tienda) ──
  function saveCustomerData(data) {
    try { localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreCustomerData() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(CUSTOMER_STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return;

    const addressEl = document.getElementById('deliveryAddress');
    const districtEl = document.getElementById('districtSelect');
    if (addressEl && !addressEl.value && saved.address) addressEl.value = saved.address;
    if (districtEl && !districtEl.value && saved.district && DISTRICT_FEES[saved.district] !== undefined) {
      districtEl.value = saved.district;
      state.district = saved.district;
    }
  }
  restoreCustomerData();

  function ensureModal() {
    if (document.getElementById('izipayModal')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'izipayModal';
    overlay.innerHTML = `
      <div class="modal-box izipay-modal-box">
        <button type="button" class="modal-close" id="izipayModalClose" aria-label="Cerrar">✕</button>
        <h3 class="modal-title">💳 Pagar el primer ciclo</h3>

        <div id="izipayStepForm">
          <div class="izipay-field"><label>Nombre</label><input type="text" id="izipayFirstName" placeholder="María"/></div>
          <div class="izipay-field"><label>Apellido</label><input type="text" id="izipayLastName" placeholder="Gómez"/></div>
          <div class="izipay-field"><label>Email</label><input type="email" id="izipayEmail" placeholder="maria@correo.com"/></div>
          <div class="izipay-field"><label>Teléfono</label><input type="tel" id="izipayPhone" placeholder="987654321"/></div>
          <div class="izipay-field"><label>DNI <span class="izipay-field__hint">(opcional, mejora la aprobación del pago)</span></label><input type="text" id="izipayDni" placeholder="12345678" maxlength="8"/></div>
          <p class="izipay-error" id="izipayError" style="display:none;"></p>
          <button type="button" class="btn btn--sky btn--full" id="izipayContinueBtn">Continuar al pago 🔒</button>
        </div>

        <div id="izipayStepPayment" style="display:none;">
          <div class="kr-embedded" id="izipayFormZone"></div>
        </div>

        <div id="izipayStepSuccess" style="display:none; text-align:center;">
          <p style="font-size:3rem;margin:0 0 10px;">🎉</p>
          <p class="izipay-success-text">¡Suscripción activada! Confírmanos por WhatsApp para coordinar la primera entrega.</p>
          <a class="btn btn--yellow btn--full" id="izipayWhatsappBtn" target="_blank">Confirmar por WhatsApp</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('izipayModalClose').addEventListener('click', closeSubscriptionModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubscriptionModal(); });
    document.getElementById('izipayContinueBtn').addEventListener('click', startPayment);
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

  window.openSubscriptionCheckout = function () {
    if (!state.planCode) { alert('🐾 ¡Cuéntanos cuánto pesa tu perro primero!'); return; }

    const dogName = document.getElementById('dogName').value.trim();
    const dogWeight = document.getElementById('dogWeight').value.trim();
    const dogBirthday = document.getElementById('dogBirthday').value;
    const district = document.getElementById('districtSelect').value;
    const address = document.getElementById('deliveryAddress').value.trim();

    if (!dogName) { alert('🐾 ¡Escribe el nombre de tu perro!'); return; }
    if (!dogWeight) { alert('🐾 ¡Escribe el peso exacto de tu perro!'); return; }
    if (!dogBirthday) { alert('🐾 ¡Elige el cumpleaños de tu perro!'); return; }
    if (!district) { alert('🐾 ¡Elige tu distrito de entrega!'); return; }
    if (!address) { alert('🐾 ¡Escribe tu dirección exacta!'); return; }

    ensureModal();
    resetModalSteps();
    document.getElementById('izipayModal').classList.add('open');
  };

  window.closeSubscriptionModal = function () {
    const modal = document.getElementById('izipayModal');
    if (modal) modal.classList.remove('open');
  };

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

  async function startPayment() {
    const firstName = document.getElementById('izipayFirstName').value.trim();
    const lastName = document.getElementById('izipayLastName').value.trim();
    const email = document.getElementById('izipayEmail').value.trim();
    const phone = document.getElementById('izipayPhone').value.trim();
    const dni = document.getElementById('izipayDni').value.trim();

    document.getElementById('izipayError').style.display = 'none';

    if (!firstName || !lastName || !email || !phone) {
      showError('🐾 Completa nombre, apellido, email y teléfono para continuar.');
      return;
    }

    const dogName = document.getElementById('dogName').value.trim();
    const dogWeight = document.getElementById('dogWeight').value.trim();
    const dogBirthday = document.getElementById('dogBirthday').value;
    const district = document.getElementById('districtSelect').value;
    const address = document.getElementById('deliveryAddress').value.trim();
    const lat = document.getElementById('deliveryLat').value;
    const lng = document.getElementById('deliveryLng').value;

    saveCustomerData({ firstName, lastName, email, phone, address, district });

    const btn = document.getElementById('izipayContinueBtn');
    btn.disabled = true;
    btn.textContent = 'Procesando...';

    const payload = {
      orderType: 'subscription',
      customer: { firstName, lastName, email, phone, identityCode: dni || undefined },
      subscription: {
        planCode: state.planCode,
        cadence: state.cadence,
        dog: { name: dogName, weight: dogWeight, birthday: dogBirthday },
        district,
        address,
        lat: lat || null,
        lng: lng || null,
      },
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

      const plan = PLANS[state.planCode];
      const cadenceLabel = state.cadence === 'quarterly' ? 'Trimestral' : 'Mensual';
      const dogName = document.getElementById('dogName').value.trim();
      const dogBirthday = document.getElementById('dogBirthday').value;
      const district = document.getElementById('districtSelect').value;
      const address = document.getElementById('deliveryAddress').value.trim();

      let msg = `¡Hola Santa Patita! 🐾 Ya pagué mi suscripción con tarjeta ✅\n\n`;
      msg += `🧾 *N° de orden:* ${lastOrderId}\n`;
      msg += `💰 *Total pagado:* S/ ${lastAmount}\n\n`;
      msg += `📦 *Plan:* ${plan ? plan.label : state.planCode} ${cadenceLabel}\n`;
      msg += `🐶 *Perro:* ${dogName} — cumple ${dogBirthday}\n`;
      msg += `📍 *Distrito:* ${district}\n`;
      msg += `🏠 *Dirección:* ${address}\n`;
      const lat = document.getElementById('deliveryLat').value, lng = document.getElementById('deliveryLng').value;
      if (lat && lng) msg += `🗺️ *Ubicación:* https://www.google.com/maps?q=${lat},${lng}\n`;
      msg += `\n¿Pueden confirmarme la entrega? ¡Gracias!`;

      document.getElementById('izipayWhatsappBtn').href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);
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
})();
