// shadcn-style local component: Radix Slot + CVA, customized for reader theme tokens.
import type { ComponentProps } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils.ts'
const variants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50', {
  variants: { variant: { default: 'bg-[var(--fg)] text-[var(--bg)] hover:opacity-85', outline: 'border border-[var(--line)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-2)]', ghost: 'text-[var(--fg)] hover:bg-[var(--bg-2)]' }, size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3' } }, defaultVariants: { variant: 'outline', size: 'default' },
})
export function Button({ className, variant, size, asChild = false, ...props }: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Element = asChild ? Slot : 'button'
  return <Element data-slot="button" className={cn(variants({ variant, size, className }))} {...props} />
}
