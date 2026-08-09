// Endpoint temporal de recuperación/diagnóstico — borrar después de usarlo.
const ORDER_GET_URL = 'https://api.micuentaweb.pe/api-payment/V4/Order/Get';

module.exports = async (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

  const shopId = process.env.IZIPAY_SHOP_ID;
  const secretKey = process.env.IZIPAY_PROD_KEY;
  const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

  const apiRes = await fetch(ORDER_GET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ orderId }),
  });
  const data = await apiRes.json();
  return res.status(200).json(data);
};
