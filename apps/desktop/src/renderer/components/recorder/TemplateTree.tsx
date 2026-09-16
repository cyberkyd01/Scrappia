import type { Recipe } from '@scrappia/core';
import { Btn, Badge } from '../ui';
import type { FieldTarget } from '../../state/recipe';
import { describeAction } from './Editors';

export type Selection =
  | { kind: 'pick' }
  | { kind: 'template'; template: string }
  | { kind: 'field'; template: string; target: FieldTarget; index: number }
  | { kind: 'list'; template: string }
  | { kind: 'action'; template: string; index: number }
  | { kind: 'pagination'; template: string }
  | { kind: 'follow'; template: string; target: FieldTarget; index: number };

function same(a: Selection | null, b: Selection): boolean { return !!a && JSON.stringify(a) === JSON.stringify(b); }

export function TemplateTree({ recipe, current, selection, onSelect, onSetCurrent, onAddTemplate }: {
  recipe: Recipe; current: string; selection: Selection | null; onSelect: (s: Selection) => void; onSetCurrent: (name: string) => void; onAddTemplate: () => void;
}) {
  return (
    <div className="tree">
      {Object.entries(recipe.templates).map(([name, t]) => {
        const isCurrent = name === current;
        const sel = (s: Selection) => `node${same(selection, s) ? ' selected' : ''}`;
        return (
          <div className="group" key={name} data-testid={`tree-template-${name}`} data-current={isCurrent ? 'true' : 'false'}>
            <div className={`group-title${isCurrent ? '' : ' muted'}`} onClick={() => { onSetCurrent(name); onSelect({ kind: 'template', template: name }); }} style={{ cursor: 'pointer' }} data-testid={`tree-template-title-${name}`}>
              <span>{isCurrent ? '▾' : '▸'}</span>
              <span className="grow ellipsis">{name}</span>
              {recipe.entry.template === name && <Badge tone="accent">entry</Badge>}
              {!isCurrent && <span className="faint tiny">{(t.list?.fields.length ?? 0) + t.fields.length} fields</span>}
            </div>
            {isCurrent && (
              <div className="children">
                {t.actions.length > 0 && (
                  <>
                    <div className="node faint"><span className="k">actions</span><span className="n">{t.actions.length}</span></div>
                    <div className="children">
                      {t.actions.map((a, i) => <div key={i} className={sel({ kind: 'action', template: name, index: i })} onClick={() => onSelect({ kind: 'action', template: name, index: i })}><span className="k">{i + 1}</span><span className="n">{describeAction(a)}</span></div>)}
                    </div>
                  </>
                )}
                {t.fields.length > 0 && <div className="node faint"><span className="k">page</span><span className="n">{t.fields.length} field(s)</span></div>}
                {t.fields.length > 0 && (
                  <div className="children">
                    {t.fields.map((f, i) => (
                      <div key={i} className={sel({ kind: 'field', template: name, target: 'page', index: i })} onClick={() => onSelect({ kind: 'field', template: name, target: 'page', index: i })} data-testid={`tree-field-${f.name}`}>
                        <span className="k">{f.type}</span><span className="n">{f.name}</span><span className="sel">{f.selector?.[0]?.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {t.list ? (
                  <>
                    <div className={sel({ kind: 'list', template: name })} onClick={() => onSelect({ kind: 'list', template: name })} data-testid="tree-list">
                      <span className="k">list</span><span className="n">records</span><span className="sel">{t.list.selector[0]?.value}</span>
                    </div>
                    <div className="children">
                      {t.list.fields.length === 0 && <div className="node faint"><span className="n tiny">no fields yet — pick elements inside a record</span></div>}
                      {t.list.fields.map((f, i) => (
                        <div key={i} className={sel({ kind: 'field', template: name, target: 'list', index: i })} onClick={() => onSelect({ kind: 'field', template: name, target: 'list', index: i })} data-testid={`tree-field-${f.name}`}>
                          <span className="k">{f.type}</span><span className="n">{f.name}</span><span className="sel">{f.selector?.[0]?.value}</span>
                        </div>
                      ))}
                      {t.list.follow.map((f, i) => (
                        <div key={`f${i}`} className={sel({ kind: 'follow', template: name, target: 'list', index: i })} onClick={() => onSelect({ kind: 'follow', template: name, target: 'list', index: i })} data-testid="tree-follow">
                          <span className="k">follow</span><span className="n">{f.field ?? f.selector?.[0]?.value} → {f.template}</span><span className="sel">{f.mode}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="node faint" onClick={() => onSelect({ kind: 'list', template: name })} data-testid="tree-list-none"><span className="k">list</span><span className="n tiny">none — use "Pick list" or auto-detect</span></div>
                )}
                {t.follow.map((f, i) => (
                  <div key={`pf${i}`} className={sel({ kind: 'follow', template: name, target: 'page', index: i })} onClick={() => onSelect({ kind: 'follow', template: name, target: 'page', index: i })} data-testid="tree-follow">
                    <span className="k">follow</span><span className="n">{f.field ?? f.selector?.[0]?.value} → {f.template}</span><span className="sel">{f.mode}</span>
                  </div>
                ))}
                <div className={sel({ kind: 'pagination', template: name })} onClick={() => onSelect({ kind: 'pagination', template: name })} data-testid="tree-pagination" data-type={t.pagination?.type ?? 'none'}>
                  <span className="k">paging</span><span className={`n${t.pagination ? '' : ' faint'}`}>{t.pagination ? t.pagination.type : 'none'}</span>
                  {t.pagination && 'selector' in t.pagination && t.pagination.selector && <span className="sel">{t.pagination.selector[0]?.value}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-8"><Btn size="sm" onClick={onAddTemplate} data-testid="tree-add-template">+ template</Btn></div>
    </div>
  );
}
