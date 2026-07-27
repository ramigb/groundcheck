import type { Product } from '../types/product'
import { formatPrice } from '../lib/format'
import { PriceTag } from './PriceTag'
import { WishlistButton } from './WishlistButton'

type Props = {
  product: Product
  onOpen?: (id: string) => void
}

export function ProductCard({ product, onOpen }: Props) {
  return (
    <article className="card" onClick={() => onOpen?.(product.id)}>
      <h3 className="card-title">{product.title}</h3>
      <footer className="card-footer">
        <PriceTag value={product.price} format={formatPrice} />
        <WishlistButton id={product.id} />
      </footer>
    </article>
  )
}
