import { describe, it, expect } from 'vitest';
import type { CopilotProgress, CopilotTurnResult, PickedElement } from '@scrappia/core';
import type { CopilotLogItem } from '@shared/ipc';
import { buildChat, foldLogItem, emptyChat, turnResultToItems, describeEvent, waitingBanner } from './copilotLog';

const at = 1000;
const progress = (p: CopilotProgress): CopilotLogItem => ({ kind: 'progress', progress: p, at });

const pick: PickedElement = {
  selectors: [{ kind: 'css', value: 'article.product:nth-child(1) h3 a' }], tag: 'A', text: '  Product   1 ', html: '<a>Product 1</a>', attrs: {}, href: 'http://x/product/1',
  rect: { x: 0, y: 0, width: 10, height: 10 }, suggestedType: 'href', suggestedName: 'link', frameUrl: 'http://x/',
  record: { selector: [{ kind: 'css', value: 'article.product' }], count: 10, clickedIndex: 0, fields: [] },
};

describe('copilot chat log', () => {
  it('folds user messages, tool calls/results and replies into entries', () => {
    const log: CopilotLogItem[] = [
      { kind: 'user', text: "let's start scraping", at },
      progress({ type: 'thinking' }),
      progress({ type: 'call', tool: 'detect_lists', args: {} }),
      progress({ type: 'result', tool: 'detect_lists', ok: true, summary: 'detect_lists: 3 candidate list(s)' }),
      progress({ type: 'call', tool: 'set_list', args: { selector: 'article' } }),
      progress({ type: 'result', tool: 'set_list', ok: false, summary: 'set_list failed: bad selector' }),
      progress({ type: 'reply', text: 'Found 3 lists. Which one?' }),
    ];
    const chat = buildChat(log);
    expect(chat.typing).toBe(false);
    expect(chat.entries.map((e) => e.kind)).toEqual(['user', 'tool', 'tool', 'assistant']);
    const [, detect, setList, reply] = chat.entries;
    expect(detect).toMatchObject({ kind: 'tool', tool: 'detect_lists', ok: true, pending: false, summary: 'detect_lists: 3 candidate list(s)' });
    expect(setList).toMatchObject({ kind: 'tool', tool: 'set_list', ok: false, pending: false, summary: 'set_list failed: bad selector' });
    expect(reply).toMatchObject({ kind: 'assistant', text: 'Found 3 lists. Which one?' });
  });

  it('shows a typing indicator while thinking and pending chips for in-flight calls', () => {
    let s = foldLogItem(emptyChat(), { kind: 'user', text: 'hi', at });
    s = foldLogItem(s, progress({ type: 'thinking' }));
    expect(s.typing).toBe(true);
    s = foldLogItem(s, progress({ type: 'call', tool: 'preview', args: {} }));
    expect(s.entries[1]).toMatchObject({ kind: 'tool', tool: 'preview', pending: true, summary: 'preview…' });
    // a result for a tool that never streamed a call is appended rather than dropped
    s = foldLogItem(s, progress({ type: 'result', tool: 'get_page', ok: true, summary: 'get_page ok' }));
    expect(s.entries).toHaveLength(3);
    s = foldLogItem(s, progress({ type: 'result', tool: 'preview', ok: true, summary: 'preview: 10 records' }));
    expect(s.entries).toHaveLength(3);
    expect(s.entries[1]).toMatchObject({ kind: 'tool', tool: 'preview', pending: false, summary: 'preview: 10 records' });
    // empty replies add no bubble but end typing
    s = foldLogItem(s, progress({ type: 'reply', text: '   ' }));
    expect(s.entries).toHaveLength(3);
    expect(s.typing).toBe(false);
  });

  it('renders events and errors', () => {
    const s = buildChat([
      { kind: 'event', event: { type: 'picked', element: pick }, at },
      { kind: 'event', event: { type: 'run.finished', runId: 'abcdef123456', status: 'succeeded', rows: 25 }, at },
      { kind: 'error', text: 'provider exploded', at },
    ]);
    expect(s.entries[0]).toMatchObject({ kind: 'event', text: 'You picked <a> "Product 1" (inside a list of 10)' });
    expect(s.entries[1]).toMatchObject({ kind: 'event', text: 'Run abcdef12 finished: succeeded, 25 rows' });
    expect(s.entries[2]).toMatchObject({ kind: 'error', text: 'provider exploded' });
    expect(describeEvent({ type: 'list.detected', list: pick.record! })).toBe('List detected: article.product (10 records)');
    expect(describeEvent({ type: 'navigated', url: 'http://x/p2' })).toBe('Navigated to http://x/p2');
  });

  it('converts a turn result into log items (fallback when nothing streamed)', () => {
    const result: CopilotTurnResult = {
      reply: 'Done.', recipe: {} as CopilotTurnResult['recipe'], waitingForPicks: false, done: true, usage: { calls: 1, inputTokens: 1, outputTokens: 1 },
      actions: [{ tool: 'set_pagination', args: {}, ok: true, summary: 'pagination: next (1 match)' }, { tool: 'test_run', args: {}, ok: false, summary: 'test_run failed: boom' }],
    };
    const items = turnResultToItems(result, at);
    expect(items).toHaveLength(3);
    const chat = buildChat(items);
    expect(chat.entries.map((e) => e.kind)).toEqual(['tool', 'tool', 'assistant']);
    expect(chat.entries[1]).toMatchObject({ ok: false, summary: 'test_run failed: boom' });
    expect(chat.entries[2]).toMatchObject({ text: 'Done.' });
  });

  it('builds the waiting banner from the instruction or the mode', () => {
    expect(waitingBanner('pickList', 'one product card')).toBe('Copilot is waiting for you to click one product card in the browser window. Say "done" when finished.');
    expect(waitingBanner('pickList', '')).toContain('one of the repeating items');
    expect(waitingBanner('pick', '')).toContain('the element');
  });
});
