const {
  FLAVOR_PRICING,
  computeCartTotal,
  computeDeliveryFee,
  validateDeliveryDate,
  computeSubscriptionPrice,
  computeSubscriptionShipping,
} = require('../../lib/pricing');

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
  const orderType = body.orderType === 'subscription' ? 'subscription' : 'cart';
  const customer = body.customer || {};

  if (!customer.email || !customer.firstName || !customer.lastName || !customer.phone) {
    return res.status(400).json({ error: 'Faltan datos del cliente (nombre, apellido, email o teléfono).' });
  }

  let subtotal;
  let deliveryFee;
  let orderInfo;
  let orderInfo2;
  let billingCity;
  let billingAddress;

  if (orderType === 'subscription') {
    const subscription = body.subscription || {};
    const { planCode, cadence, dog, district, address, lat, lng } = subscription;

    if (!dog || !dog.name || !dog.weight || !dog.birthday) {
      return res.status(400).json({ error: 'Faltan los datos del perro (nombre, peso o cumpleaños).' });
    }
    if (!district) {
      return res.status(400).json({ error: 'Falta el distrito de entrega.' });
    }

    let priceInfo;
    try {
      priceInfo = computeSubscriptionPrice(planCode, cadence);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      deliveryFee = computeSubscriptionShipping(planCode, cadence, district);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    subtotal = priceInfo.price;
    billingCity = district;
    billingAddress = address || 'Lima, Perú';

    orderInfo = JSON.stringify({
      type: 'subscription',
      planCode,
      cadence,
      gummies: priceInfo.gummies,
      dog: { name: dog.name, weight: dog.weight, birthday: dog.birthday },
    });
    orderInfo2 = JSON.stringify({
      type: 'delivery',
      district,
      address: billingAddress,
      subtotal,
      deliveryFee,
      lat: lat || null,
      lng: lng || null,
    });
  } else {
    const cart = body.cart;
    const delivery = body.delivery || {};
    const deliveryType = delivery.type || 'pickup';

    try {
      subtotal = computeCartTotal(cart);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (deliveryType === 'delivery' && (!customer.address || !delivery.district)) {
      return res.status(400).json({ error: 'Faltan el distrito o la dirección de entrega.' });
    }

    try {
      validateDeliveryDate(delivery.date);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      deliveryFee = computeDeliveryFee(deliveryType, delivery.district, delivery.date, subtotal);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    billingCity = customer.city || 'Lima';
    billingAddress = customer.address || 'Lima, Perú';

    // Izipay solo conoce el monto — el carrito y las coordenadas del mapa viajan como
    // texto en orderInfo/orderInfo2 (y de respaldo en metadata) para que el webhook de
    // notificación pueda incluirlos en el aviso de email/WhatsApp.
    // Guardamos también el monto de cada línea (ya validado por computeCartTotal
    // arriba) para que la notificación pueda mostrar precio por ítem, no solo el total.
    orderInfo = JSON.stringify(cart.map((i) => ({
      f: i.flavor,
      u: i.units,
      q: i.qty,
      a: FLAVOR_PRICING[i.flavor][i.units] * i.qty,
    })));
    orderInfo2 = JSON.stringify({
      type: deliveryType,
      district: delivery.district || null,
      address: billingAddress,
      subtotal,
      deliveryFee,
      lat: delivery.lat || null,
      lng: delivery.lng || null,
    });
  }

  const total = subtotal + deliveryFee;
  const orderId = `SP${Date.now()}`;

  // Respaldo del cliente: en producción, Izipay no siempre echa de vuelta
  // billingDetails en la notificación de pago (confirmado con órdenes reales
  // donde llegó "No disponible" pese a habérselo mandado) — así que además de
  // enviarlo en customer.billingDetails, lo mandamos nosotros mismos en
  // orderInfo3 para que notify.js siempre tenga de dónde leerlo.
  const orderInfo3 = JSON.stringify({
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    email: customer.email,
  });

  const payload = {
    amount: total * 100,
    currency: 'PEN',
    orderId,
    orderInfo,
    orderInfo2,
    orderInfo3,
    metadata: { cart: orderInfo, delivery: orderInfo2, customer: orderInfo3 },
    customer: {
      email: customer.email,
      billingDetails: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phone,
        address: billingAddress,
        country: 'PE',
        city: billingCity,
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
