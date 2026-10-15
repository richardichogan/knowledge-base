/**
 * AI flow / governance panels for the diagram editor: the properties sections
 * for steps, lanes and connectors, the Governance findings list and the key.
 * Cleared fields are removed rather than saved as empty strings.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AGENT_MODE_BADGES, AGENT_MODE_LABELS, ASSERTION_LABELS, EDGE_STYLES, EDGE_TYPE_LABELS, INTERACTION_LABELS, MEMORY_LABELS,
  SENSITIVITY_LABELS, STATE_LABELS, STEP_STYLES, STEP_TYPE_LABELS, VOLUME_LABELS, isAiStep, type AiFlowFinding, type AiFlowSeverity,
} from './aiFlow';
import {
  AI_AGENT_MODES, AI_ASSERTION_LEVELS, AI_FLOW_EDGE_TYPES, AI_FLOW_INTERACTIONS, AI_FLOW_STATES, AI_FLOW_STEP_KINDS, AI_FLOW_STEP_TYPES,
  AI_FLOW_VOLUMES, AI_MEMORY_SCOPES, DATA_SENSITIVITIES, type AiFlowAgent, type AiFlowControls, type AiFlowEdge, type AiFlowOperations,
  type AiFlowStep, type AiFlowStepType, type DiagramEdge, type DiagramKind, type DiagramNode,
} from './diagramTypes';
import { AI_CHIP_COLOURS, AI_SEVERITY_COLOURS, AI_SEVERITY_LABELS, ASSERTION_SHORT, STEP_TYPE_SHORT, applyStepStyle, hasStepStyle, parseAiList, type AiChipTone } from './diagramAiFlowBadges';
import { diagramEditorFill, diagramEditorInk } from './diagramTheme';

const TEXT_MAX = 500;
const LANE_ORDER_LIMIT = 10000;
const STEP_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>(AI_FLOW_STEP_KINDS);

const isAiStepKind = (kind: DiagramKind): boolean => STEP_KINDS.has(kind);

/** Copy of `obj` with `key` set, or removed when the value is empty. */
function withKey<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const next = { ...obj };
  const empty = value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
  if (empty) delete next[key];
  else next[key] = value;
  return next;
}

const isEmpty = (obj: object): boolean => Object.keys(obj).length === 0;

/** Tracks whether a typing session has started so the first keystroke is undoable and the rest coalesce. */
function useTypingSession(): { begin: () => boolean; end: () => void } {
  const started = useRef(false);
  return {
    begin: () => { const first = !started.current; started.current = true; return first; },
    end: () => { started.current = false; },
  };
}

// ── Field controls ──────────────────────────────────────────────────────────

interface TextFieldProps { label: string; value: string | undefined; onChange: (value: string, first: boolean) => void; multiline?: boolean; placeholder?: string; hint?: string }

function TextField({ label, value, onChange, multiline = false, placeholder, hint }: TextFieldProps): React.ReactElement {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  const session = useTypingSession();
  useEffect(() => { if (!focused) setDraft(value ?? ''); }, [value, focused]);
  const common = {
    className: multiline ? 'dg-ai-props__input dg-ai-props__input--multiline' : 'dg-ai-props__input',
    value: draft, maxLength: TEXT_MAX, placeholder,
    onFocus: () => { setFocused(true); session.end(); },
    onBlur: () => { setFocused(false); session.end(); },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); onChange(e.target.value, session.begin()); },
  };
  return (
    <label className="dg-ai-props__field">
      <span className="dg-ai-props__label">{label}</span>
      {multiline ? <textarea rows={2} {...common} /> : <input type="text" {...common} />}
      {hint !== undefined && <span className="dg-ai-props__hint">{hint}</span>}
    </label>
  );
}

function ListField({ label, value, onChange, placeholder }: { label: string; value: readonly string[] | undefined; onChange: (value: string[], first: boolean) => void; placeholder?: string }): React.ReactElement {
  const joined = (value ?? []).join(', ');
  const [draft, setDraft] = useState(joined);
  const [focused, setFocused] = useState(false);
  const session = useTypingSession();
  useEffect(() => { if (!focused) setDraft(joined); }, [joined, focused]);
  const items = parseAiList(draft);
  return (
    <label className="dg-ai-props__field">
      <span className="dg-ai-props__label">{label}</span>
      <textarea
        className="dg-ai-props__input dg-ai-props__input--multiline" rows={2} value={draft} placeholder={placeholder ?? 'Separate items with commas'}
        onFocus={() => { setFocused(true); session.end(); }}
        onBlur={() => { setFocused(false); session.end(); setDraft(parseAiList(draft).join(', ')); }}
        onChange={(e) => { setDraft(e.target.value); onChange(parseAiList(e.target.value), session.begin()); }}
      />
      {items.length > 0 && (
        <span className="dg-ai-props__chips" aria-label={`${items.length} item${items.length === 1 ? '' : 's'}`}>
          {items.map((item, i) => <span key={`${i}-${item}`} className="dg-ai-props__chip">{item}</span>)}
        </span>
      )}
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, labels, onChange, emptyLabel = 'Not set' }: {
  label: string; value: T | undefined; options: readonly T[]; labels: Record<T, string>; onChange: (value: T | undefined) => void; emptyLabel?: string | null;
}): React.ReactElement {
  return (
    <label className="dg-ai-props__field">
      <span className="dg-ai-props__label">{label}</span>
      <select className="dg-ai-props__select" value={value ?? ''} onChange={(e) => { onChange(e.target.value === '' ? undefined : e.target.value as T); }}>
        {emptyLabel !== null && <option value="">{emptyLabel}</option>}
        {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
      </select>
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <label className="dg-check dg-ai-props__check">
      <input type="checkbox" className="dg-check__input" checked={checked} onChange={(e) => { onChange(e.target.checked); }} />
      <span className="dg-check__label">{label}</span>
    </label>
  );
}

function NumberField({ label, value, min, max, step, onChange, hint, placeholder }: {
  label: string; value: number | undefined; min: number; max: number; step: number; onChange: (value: number | undefined) => void; hint?: string; placeholder?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { if (!focused) { setDraft(value === undefined ? '' : String(value)); setInvalid(false); } }, [value, focused]);
  const commit = (raw: string): void => {
    if (raw.trim() === '') { setInvalid(false); onChange(undefined); return; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) { setInvalid(true); return; }
    setInvalid(false);
    if (n !== value) onChange(n);
  };
  return (
    <label className="dg-ai-props__field">
      <span className="dg-ai-props__label">{label}</span>
      <input
        type="number" className={`dg-ai-props__input${invalid ? ' dg-ai-props__input--invalid' : ''}`} value={draft} min={min} max={max} step={step}
        placeholder={placeholder} aria-invalid={invalid}
        onFocus={() => { setFocused(true); }}
        onBlur={(e) => { setFocused(false); commit(e.target.value); }}
        onChange={(e) => { setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value); }}
      />
      {invalid ? <span className="dg-ai-props__error" role="alert">Enter a number from {min} to {max}.</span>
        : hint !== undefined && <span className="dg-ai-props__hint">{hint}</span>}
    </label>
  );
}

function Group({ title, defaultOpen, children, badge }: { title: string; defaultOpen: boolean; children: React.ReactNode; badge?: string | undefined }): React.ReactElement {
  return (
    <details className="dg-ai-props__group" open={defaultOpen}>
      <summary className="dg-ai-props__summary">
        <span>{title}</span>
        {badge !== undefined && <span className="dg-ai-props__count">{badge}</span>}
      </summary>
      <div className="dg-ai-props__fields">{children}</div>
    </details>
  );
}

// ── Properties ──────────────────────────────────────────────────────────────

export interface AiFlowPropertiesProps {
  node?: DiagramNode | undefined;
  edge?: DiagramEdge | undefined;
  /** Lane order to use when a swimlane without lane metadata is first described. */
  nextLaneOrder: number;
  onNodeChange: (next: DiagramNode, first: boolean) => void;
  onEdgeChange: (next: DiagramEdge, first: boolean) => void;
}

export function AiFlowProperties({ node, edge, nextLaneOrder, onNodeChange, onEdgeChange }: AiFlowPropertiesProps): React.ReactElement | null {
  if (edge !== undefined) return <AiConnectorProperties edge={edge} onChange={onEdgeChange} />;
  if (node === undefined) return null;
  if (node.kind === 'swimlane') return <AiLaneProperties node={node} nextLaneOrder={nextLaneOrder} onChange={onNodeChange} />;
  if (!isAiStepKind(node.kind)) {
    return <p className="dg-ai-props__note">Only process, decision, start / end and document shapes can be AI flow steps.</p>;
  }
  return <AiStepProperties node={node} onChange={onNodeChange} />;
}

function AiStepProperties({ node, onChange }: { node: DiagramNode; onChange: (next: DiagramNode, first: boolean) => void }): React.ReactElement {
  const flow = node.flow;
  const setFlow = (next: AiFlowStep | undefined, first = true): void => {
    const n = { ...node };
    if (next === undefined) delete n.flow; else n.flow = next;
    onChange(n, first);
  };
  const changeType = (type: AiFlowStepType | undefined): void => {
    if (type === undefined) { setFlow(undefined); return; }
    const previous = flow?.stepType;
    const label = previous !== undefined && node.label === STEP_TYPE_LABELS[previous] ? STEP_TYPE_LABELS[type] : node.label;
    const n: DiagramNode = { ...node, label, flow: { ...(flow ?? {}), stepType: type } };
    onChange(previous === undefined ? applyStepStyle(n, type) : n, true);
  };

  const typeField = (
    <SelectField label="Step type" value={flow?.stepType} options={AI_FLOW_STEP_TYPES} labels={STEP_TYPE_LABELS} onChange={changeType} emptyLabel="Not a step" />
  );
  if (flow === undefined) {
    return (
      <div className="dg-ai-props" aria-label="AI flow step">
        <h4 className="dg-ai-props__heading">AI flow step</h4>
        {typeField}
        <p className="dg-ai-props__note">Choose a step type to record the actor, agent, controls and operations for this shape.</p>
      </div>
    );
  }

  const agent = flow.agent ?? {};
  const controls = flow.controls ?? {};
  const operations = flow.operations ?? {};
  const set = <K extends keyof AiFlowStep>(key: K, value: AiFlowStep[K] | undefined, first = true): void => { setFlow(withKey(flow, key, value), first); };
  const setAgent = <K extends keyof AiFlowAgent>(key: K, value: AiFlowAgent[K] | undefined, first = true): void => {
    const next = withKey(agent, key, value);
    set('agent', isEmpty(next) ? undefined : next, first);
  };
  const setControls = <K extends keyof AiFlowControls>(key: K, value: AiFlowControls[K] | undefined, first = true): void => {
    const next = withKey(controls, key, value);
    set('controls', isEmpty(next) ? undefined : next, first);
  };
  const setOperations = <K extends keyof AiFlowOperations>(key: K, value: AiFlowOperations[K] | undefined, first = true): void => {
    const next = withKey(operations, key, value);
    set('operations', isEmpty(next) ? undefined : next, first);
  };
  const ai = isAiStep(flow.stepType);
  const agentCount = Object.keys(agent).length;

  return (
    <div className="dg-ai-props" aria-label="AI flow step">
      <h4 className="dg-ai-props__heading">AI flow step</h4>
      {typeField}
      {!hasStepStyle(node, flow.stepType) && (
        <button type="button" className="dg-text-btn dg-text-btn--block dg-ai-props__apply" onClick={() => { onChange(applyStepStyle(node, flow.stepType), true); }}>
          Apply {STEP_TYPE_LABELS[flow.stepType].toLowerCase()} style
        </button>
      )}
      <SelectField label="State" value={flow.state} options={AI_FLOW_STATES} labels={STATE_LABELS} onChange={(v) => { set('state', v); }} />
      <TextField label="Actor" value={flow.actor} placeholder="Who or what performs this step" onChange={(v, first) => { set('actor', v, first); }} />
      <ListField label="Systems" value={flow.systems} onChange={(v, first) => { set('systems', v, first); }} />
      <ListField label="Data in" value={flow.dataIn} onChange={(v, first) => { set('dataIn', v, first); }} />
      <ListField label="Data out" value={flow.dataOut} onChange={(v, first) => { set('dataOut', v, first); }} />

      <Group title="Agent" defaultOpen={ai} badge={agentCount > 0 ? String(agentCount) : undefined} key={`agent-${ai ? 'ai' : 'other'}`}>
        {!ai && <p className="dg-ai-props__note">Optional for this step type. Use it when an AI agent assists the step.</p>}
        <TextField label="Agent role" value={agent.role} onChange={(v, first) => { setAgent('role', v, first); }} />
        <SelectField label="Autonomy" value={agent.mode} options={AI_AGENT_MODES}
          labels={Object.fromEntries(AI_AGENT_MODES.map((m) => [m, `${AGENT_MODE_BADGES[m]} · ${AGENT_MODE_LABELS[m]}`])) as Record<typeof AI_AGENT_MODES[number], string>}
          onChange={(v) => { setAgent('mode', v); }} />
        <SelectField label="Assertion level" value={agent.assertion} options={AI_ASSERTION_LEVELS} labels={ASSERTION_LABELS} onChange={(v) => { setAgent('assertion', v); }} />
        <TextField label="Orchestrator" value={agent.orchestrator} onChange={(v, first) => { setAgent('orchestrator', v, first); }} />
        <ListField label="Tools" value={agent.tools} onChange={(v, first) => { setAgent('tools', v, first); }} />
        <ListField label="Knowledge sources" value={agent.knowledge} onChange={(v, first) => { setAgent('knowledge', v, first); }} />
        <ListField label="Guardrails" value={agent.guardrails} onChange={(v, first) => { setAgent('guardrails', v, first); }} />
        <TextField label="Escalation path" value={agent.escalationPath} multiline onChange={(v, first) => { setAgent('escalationPath', v, first); }} />
        <TextField label="Decision boundary" value={agent.decisionBoundary} multiline onChange={(v, first) => { setAgent('decisionBoundary', v, first); }} />
        <NumberField label="Confidence threshold" value={agent.confidenceThreshold} min={0} max={1} step={0.05} placeholder="0 to 1"
          hint="Below this confidence the agent escalates." onChange={(v) => { setAgent('confidenceThreshold', v); }} />
        <SelectField label="Memory" value={agent.memory} options={AI_MEMORY_SCOPES} labels={MEMORY_LABELS} onChange={(v) => { setAgent('memory', v); }} />
        <TextField label="Model" value={agent.model} onChange={(v, first) => { setAgent('model', v, first); }} />
        <TextField label="Prompt version" value={agent.promptVersion} onChange={(v, first) => { setAgent('promptVersion', v, first); }} />
      </Group>

      <Group title="Controls" defaultOpen badge={Object.keys(controls).length > 0 ? String(Object.keys(controls).length) : undefined}>
        <SelectField label="Data sensitivity" value={controls.sensitivity} options={DATA_SENSITIVITIES} labels={SENSITIVITY_LABELS} onChange={(v) => { setControls('sensitivity', v); }} />
        <CheckField label="Authentication required" checked={controls.authRequired === true} onChange={(v) => { setControls('authRequired', v ? true : undefined); }} />
        <TextField label="Auth model" value={controls.authModel} placeholder="e.g. OAuth on behalf of user" onChange={(v, first) => { setControls('authModel', v, first); }} />
        <CheckField label="Audit logging" checked={controls.auditLogging === true} onChange={(v) => { setControls('auditLogging', v ? true : undefined); }} />
        <CheckField label="Human approval" checked={controls.humanApproval === true} onChange={(v) => { setControls('humanApproval', v ? true : undefined); }} />
        <ListField label="Regulatory tags" value={controls.regulatoryTags} onChange={(v, first) => { setControls('regulatoryTags', v, first); }} />
      </Group>

      <Group title="Operations" defaultOpen={false} badge={Object.keys(operations).length > 0 ? String(Object.keys(operations).length) : undefined}>
        <SelectField label="Volume" value={operations.volume} options={AI_FLOW_VOLUMES} labels={VOLUME_LABELS} onChange={(v) => { setOperations('volume', v); }} />
        <TextField label="SLA" value={operations.sla} onChange={(v, first) => { setOperations('sla', v, first); }} />
        <TextField label="Failure handling" value={operations.failureHandling} multiline onChange={(v, first) => { setOperations('failureHandling', v, first); }} />
        <TextField label="Monitoring" value={operations.monitoring} multiline onChange={(v, first) => { setOperations('monitoring', v, first); }} />
      </Group>
    </div>
  );
}

function AiLaneProperties({ node, nextLaneOrder, onChange }: { node: DiagramNode; nextLaneOrder: number; onChange: (next: DiagramNode, first: boolean) => void }): React.ReactElement {
  const lane = node.lane ?? { order: nextLaneOrder };
  const setLane = (key: 'owner' | 'description', value: string, first: boolean): void => { onChange({ ...node, lane: withKey(lane, key, value) }, first); };
  return (
    <div className="dg-ai-props" aria-label="AI flow lane">
      <h4 className="dg-ai-props__heading">Lane</h4>
      <NumberField label="Order" value={node.lane?.order} min={-LANE_ORDER_LIMIT} max={LANE_ORDER_LIMIT} step={1} placeholder={String(nextLaneOrder)}
        hint="Arrange lanes stacks lanes from the lowest order down."
        onChange={(v) => { onChange({ ...node, lane: { ...lane, order: v === undefined ? lane.order : Math.round(v) } }, true); }} />
      <TextField label="Owner or persona" value={node.lane?.owner} placeholder="e.g. Claims handler" onChange={(v, first) => { setLane('owner', v, first); }} />
      <TextField label="Lane description" value={node.lane?.description} multiline onChange={(v, first) => { setLane('description', v, first); }} />
    </div>
  );
}

function AiConnectorProperties({ edge, onChange }: { edge: DiagramEdge; onChange: (next: DiagramEdge, first: boolean) => void }): React.ReactElement {
  const flow: AiFlowEdge = edge.flow ?? { edgeType: 'primary_flow' };
  const set = <K extends keyof AiFlowEdge>(key: K, value: AiFlowEdge[K] | undefined, first = true): void => {
    onChange({ ...edge, flow: withKey(flow, key, value) }, first);
  };
  const changeType = (type: AiFlowEdge['edgeType'] | undefined): void => {
    if (type === undefined) { const next = { ...edge }; delete next.flow; onChange(next, true); return; }
    const style = EDGE_STYLES[type];
    onChange({ ...edge, stroke: style.stroke, dashed: style.dashed, flow: { ...flow, edgeType: type } }, true);
  };
  return (
    <div className="dg-ai-props" aria-label="AI flow connector">
      <h4 className="dg-ai-props__heading">AI flow connector</h4>
      <SelectField label="Connector type" value={edge.flow?.edgeType} options={AI_FLOW_EDGE_TYPES} labels={EDGE_TYPE_LABELS} onChange={changeType} />
      <SelectField label="Interaction" value={edge.flow?.interaction} options={AI_FLOW_INTERACTIONS} labels={INTERACTION_LABELS} onChange={(v) => { set('interaction', v); }} />
      <TextField label="Payload" value={edge.flow?.payload} placeholder="What passes along this connector" onChange={(v, first) => { set('payload', v, first); }} />
      <SelectField label="Data sensitivity" value={edge.flow?.sensitivity} options={DATA_SENSITIVITIES} labels={SENSITIVITY_LABELS} onChange={(v) => { set('sensitivity', v); }} />
      <TextField label="Authentication" value={edge.flow?.auth} placeholder="e.g. mTLS, service principal" onChange={(v, first) => { set('auth', v, first); }} />
      <TextField label="Condition" value={edge.flow?.condition} placeholder="When this path is taken" onChange={(v, first) => { set('condition', v, first); }} />
    </div>
  );
}

// ── Governance ──────────────────────────────────────────────────────────────

const SEVERITIES: readonly AiFlowSeverity[] = ['high', 'warning', 'info'];

export function AiFlowGovernance({ findings, onSelect }: { findings: readonly AiFlowFinding[]; onSelect: (targetId: string) => void }): React.ReactElement {
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const);
  return (
    <div className="dg-ai-gov">
      <div className="dg-ai-gov__head">
        <h3>Governance</h3>
        <span className="dg-ai-gov__counts">
          {counts.map(([s, n]) => (
            <span key={s} className={`dg-ai-gov__count dg-ai-gov__count--${s}${n === 0 ? ' dg-ai-gov__count--zero' : ''}`} title={`${n} ${AI_SEVERITY_LABELS[s].toLowerCase()}`}>
              {n} {AI_SEVERITY_LABELS[s]}
            </span>
          ))}
        </span>
      </div>
      {findings.length === 0 ? (
        <p className="dg-ai-gov__empty">No governance findings. Every step has an owner lane, and AI steps have the controls these checks look for.</p>
      ) : (
        <ul className="dg-ai-gov__list">
          {findings.map((f, i) => (
            <li key={`${f.code}-${f.targetId}-${i}`} className="dg-ai-gov__row">
              <span className={`dg-ai-gov__sev dg-ai-gov__sev--${f.severity}`}>{AI_SEVERITY_LABELS[f.severity]}</span>
              <button type="button" className="dg-ai-gov__msg" title="Select this item" onClick={() => { onSelect(f.targetId); }}>{f.message}</button>
            </li>
          ))}
        </ul>
      )}
      <p className="dg-popover__hint">Advisory checks only — nothing here stops the diagram saving.</p>
    </div>
  );
}

// ── Key ─────────────────────────────────────────────────────────────────────

function KeyChip({ tone, text }: { tone: AiChipTone; text: string }): React.ReactElement {
  const c = AI_CHIP_COLOURS[tone];
  return (
    <span className={`dg-ai-key__chip${c.dashed === true ? ' dg-ai-key__chip--dashed' : ''}`} style={{ background: c.fill, borderColor: c.stroke, color: c.text }}>{text}</span>
  );
}

export function AiFlowKey(): React.ReactElement {
  return (
    <div className="dg-ai-key">
      <section className="dg-ai-key__section">
        <h3 className="dg-popover__heading">Step types</h3>
        <ul className="dg-ai-key__list">
          {AI_FLOW_STEP_TYPES.map((t) => (
            <li key={t} className="dg-ai-key__row">
              <span className="dg-ai-key__swatch" style={{ background: diagramEditorFill(STEP_STYLES[t].fill), borderColor: diagramEditorInk(STEP_STYLES[t].stroke) }}>{STEP_TYPE_SHORT[t].code}</span>
              <span>{STEP_TYPE_LABELS[t]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="dg-ai-key__section">
        <h3 className="dg-popover__heading">Autonomy and assertion</h3>
        <ul className="dg-ai-key__list">
          {AI_AGENT_MODES.map((m) => (
            <li key={m} className="dg-ai-key__row"><KeyChip tone={`autonomy-${AGENT_MODE_BADGES[m].slice(1)}` as AiChipTone} text={AGENT_MODE_BADGES[m]} /><span>{AGENT_MODE_LABELS[m]}</span></li>
          ))}
          {AI_ASSERTION_LEVELS.map((a) => (
            <li key={a} className="dg-ai-key__row"><KeyChip tone="assertion" text={ASSERTION_SHORT[a]} /><span>{ASSERTION_LABELS[a]} output</span></li>
          ))}
        </ul>
      </section>
      <section className="dg-ai-key__section">
        <h3 className="dg-popover__heading">Step chips</h3>
        <ul className="dg-ai-key__list">
          <li className="dg-ai-key__row"><KeyChip tone="sensitive" text="PII" /><span>Sensitive data (PII, medical, payment card)</span></li>
          <li className="dg-ai-key__row"><KeyChip tone="restricted" text="Confidential" /><span>Confidential data</span></li>
          <li className="dg-ai-key__row"><KeyChip tone="controls" text="3 ctrl" /><span>Controls: auth, audit, approval, guardrails, regulatory tags</span></li>
          <li className="dg-ai-key__row"><KeyChip tone="tools" text="CRM +2" /><span>Tools the agent calls</span></li>
          <li className="dg-ai-key__row"><KeyChip tone="future" text="Future" /><span>Future state (or existing and future)</span></li>
        </ul>
      </section>
      <section className="dg-ai-key__section">
        <h3 className="dg-popover__heading">Connectors</h3>
        <ul className="dg-ai-key__list">
          {AI_FLOW_EDGE_TYPES.map((t) => (
            <li key={t} className="dg-ai-key__row">
              <svg className="dg-ai-key__line" width="36" height="10" viewBox="0 0 36 10" aria-hidden="true">
                <line x1="1" y1="5" x2="35" y2="5" stroke={diagramEditorInk(EDGE_STYLES[t].stroke)} strokeWidth="2" strokeDasharray={EDGE_STYLES[t].dashed ? '5 3' : undefined} />
              </svg>
              <span>{EDGE_TYPE_LABELS[t]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="dg-ai-key__section">
        <h3 className="dg-popover__heading">Governance findings</h3>
        <ul className="dg-ai-key__list">
          {SEVERITIES.map((s) => (
            <li key={s} className="dg-ai-key__row">
              <span className="dg-ai-key__finding" style={{ background: AI_SEVERITY_COLOURS[s].fill, color: AI_SEVERITY_COLOURS[s].text }} aria-hidden="true">!</span>
              <span>{AI_SEVERITY_LABELS[s]}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
