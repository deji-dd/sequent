import { X } from 'lucide-react';
import * as DialogPrimitive from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Dialog.Root;
export const DialogTrigger = DialogPrimitive.Dialog.Trigger;
export const DialogPortal = DialogPrimitive.Dialog.Portal;
export const DialogClose = DialogPrimitive.Dialog.Close;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Dialog.Overlay>) {
  return (
    <DialogPrimitive.Dialog.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/70 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Dialog.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Dialog.Content
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-card text-foreground p-6 shadow-2xl duration-200 glass-panel rounded-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Dialog.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground opacity-70 ring-offset-background transition-all hover:opacity-100 hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none cursor-pointer z-20">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Dialog.Close>
      </DialogPrimitive.Dialog.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Dialog.Title>) {
  return (
    <DialogPrimitive.Dialog.Title
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Dialog.Description>) {
  return (
    <DialogPrimitive.Dialog.Description
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}
