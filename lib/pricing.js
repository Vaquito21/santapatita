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

module.exports = { FLAVOR_PRICING, computeCartTotal };
