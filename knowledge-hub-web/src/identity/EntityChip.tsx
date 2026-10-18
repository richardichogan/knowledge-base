/**
 * EntityChip — the one way a project, group, area or topic is drawn.
 *   project → coloured icon badge
 *   area / topic → coloured dot
 *   group → neutral outline
 */
import type { CSSProperties, FC, MouseEvent, ReactNode } from 'react';
import { identityIcon } from './icons';
import { useIdentity, type Identity } from './useIdentity';

type ChipSize = 'sm' | 'md';

interface ChipProps {
  identity: Identity;
  size?: ChipSize;
  /** Show only the mark (icon or dot) with the name as a tooltip. */
  compact?: boolean;
  active?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onRemove?: () => void;
  /** Remove-button tooltip, when removal has a consequence worth stating. */
  removeTitle?: string;
  /** Extra marker after the label, e.g. "auto". */
  suffix?: ReactNode;
  className?: string;
}

function chipTitle(identity: Identity): string {
  if (identity.kind === 'project') return identity.parentName ? `${identity.label} · ${identity.parentName}` : `${identity.label} · Project`;
  if (identity.kind === 'topic' && identity.parentName) return `${identity.label} · ${identity.parentName}`;
  return identity.label;
}

export const IdentityChip: FC<ChipProps> = ({ identity, size = 'sm', compact = false, active = false, onClick, onRemove, removeTitle, suffix, className }) => {
  const Icon = identity.kind === 'project' ? identityIcon(identity.icon) : null;
  const style = identity.hex !== null ? ({ '--kh-id': identity.hex } as CSSProperties) : undefined;
  const classes = [
    'kh-chip', `kh-chip--${identity.kind}`, `kh-chip--${size}`,
    compact ? 'kh-chip--compact' : '', active ? 'kh-chip--active' : '',
    onClick ? 'kh-chip--clickable' : '', className ?? '',
  ].filter(Boolean).join(' ');
  const mark = Icon !== null
    ? <Icon size={size === 'md' ? 14 : 12} className="kh-chip__icon" aria-hidden="true" />
    : identity.kind === 'group' ? null : <span className="kh-chip__dot" aria-hidden="true" />;
  const body = (
    <>
      {mark}
      {compact ? <span className="kh-chip__sr">{identity.label}</span> : <span className="kh-chip__label">{identity.label}</span>}
      {suffix}
      {onRemove && (
        <button type="button" className="kh-chip__remove" aria-label={`Remove ${identity.label}`} title={removeTitle}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      )}
    </>
  );
  if (onClick && !onRemove) {
    return <button type="button" className={classes} style={style} title={chipTitle(identity)} aria-pressed={active} onClick={onClick}>{body}</button>;
  }
  return <span className={classes} style={style} title={chipTitle(identity)}>{body}</span>;
};

interface EntityChipProps extends Omit<ChipProps, 'identity'> {
  tagId?: string;
  projectId?: string;
  name?: string;
  /** Used when the tag is not in the taxonomy (e.g. just created). */
  fallbackLabel?: string;
}

/** Resolves a tag id, project id or tag name to its identity and draws it. */
export const EntityChip: FC<EntityChipProps> = ({ tagId, projectId, name, fallbackLabel, ...rest }) => {
  const index = useIdentity();
  const identity = (tagId !== undefined ? index.byTagId(tagId) : undefined)
    ?? (projectId !== undefined ? index.byProjectId(projectId) : undefined)
    ?? (name !== undefined ? index.byName(name) : undefined);
  if (identity !== undefined) return <IdentityChip identity={identity} {...rest} />;
  const label = fallbackLabel ?? name;
  if (label === undefined) return null;
  return <IdentityChip identity={{ tagId: tagId ?? null, label, kind: 'topic', hex: null, icon: null, projectId: null, parentName: null }} {...rest} />;
};

/** Just the mark — project icon or theme dot — for lists and pickers. */
export const IdentityMark: FC<{ identity: Identity | undefined; size?: 12 | 14 | 16 }> = ({ identity, size = 14 }) => {
  if (identity === undefined || identity.kind === 'group') return <span className="kh-mark kh-mark--none" aria-hidden="true" />;
  const style = { '--kh-id': identity.hex ?? undefined } as CSSProperties;
  if (identity.kind === 'project') {
    const Icon = identityIcon(identity.icon);
    return <span className="kh-mark kh-mark--icon" style={style} aria-hidden="true"><Icon size={size} /></span>;
  }
  return <span className="kh-mark kh-mark--dot" style={style} aria-hidden="true" />;
};
