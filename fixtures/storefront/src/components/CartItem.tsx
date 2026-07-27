import type { Product } from '../types/product'

type Props = {
  product: Product
  qty: number
}

export function CartItem({ product, qty }: Props) {
  return (
    <li className="cart-item">
      <span className="cart-item-title">{product.title}</span>
      <span className="cart-item-qty">x{qty}</span>
      <span className="cart-item-price">
        {product.price.cur} {product.price.amount}
      </span>
    </li>
  )
}
