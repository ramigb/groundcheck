export type Money = {
  amount: number
  cur: string
}

export interface Product {
  id: string
  title: string
  price: Money
  wishlisted?: boolean
}
