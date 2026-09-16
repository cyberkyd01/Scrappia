/**
 * Folds the copilot's raw log stream (user messages, events, `CopilotProgress` items, errors) into
 * the chat entries rendered by the Copilot panel. Pure functions so the same code restores a
 * conversation from `copilot.history` and applies live `copilot:progress` / `copilot:log` events.
 */
import type { CopilotEvent, CopilotProgress, CopilotTurnResult, PickedElement } from '@scrappia/core';
import type { CopilotLogItem } from '@shared/ipc';

export type ChatEntry =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number }
  | { id: string; kind: 'event'; text: string; at: number }
  | { id: string; kind: 'tool'; tool: string; summary: string; ok: boolean; pending: boolean; at: number }
  | { id: string; kind: 'error'; text: string; at: number };

export interface ChatState { entries: ChatEntry[]; typing: boolean }

export const emptyChat = (): ChatState => ({ entries: [], typing: false });

let seq = 0;
const nextId = () => `c${++seq}`;

/** Describe an event for the chat ("You picked <a> "Product 1""). */
export function describeEvent(e: CopilotEvent): string {
  switch (e.type) {
    case 'picked': return `You picked ${describePick(e.element)}`;
    case 'list.detected': return `List detected: ${e.list.selector[0]?.value ?? '?'} (${e.list.count} records)`;
    case 'navigated': return `Navigated to ${e.url}`;
    case 'run.finished': return `Run ${e.runId.slice(0, 8)} finished: ${e.status}, ${e.rows} rows`;
  }
}

function describePick(el: PickedElement): string {
  const text = el.text.trim().replace(/\s+/g, ' ');
  const label = text ? ` "${text.length > 40 ? text.slice(0, 40) + '…' : text}"` : '';
  const rec = el.record ? ` (inside a list of ${el.record.count})` : '';
  return `<${el.tag.toLowerCase()}>${label}${rec}`;
}

/** Apply one raw log item to the chat state (immutable). */
export function foldLogItem(state: ChatState, item: CopilotLogItem): ChatState {
  const entries = state.entries;
  switch (item.kind) {
    case 'user': return { entries: [...entries, { id: nextId(), kind: 'user', text: item.text, at: item.at }], typing: state.typing };
    case 'event': return { entries: [...entries, { id: nextId(), kind: 'event', text: describeEvent(item.event), at: item.at }], typing: state.typing };
    case 'error': return { entries: [...entries, { id: nextId(), kind: 'error', text: item.text, at: item.at }], typing: false };
    case 'progress': return foldProgress(state, item.progress, item.at);
  }
}

function foldProgress(state: ChatState, p: CopilotProgress, at: number): ChatState {
  const entries = state.entries;
  switch (p.type) {
    case 'thinking': return { entries, typing: true };
    case 'call': return { entries: [...entries, { id: nextId(), kind: 'tool', tool: p.tool, summary: `${p.tool}…`, ok: true, pending: true, at }], typing: true };
    case 'result': {
      // Resolve the matching pending chip (last pending call with this tool name), otherwise append.
      let i = entries.length - 1;
      while (i >= 0) { const e = entries[i]; if (e.kind === 'tool' && e.pending && e.tool === p.tool) break; i--; }
      const chip: ChatEntry = { id: i >= 0 ? entries[i].id : nextId(), kind: 'tool', tool: p.tool, summary: p.summary, ok: p.ok, pending: false, at };
      const next = i >= 0 ? [...entries.slice(0, i), chip, ...entries.slice(i + 1)] : [...entries, chip];
      return { entries: next, typing: true };
    }
    case 'reply': {
      const text = p.text.trim();
      return { entries: text ? [...entries, { id: nextId(), kind: 'assistant', text, at }] : entries, typing: false };
    }
  }
}

/** Rebuild the chat from a full log (used on mount / after returning from the run monitor). */
export function buildChat(log: CopilotLogItem[]): ChatState {
  return log.reduce(foldLogItem, emptyChat());
}

/**
 * Turn a finished `CopilotTurnResult` into log items (tool chips + final reply). Used when a turn
 * completes without any streamed progress (e.g. a host that does not stream), so nothing is lost.
 */
export function turnResultToItems(result: CopilotTurnResult, at = Date.now()): CopilotLogItem[] {
  const items: CopilotLogItem[] = result.actions.map((a) => ({ kind: 'progress', progress: { type: 'result', tool: a.tool, ok: a.ok, summary: a.summary }, at }));
  items.push({ kind: 'progress', progress: { type: 'reply', text: result.reply }, at });
  return items;
}

/** Short banner text while the copilot waits for picks. */
export function waitingBanner(mode: string, instruction: string): string {
  const what = instruction.trim() || (mode === 'pickList' ? 'one of the repeating items' : mode === 'pickAction' ? 'the button or input' : 'the element');
  return `Copilot is waiting for you to click ${what} in the browser window. Say "done" when finished.`;
}
