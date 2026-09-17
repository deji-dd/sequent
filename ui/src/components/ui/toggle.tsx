import { cva, type VariantProps } from 'class-variance-authority';
import * as TogglePrimitive from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs select-none cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-border bg-transparent shadow-xs hover:bg-muted hover:text-foreground',
      },
      size: {
        default: 'h-8 px-2.5 min-w-8',
        xs: 'h-7 px-2.5 text-xs rounded-md',
        sm: 'h-8 px-2.5 text-xs rounded-lg',
        lg: 'h-10 px-3.5 text-sm rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Toggle.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Toggle.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}
