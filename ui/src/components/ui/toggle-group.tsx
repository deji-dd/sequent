import type { VariantProps } from 'class-variance-authority';
import * as ToggleGroupPrimitive from 'radix-ui';
import * as React from 'react';

import { toggleVariants } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: 'default',
  variant: 'default',
});

export function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.ToggleGroup.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive.ToggleGroup.Root
      data-slot="toggle-group"
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-lg bg-muted/50 p-1 border border-border/60 text-muted-foreground',
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.ToggleGroup.Root>
  );
}

export function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.ToggleGroup.Item> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <ToggleGroupPrimitive.ToggleGroup.Item
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        'min-w-0 data-[state=on]:font-semibold',
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.ToggleGroup.Item>
  );
}
