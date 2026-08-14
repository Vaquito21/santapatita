// Helpers de eventos de e-commerce para Meta Pixel. El snippet base (fbq init +
// PageView) va en el <head> de cada página; esto solo centraliza el formato y
// las reglas de Meta (currency siempre PEN, value siempre numérico, Purchase
// deduplicado por orderId) para no repetir la lógica en cada checkout.
(function () {
  function slugify(text) {
    return String(text)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  window.fbSlug = slugify;

  function safeTrack(event, params, opts) {
    if (typeof fbq !== 'function') return;
    fbq('track', event, params, opts);
  }

  window.trackViewContent = function (id, name, value) {
    safeTrack('ViewContent', { content_ids: [id], content_name: name, content_type: 'product', value: Number(value) || 0.01, currency: 'PEN' });
  };

  window.trackAddToCart = function (id, name, value) {
    safeTrack('AddToCart', { content_ids: [id], content_name: name, value: Number(value) || 0.01, currency: 'PEN' });
  };

  window.trackInitiateCheckout = function (value, numItems, contentIds) {
    safeTrack('InitiateCheckout', { value: Number(value) || 0.01, currency: 'PEN', num_items: numItems, content_ids: contentIds });
  };

  const FIRED_KEY_PREFIX = 'fb_purchase_fired_';
  window.trackPurchase = function (orderId, value, contentIds, numItems) {
    if (!orderId) return;
    const key = FIRED_KEY_PREFIX + orderId;
    try {
      if (localStorage.getItem(key)) return; // ya disparado — evita duplicado si se reintenta
      localStorage.setItem(key, '1');
    } catch (e) {}
    safeTrack('Purchase', { value: Number(value) || 0.01, currency: 'PEN', content_ids: contentIds, num_items: numItems }, { eventID: String(orderId) });
  };
})();
