const { computeCartTotal, computeDeliveryFee } = require('../../lib/pricing');

const IZIPAY_API_URL = 'https://api.micuentaweb.pe/api-payment/V4/Charge/CreatePayment';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const shopId = process.env.IZIPAY_SHOP_ID;
  const secretKey = process.env.IZIPAY_PROD_KEY;
  const publicKey = process.env.IZIPAY_PUBLIC_KEY_PROD;

  if (!shopId || !secretKey || !publicKey) {
    console.error('Faltan variables de entorno IZIPAY_* en Vercel.');
    return res.status(500).json({ error: 'Configuración de pago incompleta.' });
  }

  const body = req.body || {};
  const cart = body.cart;
  const customer = body.customer || {};
  const delivery = body.delivery || {};
  const deliveryType = delivery.type || 'pickup';

  let subtotal;
  try {
    subtotal = computeCartTotal(cart);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!customer.email || !customer.firstName || !customer.lastName || !customer.phone) {
    return res.status(400).json({ error: 'Faltan datos del cliente (nombre, apellido, email o teléfono).' });
  }

  if (deliveryType === 'delivery' && (!customer.address || !delivery.district)) {
    return res.status(400).json({ error: 'Faltan el distrito o la dirección de entrega.' });
  }

  let deliveryFee;
  try {
    deliveryFee = computeDeliveryFee(deliveryType, delivery.district, delivery.date, subtotal);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const total = subtotal + deliveryFee;
  const orderId = `SP${Date.now()}`;

  // Izipay solo conoce el monto — el carrito y las coordenadas del mapa viajan como
  // texto en orderInfo/orderInfo2 (y de respaldo en metadata) para que el webhook de
  // notificación pueda incluirlos en el aviso de email/WhatsApp.
  const cartInfo = JSON.stringify(cart.map((i) => ({ f: i.flavor, u: i.units, q: i.qty })));
  const deliveryInfo = JSON.stringify({
    type: deliveryType,
    lat: delivery.lat || null,
    lng: delivery.lng || null,
  });

  const payload = {
    amount: total * 100,
    currency: 'PEN',
    orderId,
    orderInfo: cartInfo,
    orderInfo2: deliveryInfo,
    metadata: { cart: cartInfo, delivery: deliveryInfo },
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
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
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
