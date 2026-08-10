// Tradicional/Mixto/Zanahoria/Brócoli vienen en 5/10/20u. Blue Velvet y Pink Velvet solo en 20u.
// Debe reflejar exactamente FLAVOR_PRICING en index.html / tienda.html.
const FLAVOR_PRICING = {
  'Tradicional': { 5: 7, 10: 12, 20: 20 },
  'Mixto':       { 5: 7, 10: 12, 20: 20 },
  'Zanahoria':   { 5: 7, 10: 12, 20: 20 },
  'Brócoli':     { 5: 7, 10: 12, 20: 20 },
  'Blue Velvet': { 20: 25 },
  'Pink Velvet': { 20: 22 },
};

// Recalcula el total en el servidor a partir de {flavor, units, qty} — nunca confiar en un precio/total enviado por el cliente.
function computeCartTotal(cart) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new Error('El carrito está vacío.');
  }

  let total = 0;
  for (const item of cart) {
    const pricing = FLAVOR_PRICING[item && item.flavor];
    const units = Number(item && item.units);
    const qty = Number(item && item.qty);

    if (!pricing || pricing[units] === undefined) {
      throw new Error(`Combinación de sabor/cantidad inválida: ${item && item.flavor} ${item && item.units}u`);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw new Error(`Cantidad de paquetes inválida para ${item.flavor}`);
    }

    total += pricing[units] * qty;
  }

  return total;
}

// Costo de delivery por distrito (recojo en tienda y domingos desde S/27 son gratis).
const DISTRICT_DELIVERY_FEES = {
  'Pueblo Libre': 7,
  'Breña': 7,
  'Jesús María': 7,
  'Magdalena': 7,
  'San Miguel': 7,
  'Cercado de Lima': 10,
  'San Isidro': 10,
  'Lince': 10,
  'Miraflores': 12,
  'Barranco': 12,
  'San Borja': 12,
  'Surquillo': 12,
  'La Victoria': 12,
};

const FREE_SUNDAY_DELIVERY_MIN_SUBTOTAL = 27;

// dateStr en formato 'YYYY-MM-DD' (el mismo que entrega <input type="date">).
function computeDeliveryFee(deliveryType, district, dateStr, subtotal) {
  if (deliveryType === 'pickup') return 0;
  if (deliveryType !== 'delivery') throw new Error('Tipo de entrega inválido.');

  const fee = DISTRICT_DELIVERY_FEES[district];
  if (fee === undefined) throw new Error(`Distrito sin cobertura: ${district}`);

  const date = dateStr ? new Date(`${dateStr}T12:00:00`) : null;
  const isSunday = date && !isNaN(date) && date.getDay() === 0;
  if (isSunday && subtotal >= FREE_SUNDAY_DELIVERY_MIN_SUBTOTAL) return 0;

  return fee;
}

const MIN_LEAD_DAYS = 3;

// El <input type="date"> del cliente ya tiene un atributo min, pero eso no bloquea de forma
// confiable la selección en todos los navegadores móviles — hay que validar también acá.
function validateDeliveryDate(dateStr) {
  if (!dateStr) throw new Error('Falta la fecha de entrega.');
  const selected = new Date(`${dateStr}T00:00:00`);
  if (isNaN(selected)) throw new Error('Fecha de entrega inválida.');

  const minDate = new Date();
  minDate.setHours(0, 0, 0, 0);
  minDate.setDate(minDate.getDate() + MIN_LEAD_DAYS);

  if (selected < minDate) {
    throw new Error(`La fecha de entrega debe tener al menos ${MIN_LEAD_DAYS} días de anticipación.`);
  }
}

module.exports = { FLAVOR_PRICING, computeCartTotal, DISTRICT_DELIVERY_FEES, computeDeliveryFee, validateDeliveryDate };
