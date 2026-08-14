// Flujo de suscripción: peso → plan recomendado → mensual/trimestral → tus datos → datos del perro → pago.
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
    PATAZA: { label: 'Pataza', weightLabel: '+25 kg',   monthly: { gummies: 90, price: 72 }, quarterly: { gummies: 270, price: 199 } },
  };

  const WEIGHT_TO_PLAN = { hasta10: 'PATITA', '10a25': 'PATA', mas25: 'PATAZA' };

  const DISTRICT_FEES = {
    'Pueblo Libre': 7, 'Breña': 7, 'Jesús María': 7, 'Magdalena': 7, 'San Miguel': 7,
    'Cercado de Lima': 10, 'San Isidro': 10, 'Lince': 10,
    'Miraflores': 12, 'Barranco': 12, 'San Borja': 12, 'Surquillo': 12, 'Surco': 12, 'La Molina': 12,
  };

  const BENEFITS_BASE = [
    { label: 'Precio congelado', detail: 'Tu precio no sube aunque el plan aumente para nuevos suscriptores — pagas siempre lo mismo mientras sigas suscrito.' },
    { label: 'Cambio de sabor libre', detail: 'Puedes cambiar el sabor de tu peludito en cualquier entrega, sin costo extra ni preguntas.' },
    { label: 'Pausa o cancela cuando quieras', detail: 'Sin contratos ni penalidades — pausa uno o varios ciclos, o cancela cuando quieras.' },
    { label: 'Club Santa Patita', detail: 'Acceso a promociones, sorteos y contenido exclusivo para suscriptores.' },
    { label: 'Regalo de cumpleaños de tu perro', detail: 'El mes del cumpleaños de tu perro le mandamos un detalle especial junto a su pedido.' },
    { label: 'Refiere y ganan los dos un mes gratis', detail: 'Comparte tu código con otro dueño de perro: cuando se suscriba, ambos reciben un mes gratis.' },
  ];
  const BENEFITS_EXTRA = {
    PATITA: [],
    PATA: [
      { label: 'Dos sabores por entrega', detail: 'En cada entrega mezclamos dos sabores a tu elección, no solo uno.' },
      { label: 'Acceso anticipado a sabores nuevos', detail: 'Pruebas los sabores nuevos antes de que salgan al público.' },
      { label: 'Bandana de bienvenida', detail: 'Te enviamos una bandana Santa Patita de regalo en tu primera entrega.' },
    ],
    PATAZA: [
      { label: 'Entrega prioritaria', detail: 'Tu pedido se prepara y despacha primero, antes que las entregas regulares.' },
      { label: 'Kit de bienvenida', detail: 'Recibes un kit de bienvenida con productos y sorpresas Santa Patita.' },
      { label: '15% en catálogo futuro', detail: '15% de descuento permanente en los nuevos productos que lancemos.' },
      { label: 'Perro del Mes en redes', detail: 'Tu perro puede ser elegido "Perro del Mes" y aparecer en nuestras redes sociales.' },
    ],
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
    document.getElementById('planBenefits').innerHTML = benefits.map((b) => `
      <li class="benefit-item">
        <div class="benefit-item__row">${b.label}<span class="benefit-item__info">ⓘ</span></div>
        <p class="benefit-item__detail">${b.detail}</p>
      </li>
    `).join('');

    document.getElementById('planResult').style.display = 'block';
    document.getElementById('subForm').style.display = 'block';
    document.getElementById('dogForm').style.display = 'block';

    document.querySelectorAll('.cadence-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.cadence === state.cadence);
    });
  }

  // Tap/click en un beneficio lo deja "abierto" (para celular, que no tiene hover).
  // Delegado en el contenedor porque la lista se re-renderiza en cada cambio de plan.
  document.getElementById('planBenefits').addEventListener('click', (e) => {
    const item = e.target.closest('.benefit-item');
    if (!item) return;
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.benefit-item.open').forEach((el) => el.classList.remove('open'));
    if (!wasOpen) item.classList.add('open');
  });

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

  // ── Recordar datos del dueño (mismo storage que el checkout de la tienda) ──
  function saveCustomerData(data) {
    try { localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreCustomerData() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(CUSTOMER_STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return;

    const fields = {
      subFirstName: saved.firstName, subLastName: saved.lastName,
      subEmail: saved.email, subPhone: saved.phone,
      deliveryAddress: saved.address,
    };
    Object.keys(fields).forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.value && fields[id]) el.value = fields[id];
    });

    const districtEl = document.getElementById('districtSelect');
    if (districtEl && !districtEl.value && saved.district && DISTRICT_FEES[saved.district] !== undefined) {
      districtEl.value = saved.district;
      state.district = saved.district;
    }
  }
  restoreCustomerData();

  // ── Cumpleaños del perro: selects propios día/mes/año (el <input type="date">
  // nativo muestra mm/dd/yyyy o dd/mm/yyyy según el idioma/región del SO del
  // dispositivo, no el idioma de la página — no se puede forzar por CSS). El
  // input oculto #dogBirthday sigue guardando ISO yyyy-mm-dd, igual que antes,
  // para no tocar el resto del flujo (validación, envío a Izipay, notificaciones).
  function initDogBirthdaySelect() {
    const daySel = document.getElementById('dogBirthdayDay');
    const monthSel = document.getElementById('dogBirthdayMonth');
    const yearSel = document.getElementById('dogBirthdayYear');
    const hidden = document.getElementById('dogBirthday');
    if (!daySel || !monthSel || !yearSel || !hidden) return;

    const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    monthSel.innerHTML = '<option value="">Mes</option>' + MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');

    const currentYear = new Date().getFullYear();
    let years = '<option value="">Año</option>';
    for (let y = currentYear; y >= currentYear - 25; y--) years += `<option value="${y}">${y}</option>`;
    yearSel.innerHTML = years;

    function daysInMonth(month, year) {
      if (!month) return 31;
      return new Date(year || currentYear, month, 0).getDate();
    }

    function populateDays() {
      const prevValue = daySel.value;
      const month = parseInt(monthSel.value, 10) || null;
      const year = parseInt(yearSel.value, 10) || null;
      const total = daysInMonth(month, year);
      let opts = '<option value="">Día</option>';
      for (let d = 1; d <= total; d++) opts += `<option value="${d}">${d}</option>`;
      daySel.innerHTML = opts;
      if (prevValue && parseInt(prevValue, 10) <= total) daySel.value = prevValue;
    }

    function syncHidden() {
      const d = daySel.value, m = monthSel.value, y = yearSel.value;
      hidden.value = (d && m && y) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
    }

    populateDays();
    [daySel, monthSel, yearSel].forEach((sel) => {
      sel.addEventListener('change', () => {
        if (sel !== daySel) populateDays();
        syncHidden();
      });
    });
  }
  initDogBirthdaySelect();

  function ensureModal() {
    if (document.getElementById('izipayModal')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'izipayModal';
    overlay.innerHTML = `
      <div class="modal-box izipay-modal-box">
        <button type="button" class="modal-close" id="izipayModalClose" aria-label="Cerrar">✕</button>
        <div class="izipay-modal-icon">💳</div>
        <h3 class="modal-title">Pagar el primer ciclo</h3>
        <p class="izipay-lock-hint">🔒 Pago seguro procesado por Izipay</p>

        <p class="izipay-error" id="izipayError" style="display:none;"></p>

        <div id="izipayStepPayment">
          <div class="kr-embedded" id="izipayFormZone"></div>
        </div>

        <div id="izipayStepSuccess" style="display:none; text-align:center;">
          <p class="izipay-success-icon">🎉</p>
          <p class="izipay-success-text">¡Suscripción activada! Confírmanos por WhatsApp para coordinar la primera entrega.</p>
          <a class="btn btn--yellow btn--full" id="izipayWhatsappBtn" target="_blank">Confirmar por WhatsApp</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('izipayModalClose').addEventListener('click', closeSubscriptionModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubscriptionModal(); });
  }

  function showError(msg) {
    const el = document.getElementById('izipayError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function resetModalSteps() {
    document.getElementById('izipayStepPayment').style.display = 'block';
    document.getElementById('izipayStepPayment').innerHTML = '<p style="text-align:center;color:var(--muted);">Preparando tu pago…</p>';
    document.getElementById('izipayStepSuccess').style.display = 'none';
    document.getElementById('izipayError').style.display = 'none';
  }

  function readOwnerFields() {
    return {
      firstName: document.getElementById('subFirstName').value.trim(),
      lastName: document.getElementById('subLastName').value.trim(),
      email: document.getElementById('subEmail').value.trim(),
      phone: document.getElementById('subPhone').value.trim(),
      dni: document.getElementById('subDni').value.trim(),
    };
  }

  function readDogFields() {
    return {
      name: document.getElementById('dogName').value.trim(),
      weight: document.getElementById('dogWeight').value.trim(),
      birthday: document.getElementById('dogBirthday').value,
    };
  }

  window.openSubscriptionCheckout = function () {
    if (!state.planCode) { alert('🐾 ¡Cuéntanos cuánto pesa tu perro primero!'); return; }

    const owner = readOwnerFields();
    const dog = readDogFields();
    const district = document.getElementById('districtSelect').value;
    const address = document.getElementById('deliveryAddress').value.trim();

    if (!owner.firstName || !owner.lastName) { alert('🐾 ¡Escribe tu nombre y apellido!'); return; }
    if (!owner.email) { alert('🐾 ¡Escribe tu correo!'); return; }
    if (!owner.phone) { alert('🐾 ¡Escribe tu WhatsApp!'); return; }
    if (!owner.dni) { alert('🐾 ¡Escribe tu DNI! Lo necesitamos para tu boleta y ayuda a que el pago se apruebe.'); return; }
    if (!district) { alert('🐾 ¡Elige tu distrito de entrega!'); return; }
    if (!address) { alert('🐾 ¡Escribe tu dirección exacta!'); return; }
    if (!dog.name) { alert('🐾 ¡Escribe el nombre de tu perro!'); return; }
    if (!dog.weight) { alert('🐾 ¡Escribe el peso exacto de tu perro!'); return; }
    if (!dog.birthday) { alert('🐾 ¡Elige el cumpleaños de tu perro!'); return; }

    if (typeof trackInitiateCheckout === 'function') {
      const plan = PLANS[state.planCode];
      const tier = plan ? plan[state.cadence] : null;
      const fee = computeShippingFee(state.planCode, state.cadence, district) || 0;
      trackInitiateCheckout((tier ? tier.price : 0) + fee, 1, [state.planCode + '-' + state.cadence]);
    }

    ensureModal();
    resetModalSteps();
    document.getElementById('izipayModal').classList.add('open');
    startPayment();
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
    const owner = readOwnerFields();
    const dog = readDogFields();
    const district = document.getElementById('districtSelect').value;
    const address = document.getElementById('deliveryAddress').value.trim();
    const lat = document.getElementById('deliveryLat').value;
    const lng = document.getElementById('deliveryLng').value;

    saveCustomerData({ firstName: owner.firstName, lastName: owner.lastName, email: owner.email, phone: owner.phone, address, district });

    const payload = {
      orderType: 'subscription',
      customer: { firstName: owner.firstName, lastName: owner.lastName, email: owner.email, phone: owner.phone, identityCode: owner.dni || undefined },
      subscription: {
        planCode: state.planCode,
        cadence: state.cadence,
        dog: { name: dog.name, weight: dog.weight, birthday: dog.birthday },
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
      document.getElementById('izipayStepPayment').innerHTML = '';
      showError('⚠️ ' + err.message);
      return;
    }

    lastOrderId = data.orderId;
    lastAmount = data.amount;

    try {
      const KR = await loadKrypton(data.publicKey);
      document.getElementById('izipayStepPayment').innerHTML = '<div class="kr-embedded" id="izipayFormZone"></div>';

      await KR.setFormToken(data.formToken);

      if (!submitHandlersAttached) {
        KR.onSubmit(onPaymentSubmit);
        if (typeof KR.onError === 'function') KR.onError(onPaymentError);
        submitHandlersAttached = true;
      }
    } catch (err) {
      showError('⚠️ ' + ((err && err.message) || 'No se pudo mostrar el formulario de pago.'));
    }
  }

  function onPaymentSubmit(paymentData) {
    const status = paymentData && paymentData.clientAnswer && paymentData.clientAnswer.orderStatus;
    if (status === 'PAID') {
      document.getElementById('izipayStepPayment').style.display = 'none';
      document.getElementById('izipayStepSuccess').style.display = 'block';

      const plan = PLANS[state.planCode];
      const cadenceLabel = state.cadence === 'quarterly' ? 'Trimestral' : 'Mensual';
      const dog = readDogFields();
      const district = document.getElementById('districtSelect').value;
      const address = document.getElementById('deliveryAddress').value.trim();

      if (typeof trackPurchase === 'function') {
        trackPurchase(lastOrderId, lastAmount, [state.planCode + '-' + state.cadence], 1);
      }

      let msg = `¡Hola Santa Patita! 🐾 Ya pagué mi suscripción con tarjeta ✅\n\n`;
      msg += `🧾 *N° de orden:* ${lastOrderId}\n`;
      msg += `💰 *Total pagado:* S/ ${lastAmount}\n\n`;
      msg += `📦 *Plan:* ${plan ? plan.label : state.planCode} ${cadenceLabel}\n`;
      msg += `🐶 *Perro:* ${dog.name} — cumple ${dog.birthday}\n`;
      msg += `📍 *Distrito:* ${district}\n`;
      msg += `🏠 *Dirección:* ${address}\n`;
      const lat = document.getElementById('deliveryLat').value, lng = document.getElementById('deliveryLng').value;
      if (lat && lng) msg += `🗺️ *Ubicación:* https://www.google.com/maps?q=${lat},${lng}\n`;
      msg += `\n¿Pueden confirmarme la entrega? ¡Gracias!`;

      document.getElementById('izipayWhatsappBtn').href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);
    } else {
      document.getElementById('izipayStepPayment').innerHTML = '';
      showError('⚠️ El pago no se completó (estado: ' + status + '). Intenta con otra tarjeta.');
    }
    return false;
  }

  function onPaymentError(error) {
    showError('⚠️ ' + (error && error.errorMessage ? error.errorMessage : 'Ocurrió un error con el pago.'));
  }
})();
