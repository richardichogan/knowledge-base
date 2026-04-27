/**
 * ProjectsPage — editable project cards backed by /api/projects (PostgreSQL).
 */

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button, TextInput, TextArea, Modal,
  Select, SelectItem, InlineNotification, ComboBox, Tag,
} from '@carbon/react';
import { Add, Edit, TrashCan, LogoGithub, Launch } from '@carbon/icons-react';
import {
  useProjects,
  type ProjectRecord,
  type ProjectColour,
  type ProjectCategory,
  type ProjectPriority,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '../services/useProjects';
import { api } from '../services/api';

// ── GitLab SVG icon ───────────────────────────────────────────────────────────

const GitLabIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.49a.42.42 0 01.11-.18.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
  </svg>
);

// ── Constants ─────────────────────────────────────────────────────────────────

const COLOURS: ProjectColour[] = ['blue','cyan','teal','purple','green','magenta','warm-gray','gray','red'];
const CATEGORIES: { value: ProjectCategory; label: string }[] = [
  { value: 'work',        label: 'Work' },
  { value: 'side-hustle', label: 'Side hustle' },
  { value: 'personal',    label: 'Personal' },
];
const PRIORITIES: { value: ProjectPriority; label: string }[] = [
  { value: 'high',   label: '🔴 High' },
  { value: 'medium', label: '🟡 Medium' },
  { value: 'low',    label: '🟢 Low' },
];
const CATEGORY_BADGE: Record<ProjectCategory, { label: string; cls: string }> = {
  work:         { label: 'Work',        cls: 'proj-cat--work' },
  'side-hustle':{ label: 'Side hustle', cls: 'proj-cat--side' },
  personal:     { label: 'Personal',    cls: 'proj-cat--personal' },
};
const PRIORITY_BADGE: Record<ProjectPriority, { label: string; cls: string }> = {
  high:   { label: 'High',   cls: 'proj-pri--high' },
  medium: { label: 'Medium', cls: 'proj-pri--medium' },
  low:    { label: 'Low',    cls: 'proj-pri--low' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSource(p: ProjectRecord): 'gitlab' | 'github' | null {
  if ((p.gitlabPaths?.length ?? 0) > 0) return 'gitlab';
  if ((p.githubRepos?.length ?? 0) > 0) return 'github';
  return null;
}

// ── Edit / Create modal ───────────────────────────────────────────────────────

interface ProjectModalProps {
  open: boolean;
  initial: ProjectRecord | null;   // null = create mode
  allTags: string[];
  onClose: () => void;
  onSave: (data: CreateProjectInput | UpdateProjectInput) => Promise<void>;
  saving: boolean;
}

const ProjectModal: React.FC<ProjectModalProps> = ({ open, initial, allTags, onClose, onSave, saving }) => {
  const isEdit = initial != null;

  const [name, setName]             = useState(initial?.name ?? '');
  const [description, setDesc]      = useState(initial?.description ?? '');
  const [colour, setColour]         = useState<ProjectColour>(initial?.colour ?? 'gray');
  const [category, setCategory]     = useState<ProjectCategory>(initial?.category ?? 'work');
  const [priority, setPriority]     = useState<ProjectPriority>(initial?.priority ?? 'medium');
  const [gitlabRaw, setGitlabRaw]   = useState((initial?.gitlabPaths ?? []).join('\n'));
  const [githubRaw, setGithubRaw]   = useState((initial?.githubRepos ?? []).join('\n'));
  const [tags, setTags]             = useState<string[]>(initial?.tags ?? []);
  const [err, setErr]               = useState<string | null>(null);

  // Reset when modal reopens for a new project
  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDesc(initial?.description ?? '');
      setColour(initial?.colour ?? 'gray');
      setCategory(initial?.category ?? 'work');
      setPriority(initial?.priority ?? 'medium');
      setGitlabRaw((initial?.gitlabPaths ?? []).join('\n'));
      setGithubRaw((initial?.githubRepos ?? []).join('\n'));
      setTags(initial?.tags ?? []);
      setErr(null);
    }
  }, [open, initial]);

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) { setErr('Name is required'); return; }
    setErr(null);
    try {
      await onSave({
        ...(isEdit ? {} : { id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') }),
        name: name.trim(),
        description: description.trim(),
        colour,
        category,
        priority,
        gitlabPaths: gitlabRaw.split('\n').map((s) => s.trim()).filter(Boolean),
        githubRepos: githubRaw.split('\n').map((s) => s.trim()).filter(Boolean),
        tags,
        links: initial?.links ?? [],
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  };

  // Tag options: global tags not already applied
  const tagOptions = allTags
    .filter((t) => !tags.includes(t))
    .map((t) => ({ id: t, label: t }));

  return (
    <Modal
      open={open}
      modalHeading={isEdit ? `Edit — ${initial?.name}` : 'New Project'}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestSubmit={() => { void handleSave(); }}
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      size="sm"
    >
      <div className="proj-modal-body">
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

        <div className="proj-modal-row">
          <Select id="pm-category" labelText="Category" value={category} onChange={(e) => setCategory(e.target.value as ProjectCategory)}>
            {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value} text={c.label} />)}
          </Select>

          <Select id="pm-priority" labelText="Priority" value={priority} onChange={(e) => setPriority(e.target.value as ProjectPriority)}>
            {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value} text={p.label} />)}
          </Select>
        </div>

        <Select id="pm-colour" labelText="Colour" value={colour} onChange={(e) => setColour(e.target.value as ProjectColour)}>
          {COLOURS.map((c) => <SelectItem key={c} value={c} text={c} />)}
        </Select>

        <TextArea
          id="pm-gitlab"
          labelText="GitLab paths (one per line)"
          helperText="e.g. structara-group/Structara-AI"
          value={gitlabRaw}
          rows={2}
          onChange={(e) => setGitlabRaw(e.target.value)}
        />

        <TextArea
          id="pm-github"
          labelText="GitHub repos (one per line)"
          helperText="e.g. richardichogan/BlogSite"
          value={githubRaw}
          rows={2}
          onChange={(e) => setGithubRaw(e.target.value)}
        />

        {/* Tags — ComboBox with autocomplete from global_tags + removable pills */}
        <div>
          <ComboBox
            id="pm-tags"
            items={tagOptions}
            itemToString={(item) => (item ? item.label : '')}
            titleText="Tags"
            placeholder="Add a tag…"
            allowCustomValue
            onChange={({ selectedItem, inputValue }) => {
              const val = (selectedItem?.label ?? inputValue ?? '').trim();
              if (val !== '' && !tags.includes(val)) {
                setTags([...tags, val]);
              }
            }}
            size="sm"
          />
          {tags.length > 0 && (
            <div className="proj-tag-pills-edit">
              {tags.map((t) => (
                <Tag
                  key={t}
                  type="cool-gray"
                  size="sm"
                  filter
                  onClose={() => { setTags(tags.filter((x) => x !== t)); }}
                >
                  {t}
                </Tag>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

// ── Main page ─────────────────────────────────────────────────────────────────

export const ProjectsPage: React.FC = () => {
  const { projects, loading, error, createProject, updateProject, deleteProject } = useProjects();
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState<ProjectCategory | 'all'>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editProject, setEditProject] = useState<ProjectRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectRecord | null>(null);

  const { data: globalTagsData } = useQuery<string[]>({
    queryKey: ['global-tags'],
    queryFn: async () => {
      const res = await api.getTags();
      return res.success ? res.data : [];
    },
    staleTime: 60_000,
    retry: 1,
  });
  const allTags = globalTagsData ?? [];

  const visible = projects.filter((p) => {
    if (filterCat !== 'all' && p.category !== filterCat) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const openCreate = (): void => { setEditProject(null); setModalOpen(true); };
  const openEdit = (p: ProjectRecord): void => { setEditProject(p); setModalOpen(true); };

  const handleSave = async (data: CreateProjectInput | UpdateProjectInput): Promise<void> => {
    setSaving(true);
    try {
      if (editProject != null) {
        await updateProject(editProject.id, data as UpdateProjectInput);
      } else {
        await createProject(data as CreateProjectInput);
      }
      setModalOpen(false);
      setEditProject(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteConfirm) return;
    await deleteProject(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  return (
    <div className="proj-page">

      {/* ── Header ── */}
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">{visible.length} of {projects.length}</p>
        </div>
        <div className="page-controls">
          <TextInput
            id="proj-search"
            labelText="Search"
            hideLabel
            placeholder="Search…"
            size="md"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="proj-search"
          />
          <Select id="proj-cat-filter" labelText="Category" hideLabel value={filterCat} onChange={(e) => setFilterCat(e.target.value as ProjectCategory | 'all')} className="proj-cat-select">
            <SelectItem value="all" text="All categories" />
            {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value} text={c.label} />)}
          </Select>
          <Button renderIcon={Add} size="md" onClick={openCreate}>New project</Button>
        </div>
      </div>

      {error && <InlineNotification kind="warning" title={error} lowContrast hideCloseButton className="proj-notice" />}

      {/* ── Grid ── */}
      {loading ? (
        <p className="proj-loading">Loading…</p>
      ) : (
        <div className="proj-grid">
          {visible.map((project) => {
            const repos = [
              ...(project.gitlabPaths ?? []).map((path) => ({ type: 'gitlab' as const, name: path.split('/').pop() ?? path, url: `https://gitlab.com/${path}` })),
              ...(project.githubRepos ?? []).map((repo) => ({ type: 'github' as const, name: repo.split('/').pop() ?? repo, url: `https://github.com/${repo}` })),
            ];
            const source = getSource(project);
            const cat = CATEGORY_BADGE[project.category];
            const pri = PRIORITY_BADGE[project.priority ?? 'medium'];

            return (
              <div key={project.id} className="proj-card">
                <div className={`proj-card-top proj-card-top--${project.colour}`} />

                <div className="proj-card-body">
                  {/* Name row */}
                  <div className="proj-card-name-row">
                    <h3 className="proj-card-name">{project.name}</h3>
                    <div className="proj-card-name-icons">
                      {source === 'gitlab' && <span className="proj-source-badge proj-source-badge--gitlab" title="GitLab"><GitLabIcon size={18} /></span>}
                      {source === 'github' && <span className="proj-source-badge proj-source-badge--github" title="GitHub"><LogoGithub size={18} /></span>}
                      <button className="proj-icon-btn" title="Edit" onClick={() => openEdit(project)}><Edit size={16} /></button>
                      <button className="proj-icon-btn proj-icon-btn--danger" title="Delete" onClick={() => setDeleteConfirm(project)}><TrashCan size={16} /></button>
                    </div>
                  </div>

                  {/* Category + Priority badges */}
                  <div className="proj-card-badges">
                    <span className={`proj-cat-badge ${cat.cls}`}>{cat.label}</span>
                    <span className={`proj-pri-badge ${pri.cls}`}>{pri.label}</span>
                  </div>

                  {/* Description */}
                  {project.description && <p className="proj-card-desc">{project.description}</p>}

                  {/* Footer */}
                  {(repos.length > 0 || project.tags.length > 0) && (
                    <div className="proj-card-footer">
                      {repos.length > 0 && (
                        <div className="proj-card-repos">
                          {repos.map((r) => (
                            <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className={`proj-repo proj-repo--${r.type}`}>
                              {r.type === 'gitlab' ? <GitLabIcon size={11} /> : <LogoGithub size={11} />}
                              <span>{r.name}</span>
                              <Launch size={10} />
                            </a>
                          ))}
                        </div>
                      )}
                      {project.tags.length > 0 && (
                        <div className="proj-card-tags">
                          {project.tags.map((t) => <span key={t} className="proj-tag-pill">{t}</span>)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Create/Edit modal ── */}
      <ProjectModal
        open={modalOpen}
        initial={editProject}
        allTags={allTags}
        onClose={() => { setModalOpen(false); setEditProject(null); }}
        onSave={handleSave}
        saving={saving}
      />

      {/* ── Delete confirm modal ── */}
      <Modal
        open={deleteConfirm != null}
        danger
        modalHeading={`Delete "${deleteConfirm?.name}"?`}
        primaryButtonText="Delete"
        secondaryButtonText="Cancel"
        onRequestSubmit={() => { void handleDelete(); }}
        onRequestClose={() => setDeleteConfirm(null)}
        onSecondarySubmit={() => setDeleteConfirm(null)}
        size="xs"
      >
        <p>This only removes the project from your local store. GitLab and GitHub data is unaffected.</p>
      </Modal>

    </div>
  );
};
