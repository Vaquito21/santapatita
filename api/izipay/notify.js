const crypto = require('crypto');

// Dominio propio verificado en Resend (mail.santapatita.pe) — reemplaza el
// dominio de pruebas onboarding@resend.dev, que solo entregaba de forma
// confiable al correo dueño de la cuenta.
const SENDER_EMAIL = 'Santa Patita <pedidos@mail.santapatita.pe>';

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
  const result = { type: 'cart', cart: [], subscription: null, deliveryType: null, district: null, address: null, subtotal: null, deliveryFee: null, customer: null, lat: null, lng: null };
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

function cartItemLine(i) {
  const priceText = typeof i.a === 'number' ? ` — S/ ${i.a}` : '';
  // "× 1 paquete(s)" es ruido en el caso común (una sola unidad) y hacía que
  // líneas con nombres largos ("Tradicional") se cortaran en dos en WhatsApp.
  const qtyText = i.q > 1 ? ` × ${i.q} paquetes` : '';
  return `${i.f} × ${i.u}u${qtyText}${priceText}`;
}

// format 'html' -> lista <ul>/<li> para el correo; format 'text' (default) ->
// líneas con viñeta "•" para el WhatsApp, más ordenado que separarlas por comas.
function cartLines(cart, format) {
  if (!Array.isArray(cart) || cart.length === 0) return 'No disponible (revisar con el cliente)';
  const lines = cart.map(cartItemLine);
  if (format === 'html') return `<ul style="margin:4px 0;padding-left:20px;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
  return lines.map((l) => `• ${l}`).join('\n');
}

function subscriptionSummary(sub) {
  if (!sub) return 'No disponible (revisar con el cliente)';
  const cadenceLabel = sub.cadence === 'quarterly' ? 'Trimestral' : 'Mensual';
  const dog = sub.dog || {};
  return `Suscripción ${sub.planCode || '?'} ${cadenceLabel} — ${sub.gummies || '?'} gomitas — Perro: ${dog.name || '?'} (${dog.weight || '?'} kg, cumple ${dog.birthday || '?'})`;
}

function orderSummary(d, format) {
  return d.type === 'subscription' ? subscriptionSummary(d.subscription) : cartLines(d.cart, format);
}

// Izipay solo confirma el total cobrado — el desglose producto/envío viaja en
// orderInfo2 (ver create-payment.js), así que si por algo no llegó, degradamos
// a mostrar solo el total en vez de dejar campos vacíos o inventar un desglose.
function amountBreakdown(d) {
  if (d.subtotal == null || d.deliveryFee == null) {
    return { hasBreakdown: false, totalText: d.amount != null ? `S/ ${d.amount}` : 'monto no disponible' };
  }
  return {
    hasBreakdown: true,
    productText: `S/ ${d.subtotal}`,
    shippingText: d.deliveryFee === 0 ? 'Gratis' : `S/ ${d.deliveryFee}`,
    totalText: d.amount != null ? `S/ ${d.amount}` : `S/ ${d.subtotal + d.deliveryFee}`,
  };
}

// ── Plantilla de correo con la identidad visual del sitio (colores, logo,
// tarjetas redondeadas) — con estilos inline porque los clientes de correo
// ignoran <style> y no soportan flexbox/grid, solo CSS inline y tablas. ──
function emailShell({ eyebrow, title, subtitle, bodyHtml, ctaHref, ctaLabel }) {
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <meta name="color-scheme" content="light"/>
    <meta name="supported-color-schemes" content="light"/>
  </head>
  <body style="margin:0;padding:0;background:#F5F7FA;">
  <div style="background:#F5F7FA;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #eef2f7;">
      <tr>
        <td style="background:#2596e4;background:linear-gradient(135deg,#2596e4,#3aaee8);padding:32px 24px;text-align:center;">
          <table role="presentation" cellpadding="0" cellspacing="0" align="center" bgcolor="#ffffff" style="display:inline-block;background-color:#ffffff !important;border-radius:14px;">
            <tr><td style="padding:8px 16px;">
              <img src="https://santapatita.pe/logo.png" width="150" height="72" alt="Santa Patita" style="display:block;max-width:150px;height:auto;"/>
            </td></tr>
          </table>
          ${eyebrow ? `<div style="color:#ffffff;opacity:.85;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-top:14px;">${eyebrow}</div>` : ''}
          <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:4px;">${title}</div>
          ${subtitle ? `<div style="color:#ffffff;opacity:.9;font-size:13px;margin-top:6px;">${subtitle}</div>` : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:28px 24px;color:#2d2d44;font-size:14px;line-height:1.65;">
          ${bodyHtml}
          ${ctaHref ? `
          <div style="text-align:center;margin-top:24px;">
            <a href="${ctaHref}" style="display:inline-block;background:#F7C618;color:#1A1A2E;font-weight:800;font-size:14px;padding:12px 28px;border-radius:50px;text-decoration:none;">${ctaLabel}</a>
          </div>` : ''}
        </td>
      </tr>
      <tr>
        <td style="background:#1A1A2E;padding:20px 24px;text-align:center;">
          <div style="color:#F7C618;font-size:12px;font-weight:800;">🐾 Santa Patita</div>
          <div style="color:#8a8aa8;font-size:11px;margin-top:6px;">Suplemento de colágeno natural para perros · Hecho en Lima, Perú</div>
        </td>
      </tr>
    </table>
  </div>
  </body>
  </html>`;
}

function infoCard(innerHtml, opts = {}) {
  const bg = opts.accent === 'yellow' ? '#fff8dc' : '#eaf4fc';
  const border = opts.accent === 'yellow' ? '#fde68a' : '#bfe0f7';
  return `<div style="background:${bg};border:1px solid ${border};border-radius:14px;padding:16px 18px;margin:14px 0;">${innerHtml}</div>`;
}

function amountRowsHtml(b) {
  if (!b.hasBreakdown) {
    return `<table role="presentation" width="100%" style="font-size:14px;"><tr><td style="padding:4px 0;color:#7C7C9A;">Total pagado</td><td style="padding:4px 0;text-align:right;font-weight:800;color:#1A1A2E;">${b.totalText}</td></tr></table>`;
  }
  return `<table role="presentation" width="100%" style="font-size:14px;">
    <tr><td style="padding:4px 0;color:#7C7C9A;">Producto</td><td style="padding:4px 0;text-align:right;color:#2d2d44;">${b.productText}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Envío</td><td style="padding:4px 0;text-align:right;color:#2d2d44;">${b.shippingText}</td></tr>
    <tr><td style="padding:8px 0 0;border-top:1px solid #e2e8f0;font-weight:800;color:#1A1A2E;">Total</td><td style="padding:8px 0 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:800;color:#1a7abf;font-size:16px;">${b.totalText}</td></tr>
  </table>`;
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
  const mapLink = d.lat && d.lng
    ? `<p style="margin:12px 0 0;"><a href="https://www.google.com/maps?q=${d.lat},${d.lng}" style="color:#1a7abf;font-weight:700;text-decoration:none;">🗺️ Ver ubicación en Google Maps</a></p>`
    : '';
  const detailsRows = `<table role="presentation" width="100%" style="font-size:13px;">
    <tr><td style="padding:4px 0;color:#7C7C9A;width:110px;">Cliente</td><td style="padding:4px 0;font-weight:700;color:#1A1A2E;">${d.name || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Teléfono</td><td style="padding:4px 0;font-weight:700;color:#1A1A2E;">${d.phone || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Email</td><td style="padding:4px 0;color:#2d2d44;">${d.email || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Entrega</td><td style="padding:4px 0;color:#2d2d44;">${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;vertical-align:top;">Dirección</td><td style="padding:4px 0;color:#2d2d44;">${d.address || 'No disponible (revisar con el cliente)'}</td></tr>
  </table>`;

  const bodyHtml = `
    ${infoCard(`<div style="font-size:12px;color:#7C7C9A;font-weight:700;text-transform:uppercase;margin-bottom:6px;">N° de orden ${d.orderId}</div>${pedidoBlock}`)}
    ${infoCard(amountRowsHtml(b), { accent: 'yellow' })}
    ${infoCard(detailsRows)}
    ${mapLink}
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: SENDER_EMAIL,
      to: [to],
      subject: `${isSubscription ? '🐾 Nueva suscripción pagada' : '🐾 Nuevo pago recibido'} — ${d.orderId}`,
      html: emailShell({
        eyebrow: isSubscription ? 'Suscripción' : 'Pago recibido',
        title: '💰 ¡Nuevo pago confirmado!',
        bodyHtml,
      }),
    }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
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
    <p style="margin:16px 0 0;color:#7C7C9A;font-size:13px;">¿Alguna consulta? Escríbenos, con gusto te ayudamos 🐾</p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: SENDER_EMAIL,
      to: [d.email],
      subject: isSubscription ? '🐾 ¡Tu suscripción a Santa Patita está activa!' : '🐾 ¡Gracias por tu compra en Santa Patita!',
      html: emailShell({
        eyebrow: isSubscription ? 'Suscripción activa' : 'Pago confirmado',
        title: isSubscription ? '¡Tu suscripción está activa! 🎉' : '¡Gracias por tu compra! 🎉',
        subtitle: 'Cada huellita es un propósito 🐾',
        bodyHtml,
        ctaHref: 'https://wa.me/51913897717',
        ctaLabel: '💬 Escríbenos por WhatsApp',
      }),
    }),
  });
  if (!res.ok) throw new Error(`Resend (cliente) respondió ${res.status}: ${await res.text()}`);
}

// Cada número de WhatsApp tiene su propia API key en CallMeBot (se registra por
// separado), así que un segundo destinatario (ej. número personal) es opcional
// vía CALLMEBOT_PHONE_2 / CALLMEBOT_APIKEY_2.
async function notifyWhatsapp(d) {
  const recipients = [
    { phone: process.env.CALLMEBOT_PHONE, apiKey: process.env.CALLMEBOT_APIKEY },
    { phone: process.env.CALLMEBOT_PHONE_2, apiKey: process.env.CALLMEBOT_APIKEY_2 },
  ].filter((r) => r.phone && r.apiKey);
  if (recipients.length === 0) return;

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
  text += `Dirección: ${d.address || 'No disponible (revisar con el cliente)'}\n`;
  if (d.lat && d.lng) text += `Ubicación (mapa): https://www.google.com/maps?q=${d.lat},${d.lng}\n`;

  const results = await Promise.allSettled(recipients.map((r) => sendCallMeBot(r.phone, r.apiKey, text)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`CallMeBot falló para ${recipients[i].phone}:`, r.reason);
  });
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error(results.map((r) => r.reason && r.reason.message).join('; '));
  }
}

async function sendCallMeBot(phone, apiKey, text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`CallMeBot respondió ${res.status}: ${body}`);
  // CallMeBot casi siempre responde HTTP 200 incluso cuando el mensaje NO se
  // envió de verdad (límite diario alcanzado, sesión vencida, apikey inválida)
  // — el status por sí solo no basta, hay que revisar el texto del cuerpo.
  if (!/message (queued|sent)/i.test(body)) {
    throw new Error(`CallMeBot respondió 200 pero sin confirmar el envío: ${body.slice(0, 300)}`);
  }
}
