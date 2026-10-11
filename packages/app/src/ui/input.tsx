import type { ComponentProps } from 'react'
import { cn } from './utils.ts'
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn('flex h-10 w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[var(--fg)] text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50', className)} {...props} />
}
