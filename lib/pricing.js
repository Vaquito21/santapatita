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
  'Surco': 12,
  'La Molina': 12,
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

// ── Suscripciones ──
// PATITA/PATA/PATAZA, mensual (entrega cada mes) o trimestral (una entrega cada 3 meses).
const SUBSCRIPTION_PLANS = {
  PATITA: {
    label: 'Patita',
    weightLabel: 'Perro hasta 10 kg',
    monthly:   { gummies: 30, price: 27 },
    quarterly: { gummies: 90, price: 70 },
  },
  PATA: {
    label: 'Pata',
    weightLabel: 'Perro de 10 a 25 kg',
    monthly:   { gummies: 60, price: 50 },
    quarterly: { gummies: 180, price: 135 },
  },
  PATAZA: {
    label: 'Pataza',
    weightLabel: '+25 kg o 2 perros',
    monthly:   { gummies: 90, price: 72 },
    quarterly: { gummies: 270, price: 199 },
  },
};

const WEIGHT_RANGE_TO_PLAN = { hasta10: 'PATITA', '10a25': 'PATA', mas25: 'PATAZA' };

function recommendPlanForWeight(weightRange) {
  const planCode = WEIGHT_RANGE_TO_PLAN[weightRange];
  if (!planCode) throw new Error('Rango de peso inválido.');
  return planCode;
}

function computeSubscriptionPrice(planCode, cadence) {
  const plan = SUBSCRIPTION_PLANS[planCode];
  if (!plan) throw new Error(`Plan inválido: ${planCode}`);
  const tier = plan[cadence];
  if (!tier) throw new Error(`Cadencia inválida: ${cadence}`);
  return { gummies: tier.gummies, price: tier.price };
}

// Solo Lima Metropolitana (cadena de frío no permite envíos a provincia).
// La agrupación cercana/lejana es solo para mostrar el distrito en el selector y
// decidir cuándo ofrecer el aviso de "pásate al trimestral con envío gratis" —
// el monto real de envío sale de DISTRICT_DELIVERY_FEES.
const ZONA_CERCANA = ['Pueblo Libre', 'Magdalena', 'Jesús María', 'San Miguel', 'Breña', 'Lince', 'Cercado de Lima'];
const ZONA_LEJANA = ['Miraflores', 'Surco', 'Barranco', 'San Isidro', 'La Molina', 'San Borja', 'Surquillo'];
const SUBSCRIPTION_DISTRICTS = [...ZONA_CERCANA, ...ZONA_LEJANA];

function getDistrictZone(district) {
  if (ZONA_CERCANA.includes(district)) return 'cercana';
  if (ZONA_LEJANA.includes(district)) return 'lejana';
  return null;
}

// PATA/PATAZA (mensual o trimestral) y cualquier plan trimestral: envío gratis toda Lima.
// PATITA mensual: paga el fee real del distrito (ver DISTRICT_DELIVERY_FEES).
function computeSubscriptionShipping(planCode, cadence, district) {
  if (!SUBSCRIPTION_DISTRICTS.includes(district)) {
    throw new Error(`Solo entregamos en Lima Metropolitana. Distrito sin cobertura: ${district}`);
  }

  if (planCode !== 'PATITA' || cadence === 'quarterly') return 0;

  const fee = DISTRICT_DELIVERY_FEES[district];
  if (fee === undefined) throw new Error(`Distrito sin tarifa configurada: ${district}`);
  return fee;
}

module.exports = {
  FLAVOR_PRICING,
  computeCartTotal,
  DISTRICT_DELIVERY_FEES,
  computeDeliveryFee,
  validateDeliveryDate,
  SUBSCRIPTION_PLANS,
  recommendPlanForWeight,
  computeSubscriptionPrice,
  ZONA_CERCANA,
  ZONA_LEJANA,
  SUBSCRIPTION_DISTRICTS,
  getDistrictZone,
  computeSubscriptionShipping,
};
