// Piezas compartidas entre los distintos flujos de notificación de pedido
// (tarjeta vía Izipay en api/izipay/notify.js, Yape/Plin en api/yape/order.js)
// — plantillas de email, helpers de formato y el envío a Resend/CallMeBot.
// Antes vivían duplicadas; centralizarlas evita que un fix (ej. la fecha de
// entrega) se aplique en un flujo y se quede afuera del otro.

// Dominio propio verificado en Resend (mail.santapatita.pe) — reemplaza el
// dominio de pruebas onboarding@resend.dev, que solo entregaba de forma
// confiable al correo dueño de la cuenta.
const SENDER_EMAIL = 'Santa Patita <pedidos@mail.santapatita.pe>';

// El <input type="date"> del checkout entrega yyyy-mm-dd; lo mostramos en
// formato peruano dd/mm/yyyy en las notificaciones.
function formatDeliveryDate(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
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

// El desglose producto/envío depende de que subtotal/deliveryFee hayan llegado
// completos — si por algo no llegaron, degradamos a mostrar solo el total en
// vez de dejar campos vacíos o inventar un desglose.
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
  const bg = opts.accent === 'yellow' ? '#fff8dc' : opts.accent === 'purple' ? '#f3e8ff' : '#eaf4fc';
  const border = opts.accent === 'yellow' ? '#fde68a' : opts.accent === 'purple' ? '#d8b4fe' : '#bfe0f7';
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

// Filas de "Cliente / Teléfono / Email / Entrega / Fecha / Dirección" — se repiten
// igual en el correo interno de tarjeta y en el de Yape/Plin.
function detailsRowsHtml(d) {
  return `<table role="presentation" width="100%" style="font-size:13px;">
    <tr><td style="padding:4px 0;color:#7C7C9A;width:110px;">Cliente</td><td style="padding:4px 0;font-weight:700;color:#1A1A2E;">${d.name || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Teléfono</td><td style="padding:4px 0;font-weight:700;color:#1A1A2E;">${d.phone || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Email</td><td style="padding:4px 0;color:#2d2d44;">${d.email || 'No disponible'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Entrega</td><td style="padding:4px 0;color:#2d2d44;">${d.deliveryType === 'delivery' ? 'Delivery' : 'Recojo en tienda'}${d.district ? ' — ' + d.district : ''}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;">Fecha solicitada</td><td style="padding:4px 0;font-weight:700;color:#1A1A2E;">${formatDeliveryDate(d.deliveryDate) || 'No disponible (revisar con el cliente)'}</td></tr>
    <tr><td style="padding:4px 0;color:#7C7C9A;vertical-align:top;">Dirección</td><td style="padding:4px 0;color:#2d2d44;">${d.address || 'No disponible (revisar con el cliente)'}</td></tr>
  </table>`;
}

function mapLinkHtml(d) {
  return d.lat && d.lng
    ? `<p style="margin:12px 0 0;"><a href="https://www.google.com/maps?q=${d.lat},${d.lng}" style="color:#1a7abf;font-weight:700;text-decoration:none;">🗺️ Ver ubicación en Google Maps</a></p>`
    : '';
}

async function sendResendEmail({ apiKey, to, from, subject, html, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to, subject, html, ...(attachments ? { attachments } : {}) }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
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

// Cada número de WhatsApp tiene su propia API key en CallMeBot (se registra por
// separado), así que un segundo destinatario (ej. número personal) es opcional
// vía CALLMEBOT_PHONE_2 / CALLMEBOT_APIKEY_2. No lanza si no hay recipients
// configurados; lanza solo si TODOS los intentos configurados fallan.
async function notifyWhatsappRecipients(text) {
  const recipients = [
    { phone: process.env.CALLMEBOT_PHONE, apiKey: process.env.CALLMEBOT_APIKEY },
    { phone: process.env.CALLMEBOT_PHONE_2, apiKey: process.env.CALLMEBOT_APIKEY_2 },
  ].filter((r) => r.phone && r.apiKey);
  if (recipients.length === 0) return;

  const results = await Promise.allSettled(recipients.map((r) => sendCallMeBot(r.phone, r.apiKey, text)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`CallMeBot falló para ${recipients[i].phone}:`, r.reason);
  });
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error(results.map((r) => r.reason && r.reason.message).join('; '));
  }
}

module.exports = {
  SENDER_EMAIL,
  formatDeliveryDate,
  cartLines,
  subscriptionSummary,
  orderSummary,
  amountBreakdown,
  emailShell,
  infoCard,
  amountRowsHtml,
  detailsRowsHtml,
  mapLinkHtml,
  sendResendEmail,
  sendCallMeBot,
  notifyWhatsappRecipients,
};
