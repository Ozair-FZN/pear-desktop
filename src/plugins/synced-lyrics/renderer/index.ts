import { batch } from 'solid-js';

import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { disposeReactiveRoot } from './reactive-root';
import {
  setConfig,
  setCurrentTime,
  setIsPlaying,
  setSeekCount,
} from './renderer';
import { fetchLyrics, updateEnabledProviders } from './store';
import { selectors, tabStates } from './utils';

import type { SyncedLyricsPluginConfig } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

const PLAYER_STATE_PLAYING = 1;
const SEEK_THRESHOLD_MS = 500;

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
  },

  stop() {
    disposeReactiveRoot();
  },
});
