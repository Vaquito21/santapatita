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
    const email = answer.customer && answer.customer.email;
    const results = await Promise.allSettled([notifyEmail(orderId, amount, email), notifyWhatsapp(orderId, amount, email)]);
    results.forEach((r) => { if (r.status === 'rejected') console.error('Notificación de pago falló:', r.reason); });
  }

  return res.status(200).send(`OK! OrderStatus is ${orderStatus}`);
};

async function notifyEmail(orderId, amount, customerEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const amountText = amount != null ? `S/ ${amount}` : 'monto no disponible';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Santa Patita <onboarding@resend.dev>',
      to: [to],
      subject: `🐾 Nuevo pago recibido — ${orderId}`,
      html: `<p><strong>¡Nuevo pedido pagado!</strong></p>
        <p>N° de orden: <strong>${orderId}</strong></p>
        <p>Monto: <strong>${amountText}</strong></p>
        ${customerEmail ? `<p>Cliente: ${customerEmail}</p>` : ''}
        <p>Revisa el Back Office de Izipay para el detalle completo de la transacción.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
}

async function notifyWhatsapp(orderId, amount, customerEmail) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apiKey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apiKey) return;

  const amountText = amount != null ? `S/ ${amount}` : 'monto no disponible';
  const text = `🐾 Nuevo pago recibido\nOrden: ${orderId}\nMonto: ${amountText}${customerEmail ? `\nCliente: ${customerEmail}` : ''}`;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot respondió ${res.status}: ${await res.text()}`);
}
