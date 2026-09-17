import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 select-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive:
          'border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium',
        outline: 'text-foreground border-border bg-transparent',
        cyan: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25',
        purple: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/25',
        emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
        amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25',
        rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/25',
        glass: 'bg-muted/60 text-muted-foreground border-border',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
