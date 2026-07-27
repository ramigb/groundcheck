import type { Product } from '../types/product'
import { useLocalStore } from './useLocalStore'

const KEY = 'wishlist'

export function useWishlist(id: Product['id']) {
  const [ids, setIds] = useLocalStore(KEY)
  const on = ids.includes(id)
  const toggle = () => setIds(on ? ids.filter((x) => x !== id) : [...ids, id])
  return { on, toggle }
}
