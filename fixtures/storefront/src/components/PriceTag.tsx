import type { Money } from '../types/product'

type Props = {
  value: Money
  format: (m: Money) => string
}

export function PriceTag({ value, format }: Props) {
  return <span className="price">{format(value)}</span>
}
