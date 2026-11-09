'use strict';
/**
 * Rental price for one unit.
 * base_price covers base_days; each extra day costs extra_day_price.
 * Renting fewer days than base_days still costs base_price.
 */
function unitPrice(product, days) {
  const extra = Math.max(0, days - (product.base_days || 1));
  return product.base_price + extra * (product.extra_day_price || 0);
}

const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });

module.exports = { unitPrice, baht };
