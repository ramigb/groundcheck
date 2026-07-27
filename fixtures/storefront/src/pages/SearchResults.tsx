import { useEffect, useState } from 'react'
import type { Product } from '../types/product'
import { fetchProducts } from '../lib/api/products'
import { ProductGrid } from '../components/ProductGrid'

export function SearchResults() {
  const [products, setProducts] = useState<Product[]>([])

  useEffect(() => {
    void fetchProducts().then(setProducts)
  }, [])

  return (
    <section className="results">
      <h2>results</h2>
      <ProductGrid products={products} />
    </section>
  )
}
