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

    const details = {
      orderId,
      amount,
      email: customer && customer.email,
      name: billing ? [billing.firstName, billing.lastName].filter(Boolean).join(' ') : null,
      phone: billing && billing.phoneNumber,
      address: billing && billing.address,
      district: billing && billing.city,
      cart: orderInfo.cart,
      deliveryType: orderInfo.deliveryType,
      lat: orderInfo.lat,
      lng: orderInfo.lng,
    };

    const results = await Promise.allSettled([notifyEmail(details), notifyWhatsapp(details)]);
    results.forEach((r) => { if (r.status === 'rejected') console.error('Notificación de pago falló:', r.reason); });
  }

  return res.status(200).send(`OK! OrderStatus is ${orderStatus}`);
};

// El carrito/distrito/coordenadas viajan en orderInfo/orderInfo2 (o metadata como respaldo),
// ya que Izipay solo conoce el monto — nunca los productos comprados.
function extractOrderInfo(transaction) {
  const result = { cart: [], deliveryType: null, lat: null, lng: null };
  if (!transaction) return result;

  const rawCart = transaction.orderInfo || (transaction.metadata && transaction.metadata.cart);
  const rawDelivery = transaction.orderInfo2 || (transaction.metadata && transaction.metadata.delivery);

  try { if (rawCart) result.cart = JSON.parse(rawCart); } catch (err) { console.error('No se pudo parsear orderInfo (cart):', rawCart); }
  try {
    if (rawDelivery) {
      const parsed = typeof rawDelivery === 'string' ? JSON.parse(rawDelivery) : rawDelivery;
      result.deliveryType = parsed.type;
      result.lat = parsed.lat;
      result.lng = parsed.lng;
    }
  } catch (err) { console.error('No se pudo parsear orderInfo2 (delivery):', rawDelivery); }

  return result;
}

function cartLines(cart) {
  if (!Array.isArray(cart) || cart.length === 0) return 'No disponible (revisar con el cliente)';
  return cart.map((i) => `${i.f} × ${i.u}u × ${i.q} paquete(s)`).join(', ');
}

async function notifyEmail(d) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const amountText = d.amount != null ? `S/ ${d.amount}` : 'monto no disponible';
  const mapLink = d.lat && d.lng ? `<p>Ubicación: <a href="https://www.google.com/maps?q=${d.lat},${d.lng}">ver en Google Maps</a></p>` : '';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Santa Patita <onboarding@resend.dev>',
      to: [to],
      subject: `🐾 Nuevo pago recibido — ${d.orderId}`,
      html: `<p><strong>¡Nuevo pedido pagado!</strong></p>
        <p>N° de orden: <strong>${d.orderId}</strong></p>
        <p>Monto: <strong>${amountText}</strong></p>
        <p>Pedido: <strong>${cartLines(d.cart)}</strong></p>
        <p>Cliente: ${d.name || 'No disponible'} ${d.phone ? '· ' + d.phone : ''} ${d.email ? '· ' + d.email : ''}</p>
        <p>Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}${d.address ? ' — ' + d.address : ''}</p>
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
  let text = `🐾 Nuevo pago recibido\nOrden: ${d.orderId}\nMonto: ${amountText}\n`;
  text += `Pedido: ${cartLines(d.cart)}\n`;
  text += `Cliente: ${d.name || 'No disponible'}${d.phone ? ' · ' + d.phone : ''}${d.email ? ' · ' + d.email : ''}\n`;
  text += `Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}${d.address ? ' — ' + d.address : ''}\n`;
  if (d.lat && d.lng) text += `Ubicación: https://www.google.com/maps?q=${d.lat},${d.lng}\n`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot respondió ${res.status}: ${await res.text()}`);
}
