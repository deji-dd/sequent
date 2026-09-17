import type { EventRecord } from '@core/types';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTime } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Slider } from './ui/slider';

interface TimeTravelSliderProps {
  events: EventRecord[];
  isTimeTraveling: boolean;
  currentSequence: number;
  timeTravelSnapshot: EventRecord | null;
  onScrub: (seq: number) => void;
  onExitTimeTravel: () => void;
}

export function TimeTravelSlider({
  events,
  isTimeTraveling,
  currentSequence,
  timeTravelSnapshot,
  onScrub,
  onExitTimeTravel,
}: TimeTravelSliderProps) {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  const maxSeq = events.length > 0 ? events[events.length - 1].sequenceId : 1;
  const activeSeq = isTimeTraveling ? currentSequence : maxSeq;

  // Auto playback loop
  useEffect(() => {
    if (!isPlaying) return;

    const intervalMs = Math.max(200, Math.floor(1000 / playbackSpeed));
    const timer = setInterval(() => {
      if (activeSeq < maxSeq) {
        onScrub(activeSeq + 1);
      } else {
        setIsPlaying(false);
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, activeSeq, maxSeq, playbackSpeed, onScrub]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div className="w-full bg-card border border-border rounded-xl p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        {/* State Indicator */}
        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-foreground">Time-Travel Debugger</span>
            {isTimeTraveling ? (
              <Badge variant="purple" className="font-mono text-xs">
                Rewound to Seq #{activeSeq}
              </Badge>
            ) : (
              <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
                Live Head &bull; Seq #{maxSeq}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Scrub sequence timeline to inspect deterministic state at any point in history.
          </div>
        </div>

        {/* Playback Controls */}
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onScrub(Math.max(1, activeSeq - 1))}
            disabled={activeSeq <= 1}
            title="Step Back"
            className="h-8 w-8 p-0"
          >
            <SkipBack className="size-3.5" />
          </Button>

          <Button
            size="sm"
            variant={isPlaying ? 'destructive-subtle' : 'outline'}
            onClick={() => {
              if (activeSeq >= maxSeq && !isPlaying) {
                onScrub(1);
              }
              setIsPlaying(!isPlaying);
            }}
            title={isPlaying ? 'Pause' : 'Play Timeline'}
            className="h-8 text-xs font-medium"
          >
            {isPlaying ? <Pause className="size-3.5 mr-1" /> : <Play className="size-3.5 mr-1" />}
            {isPlaying ? 'Pause' : 'Replay'}
          </Button>

          <Button
            size="xs"
            variant="outline"
            onClick={() => onScrub(Math.min(maxSeq, activeSeq + 1))}
            disabled={activeSeq >= maxSeq}
            title="Step Forward"
            className="h-8 w-8 p-0"
          >
            <SkipForward className="size-3.5" />
          </Button>

          {/* Speed picker */}
          <div className="flex items-center rounded-md bg-muted border border-border p-0.5 text-xs font-mono ml-1">
            {[1, 2, 5].map((spd) => (
              <button
                type="button"
                key={spd}
                className={`px-2 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                  playbackSpeed === spd
                    ? 'bg-background text-foreground font-semibold shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setPlaybackSpeed(spd)}
              >
                {spd}x
              </button>
            ))}
          </div>

          {/* Resume Live Button */}
          {isTimeTraveling && (
            <Button
              size="sm"
              variant="default"
              onClick={onExitTimeTravel}
              className="ml-2 h-8 text-xs"
            >
              Resume Live Head
            </Button>
          )}
        </div>
      </div>

      {/* Slider Bar */}
      <div className="space-y-2 pt-1">
        <Slider
          value={[activeSeq]}
          min={1}
          max={maxSeq}
          step={1}
          onValueChange={(val) => {
            setIsPlaying(false);
            onScrub(val[0]);
          }}
          className="cursor-pointer"
        />

        <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
          <span>Seq #1</span>
          <span>
            {timeTravelSnapshot?.metadata?.timestamp
              ? formatTime(timeTravelSnapshot.metadata.timestamp)
              : ''}
          </span>
          <span>Seq #{maxSeq}</span>
        </div>
      </div>

      {/* Replayed Event Details Snapshot */}
      {timeTravelSnapshot && (
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Event:</span>
            <Badge variant="secondary" className="font-mono text-xs font-normal">
              {timeTravelSnapshot.eventType}
            </Badge>
            {timeTravelSnapshot.nodeId && (
              <span className="font-mono text-foreground font-medium">
                Node: {timeTravelSnapshot.nodeId}
              </span>
            )}
          </div>
          {timeTravelSnapshot.metadata?.fencingToken && (
            <div className="font-mono text-xs text-muted-foreground">
              Fence #{timeTravelSnapshot.metadata.fencingToken}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
