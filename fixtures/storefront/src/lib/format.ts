import type { Money } from '../types/product'

const locale = 'en-US'

export function formatPrice(m: Money) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.cur,
  }).format(m.amount)
}
