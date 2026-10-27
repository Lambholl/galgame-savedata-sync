import type { ReactNode } from 'react'

export function Panel({
  title,
  children,
}: {
  readonly title?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <section className="panel">
      {title && <h2>{title}</h2>}
      {children}
    </section>
  )
}
