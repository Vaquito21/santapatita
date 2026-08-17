const crypto = require('crypto');
const {
  SENDER_EMAIL,
  formatDeliveryDate,
  orderSummary,
  amountBreakdown,
  emailShell,
  infoCard,
  amountRowsHtml,
  detailsRowsHtml,
  mapLinkHtml,
  sendResendEmail,
  notifyWhatsappRecipients,
} = require('../../lib/notifications');

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

  // Cuando el pago NO se aprueba, "UNPAID" por sí solo no dice por qué (tarjeta
  // rechazada por el banco, fondos insuficientes, regla antifraude de Izipay,
  // etc.) — logueamos el detalle completo de la transacción para poder leer el
  // motivo real en los logs de Vercel sin tener que llamar a la API Order/Get.
  if (orderStatus !== 'PAID' && transaction) {
    console.error(`Izipay IPN: detalle del rechazo para ${orderId}:`, JSON.stringify({
      status: transaction.status,
      detailedStatus: transaction.detailedStatus,
      errorCode: transaction.errorCode,
      errorMessage: transaction.errorMessage,
      detailedErrorCode: transaction.detailedErrorCode,
      detailedErrorMessage: transaction.detailedErrorMessage,
    }));
  }

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
      deliveryDate: orderInfo.deliveryDate,
      subtotal: orderInfo.subtotal,
      deliveryFee: orderInfo.deliveryFee,
      type: orderInfo.type,
      cart: orderInfo.cart,
      subscription: orderInfo.subscription,
      deliveryType: orderInfo.deliveryType,
      lat: orderInfo.lat,
      lng: orderInfo.lng,
    };

    const results = await Promise.allSettled([notifyEmail(details), notifyWhatsapp(details), notifyCustomerEmail(details)]);
    results.forEach((r) => { if (r.status === 'rejected') console.error('Notificación de pago falló:', r.reason); });
  }

  return res.status(200).send(`OK! OrderStatus is ${orderStatus}`);
};

// El carrito (o los datos de suscripción)/distrito/coordenadas viajan en orderInfo/orderInfo2
// (o metadata como respaldo), ya que Izipay solo conoce el monto — nunca lo que se compró.
function extractOrderInfo(transaction) {
  const result = { type: 'cart', cart: [], subscription: null, deliveryType: null, district: null, address: null, deliveryDate: null, subtotal: null, deliveryFee: null, customer: null, lat: null, lng: null };
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
      result.deliveryDate = parsed.date || null;
      result.subtotal = typeof parsed.subtotal === 'number' ? parsed.subtotal : null;
      result.deliveryFee = typeof parsed.deliveryFee === 'number' ? parsed.deliveryFee : null;
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

async function notifyEmail(d) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const b = amountBreakdown(d);
  const isSubscription = d.type === 'subscription';
  const pedidoBlock = isSubscription
    ? `<div>${orderSummary(d)}</div>`
    : orderSummary(d, 'html');

  const bodyHtml = `
    ${infoCard(`<div style="font-size:12px;color:#7C7C9A;font-weight:700;text-transform:uppercase;margin-bottom:6px;">N° de orden ${d.orderId}</div>${pedidoBlock}`)}
    ${infoCard(amountRowsHtml(b), { accent: 'yellow' })}
    ${infoCard(detailsRowsHtml(d))}
    ${mapLinkHtml(d)}
  `;

  await sendResendEmail({
    apiKey,
    to: [to],
    from: SENDER_EMAIL,
    subject: `${isSubscription ? '🐾 Nueva suscripción pagada' : '🐾 Nuevo pago recibido'} — ${d.orderId}`,
    html: emailShell({
      eyebrow: isSubscription ? 'Suscripción' : 'Pago recibido',
      title: '💰 ¡Nuevo pago confirmado!',
      bodyHtml,
    }),
  });
}

// Correo de confirmación AL CLIENTE (distinto del aviso interno de arriba).
async function notifyCustomerEmail(d) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !d.email) return;

  const b = amountBreakdown(d);
  const isSubscription = d.type === 'subscription';
  const firstName = d.name ? d.name.split(' ')[0] : null;
  const greeting = firstName ? `¡Hola ${firstName}! 🐾` : '¡Hola! 🐾';

  const pedidoBlock = isSubscription
    ? `<div>${orderSummary(d)}</div>`
    : orderSummary(d, 'html');
  const intro = isSubscription
    ? 'Tu suscripción quedó activa. Este es el resumen de tu primer ciclo:'
    : '¡Recibimos tu pago! Este es el resumen de tu pedido:';

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:16px;font-weight:800;color:#1A1A2E;">${greeting}</p>
    <p style="margin:0 0 4px;color:#7C7C9A;">${intro}</p>
    ${infoCard(`<div style="font-size:12px;color:#7C7C9A;font-weight:700;text-transform:uppercase;margin-bottom:6px;">N° de orden ${d.orderId}</div>${pedidoBlock}`)}
    ${infoCard(amountRowsHtml(b), { accent: 'yellow' })}
    <p style="margin:16px 0 0;">📍 <strong>Entrega:</strong> ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}${d.address ? ' — ' + d.address : ''}</p>
    ${formatDeliveryDate(d.deliveryDate) ? `<p style="margin:4px 0 0;">📅 <strong>Fecha solicitada:</strong> ${formatDeliveryDate(d.deliveryDate)}</p>` : ''}
    <p style="margin:16px 0 0;color:#7C7C9A;font-size:13px;">¿Alguna consulta? Escríbenos, con gusto te ayudamos 🐾</p>
  `;

  await sendResendEmail({
    apiKey,
    to: [d.email],
    from: SENDER_EMAIL,
    subject: isSubscription ? '🐾 ¡Tu suscripción a Santa Patita está activa!' : '🐾 ¡Gracias por tu compra en Santa Patita!',
    html: emailShell({
      eyebrow: isSubscription ? 'Suscripción activa' : 'Pago confirmado',
      title: isSubscription ? '¡Tu suscripción está activa! 🎉' : '¡Gracias por tu compra! 🎉',
      subtitle: 'Cada huellita es un propósito 🐾',
      bodyHtml,
      ctaHref: 'https://wa.me/51913897717',
      ctaLabel: '💬 Escríbenos por WhatsApp',
    }),
  });
}

async function notifyWhatsapp(d) {
  const b = amountBreakdown(d);
  const titleLine = d.type === 'subscription' ? '🐾 Nueva suscripción pagada' : '🐾 Nuevo pago recibido';
  let text = `${titleLine}\nOrden: ${d.orderId}\n`;
  text += b.hasBreakdown
    ? `Producto: ${b.productText}\nEnvío: ${b.shippingText}\nTotal: ${b.totalText}\n`
    : `Monto: ${b.totalText}\n`;
  text += d.type === 'subscription'
    ? `Pedido: ${orderSummary(d)}\n`
    : `Pedido:\n${orderSummary(d, 'text')}\n`;
  text += `Cliente: ${d.name || 'No disponible'}\n`;
  text += `Teléfono/WhatsApp: ${d.phone || 'No disponible'}\n`;
  if (d.email) text += `Email: ${d.email}\n`;
  text += `Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}\n`;
  text += `Fecha solicitada: ${formatDeliveryDate(d.deliveryDate) || 'No disponible (revisar con el cliente)'}\n`;
  text += `Dirección: ${d.address || 'No disponible (revisar con el cliente)'}\n`;
  if (d.lat && d.lng) text += `Ubicación (mapa): https://www.google.com/maps?q=${d.lat},${d.lng}\n`;

  await notifyWhatsappRecipients(text);
}
