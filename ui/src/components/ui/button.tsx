import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium whitespace-nowrap transition-colors outline-none select-none cursor-pointer disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:not-aria-[haspopup]:scale-[0.99] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 gap-1.5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground font-medium hover:bg-primary/90 shadow-xs',
        outline:
          'bg-transparent hover:bg-muted text-foreground border border-border hover:border-border/80 shadow-xs',
        secondary:
          'bg-secondary text-secondary-foreground font-medium hover:bg-secondary/80 border border-border/50 shadow-xs',
        ghost: 'bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground',
        destructive: 'bg-destructive text-white font-medium hover:bg-destructive/90 shadow-xs',
        'destructive-subtle':
          'bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/25 font-medium',
        'cyan-subtle':
          'bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/25 font-medium',
        success: 'bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-xs',
        'success-subtle':
          'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25 font-medium',
        purple:
          'bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/25 font-medium',
        gradient: 'bg-primary text-primary-foreground hover:bg-primary/90 font-medium shadow-xs',
      },
      size: {
        default: 'h-8.5 px-3.5 py-1.5 text-xs',
        xs: 'h-7 px-2.5 py-1 text-xs rounded-md',
        sm: 'h-8 px-3 py-1.5 text-xs rounded-lg',
        lg: 'h-10 px-5 py-2 text-sm rounded-lg',
        icon: 'size-8 p-0 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
