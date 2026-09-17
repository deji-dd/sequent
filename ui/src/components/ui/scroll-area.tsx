import * as ScrollAreaPrimitive from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollArea.Root>) {
  return (
    <ScrollAreaPrimitive.ScrollArea.Root
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollArea.Viewport className="size-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.ScrollArea.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.ScrollArea.Corner />
    </ScrollAreaPrimitive.ScrollArea.Root>
  );
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollArea.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollArea.Scrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollArea.Scrollbar>
  );
}
