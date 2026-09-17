import * as SliderPrimitive from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Slider.Root>) {
  return (
    <SliderPrimitive.Slider.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={onValueChange}
      className={cn(
        'relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Slider.Track
        data-slot="slider-track"
        className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted/60"
      >
        <SliderPrimitive.Slider.Range
          data-slot="slider-range"
          className="absolute h-full bg-gradient-to-r from-cyan-500 to-purple-500"
        />
      </SliderPrimitive.Slider.Track>
      <SliderPrimitive.Slider.Thumb
        data-slot="slider-thumb"
        className="block size-4.5 rounded-full border-2 border-primary bg-background shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none cursor-grab active:cursor-grabbing hover:scale-110"
      />
    </SliderPrimitive.Slider.Root>
  );
}
