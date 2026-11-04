/**
 * ProjectsPage — editable project cards backed by /api/projects (PostgreSQL).
 */

import React, { useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Button, TextInput, TextArea, Modal,
  Select, SelectItem, InlineNotification, Checkbox, ComboBox, FilterableMultiSelect,
} from '@carbon/react';
import { Add, Edit, TrashCan, LogoGithub, Launch } from '@carbon/icons-react';
import {
  useProjects,
  type ProjectRecord,
  type ProjectColour,
  type ProjectPriority,
  type ProjectType,
  type ProjectLifecycleState,
  type ProjectImportance,
  type ProjectLink,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '../services/useProjects';
import { api, type OfferingRelation } from '../services/api';
import type { Company } from '../types/companies';
import { COLOUR_LABEL, IDENTITY_COLOURS, IDENTITY_ICONS, IdentityChip, colourHex, identityIcon, type Identity } from '../identity';
import { describeApiError, requireApiData } from '../services/apiError';
import { DataNotice } from '../components/DataNotice';
import { PageHeader } from '../components/PageHeader';
import { parseExpectedOutputs, validateProjectContext } from '../services/projectFormValidation';
import { ProjectCockpitContent } from './ProjectCockpit';
import { ReviewWorkspace, ReviewItem } from '../components/ReviewWorkspace';

// ── GitLab SVG icon ───────────────────────────────────────────────────────────

const GitLabIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.49a.42.42 0 01.11-.18.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
  </svg>
);

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITIES: { value: ProjectPriority; label: string }[] = [
  { value: 'high',   label: '🔴 High' },
  { value: 'medium', label: '🟡 Medium' },
  { value: 'low',    label: '🟢 Low' },
];
const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'offering', label: 'Offering' },
  { value: 'bau', label: 'Ongoing responsibility (BAU)' },
  { value: 'aspiration', label: 'Aspiration' },
  { value: 'exploration', label: 'Exploration' },
  { value: 'side-project', label: 'Side project' },
];
const LIFECYCLE_STATES: { value: ProjectLifecycleState | 'all'; label: string }[] = [
  { value: 'all', label: 'All workstream states' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];
const IMPORTANCES: { value: ProjectImportance; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];
const LIFECYCLE_LABEL: Record<ProjectLifecycleState, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ProjectGroup { id: string; name: string; }

function getSource(p: ProjectRecord): 'gitlab' | 'github' | null {
  if ((p.gitlabPaths?.length ?? 0) > 0) return 'gitlab';
  if ((p.githubRepos?.length ?? 0) > 0) return 'github';
  return null;
}

// ── Edit / Create modal ───────────────────────────────────────────────────────

interface ProjectModalProps {
  open: boolean;
  initial: ProjectRecord | null;   // null = create mode
  groups: ProjectGroup[];
  offerings: ProjectRecord[];
  onClose: () => void;
  onSave: (data: CreateProjectInput | UpdateProjectInput) => Promise<void>;
  saving: boolean;
}

interface CompanyOption { id: string; text: string }

const ProjectModal: React.FC<ProjectModalProps> = ({ open, initial, groups, offerings, onClose, onSave, saving }) => {
  const isEdit = initial != null;

  const [name, setName]             = useState(initial?.name ?? '');
  const [description, setDesc]      = useState(initial?.description ?? '');
  const [goal, setGoal]             = useState(initial?.goal ?? '');
  const [role, setRole]             = useState(initial?.role ?? '');
  const [ownership, setOwnership]   = useState(initial?.ownership ?? '');
  const [lifecycleState, setLifecycleState] = useState<ProjectLifecycleState>(initial?.lifecycleState ?? 'active');
  const [startDate, setStartDate]   = useState(initial?.startDate ?? '');
  const [targetEndDate, setTargetEndDate] = useState(initial?.targetEndDate ?? '');
  const [importance, setImportance] = useState<ProjectImportance>(initial?.importance ?? 'normal');
  const [expectedOutputsRaw, setExpectedOutputsRaw] = useState((initial?.expectedOutputs ?? []).join('\n'));
  const [colour, setColour]         = useState<ProjectColour>(initial?.colour ?? 'gray');
  const [icon, setIcon]             = useState<string>(initial?.icon ?? 'folder');
  const [groupId, setGroupId]       = useState<string>(initial?.groupId ?? '');
  const [priority, setPriority]     = useState<ProjectPriority>(initial?.priority ?? 'medium');
  const [projectType, setProjectType] = useState<ProjectType>(initial?.projectType ?? 'project');
  const [hasIcaCollection, setHasIcaCollection] = useState(initial?.hasIcaDocumentCollection ?? false);
  const [icaCollectionName, setIcaCollectionName] = useState(initial?.icaDocumentCollectionName ?? '');
  const [icaCollectionId, setIcaCollectionId] = useState(initial?.icaDocumentCollectionId ?? '');
  const [gitlabRaw, setGitlabRaw]   = useState((initial?.gitlabPaths ?? []).join('\n'));
  const [githubRaw, setGithubRaw]   = useState((initial?.githubRepos ?? []).join('\n'));
  const [links, setLinks]           = useState<ProjectLink[]>(initial?.links ?? []);
  const [clientId, setClientId]     = useState<string>(initial?.client?.id ?? '');
  const [partnerIds, setPartnerIds] = useState<string[]>((initial?.partners ?? []).map((partner) => partner.id));
  const [offeringId, setOfferingId] = useState<string>(initial?.offeringLink?.offeringId ?? '');
  const [offeringRelation, setOfferingRelation] = useState<OfferingRelation>(initial?.offeringLink?.relation ?? 'sells');
  const [err, setErr]               = useState<string | null>(null);

  const companiesQuery = useQuery<Company[]>({
    queryKey: ['companies', ''],
    queryFn: async () => requireApiData(await api.getCompanies()),
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  });
  const companyOptions: CompanyOption[] = (companiesQuery.data ?? []).map((company) => ({ id: company.id, text: company.name }));
  const companiesReady = companiesQuery.data !== undefined;
  const offeringOptions = offerings.filter((offering) => offering.id !== initial?.id);

  // Reset when modal reopens for a new project
  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDesc(initial?.description ?? '');
      setGoal(initial?.goal ?? '');
      setRole(initial?.role ?? '');
      setOwnership(initial?.ownership ?? '');
      setLifecycleState(initial?.lifecycleState ?? 'active');
      setStartDate(initial?.startDate ?? '');
      setTargetEndDate(initial?.targetEndDate ?? '');
      setImportance(initial?.importance ?? 'normal');
      setExpectedOutputsRaw((initial?.expectedOutputs ?? []).join('\n'));
      setColour(initial?.colour ?? 'gray');
      setIcon(initial?.icon ?? 'folder');
      setGroupId(initial?.groupId ?? '');
      setPriority(initial?.priority ?? 'medium');
      setProjectType(initial?.projectType ?? 'project');
      setHasIcaCollection(initial?.hasIcaDocumentCollection ?? false);
      setIcaCollectionName(initial?.icaDocumentCollectionName ?? '');
      setIcaCollectionId(initial?.icaDocumentCollectionId ?? '');
      setGitlabRaw((initial?.gitlabPaths ?? []).join('\n'));
      setGithubRaw((initial?.githubRepos ?? []).join('\n'));
      setLinks(initial?.links ?? []);
      setClientId(initial?.client?.id ?? '');
      setPartnerIds((initial?.partners ?? []).map((partner) => partner.id));
      setOfferingId(initial?.offeringLink?.offeringId ?? '');
      setOfferingRelation(initial?.offeringLink?.relation ?? 'sells');
      setErr(null);
    }
  }, [open, initial]);

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) { setErr('Name is required'); return; }
    const contextError = validateProjectContext({ goal, role, ownership });
    if (contextError !== null) { setErr(contextError); return; }
    if (startDate !== '' && targetEndDate !== '' && targetEndDate < startDate) {
      setErr('Target end date cannot be earlier than the start date.');
      return;
    }
    if (hasIcaCollection && !icaCollectionName.trim() && !icaCollectionId.trim()) {
      setErr('Enter the ICA document collection name or ID.');
      return;
    }
    const normalizedLinks = links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label !== '' || link.url !== '');
    for (const link of normalizedLinks) {
      if (link.label === '' || link.url === '') {
        setErr('Each workstream reference needs both a label and a URL.');
        return;
      }
      try {
        const parsed = new URL(link.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid protocol');
      } catch {
        setErr(`"${link.url}" is not a valid http(s) URL.`);
        return;
      }
    }
    if (clientId !== '' && partnerIds.includes(clientId)) {
      setErr('The client cannot also be a partner.');
      return;
    }
    setErr(null);
    try {
      await onSave({
        // Company links are sent only once the company list has loaded, so a lookup failure never clears them.
        ...(companiesReady ? { clientCompanyId: clientId === '' ? null : clientId, partnerCompanyIds: partnerIds } : {}),
        offeringLink: projectType === 'offering' || offeringId === '' ? null : { offeringId, relation: offeringRelation },
        ...(isEdit ? {} : { id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') }),
        name: name.trim(),
        description: description.trim(),
        goal: goal.trim(),
        role: role.trim(),
        ownership: ownership.trim(),
        lifecycleState,
        startDate: startDate || null,
        targetEndDate: targetEndDate || null,
        importance,
        expectedOutputs: parseExpectedOutputs(expectedOutputsRaw),
        colour,
        icon,
        groupId: groupId === '' ? null : groupId,
        priority,
        projectType,
        gitlabPaths: gitlabRaw.split('\n').map((s) => s.trim()).filter(Boolean),
        githubRepos: githubRaw.split('\n').map((s) => s.trim()).filter(Boolean),
        hasIcaDocumentCollection: hasIcaCollection,
        icaDocumentCollectionName: hasIcaCollection ? icaCollectionName.trim() : '',
        icaDocumentCollectionId: hasIcaCollection ? icaCollectionId.trim() : '',
        links: normalizedLinks,
      });
    } catch (e) {
      setErr(describeApiError(e));
    }
  };

  const preview: Identity = {
    tagId: null, label: name.trim() || 'New workstream', kind: 'project', hex: colourHex(colour), icon,
    projectId: null, parentName: groups.find((g) => g.id === groupId)?.name ?? null,
  };

  return (
    <Modal
      open={open}
      modalHeading={isEdit ? `Edit — ${initial?.name}` : 'New Workstream'}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestSubmit={() => { void handleSave(); }}
      onRequestClose={() => { if (!saving) onClose(); }}
      onSecondarySubmit={() => { if (!saving) onClose(); }}
      size="sm"
    >
      <fieldset className="proj-modal-body" disabled={saving} aria-label="Workstream fields">
        {err && (
          <InlineNotification kind="error" title={err} lowContrast hideCloseButton />
        )}

        <TextInput
          id="pm-name"
          labelText="Name *"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <TextArea
          id="pm-desc"
          labelText="Description"
          value={description}
          rows={2}
          onChange={(e) => setDesc(e.target.value)}
        />

        <div className="proj-context-editor">
          <h3 className="proj-context-editor__title">Workstream context</h3>
          <TextArea
            id="pm-goal"
            labelText="Goal"
            helperText="The outcome this body of work is intended to achieve. Up to 2,000 characters."
            value={goal}
            rows={3}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="proj-modal-row">
            <TextInput
              id="pm-role"
              labelText="Your role"
              helperText="Up to 200 characters."
              placeholder="e.g. Global Chief Architect"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
            <TextInput
              id="pm-ownership"
              labelText="Ownership"
              helperText="Up to 200 characters."
              placeholder="e.g. IBM, Personal, Client"
              value={ownership}
              onChange={(e) => setOwnership(e.target.value)}
            />
          </div>
          <div className="proj-modal-row">
            <Select id="pm-lifecycle" labelText="Lifecycle" value={lifecycleState} onChange={(e) => setLifecycleState(e.target.value as ProjectLifecycleState)}>
              {LIFECYCLE_STATES.filter((state) => state.value !== 'all').map((state) => (
                <SelectItem key={state.value} value={state.value} text={state.label} />
              ))}
            </Select>
            <Select id="pm-importance" labelText="Importance" value={importance} onChange={(e) => setImportance(e.target.value as ProjectImportance)}>
              {IMPORTANCES.map((option) => <SelectItem key={option.value} value={option.value} text={option.label} />)}
            </Select>
          </div>
          <div className="proj-modal-row">
            <TextInput
              id="pm-start-date"
              type="date"
              labelText="Start date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <TextInput
              id="pm-target-end-date"
              type="date"
              labelText="Target end date (optional)"
              value={targetEndDate}
              onChange={(e) => setTargetEndDate(e.target.value)}
            />
          </div>
          <TextArea
            id="pm-expected-outputs"
            labelText="Deliverables"
            helperText="Enter one output per line. Full descriptions are supported; blank lines are ignored."
            value={expectedOutputsRaw}
            rows={3}
            onChange={(e) => setExpectedOutputsRaw(e.target.value)}
          />
        </div>

        <div className="proj-modal-row">
          <Select id="pm-group" labelText="Group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <SelectItem value="" text="No group" />
            {groups.map((g) => <SelectItem key={g.id} value={g.id} text={g.name} />)}
          </Select>

          <Select id="pm-priority" labelText="Priority" value={priority} onChange={(e) => setPriority(e.target.value as ProjectPriority)}>
            {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value} text={p.label} />)}
          </Select>
        </div>

        <Select id="pm-project-type" labelText="Workstream type" value={projectType} onChange={(e) => {
          const next = e.target.value as ProjectType;
          setProjectType(next);
          if (!initial?.offeringLink) setOfferingRelation(next === 'opportunity' ? 'sells' : 'related');
        }}>
          {PROJECT_TYPES.map((p) => <SelectItem key={p.value} value={p.value} text={p.label} />)}
        </Select>

        <div className="proj-relations-editor">
          <p className="proj-relations-editor__title">Client, partners and offering</p>
          {companiesQuery.error ? (
            <InlineNotification kind="warning" lowContrast hideCloseButton
              title="Companies could not be loaded."
              subtitle="Existing client and partner links will be kept." />
          ) : (
            <>
              <ComboBox<CompanyOption>
                id="pm-client"
                titleText="Client"
                placeholder={companiesReady ? 'Choose a company' : 'Loading companies…'}
                disabled={!companiesReady}
                items={companyOptions}
                itemToString={(item) => item?.text ?? ''}
                selectedItem={companyOptions.find((option) => option.id === clientId) ?? null}
                onChange={({ selectedItem }) => { setClientId(selectedItem?.id ?? ''); }}
                helperText="The company this work is for."
              />
              <FilterableMultiSelect<CompanyOption>
                key={open ? 'partners-open' : 'partners-closed'}
                id="pm-partners"
                titleText="Partners"
                placeholder={companiesReady ? 'Choose partner companies' : 'Loading companies…'}
                disabled={!companiesReady}
                items={companyOptions.filter((option) => option.id !== clientId)}
                itemToString={(item) => item?.text ?? ''}
                selectedItems={companyOptions.filter((option) => partnerIds.includes(option.id))}
                onChange={({ selectedItems }) => { setPartnerIds((selectedItems ?? []).map((item) => item.id)); }}
              />
            </>
          )}
          {projectType === 'offering' ? (
            <p className="proj-relations-editor__help">Projects and opportunities link to this offering from their own settings.</p>
          ) : (
            <div className="proj-modal-row">
              <Select id="pm-offering" labelText="Offering" value={offeringId} onChange={(e) => setOfferingId(e.target.value)}
                helperText={offeringOptions.length === 0 ? 'No offerings yet. Create a workstream with type Offering.' : undefined}>
                <SelectItem value="" text="No offering" />
                {offeringOptions.map((offering) => <SelectItem key={offering.id} value={offering.id} text={offering.name} />)}
              </Select>
              <Select id="pm-offering-relation" labelText="Relationship" value={offeringRelation} disabled={offeringId === ''}
                onChange={(e) => setOfferingRelation(e.target.value as OfferingRelation)}>
                <SelectItem value="sells" text="Sells" />
                <SelectItem value="related" text="Related to" />
              </Select>
            </div>
          )}
        </div>

        <div className="proj-ica-panel">
          <Checkbox
            id="pm-has-ica"
            labelText="This workstream has an ICA document collection"
            checked={hasIcaCollection}
            onChange={(_, data) => { setHasIcaCollection(data.checked); }}
          />
          {hasIcaCollection && (
            <div className="proj-ica-panel__fields">
              <TextInput
                id="pm-ica-name"
                labelText="ICA document collection name"
                helperText="Human-readable collection label shown in Athena."
                value={icaCollectionName}
                onChange={(e) => setIcaCollectionName(e.target.value)}
              />
              <TextInput
                id="pm-ica-id"
                spellCheck={false}
                labelText="ICA document collection ID"
                helperText="Required for automatic sync when the ICA API address is ID-based."
                value={icaCollectionId}
                onChange={(e) => setIcaCollectionId(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="proj-identity-editor">
          <div className="proj-identity-editor__heading">
            <p className="proj-identity-editor__title">Identity</p>
            <IdentityChip identity={preview} size="md" />
          </div>
          <p className="proj-identity-editor__help">How this workstream looks on every tag, card and graph node.</p>
          <div className="proj-swatches" role="radiogroup" aria-label="Workstream colour">
            {IDENTITY_COLOURS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={colour === c} aria-label={COLOUR_LABEL[c]} title={COLOUR_LABEL[c]}
                className={`proj-swatch${colour === c ? ' proj-swatch--active' : ''}`}
                style={{ '--kh-id': colourHex(c) } as React.CSSProperties}
                onClick={() => setColour(c)} />
            ))}
          </div>
          <div className="proj-icon-grid" role="radiogroup" aria-label="Workstream icon" style={{ '--kh-id': colourHex(colour) } as React.CSSProperties}>
            {Object.entries(IDENTITY_ICONS).map(([key, { label }]) => {
              const Icon = identityIcon(key);
              return (
                <button key={key} type="button" role="radio" aria-checked={icon === key} aria-label={label} title={label}
                  className={`proj-icon-option${icon === key ? ' proj-icon-option--active' : ''}`}
                  onClick={() => setIcon(key)}>
                  <Icon size={16} />
                </button>
              );
            })}
          </div>
        </div>

        <TextArea
          id="pm-gitlab"
          spellCheck={false}
          labelText="GitLab paths (one per line)"
          helperText="e.g. structara-group/Structara-AI"
          value={gitlabRaw}
          rows={2}
          onChange={(e) => setGitlabRaw(e.target.value)}
        />

        <TextArea
          id="pm-github"
          spellCheck={false}
          labelText="GitHub repos (one per line)"
          helperText="e.g. richardichogan/BlogSite"
          value={githubRaw}
          rows={2}
          onChange={(e) => setGithubRaw(e.target.value)}
        />

        <div className="proj-reference-editor">
          <div className="proj-reference-editor__heading">
            <div>
              <p className="proj-reference-editor__title">Canonical references</p>
              <p className="proj-reference-editor__help">
                Product sites or documentation Athena should consult for this workstream.
              </p>
            </div>
            <Button
              type="button"
              kind="ghost"
              size="sm"
              renderIcon={Add}
              onClick={() => { setLinks([...links, { label: '', url: '' }]); }}
            >
              Add reference
            </Button>
          </div>
          {links.map((link, index) => (
            <div className="proj-reference-editor__row" key={`reference-${index}`}>
              <TextInput
                id={`pm-link-label-${index}`}
                labelText="Label"
                placeholder="Product portal"
                value={link.label}
                onChange={(e) => {
                  setLinks(links.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, label: e.target.value } : item));
                }}
              />
              <TextInput
                id={`pm-link-url-${index}`}
                spellCheck={false}
                labelText="URL"
                placeholder="https://..."
                value={link.url}
                onChange={(e) => {
                  setLinks(links.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, url: e.target.value } : item));
                }}
              />
              <Button
                type="button"
                kind="ghost"
                size="md"
                hasIconOnly
                renderIcon={TrashCan}
                iconDescription={`Remove ${link.label || 'reference'}`}
                onClick={() => { setLinks(links.filter((_, itemIndex) => itemIndex !== index)); }}
              />
            </div>
          ))}
        </div>

      </fieldset>
    </Modal>
  );
};

// ── Main page ─────────────────────────────────────────────────────────────────

export const ProjectsPage: React.FC = () => {
  const { projects, loading, error, reload, createProject, updateProject, deleteProject } = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedProjectId = searchParams.get('projectId');
  const [filterGroup, setFilterGroup] = useState<string>('all');
  const [filterLifecycle, setFilterLifecycle] = useState<ProjectLifecycleState | 'all'>('active');
  const [modalOpen, setModalOpen] = useState(false);
  const [editProject, setEditProject] = useState<ProjectRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data: groupsData, error: groupsError, refetch: reloadGroups } = useQuery<ProjectGroup[]>({
    queryKey: ['project-groups'],
    queryFn: async () => requireApiData(await api.getProjectGroups()),
    staleTime: 60_000,
    retry: 1,
  });
  const groups = groupsData ?? [];

  const visible = projects.filter((p) => {
    if (filterGroup !== 'all' && (p.groupId ?? 'none') !== filterGroup) return false;
    if (filterLifecycle !== 'all' && (p.lifecycleState ?? 'active') !== filterLifecycle) return false;
    return true;
  });
  const selectedProject = linkedProjectId
    ? projects.find(project => project.id === linkedProjectId)
    : visible[0];
  const selectProject = (projectId: string): void => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('projectId', projectId);
      return next;
    }, { replace: true });
  };

  const openCreate = (): void => { setEditProject(null); setModalOpen(true); };
  const openEdit = (p: ProjectRecord): void => { setEditProject(p); setModalOpen(true); };

  const handleSave = async (data: CreateProjectInput | UpdateProjectInput): Promise<void> => {
    if (savePending.current) return;
    savePending.current = true;
    setSaving(true);
    try {
      if (editProject != null) {
        await updateProject(editProject.id, data as UpdateProjectInput);
      } else {
        const created = await createProject(data as CreateProjectInput);
        selectProject(created.id);
      }
      setModalOpen(false);
      setEditProject(null);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteConfirm || deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(deleteConfirm.id);
      if (linkedProjectId === deleteConfirm.id) setSearchParams(previous => {
        const next = new URLSearchParams(previous);
        next.delete('projectId');
        return next;
      }, { replace: true });
      setDeleteConfirm(null);
    } catch (err) {
      setDeleteError(describeApiError(err));
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  };

  return (
    <main className="page-root proj-page kh-review-page">

      <PageHeader title="Workstreams" subtitle={`${visible.length} of ${projects.length} workstreams`} actions={
          <button type="button" className="docs-upload-btn" onClick={openCreate}><Add size={16} /> New workstream</button>
      } />
      <div className="dc-toolbar">
        <div className="dc-tabs kh-command-row">
          {LIFECYCLE_STATES.map((state) => (
            <button
              key={state.value}
              type="button"
              className={`dc-tab${filterLifecycle === state.value ? ' dc-tab--active' : ''}`}
              aria-pressed={filterLifecycle === state.value}
              onClick={() => setFilterLifecycle(state.value)}
            >
              {state.label}
            </button>
          ))}
        </div>
        <div className="dc-toolbar__filters kh-command-row">
          <select
            className="dc-filter-select"
            aria-label="Filter by group"
            value={filterGroup}
            onChange={(e) => setFilterGroup(e.target.value)}
          >
            <option value="all">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="none">No group</option>
          </select>
        </div>
      </div>

      {error && <DataNotice title="Workstreams could not be refreshed." error={error} onRetry={() => { void reload(); }} />}
      {groupsError && <DataNotice title="Workstream groups are unavailable." error={groupsError} onRetry={() => { void reloadGroups(); }} />}

      <ReviewWorkspace storageKey="projects" label="Workstreams"
        context={selectedProject ? {
          type: 'project', id: selectedProject.id, projectId: selectedProject.id, title: selectedProject.name,
          detail: `Selected workstream's current saved properties and references:\n${JSON.stringify(selectedProject)}\nThe main record includes dated direction/progress reviews, changes, waiting work, open commitments, questions/risks/issues, review packets and supporting evidence. Use read_project_progress_reviews for saved review history and reviewId for the full assessment, captured evidence and rationale. generate_project_progress_review appends a last-seven-days review only when requested; it does not change tasks/goals/deliverables. Use get_project_details with includeWork=true for current bounded work; use packetId to retrieve a full review packet and saved-content retrieval for linked documents. Use update_project to change the work type only when requested. Do not infer progress, require a finish date for BAU/aspirations, or treat repository links as read source content.`,
        } : { type: 'project', title: 'Workstreams', detail: 'No workstream selected. Do not infer workstream details.' }}
        list={<>
          <h2>Workstreams</h2>
          {loading && <p className="proj-loading" role="status">Loading workstreams...</p>}
          {!loading && visible.length === 0 && !error && <p className="proj-empty">
            {projects.length === 0 ? 'No workstreams yet. Create a workstream to organise your work.' : 'No workstreams match these filters. Try another group or workstream state.'}
          </p>}
          {visible.map(project => <ReviewItem key={project.id} title={project.name}
            meta={[project.groupName, LIFECYCLE_LABEL[project.lifecycleState ?? 'active'], `${project.priority ?? 'medium'} priority`].filter(Boolean).join(' · ')}
            selected={selectedProject?.id === project.id} onSelect={() => { selectProject(project.id); }} />)}
        </>}
        detail={loading ? (
        <p className="proj-loading" role="status">Loading workstreams...</p>
      ) : (
        <>
        {!selectedProject && !error && (
          <p className="proj-empty" role={linkedProjectId ? 'alert' : undefined}>
            {linkedProjectId ? 'The linked workstream is no longer available.' : projects.length === 0
              ? 'No workstreams yet. Create a workstream to organise your work.'
              : 'Select a workstream to view its details.'}
          </p>
        )}
        <div className="proj-detail">
          {(selectedProject ? [selectedProject] : []).map((project) => {
            const repos = [
              ...(project.gitlabPaths ?? []).map((path) => ({ type: 'gitlab' as const, name: path.split('/').pop() ?? path, url: `https://gitlab.com/${path}` })),
              ...(project.githubRepos ?? []).map((repo) => ({ type: 'github' as const, name: repo.split('/').pop() ?? repo, url: `https://github.com/${repo}` })),
            ];
            const source = getSource(project);
            const ProjectIcon = identityIcon(project.icon);
            const lifecycle = project.lifecycleState ?? 'active';
            const projectDates = [
              project.startDate ? `Start: ${project.startDate}` : null,
              project.targetEndDate ? `Target end: ${project.targetEndDate}` : null,
            ].filter((value): value is string => value !== null);

            const hasDetails = Boolean(
              project.goal ||
              project.role ||
              project.ownership ||
              projectDates.length > 0 ||
              project.expectedOutputs.length > 0 ||
              project.description ||
              (project.linkedProjects?.length ?? 0) > 0
            );

            return (
              <article key={project.id} className="proj-card proj-detail__article">
                <div className="proj-card-body">
                  {/* Card Header */}
                  <div className="proj-card-header">
                    <div className="proj-card-title-col">
                      <div className="proj-card-title-row">
                        <span className="proj-card-mark" style={{ '--kh-id': colourHex(project.colour) } as React.CSSProperties} aria-hidden="true">
                          <ProjectIcon size={16} />
                        </span>
                        <h2 className="proj-card-name" title={project.name}>{project.name}</h2>
                        {source === 'gitlab' && (
                          <span className="proj-source-badge proj-source-badge--gitlab" title="GitLab repository">
                            <GitLabIcon size={16} />
                          </span>
                        )}
                        {source === 'github' && (
                          <span className="proj-source-badge proj-source-badge--github" title="GitHub repository">
                            <LogoGithub size={16} />
                          </span>
                        )}
                      </div>

                      {/* Badges / metadata */}
                      <div className="proj-detail-meta">
                        {project.groupName && (
                          <IdentityChip identity={{ tagId: project.groupId ?? null, label: project.groupName, kind: 'group', hex: null, icon: null, projectId: null, parentName: null }} />
                        )}
                        <span>{LIFECYCLE_LABEL[lifecycle]}</span>
                        <span>{project.priority ?? 'medium'} priority</span>
                        {project.importance && project.importance !== 'normal' && (
                          <span>{project.importance} importance</span>
                        )}
                        <span>{PROJECT_TYPES.find(type => type.value === project.projectType)?.label}</span>
                        {project.client && <span>Client: {project.client.name}</span>}
                        {(project.partners?.length ?? 0) > 0 && (
                          <span>Partners: {(project.partners ?? []).map((partner) => partner.name).join(', ')}</span>
                        )}
                        {project.offeringLink && (
                          <span>{project.offeringLink.relation === 'sells' ? 'Sells' : 'Related to'} {project.offeringLink.offeringName}</span>
                        )}
                        {project.hasIcaDocumentCollection && (
                          <span title={project.icaDocumentCollectionName || project.icaDocumentCollectionId}>
                            ICA docs
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Quick actions */}
                    <div className="proj-card-actions">
                      <button
                        type="button"
                        className="proj-icon-btn"
                        aria-label={`Edit ${project.name}`}
                        title="Edit workstream"
                        onClick={() => openEdit(project)}
                      >
                        <Edit size={16} />
                      </button>
                      <button
                        type="button"
                        className="proj-icon-btn proj-icon-btn--danger"
                        aria-label={`Delete ${project.name}`}
                        title="Delete workstream"
                        onClick={() => { setDeleteError(null); setDeleteConfirm(project); }}
                      >
                        <TrashCan size={16} />
                      </button>
                    </div>
                  </div>

                  {/* Project details */}
                  {hasDetails && (
                    <div className="proj-card-details__body">
                      <div className="proj-detail-narrative">
                        {project.description && (
                          <div className="proj-detail-section">
                            <h3 className="proj-detail-heading">Description</h3>
                            <p className="proj-card-desc">{project.description}</p>
                          </div>
                        )}
                        {project.goal && (
                          <div className="proj-detail-section">
                            <h3 className="proj-detail-heading">Goal</h3>
                            <p className="proj-card-goal">{project.goal}</p>
                          </div>
                        )}
                        {project.projectType === 'offering' && (project.linkedProjects?.length ?? 0) > 0 && (
                          <div className="proj-detail-section">
                            <h3 className="proj-detail-heading">Projects and opportunities</h3>
                            <ul className="proj-linked-work">
                              {(project.linkedProjects ?? []).map((linked) => (
                                <li key={linked.id}>
                                  <button type="button" className="proj-linked-work__item" onClick={() => { selectProject(linked.id); }}>
                                    {linked.name}
                                  </button>
                                  <span className="proj-linked-work__meta">
                                    {PROJECT_TYPES.find(type => type.value === linked.projectType)?.label ?? linked.projectType}
                                    {' · '}{linked.relation === 'sells' ? 'sells it' : 'related'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {project.expectedOutputs.length > 0 && (
                          <div className="proj-detail-section">
                            <h3 className="proj-detail-heading">Deliverables</h3>
                            <ul className="proj-card-outputs">
                              {project.expectedOutputs.map((output, index) => (
                                <li key={index}>{output}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                        {(project.role || project.ownership || projectDates.length > 0) && (
                          <div className="proj-card-context">
                            {project.role && (
                              <div className="proj-context-item">
                                <span className="proj-context-label">Role</span>
                                <span className="proj-context-value">{project.role}</span>
                              </div>
                            )}
                            {project.ownership && (
                              <div className="proj-context-item">
                                <span className="proj-context-label">Ownership</span>
                                <span className="proj-context-value">{project.ownership}</span>
                              </div>
                            )}
                            {projectDates.length > 0 && (
                              <div className="proj-context-item">
                                <span className="proj-context-label">Timeline</span>
                                <span className="proj-context-value">{projectDates.join(' · ')}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                  )}

                  {/* Footer with Repos, Links & Tags */}
                  {(repos.length > 0 || project.links.length > 0) && (
                    <div className="proj-card-footer">
                      {(repos.length > 0 || project.links.length > 0) && (
                        <div className="proj-card-repos">
                          {repos.map((r) => (
                            <a
                              key={r.url}
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className={`proj-repo proj-repo--${r.type}`}
                              title={r.name}
                            >
                              {r.type === 'gitlab' ? <GitLabIcon size={12} /> : <LogoGithub size={12} />}
                              <span>{r.name}</span>
                              <Launch size={11} />
                            </a>
                          ))}
                          {project.links.map((link) => (
                            <a
                              key={link.url}
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              className="proj-repo proj-repo--reference"
                              title={link.label}
                            >
                              <Launch size={12} />
                              <span>{link.label}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <ProjectCockpitContent key={project.id} projectId={project.id} embedded />
                </div>
              </article>
            );
          })}
        </div>
        </>
      )} />

      {/* ── Create/Edit modal ── */}
      <ProjectModal
        open={modalOpen}
        initial={editProject}
        groups={groups}
        offerings={projects.filter((item) => item.projectType === 'offering')}
        onClose={() => { setModalOpen(false); setEditProject(null); }}
        onSave={handleSave}
        saving={saving}
      />

      {/* ── Delete confirm modal ── */}
      <Modal
        open={deleteConfirm != null}
        danger
        modalHeading={`Delete "${deleteConfirm?.name}"?`}
        primaryButtonText={deleting ? 'Deleting...' : 'Delete'}
        primaryButtonDisabled={deleting}
        secondaryButtonText="Cancel"
        onRequestSubmit={() => { void handleDelete(); }}
        onRequestClose={() => { if (!deletePending.current) setDeleteConfirm(null); }}
        onSecondarySubmit={() => { if (!deletePending.current) setDeleteConfirm(null); }}
        size="xs"
      >
        <p>This removes the workstream from Athena. GitLab and GitHub data is unaffected.</p>
        {deleteError && <DataNotice title="Workstream was not deleted. Please try again." error={deleteError} />}
      </Modal>

    </main>
  );
};
