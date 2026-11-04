import { batch, createEffect, runWithOwner } from 'solid-js';

import { getSongInfo } from '@/providers/song-info-front';
import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { disposeReactiveRoot, reactiveOwner } from './reactive-root';
import {
  setConfig,
  setCurrentTime,
  setIsPlaying,
  setSeekCount,
} from './renderer';
import { currentLyrics, fetchLyrics, updateEnabledProviders } from './store';
import { selectors, tabStates } from './utils';

import type { LyricResult, SyncedLyricsPluginConfig } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

const PLAYER_STATE_PLAYING = 1;
const SEEK_THRESHOLD_MS = 500;

const formatLrcTime = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const centiseconds = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
};

/** Converts lyrics into the file contents saved alongside downloads. */
const toLyricsFile = (
  data: LyricResult,
): { extension: 'lrc' | 'txt'; content: string } | null => {
  const lines = data.lines?.filter(
    (line, idx) => !(idx === 0 && line.timeInMs === 0 && !line.text.trim()),
  );
  if (lines?.length) {
    return {
      extension: 'lrc',
      content: lines
        .map((line) => `[${formatLrcTime(line.timeInMs)}]${line.text}`)
        .join('\n'),
    };
  }
  if (data.lyrics?.trim()) {
    return { extension: 'txt', content: data.lyrics };
  }
  return null;
};

export let _ytAPI: MusicPlayer | null = null;
export let netFetch: (
  url: string,
  init?: RequestInit,
) => Promise<[number, string, Record<string, string>]>;

export const renderer = createRenderer<
  {
    observerCallback: MutationCallback;
    observer?: MutationObserver;
    videoDataChange: () => Promise<void>;
    updateTimestampInterval?: NodeJS.Timeout | string | number;
  },
  SyncedLyricsPluginConfig
>({
  onConfigChange(newConfig) {
    updateEnabledProviders(newConfig.disabledProviders);
    setConfig(newConfig);
  },

  observerCallback(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      const header = mutation.target as HTMLElement;

      switch (mutation.attributeName) {
        case 'disabled':
          header.removeAttribute('disabled');
          break;
        case 'aria-selected':
          tabStates[header.ariaSelected ?? 'false']();
          break;
      }
    }
  },

  async onPlayerApiReady(api: MusicPlayer) {
    _ytAPI = api;

    api.addEventListener('videodatachange', this.videoDataChange);

    await this.videoDataChange();
  },
  async videoDataChange() {
    if (!this.updateTimestampInterval) {
      // Used to detect jumps in the playback position (seeks, song changes),
      // so the word animations can be re-aligned.
      let last = { time: -1, at: performance.now(), playing: false };

      this.updateTimestampInterval = setInterval(() => {
        const time = (_ytAPI?.getCurrentTime() ?? 0) * 1000;
        const at = performance.now();
        const playing = _ytAPI?.getPlayerState() === PLAYER_STATE_PLAYING;
        const rate = _ytAPI?.getPlaybackRate() ?? 1;

        const expected = last.time + (last.playing ? (at - last.at) * rate : 0);
        const jumped = Math.abs(time - expected) > SEEK_THRESHOLD_MS;
        last = { time, at, playing };

        batch(() => {
          setCurrentTime(time);
          setIsPlaying(playing);
          if (jumped) setSeekCount((count) => count + 1);
        });
      }, 100);
    }

    // prettier-ignore
    this.observer ??= new MutationObserver(this.observerCallback);
    this.observer.disconnect();

    // Force the lyrics tab to be enabled at all times.
    const header = await waitForElement<HTMLElement>(selectors.head);
    {
      header.removeAttribute('disabled');
      tabStates[header.ariaSelected ?? 'false']();
    }

    this.observer.observe(header, { attributes: true });
    header.removeAttribute('disabled');
  },

  async start(ctx: RendererContext<SyncedLyricsPluginConfig>) {
    netFetch = ctx.ipc.invoke.bind(ctx.ipc, 'synced-lyrics:fetch');

    const config = await ctx.getConfig();
    updateEnabledProviders(config.disabledProviders);
    setConfig(config);

    ctx.ipc.on('peard:update-song-info', (info: SongInfo) => {
      fetchLyrics(info);
    });

    // Share the lyrics shown for the current song, so the downloader can
    // save them next to the downloaded file.
    runWithOwner(reactiveOwner, () => {
      createEffect(() => {
        const data = currentLyrics()?.data;
        const videoId = getSongInfo()?.videoId;
        if (!data || !videoId) return;

        const file = toLyricsFile(data);
        if (file) ctx.ipc.send('synced-lyrics:lyrics', { videoId, ...file });
      });
    });
  },

  stop() {
    disposeReactiveRoot();
  },
});
