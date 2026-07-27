import type { Product } from '../types/product'
import { ProductCard } from './ProductCard'

type Props = {
  products: Product[]
}

export function ProductGrid({ products }: Props) {
  return (
    <div className="grid">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  )
}
