import type { Product } from '../../types/product'

const toMinorUnits = (m: Product['price']) => Math.round(m.amount * 100)

export const serializeProduct = (p: Product) => ({
  id: p.id,
  title: p.title,
  price: toMinorUnits(p.price),
})

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch('/api/products')
  return (await res.json()) as Product[]
}
