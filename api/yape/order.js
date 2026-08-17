const {
  FLAVOR_PRICING,
  computeCartTotal,
  computeDeliveryFee,
  validateDeliveryDate,
} = require('../../lib/pricing');
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

// Con Yape/Plin no hay pasarela que confirme el pago: el "comprobante" es una
// captura o un N° de operación que el cliente sube desde su banco/app — no lo
// validamos contra ninguna API, solo lo adjuntamos para que alguien lo revise
// a mano. Por eso el pedido queda "pendiente de verificación" hasta que se
// confirme por WhatsApp (igual que ya pasa con los pedidos coordinados ahí).
const MAX_IMAGE_BASE64_CHARS = 4_800_000; // ~3.5MB decodificado, deja margen bajo el límite de 4.5MB de Vercel
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const body = req.body || {};
  const customer = body.customer || {};
  const cart = body.cart;
  const delivery = body.delivery || {};
  const proof = body.proof || {};

  if (!customer.email || !customer.firstName || !customer.lastName || !customer.phone) {
    return res.status(400).json({ error: 'Faltan datos del cliente (nombre, apellido, email o teléfono).' });
  }

  let subtotal;
  try {
    subtotal = computeCartTotal(cart);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const deliveryType = delivery.type || 'pickup';
  if (deliveryType === 'delivery' && (!customer.address || !delivery.district)) {
    return res.status(400).json({ error: 'Faltan el distrito o la dirección de entrega.' });
  }

  try {
    validateDeliveryDate(delivery.date);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let deliveryFee;
  try {
    deliveryFee = computeDeliveryFee(deliveryType, delivery.district, delivery.date, subtotal);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let proofAttachment = null;
  let operationNumber = null;
  if (proof.type === 'image') {
    const raw = String(proof.imageBase64 || '');
    const match = raw.match(/^data:([\w/+.-]+);base64,(.+)$/s);
    const mimeType = (match && match[1]) || proof.imageMimeType;
    const base64Data = match ? match[2] : raw;

    if (!base64Data) return res.status(400).json({ error: 'Falta la imagen del comprobante.' });
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) return res.status(400).json({ error: 'La imagen debe ser JPG, PNG o WEBP.' });
    if (base64Data.length > MAX_IMAGE_BASE64_CHARS) return res.status(400).json({ error: 'La imagen es muy pesada. Sube una captura de menos de 3.5MB.' });

    proofAttachment = { filename: `comprobante.${mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1]}`, content: base64Data };
  } else if (proof.type === 'operation') {
    operationNumber = String(proof.operationNumber || '').trim().slice(0, 40);
    if (!operationNumber) return res.status(400).json({ error: 'Escribe el N° de operación de tu pago.' });
  } else {
    return res.status(400).json({ error: 'Sube una captura del comprobante o ingresa el N° de operación.' });
  }

  const billingAddress = customer.address || 'Lima, Perú';
  const total = subtotal + deliveryFee;
  const orderId = `SPY${Date.now()}`;

  const details = {
    orderId,
    amount: total,
    email: customer.email,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
    phone: customer.phone,
    address: deliveryType === 'delivery' ? billingAddress : null,
    district: delivery.district || null,
    deliveryDate: delivery.date || null,
    subtotal,
    deliveryFee,
    type: 'cart',
    cart: cart.map((i) => ({ f: i.flavor, u: i.units, q: i.qty, a: FLAVOR_PRICING[i.flavor][i.units] * i.qty })),
    deliveryType,
    lat: delivery.lat || null,
    lng: delivery.lng || null,
    operationNumber,
  };

  const results = await Promise.allSettled([
    notifyEmail(details, proofAttachment),
    notifyWhatsapp(details),
    notifyCustomerEmail(details),
  ]);
  const allFailed = results.every((r) => r.status === 'rejected');
  results.forEach((r) => { if (r.status === 'rejected') console.error('Notificación de pedido Yape/Plin falló:', r.reason); });

  if (allFailed) {
    return res.status(502).json({ error: 'No pudimos registrar tu pedido. Escríbenos directo por WhatsApp para no perderlo.' });
  }

  return res.status(200).json({ orderId, amount: total });
};

async function notifyEmail(d, attachment) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const b = amountBreakdown(d);
  const pedidoBlock = orderSummary(d, 'html');
  const proofLine = d.operationNumber
    ? `<p style="margin:12px 0 0;">🧾 <strong>N° de operación:</strong> ${d.operationNumber}</p>`
    : `<p style="margin:12px 0 0;">🧾 <strong>Comprobante:</strong> adjunto a este correo</p>`;

  const bodyHtml = `
    ${infoCard('<div style="font-weight:800;color:#7c3aed;">⏳ Pendiente de verificación — Yape/Plin</div>', { accent: 'purple' })}
    ${infoCard(`<div style="font-size:12px;color:#7C7C9A;font-weight:700;text-transform:uppercase;margin-bottom:6px;">N° de orden ${d.orderId}</div>${pedidoBlock}`)}
    ${infoCard(amountRowsHtml(b), { accent: 'yellow' })}
    ${infoCard(detailsRowsHtml(d))}
    ${proofLine}
    ${mapLinkHtml(d)}
  `;

  await sendResendEmail({
    apiKey,
    to: [to],
    from: SENDER_EMAIL,
    subject: `🐾 Pedido por Yape/Plin — pendiente de verificar — ${d.orderId}`,
    html: emailShell({
      eyebrow: 'Yape / Plin · Pendiente de verificación',
      title: '⏳ ¡Nuevo pedido por revisar!',
      bodyHtml,
    }),
    attachments: attachment ? [attachment] : undefined,
  });
}

async function notifyCustomerEmail(d) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !d.email) return;

  const b = amountBreakdown(d);
  const firstName = d.name ? d.name.split(' ')[0] : null;
  const greeting = firstName ? `¡Hola ${firstName}! 🐾` : '¡Hola! 🐾';
  const pedidoBlock = orderSummary(d, 'html');

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:16px;font-weight:800;color:#1A1A2E;">${greeting}</p>
    <p style="margin:0 0 12px;color:#7C7C9A;">Recibimos tu pedido y tu comprobante de Yape/Plin. Este es el resumen:</p>
    ${infoCard(`<div style="font-size:12px;color:#7C7C9A;font-weight:700;text-transform:uppercase;margin-bottom:6px;">N° de orden ${d.orderId}</div>${pedidoBlock}`)}
    ${infoCard(amountRowsHtml(b), { accent: 'yellow' })}
    <p style="margin:16px 0 0;">📍 <strong>Entrega:</strong> ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}${d.address ? ' — ' + d.address : ''}</p>
    ${formatDeliveryDate(d.deliveryDate) ? `<p style="margin:4px 0 0;">📅 <strong>Fecha solicitada:</strong> ${formatDeliveryDate(d.deliveryDate)}</p>` : ''}
    <p style="margin:16px 0 0;color:#7C7C9A;font-size:13px;">Estamos verificando tu pago — te confirmamos por WhatsApp en las próximas horas 🐾</p>
  `;

  await sendResendEmail({
    apiKey,
    to: [d.email],
    from: SENDER_EMAIL,
    subject: '🐾 Recibimos tu pedido — verificando tu pago',
    html: emailShell({
      eyebrow: 'Pendiente de verificación',
      title: '¡Ya casi! Verificamos tu pago 🕐',
      subtitle: 'Te confirmamos por WhatsApp apenas lo revisemos',
      bodyHtml,
      ctaHref: 'https://wa.me/51913897717',
      ctaLabel: '💬 Escríbenos por WhatsApp',
    }),
  });
}

async function notifyWhatsapp(d) {
  const b = amountBreakdown(d);
  let text = `🐾 Nuevo pedido por Yape/Plin — PENDIENTE DE VERIFICAR\nOrden: ${d.orderId}\n`;
  text += b.hasBreakdown
    ? `Producto: ${b.productText}\nEnvío: ${b.shippingText}\nTotal: ${b.totalText}\n`
    : `Monto: ${b.totalText}\n`;
  text += `Pedido:\n${orderSummary(d, 'text')}\n`;
  text += `Cliente: ${d.name || 'No disponible'}\n`;
  text += `Teléfono/WhatsApp: ${d.phone || 'No disponible'}\n`;
  if (d.email) text += `Email: ${d.email}\n`;
  text += `Entrega: ${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}\n`;
  text += `Fecha solicitada: ${formatDeliveryDate(d.deliveryDate) || 'No disponible (revisar con el cliente)'}\n`;
  text += `Dirección: ${d.address || 'No disponible (revisar con el cliente)'}\n`;
  text += d.operationNumber ? `N° de operación: ${d.operationNumber}\n` : `Comprobante: revisar correo (adjunto)\n`;
  if (d.lat && d.lng) text += `Ubicación (mapa): https://www.google.com/maps?q=${d.lat},${d.lng}\n`;

  await notifyWhatsappRecipients(text);
}
