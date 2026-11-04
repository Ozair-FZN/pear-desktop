import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from 'solid-js';
import { type VirtualizerHandle } from 'virtua/solid';

import { type LineLyrics } from '@/plugins/synced-lyrics/types';

import { _ytAPI } from '..';
import { config, currentTime, isPlaying, seekCount } from '../renderer';
import {
  canonicalize,
  convertChineseCharacter,
  romanize,
  simplifyUnicode,
} from '../utils';

// How long before the next lyric line the current one should be fully "sung".
const LINE_END_GAP_MS = 100;
// Used when the line duration is unknown (e.g. the last line of an LRC file).
const FALLBACK_DURATION_MS = 5000;

/**
 * Lyrics providers only tell us when a line starts, not when each word is sung.
 * We assume the line is sung between its start time `t_s` and the start of the
 * next line `t_e` (minus a small gap), and spread the words over that window,
 * weighted by their length, since longer words take longer to sing.
 *
 * `elapsed` is how far into the line playback was when the animation (re)started,
 * so the delays can be negative when we join a line midway (e.g. after a seek).
 */
const wordTimingStyles = (
  words: string[],
  line: LineLyrics,
  elapsed: number,
) => {
  let duration = line.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    const songEnd = (_ytAPI?.getDuration() ?? 0) * 1000;
    const remaining = songEnd - line.timeInMs;
    duration =
      remaining > 0
        ? Math.min(remaining, FALLBACK_DURATION_MS)
        : FALLBACK_DURATION_MS;
  }

  const singing = Math.max(
    duration * 0.5,
    duration - Math.min(LINE_END_GAP_MS, duration * 0.05),
  );

  const weights = words.map((word) => Math.max(1, Array.from(word).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let start = 0;
  return weights.map((weight) => {
    const wordDuration = (singing * weight) / totalWeight;
    const style = {
      '--lyrics-word-delay': `${start - elapsed}ms`,
      '--lyrics-word-duration': `${wordDuration}ms`,
    };
    start += wordDuration;
    return style;
  });
};

const AnimatedWords = (props: {
  text: string;
  line: LineLyrics;
  elapsed: number;
  class?: string;
}) => {
  const words = createMemo(() => props.text.split(' '));
  const styles = createMemo(() =>
    wordTimingStyles(words(), props.line, props.elapsed),
  );

  return (
    <span class={props.class}>
      <For each={words()}>
        {(word, index) => (
          <span style={styles()[index()]}>
            <yt-formatted-string text={{ runs: [{ text: `${word} ` }] }} />
          </span>
        )}
      </For>
    </span>
  );
};

interface SyncedLineProps {
  scroller: VirtualizerHandle;
  index: number;

  line: LineLyrics;
  status: 'upcoming' | 'current' | 'previous';
}

const EmptyLine = (props: SyncedLineProps) => {
  const states = createMemo(() => {
    const defaultText = config()?.defaultTextString ?? '';
    return Array.isArray(defaultText) ? defaultText : [defaultText];
  });

  const index = createMemo(() => {
    const progress = currentTime() - props.line.timeInMs;
    const total = props.line.duration;

    const percentage = Math.min(1, progress / total);
    return Math.max(0, Math.floor((states().length - 1) * percentage));
  });

  return (
    <div
      class={`synced-line ${props.status}`}
      onClick={() => {
        _ytAPI?.seekTo((props.line.timeInMs + 10) / 1000);
      }}
    >
      <div class="description ytmusic-description-shelf-renderer" dir="auto">
        <yt-formatted-string
          text={{
            runs: [
              {
                text: config()?.showTimeCodes ? `[${props.line.time}] ` : '',
              },
            ],
          }}
        />

        <div class="text-lyrics">
          <span>
            <span>
              <Show
                fallback={
                  <yt-formatted-string
                    text={{ runs: [{ text: states()[0] }] }}
                  />
                }
                when={states().length > 1}
              >
                <yt-formatted-string
                  text={{
                    runs: [
                      {
                        text: states().at(
                          props.status === 'current' ? index() : -1,
                        )!,
                      },
                    ],
                  }}
                />
              </Show>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};

export const SyncedLine = (props: SyncedLineProps) => {
  const text = createMemo(() => {
    let line = props.line.text;
    const convertChineseText = config()?.convertChineseCharacter;
    if (convertChineseText && convertChineseText !== 'disabled') {
      line = convertChineseCharacter(line, convertChineseText);
    }
    return line.trim();
  });

  const [romanization, setRomanization] = createSignal('');
  createEffect(() => {
    const input = canonicalize(text());
    if (!config()?.romanization) return;

    romanize(input).then((result) => {
      setRomanization(canonicalize(result));
    });
  });

  // A new object every time the line becomes current or the user seeks,
  // which re-mounts the words below and thus restarts their animations,
  // aligned with the actual playback position.
  const sync = createMemo(() => {
    seekCount();
    const status = props.status;
    const elapsed =
      status === 'current' ? untrack(currentTime) - props.line.timeInMs : 0;
    return { status, elapsed };
  });

  return (
    <Show fallback={<EmptyLine {...props} />} when={text()}>
      <div
        class={`synced-line ${props.status}${isPlaying() ? '' : ' paused'}`}
        onClick={() => {
          _ytAPI?.seekTo((props.line.timeInMs + 10) / 1000);
        }}
      >
        <div class="description ytmusic-description-shelf-renderer" dir="auto">
          <yt-formatted-string
            text={{
              runs: [
                {
                  text: config()?.showTimeCodes ? `[${props.line.time}] ` : '',
                },
              ],
            }}
          />

          <div
            class="text-lyrics"
            style={{ 'display': 'flex', 'flex-direction': 'column' }}
          >
            <Show keyed when={sync()}>
              {({ elapsed }) => (
                <>
                  <AnimatedWords
                    elapsed={elapsed}
                    line={props.line}
                    text={text()}
                  />

                  <Show
                    when={
                      config()?.romanization &&
                      simplifyUnicode(text()) !==
                        simplifyUnicode(romanization())
                    }
                  >
                    <AnimatedWords
                      class="romaji"
                      elapsed={elapsed}
                      line={props.line}
                      text={romanization()}
                    />
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
