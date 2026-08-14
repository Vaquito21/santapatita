const crypto = require('crypto');

function computeHash(answer, key) {
  return crypto.createHmac('sha256', key).update(answer, 'utf8').digest('hex');
}

function hashesMatch(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Método no permitido.');
  }

  const body = req.body || {};
  const krAnswer = body['kr-answer'];
  const krHash = body['kr-hash'];
  const krHashKey = body['kr-hash-key']; // 'sha256_hmac' o 'password', según config de notificación en el back office Izipay

  if (!krAnswer || !krHash) {
    return res.status(400).send('Notificación incompleta.');
  }

  const hmacKey = process.env.IZIPAY_HMAC_PROD;
  const passwordKey = process.env.IZIPAY_PROD_KEY;
  const key = krHashKey === 'password' ? passwordKey : hmacKey;

  if (!key) {
    console.error('Falta la clave IZIPAY_HMAC_PROD / IZIPAY_PROD_KEY en Vercel.');
    return res.status(500).send('Configuración de validación incompleta.');
  }

  const calculatedHash = computeHash(krAnswer, key);
  if (!hashesMatch(calculatedHash, krHash)) {
    console.error('Firma kr-hash inválida en notificación Izipay.');
    return res.status(400).send('Firma inválida.');
  }

  let answer;
  try {
    answer = JSON.parse(krAnswer);
  } catch (err) {
    return res.status(400).send('kr-answer no es JSON válido.');
  }

  const orderStatus = answer.orderStatus;
  const orderId = answer.orderDetails && answer.orderDetails.orderId;
  const transaction = answer.transactions && answer.transactions[0];
  const transactionUuid = transaction && transaction.uuid;

  console.log(`Izipay IPN: orden ${orderId} → ${orderStatus} (tx ${transactionUuid})`);

  if (orderStatus === 'PAID') {
    const amount = transaction && typeof transaction.amount === 'number' ? transaction.amount / 100 : null;
    const customer = transaction && transaction.customer;
    const billing = customer && customer.billingDetails;
    const orderInfo = extractOrderInfo(transaction);

    const billingName = billing ? [billing.firstName, billing.lastName].filter(Boolean).join(' ') : null;
    const fallbackCustomer = orderInfo.customer || {};
    const fallbackName = [fallbackCustomer.firstName, fallbackCustomer.lastName].filter(Boolean).join(' ');

    const details = {
      orderId,
      amount,
      // billingDetails viene de vuelta desde Izipay, pero en la práctica no
      // siempre lo incluye en la notificación — usamos como respaldo lo que
      // nosotros mismos mandamos en orderInfo3/orderInfo2.
      email: (customer && customer.email) || fallbackCustomer.email,
      name: billingName || (fallbackName || null),
      phone: (billing && billing.phoneNumber) || fallbackCustomer.phone,
      address: (billing && billing.address) || orderInfo.address,
      district: (billing && billing.city) || orderInfo.district,
      type: orderInfo.type,
      cart: orderInfo.cart,
      subscription: orderInfo.subscription,
      deliveryType: orderInfo.deliveryType,
      lat: orderInfo.lat,
      lng: orderInfo.lng,
    };

    const results = await Promise.allSettled([notifyEmail(details), notifyWhatsapp(details)]);
    results.forEach((r) => { if (r.status === 'rejected') console.error('Notificación de pago falló:', r.reason); });
  }

  return res.status(200).send(`OK! OrderStatus is ${orderStatus}`);
};

// El carrito (o los datos de suscripción)/distrito/coordenadas viajan en orderInfo/orderInfo2
// (o metadata como respaldo), ya que Izipay solo conoce el monto — nunca lo que se compró.
function extractOrderInfo(transaction) {
  const result = { type: 'cart', cart: [], subscription: null, deliveryType: null, district: null, address: null, customer: null, lat: null, lng: null };
  if (!transaction) return result;

  const rawOrderInfo = transaction.orderInfo || (transaction.metadata && transaction.metadata.cart);
  const rawDelivery = transaction.orderInfo2 || (transaction.metadata && transaction.metadata.delivery);
  const rawCustomer = transaction.orderInfo3 || (transaction.metadata && transaction.metadata.customer);

  try {
    if (rawOrderInfo) {
      const parsed = JSON.parse(rawOrderInfo);
      if (Array.isArray(parsed)) {
        result.cart = parsed;
      } else if (parsed && parsed.type === 'subscription') {
        result.type = 'subscription';
        result.subscription = parsed;
      }
    }
  } catch (err) { console.error('No se pudo parsear orderInfo:', rawOrderInfo); }

  try {
    if (rawDelivery) {
      const parsed = typeof rawDelivery === 'string' ? JSON.parse(rawDelivery) : rawDelivery;
      result.deliveryType = parsed.type;
      result.district = parsed.district || null;
      result.address = parsed.address || null;
      result.lat = parsed.lat;
      result.lng = parsed.lng;
    }
  } catch (err) { console.error('No se pudo parsear orderInfo2 (delivery):', rawDelivery); }

  try {
    if (rawCustomer) {
      result.customer = typeof rawCustomer === 'string' ? JSON.parse(rawCustomer) : rawCustomer;
    }
  } catch (err) { console.error('No se pudo parsear orderInfo3 (customer):', rawCustomer); }

  return result;
}

function cartLines(cart) {
  if (!Array.isArray(cart) || cart.length === 0) return 'No disponible (revisar con el cliente)';
  return cart.map((i) => `${i.f} × ${i.u}u × ${i.q} paquete(s)`).join(', ');
}

function subscriptionSummary(sub) {
  if (!sub) return 'No disponible (revisar con el cliente)';
  const cadenceLabel = sub.cadence === 'quarterly' ? 'Trimestral' : 'Mensual';
  const dog = sub.dog || {};
  return `Suscripción ${sub.planCode || '?'} ${cadenceLabel} — ${sub.gummies || '?'} gomitas — Perro: ${dog.name || '?'} (${dog.weight || '?'} kg, cumple ${dog.birthday || '?'})`;
}

function orderSummary(d) {
  return d.type === 'subscription' ? subscriptionSummary(d.subscription) : cartLines(d.cart);
}

async function notifyEmail(d) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const amountText = d.amount != null ? `S/ ${d.amount}` : 'monto no disponible';
  const mapLink = d.lat && d.lng ? `<p>Ubicación (mapa): <a href="https://www.google.com/maps?q=${d.lat},${d.lng}">ver en Google Maps</a></p>` : '';
  const subjectPrefix = d.type === 'subscription' ? '🐾 Nueva suscripción pagada' : '🐾 Nuevo pago recibido';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Santa Patita <onboarding@resend.dev>',
      to: [to],
      subject: `${subjectPrefix} — ${d.orderId}`,
      html: `<p><strong>¡Nuevo pago confirmado!</strong></p>
        <p>N° de orden: <strong>${d.orderId}</strong></p>
        <p>Monto: <strong>${amountText}</strong></p>
        <p>Pedido: <strong>${orderSummary(d)}</strong></p>
        <p>Cliente: <strong>${d.name || 'No disponible'}</strong></p>
        <p>Teléfono / WhatsApp: <strong>${d.phone || 'No disponible'}</strong></p>
        <p>Email: ${d.email || 'No disponible'}</p>
        <p>Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}</p>
        <p>Dirección: <strong>${d.address || 'No disponible (revisar con el cliente)'}</strong></p>
        ${mapLink}`,
    }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
}

async function notifyWhatsapp(d) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apiKey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apiKey) return;

  const amountText = d.amount != null ? `S/ ${d.amount}` : 'monto no disponible';
  const titleLine = d.type === 'subscription' ? '🐾 Nueva suscripción pagada' : '🐾 Nuevo pago recibido';
  let text = `${titleLine}\nOrden: ${d.orderId}\nMonto: ${amountText}\n`;
  text += `Pedido: ${orderSummary(d)}\n`;
  text += `Cliente: ${d.name || 'No disponible'}\n`;
  text += `Teléfono/WhatsApp: ${d.phone || 'No disponible'}\n`;
  if (d.email) text += `Email: ${d.email}\n`;
  text += `Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}\n`;
  text += `Dirección: ${d.address || 'No disponible (revisar con el cliente)'}\n`;
  if (d.lat && d.lng) text += `Ubicación (mapa): https://www.google.com/maps?q=${d.lat},${d.lng}\n`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot respondió ${res.status}: ${await res.text()}`);
}
