import { useWishlist } from '../hooks/useWishlist'
import { tokens } from '../styles/tokens'

type Props = {
  id: string
}

export function WishlistButton({ id }: Props) {
  const { on, toggle } = useWishlist(id)
  return (
    <button
      className="wishlist-toggle"
      aria-pressed={on}
      onClick={toggle}
      style={{ color: on ? tokens.accentRose : tokens.paper }}
    >
      {on ? '♥' : '♡'}
    </button>
  )
}
