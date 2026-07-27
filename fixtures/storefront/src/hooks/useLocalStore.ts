import { useCallback, useState } from 'react'

// Minimal localStorage-backed string list. No SSR guard on write by design:
// the fixture needs a plausible place for a reviewer note to point at.
export function useLocalStore(key: string): [string[], (next: string[]) => void] {
  const [value, setValue] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    return JSON.parse(window.localStorage.getItem(key) ?? '[]') as string[]
  })

  const write = useCallback(
    (next: string[]) => {
      setValue(next)
      window.localStorage.setItem(key, JSON.stringify(next))
    },
    [key],
  )

  return [value, write]
}
