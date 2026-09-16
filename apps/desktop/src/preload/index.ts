import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/ipc';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

const bridge = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!invokeSet.has(channel)) return Promise.reject(new Error('unknown ipc channel: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!eventSet.has(channel)) throw new Error('unknown ipc event: ' + channel);
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
};

contextBridge.exposeInMainWorld('scrappia', bridge);
