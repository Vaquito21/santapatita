const { computeCartTotal } = require('../../lib/pricing');

const IZIPAY_API_URL = 'https://api.micuentaweb.pe/api-payment/V4/Charge/CreatePayment';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const shopId = process.env.IZIPAY_SHOP_ID;
  const testKey = process.env.IZIPAY_TEST_KEY;
  const publicKey = process.env.IZIPAY_PUBLIC_KEY_TEST;

  if (!shopId || !testKey || !publicKey) {
    console.error('Faltan variables de entorno IZIPAY_* en Vercel.');
    return res.status(500).json({ error: 'Configuración de pago incompleta.' });
  }

  const body = req.body || {};
  const cart = body.cart;
  const customer = body.customer || {};

  let total;
  try {
    total = computeCartTotal(cart);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!customer.email || !customer.firstName || !customer.lastName || !customer.phone) {
    return res.status(400).json({ error: 'Faltan datos del cliente (nombre, apellido, email o teléfono).' });
  }

  const orderId = `SP${Date.now()}`;

  const payload = {
    amount: total * 100,
    currency: 'PEN',
    orderId,
    customer: {
      email: customer.email,
      billingDetails: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phone,
        address: customer.address || 'Lima, Perú',
        country: 'PE',
        city: customer.city || 'Lima',
        state: 'Lima',
        zipCode: customer.zipCode || '15000',
        ...(customer.identityCode ? { identityType: 'DNI', identityCode: customer.identityCode } : {}),
      },
    },
  };

  let izipayResponse;
  try {
    const auth = Buffer.from(`${shopId}:${testKey}`).toString('base64');
    const apiRes = await fetch(IZIPAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });
    izipayResponse = await apiRes.json();
  } catch (err) {
    console.error('Error llamando a la API de Izipay:', err);
    return res.status(502).json({ error: 'No se pudo contactar a la pasarela de pago.' });
  }

  if (izipayResponse.status !== 'SUCCESS' || !izipayResponse.answer || !izipayResponse.answer.formToken) {
    console.error('Izipay CreatePayment error:', JSON.stringify(izipayResponse));
    const detail = izipayResponse.answer && (izipayResponse.answer.errorMessage || izipayResponse.answer.detailedErrorMessage);
    return res.status(502).json({ error: detail || 'La pasarela de pago rechazó la solicitud.' });
  }

  return res.status(200).json({
    formToken: izipayResponse.answer.formToken,
    publicKey,
    orderId,
    amount: total,
    currency: 'PEN',
  });
};
