import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { InlineLoading } from '@carbon/react';
import { api, type BlogJobResult } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import { AppDialog } from '../AppDialog';
import { BlogDraftEditor, type BlogPublishSource } from './BlogPublishModal';

function isBlogJobResult(value: unknown): value is BlogJobResult {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (typeof data['url'] !== 'string' || typeof data['subjectId'] !== 'string'
    || !data['draft'] || typeof data['draft'] !== 'object'
    || !data['verification'] || typeof data['verification'] !== 'object') return false;
  const draft = data['draft'] as Record<string, unknown>;
  const verification = data['verification'] as Record<string, unknown>;
  const workflow = data['workflow'];
  if (workflow !== undefined) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
    const state = workflow as Record<string, unknown>;
    if (typeof state['originalAvailable'] !== 'boolean' || typeof state['remediationUsed'] !== 'boolean'
      || !Array.isArray(state['stages']) || !state['stages'].every(stage =>
        stage && typeof stage === 'object' && typeof stage.stage === 'string' && typeof stage.at === 'string')) return false;
  }
  return ['title', 'excerpt', 'summary', 'content', 'postType'].every(key => typeof draft[key] === 'string')
    && ['keyTakeaways', 'categories', 'tags'].every(key => Array.isArray(draft[key]) && (draft[key] as unknown[]).every(item => typeof item === 'string'))
    && (draft['sourceUrl'] === null || typeof draft['sourceUrl'] === 'string')
    && typeof verification['verified'] === 'boolean' && Array.isArray(verification['issues'])
    && verification['issues'].every(item => typeof item === 'string');
}

export const BlogJobHost: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = new URLSearchParams(location.search).get('blogJob');
  const query = useQuery({
    queryKey: ['blog-job', id],
    queryFn: async () => {
      if (!id) throw new Error('The blog draft ID is missing.');
      const response = await api.getAgentJob(id);
      if (!response.success) throw new Error(response.error?.message ?? 'Could not load the blog draft.');
      if (response.data.specialist !== 'blog-writer') throw new Error('This is not a blog draft.');
      return response.data;
    },
    enabled: !!id, retry: false, refetchOnWindowFocus: false,
    refetchInterval: state => state.state.data?.status === 'queued' || state.state.data?.status === 'running' ? 5000 : false,
  });
  if (!id) return null;
  const close = (): void => {
    const params = new URLSearchParams(location.search);
    params.delete('blogJob');
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, state: location.state });
  };
  const job = query.data;
  if (job && job.status !== 'queued' && job.status !== 'running' && isBlogJobResult(job.result)) {
    const result = job.result;
    const prefix = 'spark-theme:';
    const source: BlogPublishSource | undefined = result.subjectId.startsWith(prefix) ? {
      key: result.subjectId,
      publish: post => api.publishSparkThemeBlogPost(result.subjectId.slice(prefix.length), post),
      onSent: () => {
        void queryClient.invalidateQueries({ queryKey: ['sparks'] });
        void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] });
        void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
      },
    } : undefined;
    const itemId = result.subjectId.startsWith('discover:') ? result.subjectId.slice('discover:'.length) : undefined;
    if (source || itemId) return <BlogDraftEditor key={id} jobId={id} initial={result} title={job.subjectTitle}
      {...(source ? { source } : itemId ? { itemId } : {})} onClose={close} />;
  }
  const error = query.error ?? (job?.status === 'failed'
    ? new Error(job.error ?? 'The blog specialist could not start a draft.')
    : job && job.status !== 'queued' && job.status !== 'running'
      ? new Error('The saved blog draft is unavailable or invalid.')
      : null);
  return <AppDialog title="Blog draft" onClose={close} actions={<button type="button" className="kh-dialog__button" onClick={close}>Close</button>}>
    {error ? <p className="dc-linkedin__error" role="alert">{describeApiError(error)}</p>
      : <div className="dc-loading" role="status"><InlineLoading description="Loading the blog draft..." /></div>}
  </AppDialog>;
};
